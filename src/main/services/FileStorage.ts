import { loggerService } from '@logger'
import { toAsarUnpackedPath } from '@main/utils'
import {
  checkName,
  getFilesDir,
  getFileType as getFileTypeByExt,
  getName,
  getNotesDir,
  getTempDir,
  parseGeneratedImageSource,
  readTextFileWithAutoEncoding,
  resolveDownloadedFileName,
  scanDir
} from '@main/utils/file'
import { t } from '@main/utils/locales'
import { documentExts, imageExts, KB, MB } from '@shared/config/constant'
import { IpcChannel } from '@shared/IpcChannel'
import type { FileReadByIdResult } from '@shared/types/fileRead'
import { parseDataUrl } from '@shared/utils'
import type { FileMetadata, FileType, NotesTreeNode } from '@types'
import { FILE_TYPE } from '@types'
import chardet from 'chardet'
import type { FSWatcher } from 'chokidar'
import chokidar from 'chokidar'
import * as crypto from 'crypto'
import type { OpenDialogOptions, OpenDialogReturnValue, SaveDialogOptions, SaveDialogReturnValue } from 'electron'
import { dialog, net, shell } from 'electron'
import * as fs from 'fs'
import { readFile } from 'fs/promises'
import { isBinaryFile } from 'isbinaryfile'
import officeParser from 'officeparser'
import * as os from 'os'
import * as path from 'path'
import { PDFDocument } from 'pdf-lib'
import { v4 as uuidv4 } from 'uuid'
import WordExtractor from 'word-extractor'

const logger = loggerService.withContext('FileStorage')

// Get ripgrep binary path
const getRipgrepBinaryPath = (): string | null => {
  try {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
    let ripgrepBinaryPath = path.join(
      __dirname,
      '../../node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep',
      `${arch}-${platform}`,
      process.platform === 'win32' ? 'rg.exe' : 'rg'
    )

    ripgrepBinaryPath = toAsarUnpackedPath(ripgrepBinaryPath)

    if (fs.existsSync(ripgrepBinaryPath)) {
      return ripgrepBinaryPath
    }
    return null
  } catch (error) {
    logger.error('Failed to locate ripgrep binary:', error as Error)
    return null
  }
}

/**
 * Execute ripgrep with captured output
 */
function executeRipgrep(args: string[]): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const ripgrepBinaryPath = getRipgrepBinaryPath()

    if (!ripgrepBinaryPath) {
      reject(new Error('Ripgrep binary not available'))
      return
    }

    const { spawn } = require('child_process')
    const child = spawn(ripgrepBinaryPath, ['--no-config', '--ignore-case', ...args], {
      windowsHide: true, // rg 是控制台子系统：不加则从 GUI 进程 spawn 时闪出控制台窗口
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let output = ''
    let errorOutput = ''

    child.stdout.on('data', (data: Buffer) => {
      output += data.toString()
    })

    child.stderr.on('data', (data: Buffer) => {
      errorOutput += data.toString()
    })

    child.on('close', (code: number) => {
      resolve({
        exitCode: code || 0,
        output: output || errorOutput
      })
    })

    child.on('error', (error: Error) => {
      reject(error)
    })
  })
}

interface FileWatcherConfig {
  watchExtensions?: string[]
  ignoredPatterns?: (string | RegExp)[]
  debounceMs?: number
  maxDepth?: number
  usePolling?: boolean
  retryOnError?: boolean
  retryDelayMs?: number
  stabilityThreshold?: number
  eventChannel?: string
}

const DEFAULT_WATCHER_CONFIG: Required<FileWatcherConfig> = {
  watchExtensions: ['.md', '.markdown', '.txt'],
  ignoredPatterns: [/(^|[/\\])\../, '**/node_modules/**', '**/.git/**', '**/*.tmp', '**/*.temp', '**/.DS_Store'],
  debounceMs: 1000,
  maxDepth: 10,
  usePolling: false,
  retryOnError: true,
  retryDelayMs: 5000,
  stabilityThreshold: 500,
  eventChannel: IpcChannel.File_Change
}

interface DirectoryListOptions {
  recursive?: boolean
  maxDepth?: number
  includeHidden?: boolean
  includeFiles?: boolean
  includeDirectories?: boolean
  maxEntries?: number
  searchPattern?: string
  fuzzy?: boolean
}

const DEFAULT_DIRECTORY_LIST_OPTIONS: Required<DirectoryListOptions> = {
  recursive: true,
  maxDepth: 10,
  includeHidden: false,
  includeFiles: true,
  includeDirectories: true,
  maxEntries: 20,
  searchPattern: '.',
  fuzzy: true
}

class FileStorage {
  private storageDir = getFilesDir()
  private notesDir = getNotesDir()
  private _tempDir = getTempDir()
  private watcher?: FSWatcher
  private watcherSender?: Electron.WebContents
  private currentWatchPath?: string
  private debounceTimer?: NodeJS.Timeout
  private watcherConfig: Required<FileWatcherConfig> = DEFAULT_WATCHER_CONFIG
  private isPaused = false

  private get tempDir(): string {
    if (!fs.existsSync(this._tempDir)) {
      fs.mkdirSync(this._tempDir, { recursive: true })
    }
    return this._tempDir
  }

  constructor() {
    this.initStorageDir()
  }

  private initStorageDir = (): void => {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true })
      }
      if (!fs.existsSync(this.notesDir)) {
        fs.mkdirSync(this.notesDir, { recursive: true })
      }
    } catch (error) {
      logger.error('Failed to initialize storage directories:', error as Error)
      throw error
    }
  }

  private getFileHash = async (filePath: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('md5')
      const stream = fs.createReadStream(filePath)
      stream.on('data', (data) => hash.update(data))
      stream.on('end', () => resolve(hash.digest('hex')))
      stream.on('error', reject)
    })
  }

  private findDuplicateFile = async (filePath: string, originName?: string): Promise<FileMetadata | null> => {
    const stats = await fs.promises.stat(filePath)
    logger.debug(`stats: ${stats}, filePath: ${filePath}`)
    const fileSize = stats.size

    const files = await fs.promises.readdir(this.storageDir)
    // 并行 stat 全部存储文件：此前循环内逐个 statSync，文件越多上传越慢且阻塞主进程
    const storedStats = await Promise.all(
      files.map(async (file) => {
        try {
          return await fs.promises.stat(path.join(this.storageDir, file))
        } catch {
          return null
        }
      })
    )

    for (let i = 0; i < files.length; i++) {
      const storedStatsItem = storedStats[i]
      if (!storedStatsItem || storedStatsItem.size !== fileSize) continue

      const storedFilePath = path.join(this.storageDir, files[i])
      const [originalHash, storedHash] = await Promise.all([
        this.getFileHash(filePath),
        this.getFileHash(storedFilePath)
      ])

      if (originalHash === storedHash) {
        const file = files[i]
        const ext = path.extname(file)
        const id = path.basename(file, ext)
        const type = await this.getFileType(filePath)

        // `name` 是仓内文件名（单后缀）——此前 `file + ext` 拼出 `uuid.png.png`，
        // getFileUrl 按 name 建 URL 直接裂图；`origin_name` 透传上传方的原始名。
        return {
          id,
          origin_name: originName ?? file,
          name: file,
          path: storedFilePath,
          created_at: storedStatsItem.birthtime.toISOString(),
          size: storedStatsItem.size,
          ext,
          type,
          count: 2
        }
      }
    }

    return null
  }

  public getFileType = async (filePath: string): Promise<FileType> => {
    const ext = path.extname(filePath)
    const fileType = getFileTypeByExt(ext)

    return fileType === FILE_TYPE.OTHER && (await this._isTextFile(filePath)) ? FILE_TYPE.TEXT : fileType
  }

  public selectFile = async (
    _: Electron.IpcMainInvokeEvent,
    options?: OpenDialogOptions
  ): Promise<FileMetadata[] | null> => {
    const defaultOptions: OpenDialogOptions = {
      properties: ['openFile']
    }

    const dialogOptions = { ...defaultOptions, ...options }

    const result = await dialog.showOpenDialog(dialogOptions)

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const fileMetadataPromises = result.filePaths.map(async (filePath) => {
      const stats = await fs.promises.stat(filePath)
      const ext = path.extname(filePath)
      const fileType = await this.getFileType(filePath)

      return {
        id: uuidv4(),
        origin_name: path.basename(filePath),
        name: path.basename(filePath),
        path: filePath,
        created_at: stats.birthtime.toISOString(),
        size: stats.size,
        ext: ext,
        type: fileType,
        count: 1
      }
    })

    return Promise.all(fileMetadataPromises)
  }

  /**
   * 图片"压缩"层：jimp 移除后此层实际只是复制（>1MB 与 <1MB 行为早已一致）。
   * 保留方法名维持调用方语义，实现退化为单次拷贝——不再白做压缩尝试。
   */
  private async compressImage(sourcePath: string, destPath: string): Promise<void> {
    try {
      await fs.promises.copyFile(sourcePath, destPath)
      logger.debug(`Image copied successfully: ${sourcePath}`)
    } catch (error) {
      logger.error('Image handling failed:', error as Error)
      throw error
    }
  }

  public uploadFile = async (_: Electron.IpcMainInvokeEvent, file: FileMetadata): Promise<FileMetadata> => {
    const filePath = file.path
    const duplicateFile = await this.findDuplicateFile(filePath, file.origin_name ?? path.basename(file.path))

    if (duplicateFile) {
      return duplicateFile
    }

    const uuid = uuidv4()
    const origin_name = path.basename(file.path)
    const ext = path.extname(origin_name).toLowerCase()
    const destPath = path.join(this.storageDir, uuid + ext)

    logger.info(`[FileStorage] Uploading file: ${filePath}`)

    // 根据文件类型选择处理方式
    if (imageExts.includes(ext)) {
      await this.compressImage(filePath, destPath)
    } else {
      await fs.promises.copyFile(filePath, destPath)
    }

    const stats = await fs.promises.stat(destPath)
    const fileType = await this.getFileType(destPath)

    const fileMetadata: FileMetadata = {
      id: uuid,
      origin_name,
      name: uuid + ext,
      path: destPath,
      created_at: stats.birthtime.toISOString(),
      size: stats.size,
      ext: ext,
      type: fileType,
      count: 1
    }

    logger.debug(`File uploaded: ${fileMetadata}`)

    return fileMetadata
  }

  public getFile = async (_: Electron.IpcMainInvokeEvent, filePath: string): Promise<FileMetadata | null> => {
    if (!fs.existsSync(filePath)) {
      return null
    }

    const stats = await fs.promises.stat(filePath)
    const fileType = await this.getFileType(filePath)

    return {
      id: uuidv4(),
      origin_name: path.basename(filePath),
      name: path.basename(filePath),
      path: filePath,
      created_at: stats.birthtime.toISOString(),
      size: stats.size,
      ext: path.extname(filePath),
      type: fileType,
      count: 1
    }
  }

  public deleteFile = async (_: Electron.IpcMainInvokeEvent, id: string): Promise<void> => {
    const filePath = path.join(this.storageDir, id)
    if (!fs.existsSync(filePath)) {
      // 终态（无字节）已达成，按幂等删除返回成功；但行还在而字节缺失是数据不一致，
      // warn 落盘取证（renderer 的 info 不落盘）。
      logger.warn(`FileStorage.deleteFile: bytes not found for ${id}, treating as already deleted`)
      return
    }
    await fs.promises.unlink(filePath)
  }

  public deleteDir = async (_: Electron.IpcMainInvokeEvent, id: string): Promise<void> => {
    if (!fs.existsSync(path.join(this.storageDir, id))) {
      return
    }
    await fs.promises.rm(path.join(this.storageDir, id), { recursive: true })
  }

  public deleteExternalFile = async (_: Electron.IpcMainInvokeEvent, filePath: string): Promise<void> => {
    try {
      if (!fs.existsSync(filePath)) {
        return
      }

      await fs.promises.rm(filePath, { force: true })
      logger.debug(`External file deleted successfully: ${filePath}`)
    } catch (error) {
      logger.error('Failed to delete external file:', error as Error)
      throw error
    }
  }

  public deleteExternalDir = async (_: Electron.IpcMainInvokeEvent, dirPath: string): Promise<void> => {
    try {
      if (!fs.existsSync(dirPath)) {
        return
      }

      await fs.promises.rm(dirPath, { recursive: true, force: true })
      logger.debug(`External directory deleted successfully: ${dirPath}`)
    } catch (error) {
      logger.error('Failed to delete external directory:', error as Error)
      throw error
    }
  }

  /**
   * moveFile/moveDir/renameFile/renameDir 四段雷同逻辑的统一内核。
   * rejectExisting：重命名语义下目标已存在要报错；移动语义保持 rename 原语义不预检。
   */
  private async renameGuarded(
    sourcePath: string,
    targetPath: string,
    kind: 'file' | 'directory',
    rejectExisting: boolean
  ): Promise<void> {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source ${kind} does not exist: ${sourcePath}`)
    }

    // 确保目标父目录存在
    const destDir = path.dirname(targetPath)
    if (!fs.existsSync(destDir)) {
      await fs.promises.mkdir(destDir, { recursive: true })
    }

    if (rejectExisting && fs.existsSync(targetPath)) {
      throw new Error(`Target ${kind} already exists: ${targetPath}`)
    }

    await fs.promises.rename(sourcePath, targetPath)
  }

  public moveFile = async (_: Electron.IpcMainInvokeEvent, filePath: string, newPath: string): Promise<void> => {
    try {
      await this.renameGuarded(filePath, newPath, 'file', false)
      logger.debug(`File moved successfully: ${filePath} to ${newPath}`)
    } catch (error) {
      logger.error('Move file failed:', error as Error)
      throw error
    }
  }

  public moveDir = async (_: Electron.IpcMainInvokeEvent, dirPath: string, newDirPath: string): Promise<void> => {
    try {
      await this.renameGuarded(dirPath, newDirPath, 'directory', false)
      logger.debug(`Directory moved successfully: ${dirPath} to ${newDirPath}`)
    } catch (error) {
      logger.error('Move directory failed:', error as Error)
      throw error
    }
  }

  public renameFile = async (_: Electron.IpcMainInvokeEvent, filePath: string, newName: string): Promise<void> => {
    try {
      const dirPath = path.dirname(filePath)
      const newFilePath = path.join(dirPath, newName + '.md')
      await this.renameGuarded(filePath, newFilePath, 'file', true)
      logger.debug(`File renamed successfully: ${filePath} to ${newFilePath}`)
    } catch (error) {
      logger.error('Rename file failed:', error as Error)
      throw error
    }
  }

  public renameDir = async (_: Electron.IpcMainInvokeEvent, dirPath: string, newName: string): Promise<void> => {
    try {
      const parentDir = path.dirname(dirPath)
      const newDirPath = path.join(parentDir, newName)
      await this.renameGuarded(dirPath, newDirPath, 'directory', true)
      logger.debug(`Directory renamed successfully: ${dirPath} to ${newDirPath}`)
    } catch (error) {
      logger.error('Rename directory failed:', error as Error)
      throw error
    }
  }

  /**
   * Core file reading logic that handles both documents and text files.
   *
   * @private
   * @param filePath - Full path to the file
   * @param detectEncoding - Whether to auto-detect text file encoding
   * @returns Promise resolving to the extracted text content
   * @throws Error if file reading fails
   */
  private async readFileCore(filePath: string, detectEncoding: boolean = false): Promise<string> {
    const fileExtension = path.extname(filePath)

    if (documentExts.includes(fileExtension)) {
      try {
        if (fileExtension === '.doc') {
          const extractor = new WordExtractor()
          const extracted = await extractor.extract(filePath)
          return extracted.getBody()
        }

        const data = await officeParser.parseOfficeAsync(filePath, {
          tempFilesLocation: this.tempDir
        })
        return data
      } catch (error) {
        logger.error('Failed to read document file:', error as Error)
        throw error
      }
    }

    try {
      if (detectEncoding) {
        return readTextFileWithAutoEncoding(filePath)
      } else {
        // File_Read/File_ReadExternal 的热路径：异步读，避免大文件阻塞主进程
        return await fs.promises.readFile(filePath, 'utf-8')
      }
    } catch (error) {
      logger.error('Failed to read text file:', error as Error)
      throw new Error(`Failed to read file: ${filePath}.`)
    }
  }

  /**
   * Reads and extracts content from a stored file.
   *
   * Supports multiple file formats including:
   * - Complex documents: .pdf, .doc, .docx, .pptx, .xlsx, .odt, .odp, .ods
   * - Text files: .txt, .md, .json, .csv, etc.
   * - Code files: .js, .ts, .py, .java, etc.
   *
   * For document formats, extracts text content using specialized parsers:
   * - .doc files: Uses word-extractor library
   * - Other Office formats: Uses officeparser library
   *
   * For text files, can optionally detect encoding automatically.
   *
   * @param _ - Electron IPC invoke event (unused)
   * @param id - File identifier with extension (e.g., "uuid.docx")
   * @param detectEncoding - Whether to auto-detect text file encoding (default: false)
   * @returns Promise resolving to the extracted text content of the file
   * @throws Error if file reading fails or file is not found
   *
   * @example
   * // Read a DOCX file
   * const content = await readFile(event, "document.docx");
   *
   * @example
   * // Read a text file with encoding detection
   * const content = await readFile(event, "text.txt", true);
   *
   * @example
   * // Read a PDF file
   * const content = await readFile(event, "manual.pdf");
   */
  public readFile = async (
    _: Electron.IpcMainInvokeEvent,
    id: string,
    detectEncoding: boolean = false
  ): Promise<string> => {
    const filePath = path.join(this.storageDir, id)
    return this.readFileCore(filePath, detectEncoding)
  }

  /**
   * /⑥：按 id 读文件仓成员，并把「文件不存在」与「存在但读不出来」**分开**回给渲染层。
   *
   * 为什么需要这条通道：`File_Read` 对任何失败都抛同一个通用错误（`readFileCore` 把读错误
   * 统一包成 `Failed to read file: …`），调用方无法区分。渲染层因此在全新安装时既不能
   * 把「文件不存在」当成空列表去播种 `custom-minapps.json`，也不得把「读失败」误当
   * 「不存在」而覆盖写用户文件。
   *
   * 判定用 `fs.existsSync`：它是文件系统对「该路径有没有目录项」的**终局答案**（存在但无
   * 读权限时仍报 true），符合「missing 必须是确定事实」的要求；其余任何失败一律落 `error`
   * 分支，由渲染层如实报错且绝不写盘。`File_Read` 的行为不变（本方法不复用它）。
   */
  public readFileById = async (_: Electron.IpcMainInvokeEvent, id: string): Promise<FileReadByIdResult> => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('readFileById: id must be a non-empty string')
    }
    if (id.includes('\0')) {
      throw new Error('readFileById: id must not contain a null byte')
    }

    const filePath = path.join(this.storageDir, id)
    // 越界判定用 path.relative：跨平台一致（不依赖分隔符字面比较，Windows 反斜杠不会绕过）。
    const relative = path.relative(this.storageDir, filePath)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('readFileById: id must stay inside the storage directory')
    }

    if (!fs.existsSync(filePath)) {
      logger.warn(`[IPC - Warning] File does not exist in storage: ${filePath}`)
      return { status: 'missing' }
    }

    try {
      const content = await this.readFileCore(filePath, false)
      return { status: 'ok', content }
    } catch (error) {
      logger.error(`[IPC - Error] File exists but could not be read: ${filePath}`, error as Error)
      return { status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Reads and extracts content from an external file path.
   *
   * Similar to readFile, but operates on external file paths instead of stored files.
   * Supports the same file formats including complex documents and text files.
   *
   * @param _ - Electron IPC invoke event (unused)
   * @param filePath - Absolute path to the external file
   * @param detectEncoding - Whether to auto-detect text file encoding (default: false)
   * @returns Promise resolving to the extracted text content of the file
   * @throws Error if file does not exist or reading fails
   *
   * @example
   * // Read an external DOCX file
   * const content = await readExternalFile(event, "/path/to/document.docx");
   *
   * @example
   * // Read an external text file with encoding detection
   * const content = await readExternalFile(event, "/path/to/text.txt", true);
   */
  public readExternalFile = async (
    _: Electron.IpcMainInvokeEvent,
    filePath: string,
    detectEncoding: boolean = false
  ): Promise<string> => {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`)
    }

    return this.readFileCore(filePath, detectEncoding)
  }

  public createTempFile = async (_: Electron.IpcMainInvokeEvent, fileName: string): Promise<string> => {
    return path.join(this.tempDir, `temp_file_${uuidv4()}_${fileName}`)
  }

  public writeFile = async (
    _: Electron.IpcMainInvokeEvent,
    filePath: string,
    data: Uint8Array | string
  ): Promise<void> => {
    await fs.promises.writeFile(filePath, data)
  }

  public fileNameGuard = async (
    _: Electron.IpcMainInvokeEvent,
    dirPath: string,
    fileName: string,
    isFile: boolean
  ): Promise<{ safeName: string; exists: boolean }> => {
    const safeName = checkName(fileName)
    const finalName = getName(dirPath, safeName, isFile)
    const fullPath = path.join(dirPath, finalName + (isFile ? '.md' : ''))
    const exists = fs.existsSync(fullPath)

    logger.debug(`File name guard: ${fileName} -> ${finalName}, exists: ${exists}`)
    return { safeName: finalName, exists }
  }

  public mkdir = async (_: Electron.IpcMainInvokeEvent, dirPath: string): Promise<string> => {
    try {
      logger.debug(`Attempting to create directory: ${dirPath}`)
      await fs.promises.mkdir(dirPath, { recursive: true })
      return dirPath
    } catch (error) {
      logger.error('Failed to create directory:', error as Error)
      throw new Error(`Failed to create directory: ${dirPath}. Error: ${(error as Error).message}`)
    }
  }

  public base64Image = async (
    _: Electron.IpcMainInvokeEvent,
    id: string
  ): Promise<{ mime: string; base64: string; data: string }> => {
    const filePath = path.join(this.storageDir, id)
    const data = await fs.promises.readFile(filePath)
    const base64 = data.toString('base64')
    const rawExt = path.extname(filePath).slice(1)
    const ext = rawExt === 'jpg' ? 'jpeg' : rawExt
    const mime = ext ? `image/${ext}` : 'image/png'
    return {
      mime,
      base64,
      data: `data:${mime};base64,${base64}`
    }
  }

  public saveBase64Image = async (_: Electron.IpcMainInvokeEvent, base64Data: string): Promise<FileMetadata> => {
    try {
      if (!base64Data) {
        throw new Error('Base64 data is required')
      }

      const parseResult = parseDataUrl(base64Data)
      const base64String = parseResult?.data ?? base64Data
      const ext = parseResult?.mediaType ? this.getExtensionFromMimeType(parseResult.mediaType) : '.png'

      const buffer = Buffer.from(base64String, 'base64')
      const uuid = uuidv4()
      const destPath = path.join(this.storageDir, uuid + ext)

      logger.debug('Saving base64 image:', {
        storageDir: this.storageDir,
        destPath,
        bufferSize: buffer.length
      })

      // 确保目录存在
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true })
      }

      await fs.promises.writeFile(destPath, buffer)

      return {
        id: uuid,
        origin_name: uuid + ext,
        name: uuid + ext,
        path: destPath,
        created_at: new Date().toISOString(),
        size: buffer.length,
        ext,
        type: getFileTypeByExt(ext),
        count: 1
      }
    } catch (error) {
      logger.error('Failed to save base64 image:', error as Error)
      throw error
    }
  }

  /**
   * 聊天页 `generate_image` 出图的**内容寻址落盘**。
   *
   * 这批图原先只作为 IMAGE 块的元数据存在（不落盘、不进 `db.files`），文件页因此永远看不到它们；
   * 现在由渲染层按源串 sha256 给 id，主进程落到 `<id><ext>`。同一张图重复投影（回放/重开话题）
   * 命中同一文件名，渲染层见行已存在就跳过 —— 不会像"每次 saveBase64Image 都生成新 uuid"那样堆积。
   * 未知 MIME 一律退 `.png`（生成图一定是图片，绝不让它落成 `.bin` 被归进"其他"）。
   */
  public saveGeneratedImage = async (
    _: Electron.IpcMainInvokeEvent,
    payload: { id: string; source: string }
  ): Promise<FileMetadata> => {
    const id = typeof payload?.id === 'string' ? payload.id.trim() : ''
    if (!/^[0-9a-f]{64}$/.test(id)) {
      throw new Error('saveGeneratedImage: id must be a sha256 hex string')
    }
    const parsed = parseGeneratedImageSource(String(payload?.source ?? ''))
    if (parsed === undefined) {
      throw new Error('saveGeneratedImage: unsupported image source')
    }

    let data: Buffer
    let ext: string
    if (parsed.kind === 'url' && parsed.url !== undefined) {
      const response = await net.fetch(parsed.url)
      if (!response.ok) {
        throw new Error(`saveGeneratedImage: HTTP ${response.status}`)
      }
      const urlName = parsed.url.split('/').pop()?.split('?')[0] ?? ''
      const resolved = resolveDownloadedFileName(
        urlName,
        this.getExtensionFromMimeType(response.headers.get('Content-Type')),
        true
      )
      ext = resolved.ext
      data = Buffer.from(await response.arrayBuffer())
    } else {
      ext = this.getExtensionFromMimeType(parsed.mediaType ?? 'image/png')
      data = Buffer.from(parsed.base64 ?? '', 'base64')
    }
    if (ext === '.bin' || ext.length === 0) ext = '.png'

    await fs.promises.mkdir(this.storageDir, { recursive: true })
    const fileName = `${id}${ext}`
    const destPath = path.join(this.storageDir, fileName)
    await fs.promises.writeFile(destPath, data)
    const stats = await fs.promises.stat(destPath)

    return {
      id,
      name: fileName,
      origin_name: `${t('files.generated_image')}-${id.slice(0, 8)}${ext}`,
      path: destPath,
      created_at: stats.birthtime.toISOString(),
      size: stats.size,
      ext,
      type: await this.getFileType(destPath),
      count: 1
    }
  }

  public savePastedImage = async (
    _: Electron.IpcMainInvokeEvent,
    imageData: Uint8Array | Buffer,
    extension?: string
  ): Promise<FileMetadata> => {
    try {
      const uuid = uuidv4()
      const ext = extension || '.png'
      const destPath = path.join(this.storageDir, uuid + ext)

      logger.debug('Saving pasted image:', {
        storageDir: this.storageDir,
        destPath,
        bufferSize: imageData.length
      })

      // 确保目录存在
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true })
      }

      // 确保 imageData 是 Buffer
      const buffer = Buffer.isBuffer(imageData) ? imageData : Buffer.from(imageData)

      // 如果图片大于1MB，进行压缩处理
      if (buffer.length > MB) {
        await this.compressImageBuffer(buffer, destPath, ext)
      } else {
        await fs.promises.writeFile(destPath, buffer)
      }

      const stats = await fs.promises.stat(destPath)

      return {
        id: uuid,
        origin_name: `pasted_image_${uuid}${ext}`,
        name: uuid + ext,
        path: destPath,
        created_at: new Date().toISOString(),
        size: stats.size,
        ext,
        type: getFileTypeByExt(ext),
        count: 1
      }
    } catch (error) {
      logger.error('Failed to save pasted image:', error as Error)
      throw error
    }
  }

  private async compressImageBuffer(imageBuffer: Buffer, destPath: string, ext: string): Promise<void> {
    void ext
    // 原"压缩"管线（先写临时文件再复制）随 jimp 移除已无实际压缩，直接落盘
    try {
      await fs.promises.writeFile(destPath, imageBuffer)
    } catch (error) {
      logger.error('Image buffer save failed:', error as Error)
      throw error
    }
  }

  public base64File = async (_: Electron.IpcMainInvokeEvent, id: string): Promise<{ data: string; mime: string }> => {
    const filePath = path.join(this.storageDir, id)
    const buffer = await fs.promises.readFile(filePath)
    const base64 = buffer.toString('base64')
    const mime = `application/${path.extname(filePath).slice(1)}`
    return { data: base64, mime }
  }

  public pdfPageCount = async (_: Electron.IpcMainInvokeEvent, id: string): Promise<number> => {
    const filePath = path.join(this.storageDir, id)
    const buffer = await fs.promises.readFile(filePath)

    const pdfDoc = await PDFDocument.load(buffer)
    return pdfDoc.getPageCount()
  }

  public binaryImage = async (_: Electron.IpcMainInvokeEvent, id: string): Promise<{ data: Buffer; mime: string }> => {
    const filePath = path.join(this.storageDir, id)
    const data = await fs.promises.readFile(filePath)
    const mime = `image/${path.extname(filePath).slice(1)}`
    return { data, mime }
  }

  public clear = async (): Promise<void> => {
    await fs.promises.rm(this.storageDir, { recursive: true })
    this.initStorageDir()
  }

  public clearTemp = async (): Promise<void> => {
    await fs.promises.rm(this.tempDir, { recursive: true })
    await fs.promises.mkdir(this.tempDir, { recursive: true })
  }

  public open = async (
    _: Electron.IpcMainInvokeEvent,
    options: OpenDialogOptions
  ): Promise<{ fileName: string; filePath: string; content?: Buffer; size: number } | null> => {
    try {
      const result: OpenDialogReturnValue = await dialog.showOpenDialog({
        title: t('dialog.open_file'),
        properties: ['openFile'],
        filters: [{ name: t('dialog.all_files'), extensions: ['*'] }],
        ...options
      })

      if (!result.canceled && result.filePaths.length > 0) {
        const filePath = result.filePaths[0]
        const fileName = filePath.split('/').pop() || ''
        const stats = await fs.promises.stat(filePath)

        // If the file is less than 2GB, read the content
        if (stats.size < 2 * 1024 * 1024 * 1024) {
          const content = await readFile(filePath)
          return { fileName, filePath, content, size: stats.size }
        }

        // For large files, only return file information, do not read content
        return { fileName, filePath, size: stats.size }
      }

      return null
    } catch (err) {
      logger.error('[IPC - Error] An error occurred opening the file:', err as Error)
      return null
    }
  }

  public openPath = async (_: Electron.IpcMainInvokeEvent, path: string): Promise<void> => {
    const resolved = await shell.openPath(path)
    if (resolved !== '') {
      throw new Error(resolved)
    }
  }

  /**
   * 通过相对路径打开文件，跨设备时使用
   * @param _
   * @param file
   */
  public openFileWithRelativePath = async (_: Electron.IpcMainInvokeEvent, file: FileMetadata): Promise<void> => {
    const filePath = path.join(this.storageDir, file.name)
    if (fs.existsSync(filePath)) {
      shell.openPath(filePath).catch((err) => logger.error('[IPC - Error] Failed to open file:', err))
    } else {
      logger.warn(`[IPC - Warning] File does not exist: ${filePath}`)
    }
  }

  public getDirectoryStructure = async (_: Electron.IpcMainInvokeEvent, dirPath: string): Promise<NotesTreeNode[]> => {
    try {
      return await scanDir(dirPath)
    } catch (error) {
      logger.error('Failed to get directory structure:', error as Error)
      throw error
    }
  }

  public listDirectory = async (
    _: Electron.IpcMainInvokeEvent,
    dirPath: string,
    options?: DirectoryListOptions
  ): Promise<string[]> => {
    const mergedOptions: Required<DirectoryListOptions> = {
      ...DEFAULT_DIRECTORY_LIST_OPTIONS,
      ...options
    }

    const resolvedPath = path.resolve(dirPath)

    const stat = await fs.promises.stat(resolvedPath).catch((error) => {
      logger.error(`[IPC - Error] Failed to access directory: ${resolvedPath}`, error as Error)
      throw error
    })

    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolvedPath}`)
    }

    // Use ripgrep for file listing with relevance-based sorting
    if (!getRipgrepBinaryPath()) {
      throw new Error('Ripgrep binary not available')
    }

    return await this.listDirectoryWithRipgrep(resolvedPath, mergedOptions)
  }

  /**
   * Search directories by name pattern
   */
  private async searchDirectories(
    resolvedPath: string,
    options: Required<DirectoryListOptions>,
    currentDepth: number = 0
  ): Promise<string[]> {
    if (!options.includeDirectories) return []
    if (!options.recursive && currentDepth > 0) return []
    if (options.maxDepth > 0 && currentDepth >= options.maxDepth) return []

    const directories: string[] = []
    const excludedDirs = new Set([
      'node_modules',
      '.git',
      '.idea',
      '.vscode',
      'dist',
      'build',
      '.next',
      '.nuxt',
      'coverage',
      '.cache'
    ])

    try {
      const entries = await fs.promises.readdir(resolvedPath, { withFileTypes: true })
      const searchPatternLower = options.searchPattern.toLowerCase()

      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        // Skip hidden directories unless explicitly included
        if (!options.includeHidden && entry.name.startsWith('.')) continue

        // Skip excluded directories
        if (excludedDirs.has(entry.name)) continue

        const fullPath = path.join(resolvedPath, entry.name).replace(/\\/g, '/')

        // Check if directory name matches search pattern
        if (options.searchPattern === '.' || entry.name.toLowerCase().includes(searchPatternLower)) {
          directories.push(fullPath)
        }
      }

      // 递归并行展开（Promise.all 保序）：此前逐目录串行 await，深树搜索耗时线性叠加
      if (options.recursive && currentDepth < options.maxDepth) {
        const subDirPromises = entries
          .filter(
            (entry) =>
              entry.isDirectory() &&
              (options.includeHidden || !entry.name.startsWith('.')) &&
              !excludedDirs.has(entry.name)
          )
          .map((entry) =>
            this.searchDirectories(path.join(resolvedPath, entry.name).replace(/\\/g, '/'), options, currentDepth + 1)
          )
        const subResults = await Promise.all(subDirPromises)
        for (const subDirs of subResults) {
          directories.push(...subDirs)
        }
      }
    } catch (error) {
      logger.warn(`Failed to search directories in: ${resolvedPath}`, error as Error)
    }

    return directories
  }

  /**
   * Search files by filename pattern
   */
  private async searchByFilename(resolvedPath: string, options: Required<DirectoryListOptions>): Promise<string[]> {
    const files: string[] = []
    const directories: string[] = []

    // Search for files using ripgrep
    if (options.includeFiles) {
      const args: string[] = ['--files']

      // Handle hidden files
      if (!options.includeHidden) {
        args.push('--glob', '!.*')
      }

      // Use --iglob to let ripgrep filter filenames (case-insensitive)
      if (options.searchPattern && options.searchPattern !== '.') {
        args.push('--iglob', `*${options.searchPattern}*`)
      }

      // Exclude common hidden directories and large directories
      args.push('-g', '!**/node_modules/**')
      args.push('-g', '!**/.git/**')
      args.push('-g', '!**/.idea/**')
      args.push('-g', '!**/.vscode/**')
      args.push('-g', '!**/.DS_Store')
      args.push('-g', '!**/dist/**')
      args.push('-g', '!**/build/**')
      args.push('-g', '!**/.next/**')
      args.push('-g', '!**/.nuxt/**')
      args.push('-g', '!**/coverage/**')
      args.push('-g', '!**/.cache/**')

      // Handle max depth
      if (!options.recursive) {
        args.push('--max-depth', '1')
      } else if (options.maxDepth > 0) {
        args.push('--max-depth', options.maxDepth.toString())
      }

      // Add the directory path
      args.push(resolvedPath)

      const { exitCode, output } = await executeRipgrep(args)

      // Exit code 0 means files found, 1 means no files found (still success), 2+ means error
      if (exitCode >= 2) {
        throw new Error(`Ripgrep failed with exit code ${exitCode}: ${output}`)
      }

      // Parse ripgrep output (no need to filter by filename - ripgrep already did it)
      files.push(
        ...output
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => line.replace(/\\/g, '/'))
      )
    }

    // Search for directories
    if (options.includeDirectories) {
      directories.push(...(await this.searchDirectories(resolvedPath, options)))
    }

    // Combine and sort: directories first (alphabetically), then files (alphabetically)
    const sortedDirectories = directories.sort((a, b) => {
      const aName = path.basename(a)
      const bName = path.basename(b)
      return aName.localeCompare(bName)
    })

    const sortedFiles = files.sort((a, b) => {
      const aName = path.basename(a)
      const bName = path.basename(b)
      return aName.localeCompare(bName)
    })

    return [...sortedDirectories, ...sortedFiles].slice(0, options.maxEntries)
  }

  /**
   * Fuzzy match: checks if all characters in query appear in text in order (case-insensitive)
   * Example: "updater" matches "packages/update/src/node/updateController.ts"
   */
  private isFuzzyMatch(text: string, query: string): boolean {
    let i = 0 // text index
    let j = 0 // query index
    const textLower = text.toLowerCase()
    const queryLower = query.toLowerCase()

    while (i < textLower.length && j < queryLower.length) {
      if (textLower[i] === queryLower[j]) {
        j++
      }
      i++
    }
    return j === queryLower.length
  }

  /**
   * Scoring constants for fuzzy match relevance ranking
   * Higher values = higher priority in search results
   */
  private static readonly SCORE_SEGMENT_MATCH = 60 // Per path segment that matches query
  private static readonly SCORE_FILENAME_CONTAINS = 80 // Filename contains exact query substring
  private static readonly SCORE_FILENAME_STARTS = 100 // Filename starts with query (highest priority)
  private static readonly SCORE_CONSECUTIVE_CHAR = 15 // Per consecutive character match
  private static readonly SCORE_WORD_BOUNDARY = 20 // Query matches start of a word
  private static readonly PATH_LENGTH_PENALTY_FACTOR = 4 // Logarithmic penalty multiplier for longer paths

  /**
   * Calculate fuzzy match score (higher is better)
   * Scoring factors:
   * - Consecutive character matches (bonus)
   * - Match at word boundaries (bonus)
   * - Shorter path length (bonus)
   * - Match in filename vs directory (bonus)
   */
  private getFuzzyMatchScore(filePath: string, query: string): number {
    const pathLower = filePath.toLowerCase()
    const queryLower = query.toLowerCase()
    const fileName = filePath.split('/').pop() || ''
    const fileNameLower = fileName.toLowerCase()

    let score = 0

    // Count how many times query-related words appear in path segments
    const pathSegments = pathLower.split(/[/\\]/)
    let segmentMatchCount = 0
    for (const segment of pathSegments) {
      if (this.isFuzzyMatch(segment, queryLower)) {
        segmentMatchCount++
      }
    }
    score += segmentMatchCount * FileStorage.SCORE_SEGMENT_MATCH

    // Bonus for filename starting with query (stronger than generic "contains")
    if (fileNameLower.startsWith(queryLower)) {
      score += FileStorage.SCORE_FILENAME_STARTS
    } else if (fileNameLower.includes(queryLower)) {
      // Bonus for exact substring match in filename (e.g., "updater" in "RCUpdater.js")
      score += FileStorage.SCORE_FILENAME_CONTAINS
    }

    // Calculate consecutive match bonus
    let i = 0
    let j = 0
    let consecutiveCount = 0
    let maxConsecutive = 0

    while (i < pathLower.length && j < queryLower.length) {
      if (pathLower[i] === queryLower[j]) {
        consecutiveCount++
        maxConsecutive = Math.max(maxConsecutive, consecutiveCount)
        j++
      } else {
        consecutiveCount = 0
      }
      i++
    }
    score += maxConsecutive * FileStorage.SCORE_CONSECUTIVE_CHAR

    // Bonus for word boundary matches (e.g., "upd" matches start of "update")
    // Only count once to avoid inflating scores for paths with repeated patterns
    const boundaryPrefix = queryLower.slice(0, Math.min(3, queryLower.length))
    const words = pathLower.split(/[/\\._-]/)
    for (const word of words) {
      if (word.startsWith(boundaryPrefix)) {
        score += FileStorage.SCORE_WORD_BOUNDARY
        break
      }
    }

    // Penalty for longer paths (prefer shorter, more specific matches)
    // Use logarithmic scaling to prevent long paths from dominating the score
    // A 50-char path gets ~-16 penalty, 100-char gets ~-18, 200-char gets ~-21
    score -= Math.log(filePath.length + 1) * FileStorage.PATH_LENGTH_PENALTY_FACTOR

    return score
  }

  /**
   * Convert query to glob pattern for ripgrep pre-filtering
   * e.g., "updater" -> "*u*p*d*a*t*e*r*"
   */
  private queryToGlobPattern(query: string): string {
    // Escape special glob characters (including ! for negation)
    const escaped = query.replace(/[[\]{}()*+?.,\\^$|#!]/g, '\\$&')
    // Convert to fuzzy glob: each char separated by *
    return '*' + escaped.split('').join('*') + '*'
  }

  /**
   * Greedy substring match: check if all characters in query can be matched
   * by finding consecutive substrings in text (not necessarily single chars)
   * e.g., "updatercontroller" matches "updateController" by:
   *   "update" + "r" (from Controller) + "controller"
   */
  private isGreedySubstringMatch(text: string, query: string): boolean {
    const textLower = text.toLowerCase()
    const queryLower = query.toLowerCase()

    let queryIndex = 0
    let searchStart = 0

    while (queryIndex < queryLower.length) {
      // Try to find the longest matching substring starting at queryIndex
      let bestMatchLen = 0
      let bestMatchPos = -1

      for (let len = queryLower.length - queryIndex; len >= 1; len--) {
        const substr = queryLower.slice(queryIndex, queryIndex + len)
        const foundAt = textLower.indexOf(substr, searchStart)
        if (foundAt !== -1) {
          bestMatchLen = len
          bestMatchPos = foundAt
          break // Found longest possible match
        }
      }

      if (bestMatchLen === 0) {
        // No substring match found, query cannot be matched
        return false
      }

      queryIndex += bestMatchLen
      searchStart = bestMatchPos + bestMatchLen
    }

    return true
  }

  /**
   * Calculate greedy substring match score (higher is better)
   * Rewards: fewer match fragments, shorter match span, matches in filename
   */
  private getGreedyMatchScore(filePath: string, query: string): number {
    const textLower = filePath.toLowerCase()
    const queryLower = query.toLowerCase()
    const fileName = filePath.split('/').pop() || ''
    const fileNameLower = fileName.toLowerCase()

    let queryIndex = 0
    let searchStart = 0
    let fragmentCount = 0
    let firstMatchPos = -1
    let lastMatchEnd = 0

    while (queryIndex < queryLower.length) {
      let bestMatchLen = 0
      let bestMatchPos = -1

      for (let len = queryLower.length - queryIndex; len >= 1; len--) {
        const substr = queryLower.slice(queryIndex, queryIndex + len)
        const foundAt = textLower.indexOf(substr, searchStart)
        if (foundAt !== -1) {
          bestMatchLen = len
          bestMatchPos = foundAt
          break
        }
      }

      if (bestMatchLen === 0) {
        return -Infinity // No match
      }

      fragmentCount++
      if (firstMatchPos === -1) firstMatchPos = bestMatchPos
      lastMatchEnd = bestMatchPos + bestMatchLen
      queryIndex += bestMatchLen
      searchStart = lastMatchEnd
    }

    const matchSpan = lastMatchEnd - firstMatchPos
    let score = 0

    // Fewer fragments = better (single continuous match is best)
    // Max bonus when fragmentCount=1, decreases as fragments increase
    score += Math.max(0, 100 - (fragmentCount - 1) * 30)

    // Shorter span relative to query length = better (tighter match)
    // Perfect match: span equals query length
    const spanRatio = queryLower.length / matchSpan
    score += spanRatio * 50

    // Bonus for match in filename
    if (this.isGreedySubstringMatch(fileNameLower, queryLower)) {
      score += 80
    }

    // Penalty for longer paths
    score -= Math.log(filePath.length + 1) * 4

    return score
  }

  /**
   * Build common ripgrep arguments for file listing
   */
  private buildRipgrepBaseArgs(options: Required<DirectoryListOptions>, resolvedPath: string): string[] {
    const args: string[] = ['--files']

    // Handle hidden files
    if (!options.includeHidden) {
      args.push('--glob', '!.*')
    }

    // Exclude common hidden directories and large directories
    args.push('-g', '!**/node_modules/**')
    args.push('-g', '!**/.git/**')
    args.push('-g', '!**/.idea/**')
    args.push('-g', '!**/.vscode/**')
    args.push('-g', '!**/.DS_Store')
    args.push('-g', '!**/dist/**')
    args.push('-g', '!**/build/**')
    args.push('-g', '!**/.next/**')
    args.push('-g', '!**/.nuxt/**')
    args.push('-g', '!**/coverage/**')
    args.push('-g', '!**/.cache/**')

    // Handle max depth
    if (!options.recursive) {
      args.push('--max-depth', '1')
    } else if (options.maxDepth > 0) {
      args.push('--max-depth', options.maxDepth.toString())
    }

    args.push(resolvedPath)

    return args
  }

  private async listDirectoryWithRipgrep(
    resolvedPath: string,
    options: Required<DirectoryListOptions>
  ): Promise<string[]> {
    // Fuzzy search mode: use ripgrep glob for pre-filtering, then score in JS
    if (options.fuzzy && options.searchPattern && options.searchPattern !== '.') {
      const args = this.buildRipgrepBaseArgs(options, resolvedPath)

      // Insert glob pattern before the path (last element)
      const globPattern = this.queryToGlobPattern(options.searchPattern)
      args.splice(args.length - 1, 0, '--iglob', globPattern)

      const { exitCode, output } = await executeRipgrep(args)

      if (exitCode >= 2) {
        throw new Error(`Ripgrep failed with exit code ${exitCode}: ${output}`)
      }

      const filteredFiles = output
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => line.replace(/\\/g, '/'))

      // If fuzzy glob found results, validate fuzzy match, sort and return
      if (filteredFiles.length > 0) {
        return filteredFiles
          .filter((file) => this.isFuzzyMatch(file, options.searchPattern))
          .map((file) => ({ file, score: this.getFuzzyMatchScore(file, options.searchPattern) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, options.maxEntries)
          .map((item) => item.file)
      }

      // Fallback: if no results, try greedy substring match on all files
      logger.debug('Fuzzy glob returned no results, falling back to greedy substring match')
      const fallbackArgs = this.buildRipgrepBaseArgs(options, resolvedPath)

      const fallbackResult = await executeRipgrep(fallbackArgs)

      if (fallbackResult.exitCode >= 2) {
        return []
      }

      const allFiles = fallbackResult.output
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => line.replace(/\\/g, '/'))

      const greedyMatched = allFiles.filter((file) => this.isGreedySubstringMatch(file, options.searchPattern))

      return greedyMatched
        .map((file) => ({ file, score: this.getGreedyMatchScore(file, options.searchPattern) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, options.maxEntries)
        .map((item) => item.file)
    }

    // Fallback: search by filename only (non-fuzzy mode)
    logger.debug('Searching by filename pattern', { pattern: options.searchPattern, path: resolvedPath })
    const filenameResults = await this.searchByFilename(resolvedPath, options)

    logger.debug('Found matches by filename', { count: filenameResults.length })
    return filenameResults.slice(0, options.maxEntries)
  }

  public validateNotesDirectory = async (_: Electron.IpcMainInvokeEvent, dirPath: string): Promise<boolean> => {
    try {
      if (!dirPath || typeof dirPath !== 'string') {
        return false
      }

      // Normalize path
      const normalizedPath = path.resolve(dirPath)

      // Check if directory exists
      if (!fs.existsSync(normalizedPath)) {
        return false
      }

      // Check if it's actually a directory
      const stats = fs.statSync(normalizedPath)
      if (!stats.isDirectory()) {
        return false
      }

      // Get app paths to prevent selection of restricted directories
      const appDataPath = path.resolve(process.env.APPDATA || path.join(os.homedir(), '.config'))
      const filesDir = path.resolve(getFilesDir())
      const currentNotesDir = path.resolve(getNotesDir())

      // Prevent selecting app data directories
      if (
        normalizedPath.startsWith(filesDir) ||
        normalizedPath.startsWith(appDataPath) ||
        normalizedPath === currentNotesDir
      ) {
        logger.warn(`Invalid directory selection: ${normalizedPath} (app data directory)`)
        return false
      }

      // Prevent selecting system root directories
      const isSystemRoot =
        process.platform === 'win32'
          ? /^[a-zA-Z]:[\\/]?$/.test(normalizedPath)
          : normalizedPath === '/' ||
            normalizedPath === '/usr' ||
            normalizedPath === '/etc' ||
            normalizedPath === '/System'

      if (isSystemRoot) {
        logger.warn(`Invalid directory selection: ${normalizedPath} (system root directory)`)
        return false
      }

      // Check write permissions
      try {
        fs.accessSync(normalizedPath, fs.constants.W_OK)
      } catch (error) {
        logger.warn(`Directory not writable: ${normalizedPath}`)
        return false
      }

      return true
    } catch (error) {
      logger.error('Failed to validate notes directory:', error as Error)
      return false
    }
  }

  public save = async (
    _: Electron.IpcMainInvokeEvent,
    fileName: string,
    content: string,
    options?: SaveDialogOptions
  ): Promise<string> => {
    try {
      const result: SaveDialogReturnValue = await dialog.showSaveDialog({
        title: t('dialog.save_file'),
        defaultPath: fileName,
        ...options
      })

      if (result.canceled) {
        return Promise.reject(new Error('User canceled the save dialog'))
      }

      if (!result.canceled && result.filePath) {
        await fs.promises.writeFile(result.filePath, content, { encoding: 'utf-8' })
      }

      return result.filePath
    } catch (err: any) {
      logger.error('[IPC - Error] An error occurred saving the file:', err as Error)
      return Promise.reject('An error occurred saving the file: ' + err?.message)
    }
  }

  public saveImage = async (_: Electron.IpcMainInvokeEvent, name: string, data: string): Promise<boolean> => {
    try {
      // 异步对话框：showSaveDialogSync 会阻塞整个主进程消息循环
      const result = await dialog.showSaveDialog({
        defaultPath: `${name}.png`,
        filters: [{ name: t('dialog.png_image'), extensions: ['png'] }]
      })

      if (!result.canceled && result.filePath) {
        const parseResult = parseDataUrl(data)
        await fs.promises.writeFile(result.filePath, parseResult?.data ?? data, 'base64')
        return true
      }
    } catch (error) {
      logger.error('[IPC - Error] An error occurred saving the image:', error as Error)
    }
    return false
  }

  public selectFolder = async (_: Electron.IpcMainInvokeEvent, options: OpenDialogOptions): Promise<string | null> => {
    try {
      const result: OpenDialogReturnValue = await dialog.showOpenDialog({
        title: t('dialog.select_folder'),
        properties: ['openDirectory'],
        ...options
      })

      if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0]
      }

      return null
    } catch (err) {
      logger.error('[IPC - Error] An error occurred selecting the folder:', err as Error)
      return null
    }
  }

  public downloadFile = async (
    _: Electron.IpcMainInvokeEvent,
    url: string,
    isUseContentType?: boolean
  ): Promise<FileMetadata> => {
    try {
      const response = await net.fetch(url)
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      // 尝试从Content-Disposition获取文件名
      const contentDisposition = response.headers.get('Content-Disposition')
      let filename = 'download'

      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="?(.+)"?/i)
        if (filenameMatch) {
          filename = filenameMatch[1]
        }
      }

      // 如果URL中有文件名，使用URL中的文件名
      const urlFilename = url.split('/').pop()?.split('?')[0]
      if (urlFilename && urlFilename.includes('.')) {
        filename = urlFilename
      }

      // 如果文件名没有后缀，根据Content-Type添加后缀
      // 后缀解析收敛到 resolveDownloadedFileName——此前 `isUseContentType` 为真时无条件把
      // Content-Type 推出的后缀**追加**在文件名尾部，"xxx.png" + octet-stream 落成 "xxx.png.bin"、
      // ext=.bin ⇒ FILE_TYPE.OTHER，文件页「图片」里看不到 AI 生成的图（真机取证）。
      const contentType = isUseContentType || !filename.includes('.') ? response.headers.get('Content-Type') : null
      const { fileName, ext } = resolveDownloadedFileName(
        filename,
        this.getExtensionFromMimeType(contentType),
        Boolean(isUseContentType)
      )

      const uuid = uuidv4()
      const destPath = path.join(this.storageDir, uuid + ext)

      // 将响应内容写入文件
      const buffer = Buffer.from(await response.arrayBuffer())
      await fs.promises.writeFile(destPath, buffer)

      const stats = await fs.promises.stat(destPath)
      const fileType = await this.getFileType(destPath)

      return {
        id: uuid,
        origin_name: fileName,
        name: uuid + ext,
        path: destPath,
        created_at: stats.birthtime.toISOString(),
        size: stats.size,
        ext: ext,
        type: fileType,
        count: 1
      }
    } catch (error) {
      logger.error('Download file error:', error as Error)
      throw error
    }
  }

  private getExtensionFromMimeType(mimeType: string | null): string {
    if (!mimeType) return '.bin'

    const mimeToExtension: { [key: string]: string } = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/bmp': '.bmp',
      'application/pdf': '.pdf',
      'text/plain': '.txt',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/zip': '.zip',
      'application/x-zip-compressed': '.zip',
      'application/octet-stream': '.bin'
    }

    return mimeToExtension[mimeType] || '.bin'
  }

  public copyFile = async (_: Electron.IpcMainInvokeEvent, id: string, destPath: string): Promise<void> => {
    try {
      const sourcePath = path.join(this.storageDir, id)

      // 确保目标目录存在
      const destDir = path.dirname(destPath)
      if (!fs.existsSync(destDir)) {
        await fs.promises.mkdir(destDir, { recursive: true })
      }

      // 复制文件
      await fs.promises.copyFile(sourcePath, destPath)
      logger.debug(`File copied successfully: ${sourcePath} to ${destPath}`)
    } catch (error) {
      logger.error('Copy file failed:', error as Error)
      throw error
    }
  }

  public writeFileWithId = async (_: Electron.IpcMainInvokeEvent, id: string, content: string): Promise<void> => {
    try {
      const filePath = path.join(this.storageDir, id)
      logger.debug(`Writing file: ${filePath}`)

      // 确保目录存在
      if (!fs.existsSync(this.storageDir)) {
        logger.debug(`Creating storage directory: ${this.storageDir}`)
        fs.mkdirSync(this.storageDir, { recursive: true })
      }

      await fs.promises.writeFile(filePath, content, 'utf8')
      logger.debug(`File written successfully: ${filePath}`)
    } catch (error) {
      logger.error('Failed to write file:', error as Error)
      throw error
    }
  }

  public startFileWatcher = async (
    event: Electron.IpcMainInvokeEvent,
    dirPath: string,
    config?: FileWatcherConfig
  ): Promise<void> => {
    try {
      this.watcherConfig = { ...DEFAULT_WATCHER_CONFIG, ...config }

      if (!dirPath?.trim()) {
        throw new Error('Directory path is required')
      }

      const normalizedPath = path.resolve(dirPath.trim())

      if (!fs.existsSync(normalizedPath)) {
        throw new Error(`Directory does not exist: ${normalizedPath}`)
      }

      const stats = fs.statSync(normalizedPath)
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${normalizedPath}`)
      }

      if (this.currentWatchPath === normalizedPath && this.watcher) {
        this.watcherSender = event.sender
        logger.debug('Already watching directory, updated sender', { path: normalizedPath })
        return
      }

      await this.stopFileWatcher()

      logger.info('Starting file watcher', {
        path: normalizedPath,
        config: {
          extensions: this.watcherConfig.watchExtensions,
          debounceMs: this.watcherConfig.debounceMs,
          maxDepth: this.watcherConfig.maxDepth
        }
      })

      this.currentWatchPath = normalizedPath
      this.watcherSender = event.sender

      const watchOptions = {
        ignored: this.watcherConfig.ignoredPatterns,
        persistent: true,
        ignoreInitial: true,
        depth: this.watcherConfig.maxDepth,
        usePolling: this.watcherConfig.usePolling,
        awaitWriteFinish: {
          stabilityThreshold: this.watcherConfig.stabilityThreshold,
          pollInterval: 100
        },
        alwaysStat: false,
        atomic: true
      }

      this.watcher = chokidar.watch(normalizedPath, watchOptions)

      const handleChange = this.createChangeHandler()

      this.watcher
        .on('add', (filePath: string) => handleChange('add', filePath))
        .on('unlink', (filePath: string) => handleChange('unlink', filePath))
        .on('addDir', (dirPath: string) => handleChange('addDir', dirPath))
        .on('unlinkDir', (dirPath: string) => handleChange('unlinkDir', dirPath))
        .on('error', (error: unknown) => {
          logger.error('File watcher error', { error: error as Error, path: normalizedPath })
          if (this.watcherConfig.retryOnError) {
            this.handleWatcherError(error as Error)
          }
        })
        .on('ready', () => {
          logger.debug('File watcher ready', { path: normalizedPath })
        })

      logger.info('File watcher started successfully')
    } catch (error) {
      logger.error('Failed to start file watcher', error as Error)
      this.cleanup()
      throw error
    }
  }

  private createChangeHandler() {
    return (eventType: string, filePath: string) => {
      // Skip processing if watcher is paused
      if (this.isPaused) {
        logger.debug('File change ignored (watcher paused)', { eventType, filePath })
        return
      }

      if (!this.shouldWatchFile(filePath, eventType)) {
        return
      }

      logger.debug('File change detected', { eventType, filePath, path: this.currentWatchPath })

      // 对于目录操作，立即触发同步，不使用防抖
      if (eventType === 'addDir' || eventType === 'unlinkDir') {
        logger.debug('Directory operation detected, triggering immediate sync', { eventType, filePath })
        this.notifyChange(eventType, filePath)
        return
      }

      // 对于文件操作，使用防抖机制
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer)
      }

      this.debounceTimer = setTimeout(() => {
        this.notifyChange(eventType, filePath)
        this.debounceTimer = undefined
      }, this.watcherConfig.debounceMs)
    }
  }

  private shouldWatchFile(filePath: string, eventType: string): boolean {
    if (eventType.includes('Dir')) {
      return true
    }

    const ext = path.extname(filePath).toLowerCase()
    return this.watcherConfig.watchExtensions.includes(ext)
  }

  private notifyChange(eventType: string, filePath: string) {
    try {
      if (!this.watcherSender || this.watcherSender.isDestroyed()) {
        logger.warn('Sender destroyed, stopping watcher')
        void this.stopFileWatcher()
        return
      }

      logger.debug('Sending file change event', {
        eventType,
        filePath,
        channel: this.watcherConfig.eventChannel,
        senderExists: !!this.watcherSender,
        senderDestroyed: this.watcherSender.isDestroyed()
      })
      this.watcherSender.send(this.watcherConfig.eventChannel, {
        eventType,
        filePath,
        watchPath: this.currentWatchPath
      })
      logger.debug('File change event sent successfully')
    } catch (error) {
      logger.error('Failed to send notification', error as Error)
    }
  }

  private handleWatcherError(error: Error) {
    const retryableErrors = ['EMFILE', 'ENFILE', 'ENOSPC']
    const isRetryable = retryableErrors.some((code) => error.message.includes(code))

    if (isRetryable && this.currentWatchPath && this.watcherSender && !this.watcherSender.isDestroyed()) {
      logger.warn('Attempting restart due to recoverable error', { error: error.message })

      setTimeout(async () => {
        try {
          if (this.currentWatchPath && this.watcherSender && !this.watcherSender.isDestroyed()) {
            const mockEvent = { sender: this.watcherSender } as Electron.IpcMainInvokeEvent
            await this.startFileWatcher(mockEvent, this.currentWatchPath, this.watcherConfig)
          }
        } catch (retryError) {
          logger.error('Restart failed', retryError as Error)
        }
      }, this.watcherConfig.retryDelayMs)
    }
  }

  private cleanup() {
    this.currentWatchPath = undefined
    this.watcherSender = undefined
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
    }
  }

  public stopFileWatcher = async (): Promise<void> => {
    try {
      if (this.watcher) {
        logger.info('Stopping file watcher', { path: this.currentWatchPath })
        await this.watcher.close()
        this.watcher = undefined
        logger.debug('File watcher stopped')
      }
      this.cleanup()
    } catch (error) {
      logger.error('Failed to stop file watcher', error as Error)
      this.watcher = undefined
      this.cleanup()
    }
  }

  public getWatcherStatus(): { isActive: boolean; watchPath?: string; hasValidSender: boolean } {
    return {
      isActive: !!this.watcher,
      watchPath: this.currentWatchPath,
      hasValidSender: !!this.watcherSender && !this.watcherSender.isDestroyed()
    }
  }

  public getFilePathById(file: FileMetadata): string {
    return path.join(this.storageDir, file.id + file.ext)
  }

  public isTextFile = async (_: Electron.IpcMainInvokeEvent, filePath: string): Promise<boolean> => {
    return this._isTextFile(filePath)
  }

  private _isTextFile = async (filePath: string): Promise<boolean> => {
    try {
      const isBinary = await isBinaryFile(filePath)
      if (isBinary) {
        return false
      }

      const length = 8 * KB
      const fileHandle = await fs.promises.open(filePath, 'r')
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await fileHandle.read(buffer, 0, length, 0)
      await fileHandle.close()

      const sampleBuffer = buffer.subarray(0, bytesRead)
      const matches = chardet.analyse(sampleBuffer)

      // 如果检测到的编码置信度较高，认为是文本文件
      if (matches.length > 0 && matches[0].confidence > 0.8) {
        return true
      }

      return false
    } catch (error) {
      logger.error('Failed to check if file is text:', error as Error)
      return false
    }
  }

  public isDirectory = async (_: Electron.IpcMainInvokeEvent, filePath: string): Promise<boolean> => {
    try {
      const stat = await fs.promises.stat(filePath)
      return stat.isDirectory()
    } catch {
      return false
    }
  }

  public showInFolder = async (_: Electron.IpcMainInvokeEvent, path: string): Promise<void> => {
    if (!fs.existsSync(path)) {
      const msg = `File or folder does not exist: ${path}`
      logger.error(msg)
      throw new Error(msg)
    }
    try {
      shell.showItemInFolder(path)
    } catch (error) {
      logger.error('Failed to show item in folder:', error as Error)
    }
  }

  /**
   * Batch upload markdown files from native File objects
   * This handles all I/O operations in the Main process to avoid blocking Renderer
   */
  public batchUploadMarkdownFiles = async (
    _: Electron.IpcMainInvokeEvent,
    filePaths: string[],
    targetPath: string
  ): Promise<{
    fileCount: number
    folderCount: number
    skippedFiles: number
  }> => {
    try {
      logger.info('Starting batch upload', { fileCount: filePaths.length, targetPath })

      const basePath = path.resolve(targetPath)
      const MARKDOWN_EXTS = ['.md', '.markdown']

      // Filter markdown files
      const markdownFiles = filePaths.filter((filePath) => {
        const ext = path.extname(filePath).toLowerCase()
        return MARKDOWN_EXTS.includes(ext)
      })

      const skippedFiles = filePaths.length - markdownFiles.length

      if (markdownFiles.length === 0) {
        return { fileCount: 0, folderCount: 0, skippedFiles }
      }

      // Collect unique folders needed
      const foldersSet = new Set<string>()

      // 并行准备文件操作（fileNameGuard 只读文件系统，无顺序依赖）
      const prepared = await Promise.all(
        markdownFiles.map(async (filePath) => {
          try {
            // Get relative path if file is from a directory upload
            const fileName = path.basename(filePath)
            const relativePath = path.dirname(filePath)

            // Determine target directory structure
            let targetDir = basePath
            const folderParts: string[] = []

            // Extract folder structure from file path for nested uploads
            // This is a simplified version - in real scenario we'd need the original directory structure
            if (relativePath && relativePath !== '.') {
              const parts = relativePath.split(path.sep)
              // Get the last few parts that represent the folder structure within upload
              const relevantParts = parts.slice(Math.max(0, parts.length - 3))
              folderParts.push(...relevantParts)
            }

            // Build target directory path
            for (const part of folderParts) {
              targetDir = path.join(targetDir, part)
              foldersSet.add(targetDir)
            }

            // Determine final file name
            const nameWithoutExt = fileName.endsWith('.md')
              ? fileName.slice(0, -3)
              : fileName.endsWith('.markdown')
                ? fileName.slice(0, -9)
                : fileName

            const { safeName } = await this.fileNameGuard(_, targetDir, nameWithoutExt, true)
            const finalPath = path.join(targetDir, safeName + '.md')

            return { sourcePath: filePath, targetPath: finalPath }
          } catch (error) {
            logger.error('Failed to prepare file operation:', error as Error, { filePath })
            return null
          }
        })
      )
      const fileOperations = prepared.filter((op): op is { sourcePath: string; targetPath: string } => op !== null)

      // 递归 mkdir 幂等且自建中间层：一次调用确保整条目录链，无需逐层 existsSync 预检
      await Promise.all(
        Array.from(foldersSet).map((folder) =>
          fs.promises
            .mkdir(folder, { recursive: true })
            .catch((error) => logger.debug('Folder creation failed', { folder, error: (error as Error).message }))
        )
      )

      // Process files in batches
      const BATCH_SIZE = 10 // Higher batch size since we're in Main process
      let successCount = 0

      for (let i = 0; i < fileOperations.length; i += BATCH_SIZE) {
        const batch = fileOperations.slice(i, i + BATCH_SIZE)

        const results = await Promise.allSettled(
          batch.map(async (op) => {
            // Read from source and write to target in Main process
            const content = await fs.promises.readFile(op.sourcePath, 'utf-8')
            await fs.promises.writeFile(op.targetPath, content, 'utf-8')
            return true
          })
        )

        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            successCount++
          } else {
            logger.error('Failed to upload file:', result.reason, {
              file: batch[index].sourcePath
            })
          }
        })
      }

      logger.info('Batch upload completed', {
        successCount,
        folderCount: foldersSet.size,
        skippedFiles
      })

      return {
        fileCount: successCount,
        folderCount: foldersSet.size,
        skippedFiles
      }
    } catch (error) {
      logger.error('Batch upload failed:', error as Error)
      throw error
    }
  }

  /**
   * Pause file watcher to prevent events during batch operations
   */
  public pauseFileWatcher = async (): Promise<void> => {
    if (this.watcher) {
      logger.debug('Pausing file watcher')
      this.isPaused = true
      // Clear any pending debounced notifications
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer)
        this.debounceTimer = undefined
      }
    }
  }

  /**
   * Resume file watcher and trigger a refresh
   */
  public resumeFileWatcher = async (): Promise<void> => {
    if (this.watcher && this.currentWatchPath) {
      logger.debug('Resuming file watcher')
      this.isPaused = false
      // Send a synthetic refresh event to trigger tree reload
      this.notifyChange('refresh', this.currentWatchPath)
    }
  }
}

export const fileStorage = new FileStorage()

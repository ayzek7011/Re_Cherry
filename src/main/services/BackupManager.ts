/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
import type { Stats } from 'node:fs'

import { loggerService } from '@logger'
import { t } from '@main/utils/locales'
import { IpcChannel } from '@shared/IpcChannel'
import type { WebDavConfig } from '@types'
import archiver from 'archiver'
import { app, dialog } from 'electron'
import * as fs from 'fs-extra'
import StreamZip from 'node-stream-zip'
import * as path from 'path'
import type { CreateDirectoryOptions, FileStat } from 'webdav'

import { getDataPath } from '../utils'
import { isPathInside, resolveAndValidatePath } from '../utils/file'
import { providerKeyStore } from './ProviderKeyStore'
import WebDav from './WebDav'
import { windowService } from './WindowService'

const logger = loggerService.withContext('BackupManager')

interface CopyDirOptions {
  dereferenceSymlinks: boolean
  sourceRootRealPath?: string
}

interface EffectiveEntryStats {
  isSymlink: boolean
  stats: Stats
}

interface ProgressData {
  stage: string
  progress: number
  total: number
}

/**
 * WebDAV 两条路径此前绕开了本地侧的 `resolveAndValidatePath`，
 * 直接把渲染层给的 `webdavConfig.fileName` 交给 `path.join(this.backupDir, filename)`
 * 与 `webdavClient.putFileContents(filename, ...)`。`fileName = '../../../Documents/x.zip'`
 * 可让写盘/读出落在 `backupDir` 之外（`restoreFromWebdav` 会**覆盖**目标路径）。
 *
 * 这里把远端文件名收敛成"bucket 内的相对路径"：非空、非绝对、不含 `..` 段、不含 NUL。
 * 其余（分隔符）保留——允许 `sub/dir/file.zip` 这类远端子目录是合理用法，本地侧再用
 * `resolveAndValidatePath` 兜住根目录。
 */
export function assertSafeRemoteBackupFileName(fileName: string): string {
  const candidate = fileName.trim()
  const reject = (reason: string): never => {
    throw new Error(`Invalid WebDAV backup file name: ${reason}`)
  }
  if (candidate.length === 0) reject('it is empty')
  if (candidate.includes('\0')) reject('it contains a NUL byte')
  if (path.isAbsolute(candidate) || /^[a-zA-Z]:[\\/]/.test(candidate)) reject('it is an absolute path')
  if (candidate.split(/[\\/]/).includes('..')) reject('it contains a parent-directory segment ("..")')
  return candidate
}

class BackupManager {
  /**
   * 「重置数据」要一并清空的 userData 根条目（补齐）。
   * 它们都不在 `Data/` 目录里，所以原来会整体存活：`provider-keys.json`＝provider key 的加密真源
   * （`ProviderKeyStore`，safeStorage 密文）、`config.json`＝应用配置（`ConfigManager` 的 electron-store
   * 默认名）、`kernel/`＝内核会话库 `sessions.db`、话题注册表 `topics.json`、pi-ai 路由 `settings.json`、
   * 附件。用户裁决："你把这些也纳入重置范围不就完了"。
   */
  private static readonly RESET_ROOT_ENTRIES = ['kernel', 'provider-keys.json', 'config.json'] as const

  /**
   * 每次备份/还原调用的**独占**临时根。
   *
   * 此前 `tempDir` 是实例字段（`.../backup/temp`），`backup()` 结尾
   * `fs.remove(this.tempDir)`、`restore()` 开头 `ensureDir(this.tempDir)` 共用同一目录，
   * 主进程侧没有任何互斥。渲染层两个入口（设置页「备份」/「还原」、WebDAV 定时备份）在一次
   * 长拷贝未结束时触发另一次，第二次的 `ensureDir`/`remove` 会把第一次正在拷贝的中间目录删掉
   * 或混进自己的归档——产出「内容错误但校验通过」的坏 zip，或让还原读到半成品。
   * 改成每次调用 `mkdtemp` 一个独占子目录：并发调用之间不再共享任何路径（主修复）。
   */
  private tempRoot = path.join(app.getPath('temp'), 'cherry-studio', 'backup', 'temp')
  private backupDir = path.join(app.getPath('temp'), 'cherry-studio', 'backup')

  private async createTempDir(): Promise<string> {
    await fs.ensureDir(this.tempRoot)
    return await fs.mkdtemp(path.join(this.tempRoot, 'run-'))
  }

  // Cached instance to avoid recreating
  private webdavInstance: WebDav | null = null

  private cachedWebdavConnectionConfig: {
    webdavHost: string
    webdavUser?: string
    webdavPass?: string
    webdavPath?: string
  } | null = null

  /**
   * Handle backup restoration on app startup
   * Called after window is created but before renderer is loaded
   *
   * 目录还原顺序（修复）：**先挪开旧目录 → 再放入新目录 → 成功后才删旧目录**。
   * 旧实现是「先 remove(旧) 再 rename(新)」，而 Windows 上 `kernel/sessions.db` 可能仍被上一进程
   * 或杀软持有——remove 成功、rename 失败时旧数据已删、`.restore` 又被 catch 清掉，用户两份都没有。
   * 本实现任一步失败都把旧目录改回原名，并保留 `.restore` 供下次启动重试。
   */
  private static async restoreDirectory(staged: string, dest: string): Promise<void> {
    const aside = `${dest}.pre-restore-${Date.now()}`
    const destExists = await fs.pathExists(dest)
    if (destExists) {
      // 失败即上抛：目标未动，.restore 仍在（下次启动重试）
      await fs.rename(dest, aside)
    }
    try {
      await fs.rename(staged, dest)
    } catch (error) {
      if (destExists) {
        await fs.rename(aside, dest).catch((rollbackError) => {
          logger.error(`[handleStartupRestore] failed to roll back ${dest}:`, rollbackError as Error)
        })
      }
      throw error
    }
    if (destExists) {
      await fs.remove(aside).catch(() => {})
    }
  }

  /**
   * 带瞬时锁重试的目录拷贝。应用运行中拷 Chromium 的 LevelDB 目录时，杀软扫描或
   * compaction 可能瞬时持有某个文件（Windows 上表现为 EBUSY/EPERM）——这类锁是
   * 短持的，一次短退避重试即可消掉大多数偶发"备份失败"。非瞬时错误（ENOENT 等）直接上抛。
   * 注意：这不解决"运行中拷贝的一致性"问题（见 docs/limits-and-baseline.md 的有意保留段）。
   */
  private static async copyDirWithTransientRetry(source: string, dest: string, attempts = 2): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await fs.copy(source, dest)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        const transient = code === 'EBUSY' || code === 'EPERM'
        if (!transient || attempt === attempts) {
          throw error
        }
        logger.warn(
          `[backupDirect] copy of ${source} hit a transient lock (${code}), retrying (${attempt}/${attempts - 1} retries left)`
        )
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
  }

  static async handleStartupRestore(): Promise<void> {
    const userDataPath = app.getPath('userData')

    // Define restore paths
    const indexedDBRestore = path.join(userDataPath, 'IndexedDB.restore')
    const localStorageRestore = path.join(userDataPath, 'Local Storage.restore')
    const dataRestore = getDataPath() + '.restore'

    // Define target paths
    const indexedDBDest = path.join(userDataPath, 'IndexedDB')
    const localStorageDest = path.join(userDataPath, 'Local Storage')
    const dataDest = getDataPath()

    // 重置时 userData 根下这几样也要清（详见 RESET_ROOT_ENTRIES 的说明）
    const pendingRootEntries: Array<{ name: string; staged: string; dest: string }> = []
    for (const name of BackupManager.RESET_ROOT_ENTRIES) {
      const staged = path.join(userDataPath, `${name}.restore`)
      if (await fs.pathExists(staged)) {
        pendingRootEntries.push({ name, staged, dest: path.join(userDataPath, name) })
      }
    }

    try {
      // Check if any restore markers exist
      const hasIndexedDBRestore = await fs.pathExists(indexedDBRestore)
      const hasLocalStorageRestore = await fs.pathExists(localStorageRestore)
      const hasDataRestore = await fs.pathExists(dataRestore)

      if (!hasIndexedDBRestore && !hasLocalStorageRestore && !hasDataRestore && pendingRootEntries.length === 0) {
        return
      }

      // Restore IndexedDB
      if (hasIndexedDBRestore) {
        logger.info('[handleStartupRestore] Found IndexedDB.restore directories, completing restoration...')
        await BackupManager.restoreDirectory(indexedDBRestore, indexedDBDest)
      }

      // Restore Local Storage
      if (hasLocalStorageRestore) {
        logger.info('[handleStartupRestore] Found Local Storage.restore directories, completing restoration...')
        await BackupManager.restoreDirectory(localStorageRestore, localStorageDest)
      }

      // Restore Data
      if (hasDataRestore) {
        logger.info('[handleStartupRestore] Found Local Data.restore directories, completing restoration...')
        await BackupManager.restoreDirectory(dataRestore, dataDest)
      }

      // Restore userData 根目录下的重置目标（内核数据 / provider key / 应用配置）
      // 逐条独立处理：某一条失败（如 kernel/sessions.db 仍被占）不影响其余条目，
      // 也不清掉失败条目的 `.restore`——保留它供下次启动重试。
      for (const entry of pendingRootEntries) {
        try {
          logger.info(`[handleStartupRestore] Found ${entry.name}.restore, completing restoration...`)
          await BackupManager.restoreDirectory(entry.staged, entry.dest)
        } catch (error) {
          logger.error(
            `[handleStartupRestore] Failed to reset ${entry.name}; kept ${entry.name}.restore for the next start:`,
            error as Error
          )
        }
      }

      logger.info('[handleStartupRestore] Restoration completed successfully')
    } catch (error) {
      logger.error('[handleStartupRestore] Failed to complete restoration:', error as Error)
      // 有意不清 `.restore`：还原失败时它们是用户数据的唯一副本，
      // 保留让下次启动重试；清掉才会造成"原库已删、备份已清"的双失。
      logger.warn('[handleStartupRestore] .restore directories were kept for a retry on the next start')
      // 用户可见信号：还原失败时应用会带着"旧数据"继续运行，用户会误以为还原成功。
      // 这里用原生对话框告知（不 await，不阻塞启动序列）。
      void dialog
        .showMessageBox({
          type: 'warning',
          title: t('backup.restore_pending.title'),
          message: t('backup.restore_pending.message'),
          buttons: [t('common.confirm')],
          defaultId: 0,
          noLink: true
        })
        .catch((dialogError) => {
          logger.warn('[handleStartupRestore] failed to show the restore-pending dialog:', dialogError as Error)
        })
    }
  }

  /**
   * Backup metadata for direct backup format (version 6+)
   */
  private createDirectBackupMetadata(): {
    version: number
    timestamp: number
    appName: string
    appVersion: string
    platform: string
    arch: string
  } {
    return {
      version: 6,
      timestamp: Date.now(),
      appName: 'Re_Cherry',
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch
    }
  }

  /**
   * Direct backup method - copies IndexedDB and Local Storage directories directly.
   * No JSON serialization, better performance for large databases.
   * @param _ - Electron IPC event
   * @param fileName - Name of the backup file
   * @param destinationPath - Path to save the backup (defaults to this.backupDir)
   * @param skipBackupFile - Whether to skip backing up the Data directory
   * @returns Path to the created backup file
   */
  async backup(
    _: Electron.IpcMainInvokeEvent,
    fileName: string,
    destinationPath: string = this.backupDir,
    skipBackupFile: boolean = false
  ): Promise<string> {
    const onProgress = this.onProgress(IpcChannel.BackupProgress, true)
    // 本次调用独占的暂存目录（并发备份/还原互不共享路径）。
    const tempDir = await this.createTempDir()

    try {
      onProgress({ stage: 'preparing', progress: 0, total: 100 })

      const userDataPath = app.getPath('userData')
      let currentProgress = 10

      // Step 2: Copy IndexedDB and Local Storage directories
      onProgress({ stage: 'copying_database', progress: 15, total: 100 })
      logger.debug('[backupDirect] Copying database directories...')

      const indexedDBSource = path.join(userDataPath, 'IndexedDB')
      const indexedDBDest = path.join(tempDir, 'IndexedDB')
      if (await fs.pathExists(indexedDBSource)) {
        await BackupManager.copyDirWithTransientRetry(indexedDBSource, indexedDBDest)
      } else {
        logger.debug('[backupDirect] IndexedDB directory not found, skipping')
      }

      const localStorageSource = path.join(userDataPath, 'Local Storage')
      const localStorageDest = path.join(tempDir, 'Local Storage')
      if (await fs.pathExists(localStorageSource)) {
        await BackupManager.copyDirWithTransientRetry(localStorageSource, localStorageDest)
      } else {
        logger.debug('[backupDirect] Local Storage directory not found, skipping')
      }

      currentProgress = 50
      onProgress({ stage: 'copying_database', progress: currentProgress, total: 100 })

      // Step 3: Write metadata.json
      const metadata = this.createDirectBackupMetadata()
      await fs.writeJson(path.join(tempDir, 'metadata.json'), metadata, { spaces: 2 })
      onProgress({ stage: 'copying_database', progress: 52, total: 100 })

      // Step 4: Copy Data directory (if not skipped)
      if (!skipBackupFile) {
        const sourcePath = path.join(userDataPath, 'Data')
        const tempDataDir = path.join(tempDir, 'Data')

        if (await fs.pathExists(sourcePath)) {
          const totalSize = await this.getDirSize(sourcePath, { dereferenceSymlinks: true })

          await this.copyDirWithProgress(
            sourcePath,
            tempDataDir,
            this.createCopyProgressHandler(totalSize, 52, 80, 'copying_files', onProgress),
            { dereferenceSymlinks: true }
          )
        }
      } else {
        // skipBackupFile：不打 Data 空壳进归档。还原侧（restoreDirect/restoreLegacy）
        // 按「Data 目录存在且非空」判定是否还原，空壳与缺失等价；空壳只会误导
        // 解包者以为文件数据已包含在备份里。
        logger.debug('[backupDirect] Skip the backup of the file')
      }

      // provider key 随备份流转（明文允许出现在低频迁移产物；恢复时经 main 加密写回）
      const vaultKeys = providerKeyStore.getAll()
      if (Object.keys(vaultKeys).length > 0) {
        await fs.writeJson(path.join(tempDir, 'provider-keys.json'), vaultKeys)
      }

      onProgress({ stage: 'compressing', progress: 80, total: 100 })

      // Step 5: Create ZIP archive
      // 落点统一过 resolveAndValidatePath（本地/WebDAV 两套入口
      // 此前口径不一致——本地还原侧已有校验，写盘侧没有）。
      const backupedFilePath = resolveAndValidatePath(destinationPath, fileName)
      const output = fs.createWriteStream(backupedFilePath)
      const archive = archiver('zip', {
        zlib: { level: 1 }, // Use lowest compression level for speed (same as legacy backup)
        zip64: true
      })

      await new Promise<void>((resolve, reject) => {
        output.on('close', () => resolve())
        archive.on('error', reject)
        archive.on('warning', (err: any) => {
          if (err.code !== 'ENOENT') {
            logger.warn('[backupDirect] Archive warning:', err)
          }
        })
        archive.pipe(output)
        archive.directory(tempDir, false)
        archive.finalize()
      })

      // Clean up temp directory
      await fs.remove(tempDir)
      onProgress({ stage: 'completed', progress: 100, total: 100 })

      logger.info('[backupDirect] Backup completed successfully')
      return backupedFilePath
    } catch (error) {
      logger.error('[backupDirect] Backup failed:', error as Error)
      await fs.remove(tempDir).catch(() => {})

      throw error
    }
  }

  /**
   * Legacy backup method (JSON format, used by LanTransfer)
   * Creates a backup in the old format with data.json and optional Data directory.
   * @param _ - Electron IPC event
   * @param fileName - Name of the backup file
   * @param data - JSON string data to backup
   * @param destinationPath - Path to save the backup (defaults to this.backupDir)
   * @param skipBackupFile - Whether to skip backing up the Data directory
   * @returns Path to the created backup file
   */
  async backupLegacy(
    _: Electron.IpcMainInvokeEvent,
    fileName: string,
    data: string,
    destinationPath: string = this.backupDir,
    skipBackupFile: boolean = false
  ): Promise<string> {
    const onProgress = this.onProgress(IpcChannel.BackupProgress, true)
    // 独占暂存目录。
    const tempDir = await this.createTempDir()

    try {
      onProgress({ stage: 'preparing', progress: 0, total: 100 })

      // Write data.json using streaming
      const tempDataPath = path.join(tempDir, 'data.json')

      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(tempDataPath)
        writeStream.write(data)
        writeStream.end()

        writeStream.on('finish', () => resolve())
        writeStream.on('error', (error) => reject(error))
      })

      onProgress({ stage: 'writing_data', progress: 20, total: 100 })

      logger.debug(`BackupManager IPC, skipBackupFile: ${skipBackupFile}`)

      if (!skipBackupFile) {
        // Copy Data directory to temp directory
        const sourcePath = path.join(app.getPath('userData'), 'Data')
        const tempDataDir = path.join(tempDir, 'Data')

        // Get total size of source directory
        const totalSize = await this.getDirSize(sourcePath, { dereferenceSymlinks: true })

        // Use streaming copy
        await this.copyDirWithProgress(
          sourcePath,
          tempDataDir,
          this.createCopyProgressHandler(totalSize, 0, 50, 'copying_files', onProgress),
          { dereferenceSymlinks: true }
        )

        onProgress({ stage: 'preparing_compression', progress: 50, total: 100 })
      } else {
        logger.debug('Skip the backup of the file')
        await fs.promises.mkdir(path.join(tempDir, 'Data')) // Creating empty Data dir is required, otherwise restore will fail
      }

      // Create output file stream
      // 同 backupDirect，落点过 resolveAndValidatePath。
      const backupedFilePath = resolveAndValidatePath(destinationPath, fileName)
      const output = fs.createWriteStream(backupedFilePath)

      // Create archiver instance, enable ZIP64 support
      const archive = archiver('zip', {
        zlib: { level: 1 }, // Use lowest compression level for speed
        zip64: true // Enable ZIP64 support for large files
      })

      let lastProgress = 50
      let totalEntries = 0
      let processedEntries = 0
      let totalBytes = 0
      let processedBytes = 0

      // First calculate total files and size, but don't log details
      const calculateTotals = async (dirPath: string) => {
        try {
          const items = await fs.readdir(dirPath, { withFileTypes: true })
          for (const item of items) {
            const fullPath = path.join(dirPath, item.name)
            if (item.isDirectory()) {
              await calculateTotals(fullPath)
            } else {
              totalEntries++
              const stats = await fs.stat(fullPath)
              totalBytes += stats.size
            }
          }
        } catch (error) {
          // Only log on error
          logger.error('[BackupManager] Error calculating totals:', error as Error)
        }
      }

      await calculateTotals(tempDir)

      // Listen for file entry events
      archive.on('entry', () => {
        processedEntries++
        if (totalEntries > 0) {
          const progressPercent = Math.min(55, 50 + Math.floor((processedEntries / totalEntries) * 5))
          if (progressPercent > lastProgress) {
            lastProgress = progressPercent
            onProgress({ stage: 'compressing', progress: progressPercent, total: 100 })
          }
        }
      })

      // Listen for data write events
      archive.on('data', (chunk) => {
        processedBytes += chunk.length
        if (totalBytes > 0) {
          const progressPercent = Math.min(99, 55 + Math.floor((processedBytes / totalBytes) * 44))
          if (progressPercent > lastProgress) {
            lastProgress = progressPercent
            onProgress({ stage: 'compressing', progress: progressPercent, total: 100 })
          }
        }
      })

      // Use Promise to wait for compression to complete
      await new Promise<void>((resolve, reject) => {
        output.on('close', () => {
          onProgress({ stage: 'compressing', progress: 100, total: 100 })
          resolve()
        })
        archive.on('error', reject)
        archive.on('warning', (err: any) => {
          if (err.code !== 'ENOENT') {
            logger.warn('[BackupManager] Archive warning:', err)
          }
        })

        // Pipe output stream to archiver
        archive.pipe(output)

        // Add entire temp directory to archive
        archive.directory(tempDir, false)

        // Finalize compression
        archive.finalize()
      })

      // Clean up temp directory
      await fs.remove(tempDir)
      onProgress({ stage: 'completed', progress: 100, total: 100 })

      logger.info('Backup completed successfully')
      return backupedFilePath
    } catch (error) {
      logger.error('[BackupManager] Backup failed:', error as Error)
      // Ensure temp directory is cleaned up
      await fs.remove(tempDir).catch(() => {})
      throw error
    }
  }

  /**
   * Direct backup to local directory
   * Creates a backup and saves it to a local directory.
   * @param _ - Electron IPC event
   * @param fileName - Name of the backup file
   * @param localConfig - Local backup configuration (directory path and options)
   * @returns Path to the created backup file
   */
  async backupToLocalDir(
    _: Electron.IpcMainInvokeEvent,
    fileName: string,
    localConfig: { localBackupDir?: string; skipBackupFile?: boolean }
  ) {
    try {
      const backupDir = localConfig.localBackupDir || this.backupDir
      await fs.ensureDir(backupDir)
      return await this.backup(_, fileName, backupDir, localConfig.skipBackupFile)
    } catch (error) {
      logger.error('[backupToLocalDir] Local backup failed:', error as Error)
      throw error
    }
  }

  /**
   * Direct backup to WebDAV
   * Creates a backup and uploads it to a WebDAV server.
   * @param _ - Electron IPC event
   * @param webdavConfig - WebDAV configuration including server URL, credentials, and options
   * @returns Result from WebDAV upload operation
   */
  async backupToWebdav(_: Electron.IpcMainInvokeEvent, webdavConfig: WebDavConfig) {
    // 远端文件名先过结构化断言（本地落盘侧再由 backup() 内的
    // resolveAndValidatePath 兜住根目录），非法即明确报错而不是写到 backupDir 之外。
    const filename = assertSafeRemoteBackupFileName(webdavConfig.fileName || 'cherry-studio.backup.zip')
    const backupedFilePath = await this.backup(_, filename, undefined, webdavConfig.skipBackupFile)
    const webdavClient = this.getWebDavInstance(webdavConfig)
    try {
      let result
      if (webdavConfig.disableStream) {
        const fileContent = await fs.readFile(backupedFilePath)
        result = await webdavClient.putFileContents(filename, fileContent, { overwrite: true })
      } else {
        const contentLength = (await fs.stat(backupedFilePath)).size
        result = await webdavClient.putFileContents(filename, fs.createReadStream(backupedFilePath), {
          overwrite: true,
          contentLength
        })
      }
      await fs.remove(backupedFilePath)
      return result
    } catch (error) {
      await fs.remove(backupedFilePath).catch(() => {})
      throw error
    }
  }

  /**
   * Direct backup to S3
   * Creates a backup and uploads it to an S3-compatible storage.
   * @param _ - Electron IPC event
   * @param s3Config - S3 configuration including endpoint, bucket, credentials, and options
   * @returns Result from S3 upload operation
   */

  async restore(_: Electron.IpcMainInvokeEvent, backupPath: string): Promise<string | void> {
    const onProgress = this.onProgress(IpcChannel.RestoreProgress, true)
    // 独占暂存目录，解包结果交给 restoreDirect/restoreLegacy 使用（原来经实例字段传递）。
    const tempDir = await this.createTempDir()

    try {
      onProgress({ stage: 'preparing', progress: 0, total: 100 })

      logger.debug(`step 1: unzip backup file: ${tempDir}`)

      const zip = new StreamZip.async({ file: backupPath })
      onProgress({ stage: 'extracting', progress: 15, total: 100 })
      await zip.extract(null, tempDir)
      onProgress({ stage: 'extracted', progress: 20, total: 100 })

      // Check for backup type: direct (version 6+) or legacy (version <= 5)
      const metadataPath = path.join(tempDir, 'metadata.json')
      const isDirectBackup = await fs.pathExists(metadataPath)

      if (isDirectBackup) {
        // Direct backup format (version 6+)
        logger.debug('Detected direct backup format (version 6+)')
        // Note: tempDir is NOT cleaned up here - restoreDirect will use and clean it
        await this.restoreDirect(tempDir)
        // Direct restore doesn't return data - app needs to relaunch
        return
      }

      // Legacy backup format (version <= 5)
      logger.debug('Detected legacy backup format (version <= 5)')

      const data = await this.restoreLegacy(tempDir)

      return data
    } catch (error) {
      logger.error('Restore failed:', error as Error)
      await fs.remove(tempDir).catch(() => {})
      throw error
    }
  }

  /**
   * Restore from direct backup format (version 6+).
   * Writes to `*.restore` directories; `handleStartupRestore` performs the atomic
   * swap on next launch, before any DB connection or window opens. Avoids
   * overwriting live IndexedDB / libsql files (issue #14774).
   */
  private async restoreDirect(tempDir: string): Promise<void> {
    const onProgress = this.onProgress(IpcChannel.RestoreProgress, true)

    const userDataPath = app.getPath('userData')
    const indexedDBDest = path.join(userDataPath, 'IndexedDB.restore')
    const localStorageDest = path.join(userDataPath, 'Local Storage.restore')
    const dataDest = path.join(userDataPath, 'Data.restore')

    try {
      // Read and validate metadata
      const metadataPath = path.join(tempDir, 'metadata.json')
      const metadata = await fs.readJson(metadataPath)

      // Validate appName to ensure backup is from Re_Cherry
      if (metadata.appName !== 'Re_Cherry') {
        throw new Error('This backup file is not from Re_Cherry and cannot be restored')
      }

      // Warn about cross-platform restore
      if (metadata.platform && metadata.platform !== process.platform) {
        logger.warn(
          `[restoreDirect] Cross-platform restore: backup from ${metadata.platform}, current is ${process.platform}`
        )
      }

      onProgress({ stage: 'validating', progress: 25, total: 100 })

      onProgress({ stage: 'restoring_database', progress: 30, total: 100 })

      // IndexedDB & Local Storage Path
      const indexedDBSource = path.join(tempDir, 'IndexedDB')
      const localStorageSource = path.join(tempDir, 'Local Storage')

      logger.debug('[restoreDirect] Staging database directories...')

      if (await fs.pathExists(indexedDBSource)) {
        await fs.remove(indexedDBDest).catch(() => {})
        await fs.copy(indexedDBSource, indexedDBDest)
      }

      if (await fs.pathExists(localStorageSource)) {
        await fs.remove(localStorageDest).catch(() => {})
        await fs.copy(localStorageSource, localStorageDest)
      }

      onProgress({ stage: 'restoring_database', progress: 65, total: 100 })

      //  Restore Data directory
      const dataSource = path.join(tempDir, 'Data')
      const dataExists = await fs.pathExists(dataSource)
      const dataFiles = dataExists ? await fs.readdir(dataSource) : []

      if (dataExists && dataFiles.length > 0) {
        logger.debug('[restoreDirect] Staging Data directory...')

        const totalSize = await this.getDirSize(dataSource, { dereferenceSymlinks: false })

        await fs.remove(dataDest).catch(() => {})

        await this.copyDirWithProgress(
          dataSource,
          dataDest,
          this.createCopyProgressHandler(totalSize, 65, 95, 'restoring_data', onProgress),
          { dereferenceSymlinks: false }
        )
      } else {
        logger.debug('[restoreDirect] No Data directory to restore')
      }

      // 恢复备份中的 provider key（明文经 main 加密写回 provider-keys.json，重启后 回填即生效）
      const vaultSource = path.join(tempDir, 'provider-keys.json')
      if (await fs.pathExists(vaultSource)) {
        try {
          const entries = (await fs.readJson(vaultSource)) as Record<string, string>
          if (entries && typeof entries === 'object') {
            providerKeyStore.setMany(entries)
            logger.info('[restoreDirect] Provider keys restored into encrypted store')
          }
        } catch (error) {
          logger.error('[restoreDirect] Failed to restore provider keys', error as Error)
        }
      }

      // Clean up
      await fs.remove(tempDir)
      onProgress({ stage: 'completed', progress: 100, total: 100 })

      logger.info('[restoreDirect] Restore staged successfully, relaunching app to apply...')

      // 与 ipc.ts 的 relaunch 处理器同理——runner 的 node 语义已按子进程注入
      // （dsh-subprocess-local 补丁），内核不再设 ambient 变量；此剥除保留为对外部
      // 环境同名变量的防御，否则重启后应用会以 node 而非 Electron 启动。
      delete process.env.ELECTRON_RUN_AS_NODE

      app.relaunch()
      app.exit(0)
    } catch (error) {
      logger.error('[restoreDirect] Restore failed:', error as Error)
      await Promise.all([
        fs.remove(tempDir).catch(() => {}),
        fs.remove(indexedDBDest).catch(() => {}),
        fs.remove(localStorageDest).catch(() => {}),
        fs.remove(dataDest).catch(() => {})
      ])
      throw error
    }
  }

  /**
   * Restore from legacy backup format (version <= 5)
   * Restores data from data.json and Data directory.
   * @param onProgress - Callback function to report restore progress
   * @returns The data string read from data.json
   */
  private async restoreLegacy(tempDir: string): Promise<string> {
    const onProgress = this.onProgress(IpcChannel.RestoreProgress, false)

    try {
      logger.debug('[restoreLegacy] read data.json')

      // Read data.json
      const dataPath = path.join(tempDir, 'data.json')
      const data = await fs.readFile(dataPath, 'utf-8')
      onProgress({ stage: 'reading_data', progress: 35, total: 100 })

      logger.debug('[restoreLegacy] restore Data directory')

      const userDataPath = app.getPath('userData')
      const dataSourcePath = path.join(tempDir, 'Data')
      const dataDestPath = path.join(userDataPath, 'Data.restore')

      const dataExists = await fs.pathExists(dataSourcePath)
      const dataFiles = dataExists ? await fs.readdir(dataSourcePath) : []

      if (dataExists && dataFiles.length > 0) {
        // Get total size of source directory
        const dataTotalSize = await this.getDirSize(dataSourcePath, { dereferenceSymlinks: false })

        await fs.remove(dataDestPath).catch(() => {})

        // Use streaming copy
        await this.copyDirWithProgress(
          dataSourcePath,
          dataDestPath,
          this.createCopyProgressHandler(dataTotalSize, 35, 85, 'copying_files', onProgress),
          { dereferenceSymlinks: false }
        )
      } else {
        logger.debug('[restoreLegacy] skipBackupFile is true, skip restoring Data directory')
      }

      // Clean up temp directory
      logger.debug('[restoreLegacy] clean up temp directory')
      await fs.remove(tempDir)

      onProgress({ stage: 'completed', progress: 100, total: 100 })

      logger.info('[restoreLegacy] Restore completed successfully')

      return data
    } catch (error) {
      logger.error('[restoreLegacy] Restore failed:', error as Error)
      await fs.remove(tempDir).catch(() => {})
      throw error
    }
  }

  /**
   * Restore from a local backup file
   * @param _ - Electron IPC event
   * @param fileName - Name of the backup file
   * @param localBackupDir - Directory where the backup file is located
   * @returns Result from restore operation
   */
  async restoreFromLocalBackup(_: Electron.IpcMainInvokeEvent, fileName: string, localBackupDir: string) {
    try {
      const backupPath = resolveAndValidatePath(localBackupDir, fileName)

      if (!fs.existsSync(backupPath)) {
        throw new Error(`Backup file not found: ${backupPath}`)
      }

      return await this.restore(_, backupPath)
    } catch (error) {
      logger.error('[BackupManager] Local restore failed:', error as Error)
      throw error
    }
  }

  /**
   * Restore from a WebDAV backup
   * Downloads the backup file from WebDAV server and restores it.
   * @param _ - Electron IPC event
   * @param webdavConfig - WebDAV configuration including server URL, credentials, and file name
   * @returns Result from restore operation
   */
  async restoreFromWebdav(_: Electron.IpcMainInvokeEvent, webdavConfig: WebDavConfig) {
    // 与 backupToWebdav 同一断言；本地落点再经 resolveAndValidatePath
    // 钉在 backupDir 内（restoreFromWebdav 会覆盖目标路径，此前可被 `../..` 带出根目录）。
    const filename = assertSafeRemoteBackupFileName(webdavConfig.fileName || 'cherry-studio.backup.zip')
    const webdavClient = this.getWebDavInstance(webdavConfig)
    try {
      const retrievedFile = await webdavClient.getFileContents(filename)
      const backupedFilePath = resolveAndValidatePath(this.backupDir, filename)

      if (!fs.existsSync(this.backupDir)) {
        fs.mkdirSync(this.backupDir, { recursive: true })
      }

      // Write file using streaming
      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(backupedFilePath)
        writeStream.write(retrievedFile as Buffer)
        writeStream.end()

        writeStream.on('finish', () => resolve())
        writeStream.on('error', (error) => reject(error))
      })

      return await this.restore(_, backupedFilePath)
    } catch (error: any) {
      logger.error('Failed to restore from WebDAV:', error)
      throw new Error(error.message || 'Failed to restore backup file')
    }
  }

  /**
   * Restore from an S3 backup
   * Downloads the backup file from S3 storage and restores it.
   * @param _ - Electron IPC event
   * @param s3Config - S3 configuration including bucket, credentials, and file name
   * @returns Result from restore operation
   */

  private onProgress = (channel: IpcChannel, shouldLog: boolean) => {
    return (processData: ProgressData) => {
      const mainWindow = windowService.getMainWindow()
      mainWindow?.webContents.send(channel, processData)
      // Never log copying_files as it generates too many log entries
      if (shouldLog && processData.stage !== 'copying_files') {
        logger.info('Backup progress', processData)
      }
    }
  }

  private createCopyProgressHandler(
    totalSize: number,
    startProgress: number,
    endProgress: number,
    stage: string,
    onProgress: (processData: ProgressData) => void
  ) {
    let copiedSize = 0
    let lastReported = startProgress

    return (size: number) => {
      copiedSize += size
      const progress =
        totalSize > 0
          ? Math.min(endProgress, startProgress + Math.floor((copiedSize / totalSize) * (endProgress - startProgress)))
          : endProgress
      if (progress === lastReported && copiedSize < totalSize) {
        return
      }
      lastReported = progress
      onProgress({ stage, progress, total: 100 })
    }
  }

  /**
   * Calculate total size of a directory recursively
   * @param dirPath - Directory path to calculate size
   * @returns Total size in bytes
   */
  private async getDirSize(
    dirPath: string,
    options: CopyDirOptions,
    activeDirectoryRealPaths = new Set<string>()
  ): Promise<number> {
    const copyOptions = {
      ...options,
      sourceRootRealPath: options.sourceRootRealPath ?? (await fs.realpath(dirPath))
    }
    const directoryRealPath = await this.enterDirectory(dirPath, activeDirectoryRealPaths)

    if (!directoryRealPath) {
      return 0
    }

    let size = 0

    try {
      const items = await fs.readdir(dirPath, { withFileTypes: true })

      // 每层并行 stat/递归（此前逐条 await，整树串行）；符号链接错误的吞并语义保持不变
      const sizes = await Promise.all(
        items.map(async (item) => {
          const fullPath = path.join(dirPath, item.name)
          const entry = await this.getEffectiveEntryStats(fullPath, copyOptions)

          if (!entry) {
            return 0
          }

          if (entry.stats.isDirectory()) {
            if (entry.isSymlink) {
              try {
                return await this.getDirSize(fullPath, copyOptions, activeDirectoryRealPaths)
              } catch (error) {
                this.logSkippedSymlink(fullPath, error)
                return 0
              }
            }
            return await this.getDirSize(fullPath, copyOptions, activeDirectoryRealPaths)
          }
          return entry.stats.isFile() ? entry.stats.size : 0
        })
      )

      size = sizes.reduce((sum, s) => sum + s, 0)
    } finally {
      activeDirectoryRealPaths.delete(directoryRealPath)
    }

    return size
  }

  /**
   * Stage an empty Data directory; handleStartupRestore swaps it in on next launch.
   * Avoids races with libsql / KnowledgeService recreating files before relaunch.
   *
   * `Data/` 之外的三样也一并预备（内核数据 / provider key / 应用配置）——它们都在 userData 根，
   * 原来不在重置范围内，导致"重置后 key、会话历史、应用配置全都还在"。目录预备成空目录，文件预备成
   * 对应的空 store（`{ keys: {} }` / `{}`），由下次启动的 handleStartupRestore 顶掉真身。
   */
  public async resetData() {
    const dataRestorePath = getDataPath() + '.restore'
    await fs.remove(dataRestorePath).catch(() => {})
    await fs.ensureDir(dataRestorePath)

    const userDataPath = app.getPath('userData')
    for (const name of BackupManager.RESET_ROOT_ENTRIES) {
      const staged = path.join(userDataPath, `${name}.restore`)
      await fs.remove(staged).catch(() => {})
      if (path.extname(name)) {
        // provider-keys.json 的 electron-store 形状是 { keys: {} }；config.json 空对象即回默认值
        await fs.writeJson(staged, name === 'provider-keys.json' ? { keys: {} } : {})
      } else {
        await fs.ensureDir(staged)
      }
    }
  }

  /**
   * Deep compare two WebDAV config objects for equality
   * Only compares core fields that affect client connection, ignores volatile fields like fileName
   * @param cachedConfig - The cached WebDAV configuration
   * @param config - The new WebDAV configuration to compare
   * @returns True if the configs are equal (connection-related fields only)
   */
  private isWebDavConfigEqual(cachedConfig: typeof this.cachedWebdavConnectionConfig, config: WebDavConfig): boolean {
    if (!cachedConfig) return false

    return (
      cachedConfig.webdavHost === config.webdavHost &&
      cachedConfig.webdavUser === config.webdavUser &&
      cachedConfig.webdavPass === config.webdavPass &&
      cachedConfig.webdavPath === config.webdavPath
    )
  }

  /**
   * Get WebDav instance, reuses existing instance if connection config hasn't changed
   * Note: Only connection-related config changes will recreate the instance
   * Other config changes don't affect instance reuse
   * @param config - WebDAV configuration
   * @returns WebDav instance
   */
  private getWebDavInstance(config: WebDavConfig): WebDav {
    // Check if core connection config has changed
    const configChanged = !this.isWebDavConfigEqual(this.cachedWebdavConnectionConfig, config)

    if (configChanged || !this.webdavInstance) {
      this.webdavInstance = new WebDav(config)
      // Only cache connection-related config fields
      this.cachedWebdavConnectionConfig = {
        webdavHost: config.webdavHost,
        webdavUser: config.webdavUser,
        webdavPass: config.webdavPass,
        webdavPath: config.webdavPath
      }
      logger.debug('[BackupManager] Created new WebDav instance')
    } else {
      logger.debug('[BackupManager] Reusing existing WebDav instance')
    }

    return this.webdavInstance
  }

  // ==================== WebDAV Methods ====================
  // These methods handle backup operations with WebDAV servers.

  /**
   * List backup files on WebDAV server
   * @param _ - Electron IPC event
   * @param config - WebDAV configuration
   * @returns Array of backup file info (name, modified time, size), sorted by newest first
   */
  listWebdavFiles = async (_: Electron.IpcMainInvokeEvent, config: WebDavConfig) => {
    try {
      const client = this.getWebDavInstance(config)
      const files = await client.getDirectoryContents()

      return files
        .filter((file: FileStat) => file.type === 'file' && file.basename.endsWith('.zip'))
        .map((file: FileStat) => ({
          fileName: file.basename,
          modifiedTime: file.lastmod,
          size: file.size
        }))
        .sort((a, b) => new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime())
    } catch (error: any) {
      logger.error('Failed to list WebDAV files:', error)
      throw new Error(error.message || 'Failed to list backup files')
    }
  }

  /**
   * Copy directory with progress reporting
   * Recursively copies files from source to destination while reporting progress
   * @param source - Source directory path
   * @param destination - Destination directory path
   * @param onProgress - Callback function called with size of each copied file
   */
  private async copyDirWithProgress(
    source: string,
    destination: string,
    onProgress: (size: number) => void,
    options: CopyDirOptions
  ): Promise<void> {
    const copyOptions = {
      ...options,
      sourceRootRealPath: options.sourceRootRealPath ?? (await fs.realpath(source))
    }
    const activeDirectoryRealPaths = new Set<string>()

    const copyDir = async (src: string, dest: string): Promise<void> => {
      const directoryRealPath = await this.enterDirectory(src, activeDirectoryRealPaths)

      if (!directoryRealPath) {
        return
      }

      try {
        await fs.ensureDir(dest)

        const items = await fs.readdir(src, { withFileTypes: true })

        for (const item of items) {
          const sourcePath = path.join(src, item.name)
          const destPath = path.join(dest, item.name)
          const entry = await this.getEffectiveEntryStats(sourcePath, copyOptions)

          if (!entry) {
            continue
          }

          if (entry.stats.isDirectory()) {
            try {
              await copyDir(sourcePath, destPath)
            } catch (error) {
              if (!entry.isSymlink) {
                throw error
              }
              await fs.remove(destPath).catch(() => {})
              this.logSkippedSymlink(sourcePath, error)
            }
          } else if (entry.stats.isFile()) {
            if (entry.isSymlink) {
              await fs.copy(sourcePath, destPath, { dereference: true })
            } else {
              await fs.copy(sourcePath, destPath)
            }
            onProgress(entry.stats.size)
          } else if (entry.isSymlink) {
            logger.warn('[BackupManager] Skipping symlink to unsupported target', { path: sourcePath })
          }
        }
      } finally {
        activeDirectoryRealPaths.delete(directoryRealPath)
      }
    }

    await copyDir(source, destination)
  }

  private async enterDirectory(dirPath: string, activeDirectoryRealPaths: Set<string>): Promise<string | null> {
    const realPath = await fs.realpath(dirPath)

    if (activeDirectoryRealPaths.has(realPath)) {
      logger.warn('[BackupManager] Skipping circular symlink directory', { path: dirPath, realPath })
      return null
    }

    activeDirectoryRealPaths.add(realPath)
    return realPath
  }

  private async getEffectiveEntryStats(
    sourcePath: string,
    options: CopyDirOptions
  ): Promise<EffectiveEntryStats | null> {
    const stats = await fs.lstat(sourcePath)

    if (!stats.isSymbolicLink()) {
      return { isSymlink: false, stats }
    }

    const targetStats = await this.getSymlinkTargetStats(sourcePath, options)
    return targetStats ? { isSymlink: true, stats: targetStats } : null
  }

  private async getSymlinkTargetStats(sourcePath: string, options: CopyDirOptions): Promise<Stats | null> {
    if (!options.dereferenceSymlinks) {
      logger.warn('[BackupManager] Skipping symlink (dereferenceSymlinks=false)', { path: sourcePath })
      return null
    }

    try {
      const [targetStats, targetRealPath] = await Promise.all([fs.stat(sourcePath), fs.realpath(sourcePath)])
      const context = {
        path: sourcePath,
        sourceRootRealPath: options.sourceRootRealPath,
        targetRealPath
      }

      if (options.sourceRootRealPath && !isPathInside(targetRealPath, options.sourceRootRealPath)) {
        logger.warn('[BackupManager] Dereferencing symlink outside source root during backup copy', context)
      } else {
        logger.info('[BackupManager] Dereferencing symlink during backup copy', context)
      }
      return targetStats
    } catch (error) {
      this.logSkippedSymlink(sourcePath, error)
      return null
    }
  }

  private logSkippedSymlink(sourcePath: string, error: unknown) {
    logger.warn('[BackupManager] Skipping broken or unreadable symlink', { path: sourcePath, error })
  }

  /**
   * Check WebDAV connection
   * @param _ - Electron IPC event
   * @param webdavConfig - WebDAV configuration to test
   * @returns True if connection is successful
   */
  async checkConnection(_: Electron.IpcMainInvokeEvent, webdavConfig: WebDavConfig) {
    const webdavClient = this.getWebDavInstance(webdavConfig)
    return await webdavClient.checkConnection()
  }

  /**
   * Create a directory on WebDAV server
   * @param _ - Electron IPC event
   * @param webdavConfig - WebDAV configuration
   * @param path - Directory path to create
   * @param options - Optional directory creation options
   * @returns Result from WebDAV operation
   */
  async createDirectory(
    _: Electron.IpcMainInvokeEvent,
    webdavConfig: WebDavConfig,
    path: string,
    options?: CreateDirectoryOptions
  ) {
    const webdavClient = this.getWebDavInstance(webdavConfig)
    return await webdavClient.createDirectory(path, options)
  }

  /**
   * Delete a backup file from WebDAV server
   * @param _ - Electron IPC event
   * @param fileName - Name of the file to delete
   * @param webdavConfig - WebDAV configuration
   * @returns Result from WebDAV operation
   */
  async deleteWebdavFile(_: Electron.IpcMainInvokeEvent, fileName: string, webdavConfig: WebDavConfig) {
    try {
      const webdavClient = this.getWebDavInstance(webdavConfig)
      return await webdavClient.deleteFile(fileName)
    } catch (error: any) {
      logger.error('Failed to delete WebDAV file:', error)
      throw new Error(error.message || 'Failed to delete backup file')
    }
  }

  // ==================== Local Backup Methods ====================
  // These methods handle backup operations with local directories.

  /**
   * List backup files in a local directory
   * @param _ - Electron IPC event
   * @param localBackupDir - Directory to list backup files from
   * @returns Array of backup file info (name, modified time, size), sorted by newest first
   */
  async listLocalBackupFiles(_: Electron.IpcMainInvokeEvent, localBackupDir: string) {
    try {
      const files = await fs.readdir(localBackupDir)

      // 并行 stat 全部条目（此前逐个 await）
      const stats = await Promise.all(
        files.map(async (file) => {
          try {
            return { file, stat: await fs.stat(path.join(localBackupDir, file)) }
          } catch {
            return null
          }
        })
      )

      const result = stats
        .filter((entry): entry is { file: string; stat: fs.Stats } => entry !== null)
        .filter(({ file, stat }) => stat.isFile() && file.endsWith('.zip'))
        .map(({ file, stat }) => ({
          fileName: file,
          modifiedTime: stat.mtime.toISOString(),
          size: stat.size
        }))

      // Sort by modified time, newest first
      return result.sort((a, b) => new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime())
    } catch (error) {
      logger.error('[BackupManager] List local backup files failed:', error as Error)
      throw error
    }
  }

  /**
   * Delete a local backup file
   * @param _ - Electron IPC event
   * @param fileName - Name of the file to delete
   * @param localBackupDir - Directory where the backup file is located
   * @returns True if deletion was successful
   */
  async deleteLocalBackupFile(_: Electron.IpcMainInvokeEvent, fileName: string, localBackupDir: string) {
    try {
      const filePath = resolveAndValidatePath(localBackupDir, fileName)

      if (!fs.existsSync(filePath)) {
        throw new Error(`Backup file not found: ${filePath}`)
      }

      await fs.remove(filePath)
      return true
    } catch (error) {
      logger.error('[BackupManager] Delete local backup file failed:', error as Error)
      throw error
    }
  }

  // ==================== Legacy & Temp Methods ====================
  // These methods are for legacy backup format and temporary file operations.

  /**
   * Create a legacy backup
   * Creates a lightweight backup (skipBackupFile=true) in the temp directory
   * Returns the path to the created ZIP file
   * @param data - JSON string data to backup
   * @param destinationPath - Path to save the backup
   */
}

export { BackupManager }

export default BackupManager

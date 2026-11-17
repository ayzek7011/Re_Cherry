import { loggerService } from '@logger'
import db from '@renderer/databases'
import i18n from '@renderer/i18n'
import store from '@renderer/store'
import { setFilesPath, setResourcesPath } from '@renderer/store/runtime'
import type { FileMetadata } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import { getFileDirectory, getFileExtension } from '@renderer/utils'
import { documentExts, imageExts, textExts } from '@shared/config/constant'
import dayjs from 'dayjs'

const logger = loggerService.withContext('FileManager')

/**
 * 路径地基（问题2候选1）的模块级缓存。
 *
 * 此前路径重建的唯一真值是 Redux `runtime.filesPath`：不持久化、启动异步赋值一次、
 * 只在主窗口 useAppInit 调用——mini 窗口永远是 ''，赋值前/赋值失败后的任何消费方
 * 都拼出 `'' + '/' + id + ext` 的坏路径且无信号。现在引导收口到 FileManager：
 * `syncRuntimePaths()` 幂等拉取 getAppInfo（失败重试一次），同时自持缓存并 dispatch
 * 进 Redux（UI 响应式消费方据此重渲染）。主窗口与 mini 窗口入口都调用它；
 * 定位/打开等动作路径先 await 它再重建路径。
 */
let filesPathCache = ''
let runtimePathsPromise: Promise<string> | null = null

/** 后缀 → 分类（与主进程 `getFileType` 同源：同一批 `@shared/config/constant` 名单）。 */
const EXT_TYPE_MAP = new Map<string, FileMetadata['type']>([
  ...imageExts.map((ext) => [ext, FILE_TYPE.IMAGE] as const),
  ...documentExts.map((ext) => [ext, FILE_TYPE.DOCUMENT] as const),
  ...textExts.map((ext) => [ext, FILE_TYPE.TEXT] as const)
])

/** 下载落盘后缀被叠加的历史痕迹（见 `repairLegacyDownloadedFile`）。 */
const LEGACY_DOWNLOAD_SUFFIX = /\.bin$/i

/**
 * 修复"下载落盘后缀被 Content-Type 叠加"造成的历史行。
 *
 * 现场：`xxx_00001_.png` + `application/octet-stream`（→ `.bin`）曾落成 `xxx_00001_.png.bin`、
 * `ext = '.bin'`、`type = other` ⇒ 文件页「图片」分类里看不到这张 **AI 生成的图**（真机取证）。
 * 字节没坏：盘上文件名就是 `<id>.bin`，`FileManager.getFilePath` 按 `id + ext` 找文件，故 `ext`
 * **必须保留 `.bin`**，这里只修**分类**（按 origin_name 去掉那个多余后缀后的真实后缀重算 `type`）
 * 与**显示名**（`formatFileName` 读 `origin_name`）。
 *
 * @returns 需要写回的新行；无需修改返回 `null`。
 */
export function repairLegacyDownloadedFile(file: FileMetadata): FileMetadata | null {
  if (!file || typeof file.ext !== 'string' || typeof file.origin_name !== 'string') return null
  if (file.ext.toLowerCase() !== '.bin') return null
  if (!LEGACY_DOWNLOAD_SUFFIX.test(file.origin_name)) return null

  const cleanedName = file.origin_name.replace(LEGACY_DOWNLOAD_SUFFIX, '')
  const realType = EXT_TYPE_MAP.get(getFileExtension(cleanedName))
  if (realType === undefined) return null

  return { ...file, origin_name: cleanedName, type: realType }
}

class FileManager {
  /**
   * 拉取并广播运行时路径（filesPath/resourcesPath）。幂等：缓存命中即返回；
   * 失败重试一次，最终失败返回 '' 并记 warn 取证——调用方必须把 '' 当
   * "路径不可用"处理（提示用户），不得当成合法路径拼 URL。
   */
  static async syncRuntimePaths(): Promise<string> {
    if (filesPathCache) return filesPathCache
    if (!runtimePathsPromise) {
      runtimePathsPromise = (async () => {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const info = await window.api.getAppInfo()
            filesPathCache = info.filesPath
            store.dispatch(setFilesPath(info.filesPath))
            store.dispatch(setResourcesPath(info.resourcesPath))
            return info.filesPath
          } catch (error) {
            // warn 级取证：路径地基拿不到，本会话的文件定位/图片 URL 都会坏。
            logger.warn(`FileManager: getAppInfo failed (attempt ${attempt}/2)`, error as Error)
          }
        }
        // 失败后清掉 promise：后续调用可再试（瞬时 IPC 故障不该永久废掉路径）。
        runtimePathsPromise = null
        return ''
      })()
    }
    return runtimePathsPromise
  }

  static async selectFiles(options?: Electron.OpenDialogOptions): Promise<FileMetadata[] | null> {
    return await window.api.file.select(options)
  }

  static async addFile(file: FileMetadata): Promise<FileMetadata> {
    const fileRecord = await db.files.get(file.id)

    if (fileRecord) {
      await db.files.update(fileRecord.id, { ...fileRecord, count: fileRecord.count + 1 })
      return fileRecord
    }

    await db.files.add(file)

    return file
  }

  static async addFiles(files: FileMetadata[]): Promise<FileMetadata[]> {
    return Promise.all(files.map((file) => this.addFile(file)))
  }

  static async readBinaryImage(file: FileMetadata): Promise<Buffer> {
    const fileData = await window.api.file.binaryImage(file.id + file.ext)
    return fileData.data
  }

  static async readBase64File(file: FileMetadata): Promise<string> {
    const fileData = await window.api.file.base64File(file.id + file.ext)
    return fileData.data
  }

  static async addBase64File(file: FileMetadata): Promise<FileMetadata> {
    logger.info(`Adding base64 file: ${JSON.stringify(file)}`)

    const base64File = await window.api.file.base64File(file.id + file.ext)
    const fileRecord = await db.files.get(base64File.id)

    if (fileRecord) {
      await db.files.update(fileRecord.id, { ...fileRecord, count: fileRecord.count + 1 })
      return fileRecord
    }

    await db.files.add(base64File)

    return base64File
  }

  static async uploadFile(file: FileMetadata): Promise<FileMetadata> {
    logger.info(`Uploading file: ${JSON.stringify(file)}`)

    const uploadFile = await window.api.file.upload(file)
    logger.info('Uploaded file:', uploadFile)
    const fileRecord = await db.files.get(uploadFile.id)

    if (fileRecord) {
      await db.files.update(fileRecord.id, { ...fileRecord, count: fileRecord.count + 1 })
      return fileRecord
    }

    await db.files.add(uploadFile)

    return uploadFile
  }

  static async uploadFiles(files: FileMetadata[]): Promise<FileMetadata[]> {
    return Promise.all(files.map((file) => this.uploadFile(file)))
  }

  static async getFile(id: string): Promise<FileMetadata | undefined> {
    const file = await db.files.get(id)

    if (file) {
      const filesPath = store.getState().runtime.filesPath
      file.path = filesPath + '/' + file.id + file.ext
    }

    return file
  }

  static getFilePath(file: FileMetadata) {
    const filesPath = store.getState().runtime.filesPath
    return filesPath + '/' + file.id + file.ext
  }

  /**
   * 删除一个文件行与它的盘上字节。
   *
   * （删除纪律）：返回 `Promise<boolean>`，调用方能区分成败并回滚乐观行。
   * `false` 的两种来源——行不存在（无可删）与盘上删不掉（`window.api.file.delete` 抛错）。
   * 先删字节、后删行：字节删不掉时行保持原状、返回 `false` 让调用方给出真实信号并可重试
   * （旧顺序先行后字节会在字节删除失败时留下孤儿字节且无法重试）。
   * 盘上删不掉时**不抛**：抛出去会让 `Promise.allSettled` 把它记成未处理拒绝，
   * 这里记 warn 并返回 `false` 交给批量接口计数。
   */
  static async deleteFile(id: string, force: boolean = false): Promise<boolean> {
    const file = await this.getFile(id)

    logger.info('Deleting file:', file)

    if (!file) {
      logger.warn(`FileManager.deleteFile: no row for id ${id}, nothing deleted`)
      return false
    }

    if (!force) {
      if (file.count > 1) {
        await db.files.update(id, { ...file, count: file.count - 1 })
        return true
      }
    }

    // 先删盘上字节、后删行（删除纪律）：字节删不掉时行保持原状、返回 false 让调用方
    // 给出真实信号并可重试——旧顺序（先行后字节）会在字节删除失败时留下孤儿字节且
    // 无法重试。字节缺失（已被外部清掉）按幂等成功处理，行照删。
    try {
      await window.api.file.delete(id + file.ext)
    } catch (error) {
      // warn 级：renderer 的 info 不落盘，这条是"行还在、字节删不掉"的取证钩子。
      logger.warn('Failed to delete file bytes from disk:', error as Error)
      return false
    }

    await db.files.delete(id)
    return true
  }

  /**
   * 批量删除。要求把 "N succeeded / M failed" 作为真实信号报出来，所以这里返回计数，
   * 而不是只写一条日志（旧签名 `Promise<void>` 让调用方结构上无法上报）。
   */
  static async deleteFiles(files: FileMetadata[]): Promise<{ succeeded: number; failed: number }> {
    if (!files || files.length === 0) return { succeeded: 0, failed: 0 }

    const results = await Promise.allSettled(files.map((file) => this.deleteFile(file.id)))

    const failed = results.filter(
      (result) => result.status === 'rejected' || (result.status === 'fulfilled' && result.value === false)
    )
    const succeeded = results.length - failed.length

    if (failed.length > 0) {
      logger.warn(`File deletions completed with ${succeeded} succeeded / ${failed.length} failed`, failed)
      window.toast.error(
        i18n.t('files.delete.partial_failed', {
          defaultValue: '{{succeeded}} deleted, {{failed}} failed',
          succeeded,
          failed: failed.length
        })
      )
    }

    return { succeeded, failed: failed.length }
  }

  static async allFiles(): Promise<FileMetadata[]> {
    return db.files.toArray()
  }

  /**
   * 一次性（幂等）修复 `repairLegacyDownloadedFile` 命中的历史行。启动时调一次；
   * 只改分类与显示名，不动文件名/字节；任何异常按"没答案不放权"处理——只记日志、不删不改。
   */
  static async repairLegacyDownloadedFiles(): Promise<number> {
    try {
      const candidates = await db.files.where('ext').equals('.bin').toArray()
      let repaired = 0
      for (const file of candidates) {
        const next = repairLegacyDownloadedFile(file)
        if (next === null) continue
        await db.files.put(next)
        repaired += 1
      }
      if (repaired > 0) {
        // warn 级：真机取证要看这条（renderer 的 info 不落盘）
        logger.warn(`FileManager: repaired ${repaired} legacy downloaded file row(s) misclassified as "other"`)
      }
      return repaired
    } catch (error) {
      logger.warn('FileManager: legacy downloaded file repair skipped', error as Error)
      return 0
    }
  }

  static isDangerFile(file: FileMetadata) {
    return ['.sh', '.bat', '.cmd', '.ps1', '.vbs', 'reg'].includes(file.ext)
  }

  /**
   * 修复"扩展名丢前导点"的历史行（问题2候选3）。
   *
   * 现场：`saveBase64Image`/`savePastedImage` 曾返回 `ext.slice(1)`（`png`），而全仓契约是
   * **带点**扩展名——路径按 `id + ext` 拼（`getFilePath`/`readBinaryImage`/`delete`）、
   * 类型名单是 `imageExts`（`.png`），无点行全部定位失败（文件页裂图、"找不到文件"、
   * 重新挂附件被当不支持类型）。盘上字节名一直是 `<id>.png`（生产者拼名时 ext 本就带点），
   * 所以把行内 `ext` 补上点即与字节对齐。幂等：仅改非空且不带点的 `ext`；
   * 失败只记日志不改行。
   */
  static async repairDotlessExtRows(): Promise<number> {
    try {
      const candidates = await db.files
        .filter((file) => typeof file?.ext === 'string' && file.ext !== '' && !file.ext.startsWith('.'))
        .toArray()
      let repaired = 0
      for (const file of candidates) {
        await db.files.put({ ...file, ext: '.' + file.ext.toLowerCase() })
        repaired += 1
      }
      if (repaired > 0) {
        // warn 级取证：真机要看这条（renderer 的 info 不落盘）
        logger.warn(`FileManager: normalized ${repaired} file row(s) with dotless ext`)
      }
      return repaired
    } catch (error) {
      logger.warn('FileManager: dotless ext repair skipped', error as Error)
      return 0
    }
  }

  static getSafePath(file: FileMetadata) {
    // use the path from the file metadata instead
    // this function is used to get path for files which are not in the filestorage
    return this.isDangerFile(file) ? getFileDirectory(file.path) : file.path
  }

  static getFileUrl(file: FileMetadata) {
    const filesPath = store.getState().runtime.filesPath
    return 'file://' + filesPath + '/' + file.name
  }

  static async updateFile(file: FileMetadata) {
    if (!file.origin_name.includes(file.ext)) {
      file.origin_name = file.origin_name + file.ext
    }

    await db.files.update(file.id, file)
  }

  static formatFileName(file: FileMetadata) {
    if (!file || !file.origin_name) {
      return ''
    }

    const date = dayjs(file.created_at).format('YYYY-MM-DD')

    if (file.origin_name.includes('pasted_text')) {
      return date + ' ' + i18n.t('message.attachments.pasted_text') + file.ext
    }

    if (file.origin_name.startsWith('temp_file') && file.origin_name.includes('image')) {
      return date + ' ' + i18n.t('message.attachments.pasted_image') + file.ext
    }

    return file.origin_name
  }
}

export default FileManager

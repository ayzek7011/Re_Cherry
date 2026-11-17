import { loggerService } from '@logger'
import db from '@renderer/databases'
import type { FileMetadata } from '@types'

const logger = loggerService.withContext('KernelImages')

/**
 * 渲染侧图片通道助手（识图通道）。
 *
 * 职责一（发送向）：把 Cherry 文件仓里的图片规范化成内核附件准入预算内的 base64 载荷。
 *   规范化在渲染进程做——这里有 canvas（EXIF 摆正 + 解码证明 + 重编码），主进程附件仓库
 *   只做容器校验（见 src/main/kernel/attachments.ts），零图像编解码依赖。
 * 职责二（回放向）：把内核图片附件按 ref 同步回本地文件仓（确定性 id，幂等），
 *   供 IMAGE 块按普通文件渲染；内核附件仓仍是唯一真相源。
 */

/** 目标编码字节上限：留 6% 余量低于内核准入的 1MB 与 pi-ai 默认单图请求预算。 */
const MAX_ENCODED_BYTES = 950 * 1024
/** 规范化最长边：对齐 pi-ai 默认请求像素预算（2048²）与内核准入的单边限制。 */
const MAX_LONG_EDGE = 2048

/** 扩展名 → wire 媒体类型（仅 v1 附件路径接受的四种；bmp 等由 canvas 转码成 png）。
 *  导出复用：paintings canonicalGenerate 的 data URL 编码同源取 mime，避免第二张表。 */
export const MEDIA_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

/** 随消息发往内核的图片 wire 载荷（EncodedImageAttachment 的 IPC 形态）。 */
export interface KernelImageInput {
  mediaType: string
  data: string
  name?: string
}

/** 内核图片附件引用的渲染侧形态（ImageAttachmentRef 的子集，回放同步用）。 */
export interface KernelImageRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read encoded image blob'))
    reader.readAsDataURL(blob)
  })
}

interface EncodedCanvas {
  mediaType: string
  data: string
  width: number
  height: number
}

/** 画布编码：按策略表逐级压质/缩边，直到落进字节预算（或返回最后一次结果交内核拒绝）。 */
async function encodeCanvas(canvas: OffscreenCanvas): Promise<EncodedCanvas> {
  const strategies: Array<{ type: string; quality?: number }> = [
    { type: 'image/png' },
    { type: 'image/jpeg', quality: 0.85 },
    { type: 'image/jpeg', quality: 0.7 }
  ]
  for (const strategy of strategies) {
    const blob = await canvas.convertToBlob({ type: strategy.type, quality: strategy.quality })
    if (blob.size <= MAX_ENCODED_BYTES) {
      return {
        mediaType: strategy.type,
        data: await blobToBase64(blob),
        width: canvas.width,
        height: canvas.height
      }
    }
  }
  // 仍超预算：逐级缩边后用 jpeg 0.7 兜底（有界循环，缩到 0.3x 为止）。
  let scale = 0.7
  while (scale >= 0.3) {
    const scaled = new OffscreenCanvas(
      Math.max(1, Math.round(canvas.width * scale)),
      Math.max(1, Math.round(canvas.height * scale))
    )
    const ctx = scaled.getContext('2d')
    if (ctx === null) break
    const source = await createImageBitmap(canvas)
    ctx.drawImage(source, 0, 0, scaled.width, scaled.height)
    source.close()
    const blob = await scaled.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
    if (blob.size <= MAX_ENCODED_BYTES) {
      logger.info(`kernelImages: downscaled image to ${scaled.width}x${scaled.height} to fit the request budget`)
      return {
        mediaType: 'image/jpeg',
        data: await blobToBase64(blob),
        width: scaled.width,
        height: scaled.height
      }
    }
    scale -= 0.2
  }
  logger.warn('kernelImages: image still exceeds the request budget after all encode strategies')
  return { mediaType: 'image/jpeg', data: '', width: canvas.width, height: canvas.height }
}

/**
 * 把一个 Cherry 图片文件规范化为内核附件载荷新形态。
 * 动图取首帧（视觉模型只吃静帧）；canvas 解码失败即抛错——发送链上可见失败，
 * 不做静默降级（附件仓库是准入的最后防线，容器不实会被 IMAGE_TYPE_MISMATCH 拒绝）。
 */
export async function encodeImageFileForKernel(file: FileMetadata): Promise<KernelImageInput> {
  const record = await window.api.file.base64File(file.id + file.ext)
  const bytes = base64ToBytes(record.data)
  // 行内 ext 是带点契约（`.png`）；wire 媒体表键不带点——查表前统一剥点。
  const declaredType = MEDIA_TYPE_BY_EXT[file.ext.replace(/^\./, '').toLowerCase()]

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob([bytes.buffer as ArrayBuffer], { type: declaredType ?? 'image/png' }))
  } catch (error) {
    throw new Error(
      `Unsupported image "${file.origin_name}": ${error instanceof Error ? error.message : String(error)}`
    )
  }

  try {
    return await encodeBitmapToPayload(bitmap, file.origin_name)
  } finally {
    bitmap.close()
  }
}

/**
 * 把一个原始图片 Blob（剪贴板/粘贴来源）规范化为内核附件载荷新形态。
 * 与 encodeImageFileForKernel 同一条 canvas 管线（EXIF 摆正由解码器处理；
 * 预算/转码/首帧语义一致）；解码失败即抛错，不做静默降级。
 */
export async function encodeImageBlobForKernel(blob: Blob, name?: string): Promise<KernelImageInput> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch (error) {
    throw new Error(`Unsupported image: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return await encodeBitmapToPayload(bitmap, name)
  } finally {
    bitmap.close()
  }
}

/** 位图 → 预算内 wire 载荷（文件/剪贴板两入口共用的规范化尾段）。 */
async function encodeBitmapToPayload(bitmap: ImageBitmap, originName?: string): Promise<KernelImageInput> {
  const scale = Math.min(1, MAX_LONG_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('OffscreenCanvas 2d context unavailable')
  ctx.drawImage(bitmap, 0, 0, width, height)
  const encoded = await encodeCanvas(canvas)
  if (encoded.data.length === 0) {
    throw new Error(`Image "${originName ?? 'clipboard'}" could not be encoded within the request budget`)
  }
  return {
    mediaType: encoded.mediaType,
    data: encoded.data,
    ...(originName ? { name: originName } : {})
  }
}

/** 已同步的内核附件 ref → FileMetadata（进程内缓存：同 ref 只走一次 IPC）。 */
const syncedRefs = new Map<string, FileMetadata>()

/**
 * 回放同步：按内核附件 ref 取回字节并落入本地文件仓（确定性 id `<attachmentId>.<ext>`）。
 * @returns 可直接放进 IMAGE 块的 FileMetadata；失败返回 null（调用方投影占位文本）。
 */
export async function syncKernelImageAttachment(ref: KernelImageRef): Promise<FileMetadata | null> {
  const cached = syncedRefs.get(ref.attachmentId)
  if (cached !== undefined) return cached
  try {
    const { file } = await window.api.dshAttachmentSync(ref)
    // 确定性 id：put = 幂等 upsert（重复回放/多话题引用同一附件不会膨胀文件仓）。
    // 行已存在时保留现 count：主进程返回的元数据 count 恒为 1，直接覆盖会把
    // 其他话题的引用计数重置丢掉——一次文件页删除就提前清行清字节（删错图）。
    // 回放不是新引用，也不递增（同话题反复打开会通胀）；本行是内核附件仓的
    // 本地缓存，误删可由下次回放重建，count 只需不被无端破坏。
    const existing = await db.files.get(file.id)
    await db.files.put(existing !== undefined ? { ...file, count: existing.count } : file)
    syncedRefs.set(ref.attachmentId, file)
    return file
  } catch (error) {
    logger.error(`kernelImages: failed to sync kernel attachment "${ref.attachmentId}"`, error as Error)
    return null
  }
}

/** 生成图的内容寻址 id（源串 sha256 十六进制）：同一张图重复投影只落一份。 */
export async function generatedImageFileId(source: string): Promise<string> {
  const bytes = new TextEncoder().encode(source)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * 把**聊天页** `generate_image` 的出图登记进文件仓（用户点名："聊天页的绘图同样没有被算进去"）。
 *
 * 背景：这批图原先只作为 IMAGE 块的元数据存在（会话日志里的 data URL / URL），**不落盘、不进
 * `db.files`** —— 于是文件页永远看不到它们；当初不落盘的理由是"回放重落盘会堆积重复文件"
 *（`saveBase64Image` 每次生成新 uuid）。这里用**内容寻址 id**（源串 sha256）解决：同图同 id、
 * 行已存在即跳过，回放/重开话题都不再产生新文件。
 *
 * 失败只记日志：生成图已经能在会话里看到，登记进文件仓是"可发现性"的增强，不该把投影打断。
 */
export async function registerGeneratedImageFiles(images: readonly string[]): Promise<FileMetadata[]> {
  const registered: FileMetadata[] = []
  for (const source of images) {
    try {
      const id = await generatedImageFileId(source)
      const existing = await db.files.get(id)
      if (existing !== undefined) {
        // 已登记（回放/重开话题）：只回传现行，不动 count——内容寻址行是投影缓存，
        // 回放不是新引用，递增会让反复打开的话题把 count 通胀。
        registered.push(existing)
        continue
      }
      const file = (await window.api.file.saveGeneratedImage({ id, source })) as FileMetadata
      await db.files.put(file)
      registered.push(file)
    } catch (error) {
      logger.warn('kernelImages: failed to register a generated image into the file store', error as Error)
    }
  }
  if (registered.length > 0) {
    logger.warn(`kernelImages: registered ${registered.length} generated image file(s)`)
  }
  return registered
}

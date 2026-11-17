/**
 * 通用绘画生成路径（V2 移植）：V2
 * `src/renderer/pages/paintings/model/canonicalGenerate.ts` 主体照抄——
 * 输入图过滤 / mode 推断 / maxInputImages / prompt 必填 / checkProviderEnabled /
 * customSize 合成 / bytesToDataUrl 全部保留。
 *
 * fork 缝（相对 V2 的差异，逐条标注在正文）：
 *   1. `options.support` 不再经 DataApi prefetch，而是由 `paintingPipeline` 从
 *      `@shared/lightLlm/imageGenerationCatalog` 的目录解析（同序：provider override
 *      → creator 默认）；
 *   2. 出口从 `generatePainting`(IPC) 改为 `paintingImageService`（LightLLM 单缝）；
 *   3. canonical 键名采用 V2 的 `size`/`numImages`（旧 `imageSize`/`batchSize` 在
 *      读取时一次性兼容映射，见 `LEGACY_PARAM_ALIASES`）。
 */
import { loggerService } from '@logger'
import { createPaintingGenerateError } from '@renderer/pages/paintings/errors/paintingGenerateError'
import { checkProviderEnabled } from '@renderer/pages/paintings/utils/checkProviderEnabled'
import FileManager from '@renderer/services/FileManager'
import { MEDIA_TYPE_BY_EXT } from '@renderer/services/kernelImages'
import { editPaintingImages, generatePaintingImages } from '@renderer/services/paintingImageService'
import type { FileMetadata } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type { ImageGenerationMode, ImageGenerationSupport } from '@shared/lightLlm/imageGenerationCatalog'
import { buildParamsSchema } from '@shared/lightLlm/imageGenerationCatalog'
import type { LightImageResult } from '@shared/lightLlm/types'

import type { GenerateInput } from './types/generateInput'
import type { PaintingData } from './types/paintingData'

const logger = loggerService.withContext('paintings/canonicalGenerate')

/** fork 上限常量（V2 registry maxInputImages 的本地等价）。 */
// fork 缝（P0-A）：导出给作曲条物化闸复用，避免"4"出现第二个事实源。
export const MAX_INPUT_IMAGES = 4

/**
 * fork 缝：旧参数键 → V2 canonical 键的一次性兼容映射。fork 的历史草稿/持久化行
 * 里存的是 `imageSize`/`batchSize`（的自写参数表），V2 的 canonical
 * 键是 `size`/`numImages`。只在 canonical 键缺席时兜底，绝不覆盖新值；其余未知键
 * 由 `buildParamsSchema` 的 loose 语义保留后被本函数丢弃，不报错。
 */
const LEGACY_PARAM_ALIASES: Record<string, string> = {
  imageSize: 'size',
  batchSize: 'numImages'
}

/** 折叠旧键拼写到 canonical 键（导出仅为测试旧数据兼容路径）。 */
export function withLegacyAliases(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params }
  for (const [legacyKey, canonicalKey] of Object.entries(LEGACY_PARAM_ALIASES)) {
    const legacyValue = out[legacyKey]
    // 空串/undefined 的旧值等同"用户没填"：不写入 canonical 键（下游按缺席处理）。
    const present = legacyValue !== undefined && legacyValue !== null && legacyValue !== ''
    if (out[canonicalKey] === undefined && present) {
      out[canonicalKey] = legacyValue
    }
    delete out[legacyKey]
  }
  return out
}

/** Encode raw image bytes as a `data:` URL for the edit endpoint. */
function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return `data:${mime || 'image/png'};base64,${btoa(binary)}`
}

export interface CanonicalGenerateOptions<T extends PaintingData> {
  /**
   * Throw a vendor-specific validation error before the generate call
   * fires. Use for cross-field rules that can't fit a single resolver.
   */
  preValidate?: (painting: T) => void
  /**
   * Whether `painting.prompt` must be non-empty. Default `true`. Pass
   * `false` (or a predicate returning `false`) for models that accept
   * empty prompts. `preValidate` is responsible for any per-model rule
   * when the standard check is skipped.
   */
  requirePrompt?: boolean | ((painting: T) => boolean)
  /**
   * Registry image-generation support for this model — composes with the
   * central param catalog to validate/coerce `painting.params` (seed
   * string→number, blank→undefined, enum/range bounds) at submit. Threaded in
   * by `paintingPipeline`, which resolves it from the fork catalog.
   */
  support?: ImageGenerationSupport
  /** Resolved mode for the `support` lookup. Default `'generate'`. */
  mode?: ImageGenerationMode
}

/**
 * Generic painting generate path. Validates/coerces `painting.params` (keyed by
 * canonical names from the model's `imageGeneration.modes[mode].supports`) via the
 * shared catalog, then ships the whole canonical bag to
 * `paintingImageService` — the feature's single AI seam (LightLLM).
 *
 * Empty / undefined / empty-string entries are dropped here (and again in main)
 * so the server applies its own default; no client-side defaults.
 */
export async function canonicalGenerate<T extends PaintingData>(
  input: GenerateInput<T>,
  options: CanonicalGenerateOptions<T> = {}
): Promise<LightImageResult> {
  const { painting, provider } = input

  // Vendor-specific cross-field errors first so they take precedence over
  // the generic MISSING_REQUIRED_FIELDS / PROMPT_REQUIRED throws below.
  options.preValidate?.(painting)

  // Only image files count as inputs — the composer can also carry non-image
  // attachments (e.g. a pasted-text `.txt`), which must never be treated/sent as an image.
  const inputImageFiles = (painting.inputFiles ?? []).filter(
    (entry) => (entry.type ?? FILE_TYPE.OTHER) === FILE_TYPE.IMAGE
  )
  const mode = options.mode ?? (inputImageFiles.length > 0 ? 'edit' : 'generate')
  // fork 缝：V2 从 support 的 `maxInputImages` 取上限；fork 目录未移植该字段，
  // 保留本地常量（与 V2 声明值一致）。
  if (inputImageFiles.length > MAX_INPUT_IMAGES) {
    throw createPaintingGenerateError('INPUT_IMAGE_LIMIT_EXCEEDED')
  }
  // Edit-only modes (anything but the text→image `generate` mode) can't run without an
  // input image. Enforce here — on the authoritative mode + the real input
  // files — so the model never receives invalid input, independent of transient UI state.
  if (mode !== 'generate' && inputImageFiles.length === 0) {
    throw createPaintingGenerateError('EDIT_IMAGE_REQUIRED')
  }

  await checkProviderEnabled(provider)
  const modelId = painting.model
  if (!modelId) throw createPaintingGenerateError('MISSING_REQUIRED_FIELDS')

  const prompt = (painting.prompt ?? '').trim()
  const promptRequired =
    typeof options.requirePrompt === 'function' ? options.requirePrompt(painting) : (options.requirePrompt ?? true)
  if (promptRequired && !prompt) throw createPaintingGenerateError('PROMPT_REQUIRED')

  // 1. Validate / coerce raw form params through the shared catalog, after folding
  //    the fork's legacy key spellings into the canonical ones. The catalog is
  //    loose (v2 `buildParamsSchema` + `.loose()`): a bad / legacy / uncatalogued
  //    value is dropped, never a submit-blocking error.
  const rawParams = withLegacyAliases(painting.params ?? {})
  const source = buildParamsSchema(options.support, options.mode)(rawParams)

  // 2. Build the canonical `paramValues` bag: drop blanks (mirrors main's
  //    `splitParamValues` guard — the byte-identical-wire invariant) and the
  //    UI-only `customSize_width`/`customSize_height` companions, and drop any
  //    non-canonical key the loose schema preserved.
  const paramValues: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (key === 'customSize_width' || key === 'customSize_height') continue
    if (value === undefined || value === '' || value === null) continue
    paramValues[key] = value
  }

  // 3. Custom size: the customSize widget pairs `size: 'custom'` with
  //    `customSize_width`/`customSize_height` (zhipu CogView's free WxH range).
  //    Compose them into `size`; drop the sentinel when the pair is incomplete
  //    so the server applies its default.
  if (paramValues.size === 'custom') {
    const width = source.customSize_width
    const height = source.customSize_height
    if (typeof width === 'number' && typeof height === 'number') {
      paramValues.size = `${width}x${height}`
    } else {
      delete paramValues.size
    }
  }

  // 4. Pre-fetch attached image bytes (encoded as `data:` URLs for the edit
  //    endpoint), carried separately from `paramValues` — they're encoded files,
  //    not form params. fork 缝：FileMetadata 经 FileManager.readBinaryImage 读字节。
  const inputImages =
    inputImageFiles.length > 0
      ? await Promise.all(
          inputImageFiles.map(async (entry: FileMetadata) => {
            const buffer = await FileManager.readBinaryImage(entry)
            // mime 按入仓文件真实扩展名取（未知扩展回落 image/png）；此前硬编码
            // 'image/png' 会把 jpeg/webp 参考图错标成 png。
            const ext = (entry.ext ?? '').replace(/^\./, '').toLowerCase()
            return bytesToDataUrl(new Uint8Array(buffer), MEDIA_TYPE_BY_EXT[ext])
          })
        )
      : undefined

  const requestId = painting.id
  // fork 缝：调用方声明的参数面（= 目录里的键）随请求上行，主进程据此过滤下发；
  // 见 lightLlmModalities.imageParamValues。
  const supportedParams = Object.keys(options.support?.modes?.[mode]?.supports ?? {})

  // 出口收敛为 PaintingGenerateRequest/PaintingEditRequest（LightImageResult）；
  // FileMetadata[] 落盘由 runPainting.resolvePaintingFiles 承接。
  try {
    if (mode === 'edit' && inputImages && inputImages.length > 0) {
      return await editPaintingImages({
        providerId: provider.id,
        modelId,
        prompt,
        inputImages,
        paramValues,
        supportedParams,
        requestId
      })
    }
    return await generatePaintingImages({
      providerId: provider.id,
      modelId,
      prompt,
      paramValues,
      supportedParams,
      requestId
    })
  } catch (error) {
    logger.error('painting generate failed', { providerId: provider.id, modelId, mode, error })
    throw error
  }
}

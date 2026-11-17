/**
 * 参考图托盘状态 hook（V2 usePaintingComposerInputFiles 重写）：
 * 页面自持 inputFiles: FileMetadata[] 状态 + window.api.file.select 图片选择。
 * V2 三动作语义保留（框架词汇替换：ComposerAttachment/FileEntry → FileMetadata）：
 * - SEED：painting 切换时把该画 inputFiles 投影进托盘（一次）。
 * - MATERIALIZE：generate 时把托盘内容物化（fork 缝里 FileMetadata 已是最终
 *   形态，无 promote 步骤；complete 如实反映"这套输入能不能直接发"）。
 * - CLEAR：模型/服务商切到不收图时清空托盘（V2 CLEAR 语义）。
 *
 * fork 缝（P0-A）：作曲条可见的 chips / `sendDisabled` 读的是 tool runtime 的
 * `files`，本 hook 自持的存档态没有写入者——于是物化用的是一份陈旧列表，删 chip
 * 不影响请求、上限闸与"输入未解析完中止发送"两道闸永远到不了。故本 hook 增加可选
 * 的实时列表 `files`/`setFiles`：给了就以实时列表为准（物化源 = 它，增删改清也写它），
 * 不给时沿用自持存档态（其它调用方行为不变）。
 */
import { mergeComposerAttachments } from '@renderer/components/composer/variants/shared/composerTokens'
import FileManager from '@renderer/services/FileManager'
import { loggerService } from '@renderer/services/LoggerService'
import type { FileMetadata } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import { imageExts } from '@shared/config/constant'
import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { createPaintingGenerateError, presentPaintingGenerateError } from '../errors/paintingGenerateError'
import { MAX_INPUT_IMAGES } from '../model/canonicalGenerate'

const logger = loggerService.withContext('usePaintingComposerInputFiles')

/** 当前模型是否收图：'unknown' = 模型未解析（不动托盘）。 */
export type InputCapability = 'unknown' | 'accept' | 'reject'

const IMAGE_SELECT_FILTERS = [{ name: 'Images', extensions: imageExts.map((ext) => ext.replace(/^\./, '')) }]

interface Params {
  paintingId: string
  /** 当前画作的存档输入（历史回灌源）。 */
  archivedInputFiles: FileMetadata[]
  inputCapability: InputCapability
  providerId: string | undefined
  /**
   * fork 缝（P0-A）：作曲条 tool runtime 的实时文件列表（`useComposerToolState().files`）。
   * 传入后它是唯一的物化源（不再用本 hook 自持的存档态）。
   */
  files?: FileMetadata[]
  /**
   * fork 缝（P0-A）：实时列表的写入器（`useComposerToolDispatch().setFiles`）。
   * 传入后增删改清都作用于作曲条真正读取的那份状态。
   */
  setFiles?: Dispatch<SetStateAction<FileMetadata[]>>
}

export interface MaterializedInputs {
  files: FileMetadata[]
  complete: boolean
}

export function usePaintingComposerInputFiles({
  paintingId,
  archivedInputFiles,
  inputCapability,
  providerId,
  files: liveFiles,
  setFiles: setLiveFiles
}: Params) {
  const { t } = useTranslation()
  const [inputFiles, setInputFiles] = useState<FileMetadata[]>([])
  const [selecting, setSelecting] = useState(false)
  const seededPaintingIdRef = useRef<string | null>(null)
  const lastCapabilityRef = useRef<'accept' | 'reject' | null>(null)
  const lastProviderIdRef = useRef<string | undefined>(providerId)

  /**
   * fork 缝（P0-A）：托盘的一切写入都走这里。有实时 setter 就写作曲条的实时列表
   * （用户看得见的 chips 与发送闸读它），没有则写本 hook 自持的存档态。
   */
  const updateFiles = useCallback(
    (next: SetStateAction<FileMetadata[]>) => {
      if (setLiveFiles) setLiveFiles(next)
      else setInputFiles(next)
    },
    [setLiveFiles]
  )

  // SEED — 一次每 painting：把存档输入投影进托盘。
  useEffect(() => {
    if (seededPaintingIdRef.current === paintingId) return
    seededPaintingIdRef.current = paintingId
    // fork 缝（P0-A）：只种本 hook 的回落态。实时列表的播种由作曲条侧负责
    // （PaintingImageAddButton 的 SEED useEffect），两处同时写会互相覆盖。
    setInputFiles(archivedInputFiles)
    // archivedInputFiles 只在 SEED 时读：后续变化（重新生成）不覆盖用户草稿。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paintingId])

  // CLEAR — 同 painting 的模型/服务商切换对账（V2 语义：能力降级或换 provider 即清）。
  useEffect(() => {
    const providerChanged = lastProviderIdRef.current !== providerId
    lastProviderIdRef.current = providerId
    const droppedImageSupport = lastCapabilityRef.current === 'accept' && inputCapability === 'reject'
    if (inputCapability !== 'unknown') lastCapabilityRef.current = inputCapability
    if (!providerChanged && !droppedImageSupport) return
    // fork 缝（P0-A）：经注入的 setter 清实时列表——只清本地态时用户看得见的 chips 纹丝不动，
    // 下一次发送仍会带上这些不该再被支持的图。
    updateFiles(() => [])
  }, [inputCapability, providerId, updateFiles])

  const addFiles = useCallback(
    (incoming: FileMetadata[]) => {
      if (incoming.length === 0) return
      updateFiles((prev) => mergeComposerAttachments(prev, incoming))
    },
    [updateFiles]
  )

  const removeFile = useCallback(
    (id: string) => {
      updateFiles((prev) => prev.filter((file) => file.id !== id))
    },
    [updateFiles]
  )

  const clearFiles = useCallback(() => {
    updateFiles(() => [])
  }, [updateFiles])

  /** 打开系统图片选择框（多选），选中即入托盘。 */
  const pickImages = useCallback(async () => {
    if (selecting) return
    setSelecting(true)
    try {
      const picked = await window.api.file.select({
        properties: ['openFile', 'multiSelections'],
        filters: IMAGE_SELECT_FILTERS
      })
      if (picked?.length) {
        addFiles(picked)
      }
    } catch (error) {
      // 选择框失败（用户取消返回空数组不算失败）不能静默：记日志 + 提示。
      logger.warn('pickImages: file.select failed', error as Error)
      presentPaintingGenerateError(
        createPaintingGenerateError('OPERATION_FAILED', { presentation: 'toast', severity: 'warning' })
      )
    } finally {
      setSelecting(false)
    }
  }, [addFiles, selecting])

  /**
   * MATERIALIZE — generate 时调用。在仓判定分两路：
   * - 已在仓（Dexie 有行，SEED 回灌/历史输入/已上传过的 chip）：addFile 计数引用即可。
   * - 不在仓（托盘新 chip）：selectFile 只回元数据（path=原盘路径，字节没入仓），
   *   必须真正 uploadFile 拷贝入仓——否则托盘缩略图裂图，generate 读
   *   storageDir/{id}{ext} ENOENT 且请求从未发出。uploadFile 返回入仓后的
   *   最终元数据（新 uuid/真实 ext），用它替换托盘 chip 并作为物化结果，
   *   存档（painting.inputFiles）与后续读取从此都指向仓内文件。
   * fork 缝（P0-A）：物化源是实时草稿（作曲条 chips 的那份），并如实作答
   * `complete`——超限或物化失败即 false，交给 usePaintingGenerationSubmit 的
   * 中止闸拦下付费请求，而不是带着陈旧/超量/缺斤少两的输入发出去。
   */
  const materializeInputs = useCallback(async (): Promise<MaterializedInputs> => {
    const target = liveFiles ?? inputFiles
    const imageCount = target.filter((file) => (file.type ?? FILE_TYPE.OTHER) === FILE_TYPE.IMAGE).length
    // 上限与 canonicalGenerate 同源（MAX_INPUT_IMAGES）；提示沿用既有
    // INPUT_IMAGE_LIMIT_EXCEEDED 文案，不新增门禁词汇。
    if (imageCount > MAX_INPUT_IMAGES) {
      presentPaintingGenerateError(createPaintingGenerateError('INPUT_IMAGE_LIMIT_EXCEEDED'))
      return { files: target, complete: false }
    }
    const materialized: FileMetadata[] = []
    const failed: FileMetadata[] = []
    for (const file of target) {
      try {
        const existing = await FileManager.getFile(file.id).catch(() => undefined)
        if (existing) {
          await FileManager.addFile(file)
          materialized.push(file)
        } else {
          materialized.push(await FileManager.uploadFile(file))
        }
      } catch (error) {
        failed.push(file)
        logger.warn('materialize failed for input file', error as Error, { fileId: file.id })
      }
    }
    if (failed.length > 0) {
      // 摘掉物化失败的 chip 再中止：让用户看到的就是实际能发的输入集（既有
      // IMAGE_RETRY_REQUIRED 文案），而不是等生成结果对不上才发现少了一张。
      const failedIds = new Set(failed.map((file) => file.id))
      updateFiles((prev) => prev.filter((file) => !failedIds.has(file.id)))
      presentPaintingGenerateError(
        createPaintingGenerateError('IMAGE_RETRY_REQUIRED', { presentation: 'toast', severity: 'warning' })
      )
      return { files: target, complete: false }
    }
    // 物化成功：托盘 chip 换成入仓后的最终元数据（uploadFile 可能去重换 id）。
    const materializedBySourceId = new Map(materialized.map((file, index) => [target[index].id, file]))
    updateFiles((prev) => prev.map((file) => materializedBySourceId.get(file.id) ?? file))
    return { files: materialized, complete: true }
  }, [inputFiles, liveFiles, updateFiles])

  return {
    inputFiles: liveFiles ?? inputFiles,
    setInputFiles: updateFiles,
    addFiles,
    removeFile,
    clearFiles,
    pickImages,
    selecting,
    inputCapability,
    materializeInputs,
    t
  }
}

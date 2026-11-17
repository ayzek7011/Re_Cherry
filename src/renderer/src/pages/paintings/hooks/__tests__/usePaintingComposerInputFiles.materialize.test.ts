/**
 * 生图参考图物化（问题3修复）行为测试。
 *
 * 缺陷形态：materializeInputs 只做 Dexie 登记（addFile）不拷字节（uploadFile），
 * selectFile 只回元数据 → 托盘缩略图裂图、generate 读 storageDir/{id}{ext} ENOENT
 * 且在 try 之前裸抛 → REMOTE_ERROR 弹原始路径，请求从未发出。
 *
 * 行为级断言：
 *   ① 不在仓的托盘新 chip → 必须走 FileManager.uploadFile 拷字节入仓，并用
 *     入仓后的最终元数据替换托盘 chip（uploadFile 可能去重换 id）；
 *   ② 已在仓（SEED 回灌/历史输入，Dexie 有行）→ 只 addFile 计数引用，不重复上传；
 *   ③ uploadFile 失败 → 摘掉失败 chip + IMAGE_RETRY_REQUIRED toast + complete:false
 *     （中止闸拦下付费请求，用户看到的就是实际能发的输入集）；
 *   ④ pickImages 选择框失败 → OPERATION_FAILED 提示（用户取消返回空数组不算失败）。
 */
import type { FileMetadata } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import { act, renderHook } from '@testing-library/react'
import type { Dispatch, SetStateAction } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getFileMock, addFileMock, uploadFileMock, presentMock, selectMock } = vi.hoisted(() => ({
  getFileMock: vi.fn(),
  addFileMock: vi.fn(),
  uploadFileMock: vi.fn(),
  presentMock: vi.fn(),
  selectMock: vi.fn()
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: { getFile: getFileMock, addFile: addFileMock, uploadFile: uploadFileMock }
}))

// 走共享错误核心（无 i18n 依赖），presentation 换成可断言的 mock。
vi.mock('@renderer/pages/paintings/errors/paintingGenerateError', async () => {
  const core = await import('@shared/painting/paintingGenerateError')
  return {
    ...core,
    translatePaintingGenerateError: (error: unknown) => String(error),
    presentPaintingGenerateError: presentMock
  }
})

// canonicalGenerate 依赖链重（paintingImageService 等），测试只取上限常量。
vi.mock('@renderer/pages/paintings/model/canonicalGenerate', () => ({ MAX_INPUT_IMAGES: 4 }))

vi.mock('@renderer/components/composer/variants/shared/composerTokens', () => ({
  mergeComposerAttachments: (prev: FileMetadata[], incoming: FileMetadata[]) => [...prev, ...incoming]
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => undefined }
}))

vi.stubGlobal('api', { file: { select: selectMock } })

import { usePaintingComposerInputFiles } from '../usePaintingComposerInputFiles'

function chip(overrides: Partial<FileMetadata> = {}): FileMetadata {
  return {
    id: 'src-1',
    name: 'src-1.png',
    origin_name: 'ref.png',
    // selectFile 只回元数据：path 是原盘路径，字节还没入仓。
    path: 'C:\\Downloads\\ref.png',
    size: 1024,
    ext: '.png',
    type: FILE_TYPE.IMAGE,
    created_at: '2026-11-16T00:00:00.000Z',
    count: 1,
    ...overrides
  }
}

/** 入仓后的最终形态：主进程拷字节返回新 id、真实 ext、path=仓内路径。 */
function warehoused(source: FileMetadata, id = 'wh-1'): FileMetadata {
  return { ...source, id, name: `${id}.png`, path: `C:\\userData\\Data\\Files\\${id}.png`, count: 1 }
}

function render(files: FileMetadata[]) {
  const setFilesCalls: Array<(prev: FileMetadata[]) => FileMetadata[]> = []
  const setFiles = vi.fn((updater: (prev: FileMetadata[]) => FileMetadata[]) => {
    setFilesCalls.push(updater)
  })
  const rendered = renderHook(() =>
    usePaintingComposerInputFiles({
      paintingId: 'p-1',
      archivedInputFiles: [],
      inputCapability: 'accept',
      providerId: 'prov-1',
      files,
      setFiles: setFiles as unknown as Dispatch<SetStateAction<FileMetadata[]>>
    })
  )
  return { rendered, setFilesCalls }
}

describe('usePaintingComposerInputFiles.materializeInputs（参考图必须真正入仓）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('不在仓的托盘新 chip：uploadFile 拷字节入仓，chip 换成入仓元数据', async () => {
    const source = chip()
    const stored = warehoused(source)
    getFileMock.mockResolvedValue(undefined)
    uploadFileMock.mockResolvedValue(stored)
    const { rendered, setFilesCalls } = render([source])

    let result: { files: FileMetadata[]; complete: boolean } | undefined
    await act(async () => {
      result = await rendered.result.current.materializeInputs()
    })

    expect(uploadFileMock).toHaveBeenCalledTimes(1)
    expect(uploadFileMock).toHaveBeenCalledWith(source)
    expect(addFileMock).not.toHaveBeenCalled()
    expect(result?.complete).toBe(true)
    expect(result?.files).toEqual([stored])
    // 托盘 chip 被替换成入仓元数据（后续读取/存档指向仓内文件）。
    expect(setFilesCalls).toHaveLength(1)
    expect(setFilesCalls[0]([source])).toEqual([stored])
    expect(presentMock).not.toHaveBeenCalled()
  })

  it('已在仓（SEED 回灌）：只 addFile 计数引用，不重复上传', async () => {
    const archived = chip({ id: 'wh-9', path: 'C:\\userData\\Data\\Files\\wh-9.png' })
    getFileMock.mockResolvedValue(archived)
    const { rendered, setFilesCalls } = render([archived])

    let result: { files: FileMetadata[]; complete: boolean } | undefined
    await act(async () => {
      result = await rendered.result.current.materializeInputs()
    })

    expect(getFileMock).toHaveBeenCalledWith('wh-9')
    expect(addFileMock).toHaveBeenCalledTimes(1)
    expect(addFileMock).toHaveBeenCalledWith(archived)
    expect(uploadFileMock).not.toHaveBeenCalled()
    expect(result?.complete).toBe(true)
    expect(result?.files).toEqual([archived])
    expect(setFilesCalls[0]([archived])).toEqual([archived])
  })

  it('uploadFile 失败：摘掉失败 chip + IMAGE_RETRY_REQUIRED 提示 + complete:false', async () => {
    const failing = chip({ id: 'src-bad' })
    const healthy = chip({ id: 'src-ok' })
    getFileMock.mockResolvedValue(undefined)
    uploadFileMock.mockImplementation(async (file: FileMetadata) => {
      if (file.id === 'src-bad') throw new Error('disk full')
      return warehoused(file, 'wh-ok')
    })
    const { rendered, setFilesCalls } = render([failing, healthy])

    let result: { files: FileMetadata[]; complete: boolean } | undefined
    await act(async () => {
      result = await rendered.result.current.materializeInputs()
    })

    expect(result?.complete).toBe(false)
    expect(presentMock).toHaveBeenCalledTimes(1)
    const presented = presentMock.mock.calls[0][0] as { code?: string; presentation?: string; severity?: string }
    expect(presented.code).toBe('IMAGE_RETRY_REQUIRED')
    expect(presented.presentation).toBe('toast')
    expect(presented.severity).toBe('warning')
    // 失败 chip 被摘掉，健康 chip 保留（用户看到的就是实际能发的输入集）。
    expect(setFilesCalls).toHaveLength(1)
    expect(setFilesCalls[0]([failing, healthy])).toEqual([healthy])
    // 物化结果如实回传原列表，交给中止闸拦下付费请求。
    expect(result?.files).toEqual([failing, healthy])
  })

  it('pickImages 选择框失败：提示不静默；用户取消（空数组）不算失败', async () => {
    const { rendered, setFilesCalls } = render([])
    selectMock.mockRejectedValueOnce(new Error('dialog crashed'))

    await act(async () => {
      await rendered.result.current.pickImages()
    })

    expect(presentMock).toHaveBeenCalledTimes(1)
    const presented = presentMock.mock.calls[0][0] as { code?: string }
    expect(presented.code).toBe('OPERATION_FAILED')
    expect(rendered.result.current.selecting).toBe(false)

    // 用户取消：空数组不算失败，无提示。
    presentMock.mockClear()
    selectMock.mockResolvedValueOnce([])
    await act(async () => {
      await rendered.result.current.pickImages()
    })
    expect(presentMock).not.toHaveBeenCalled()
    expect(rendered.result.current.selecting).toBe(false)
    expect(setFilesCalls).toHaveLength(0)
  })
})

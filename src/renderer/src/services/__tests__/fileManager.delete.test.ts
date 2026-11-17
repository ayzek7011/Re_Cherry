import type { FileMetadata } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 删除纪律：
 *   · `deleteFile` 返回 `Promise<boolean>`（旧签名 `Promise<void>` 让调用方结构上无法回滚）；
 *   · `deleteFiles` 返回 `{succeeded, failed}` 并把 "N 成功 / M 失败" 作为**真实信号**上报
 *     （旧实现只写一条日志）。
 * Dexie / store / i18n / 文件 IPC 全部桩注入。
 */

const filesGet = vi.hoisted(() => vi.fn())
const filesDelete = vi.hoisted(() => vi.fn())
const filesUpdate = vi.hoisted(() => vi.fn())
const fileDelete = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())

vi.mock('@renderer/databases', () => ({
  default: { files: { get: filesGet, delete: filesDelete, update: filesUpdate } },
  db: { files: { get: filesGet, delete: filesDelete, update: filesUpdate } }
}))

vi.mock('@renderer/store', () => ({
  default: { getState: () => ({ runtime: { filesPath: 'C:/files' } }) }
}))

vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))

import FileManager from '../FileManager'

function file(id: string, count = 1): FileMetadata {
  return {
    id,
    name: `${id}.png`,
    origin_name: `${id}.png`,
    ext: '.png',
    type: 'image',
    size: 10,
    count
  } as FileMetadata
}

beforeEach(() => {
  filesGet.mockReset()
  filesDelete.mockReset().mockResolvedValue(undefined)
  filesUpdate.mockReset().mockResolvedValue(1)
  fileDelete.mockReset().mockResolvedValue(undefined)
  toastError.mockReset()
  vi.stubGlobal('window', { ...globalThis.window, api: { file: { delete: fileDelete } }, toast: { error: toastError } })
})

describe('FileManager.deleteFile', () => {
  it('成功 → true，并删掉盘上字节', async () => {
    filesGet.mockResolvedValue(file('f1'))

    await expect(FileManager.deleteFile('f1', true)).resolves.toBe(true)
    expect(filesDelete).toHaveBeenCalledWith('f1')
    expect(fileDelete).toHaveBeenCalledWith('f1.png')
  })

  it('盘上删除失败 → false 且行保持原状（先字节后行，可重试不吞错）', async () => {
    filesGet.mockResolvedValue(file('f1'))
    fileDelete.mockRejectedValue(new Error('EPERM: file is locked'))

    await expect(FileManager.deleteFile('f1', true)).resolves.toBe(false)
    expect(filesDelete).not.toHaveBeenCalled()
  })

  it('行不存在 → false（"无可删"不等于成功）', async () => {
    filesGet.mockResolvedValue(undefined)

    await expect(FileManager.deleteFile('missing')).resolves.toBe(false)
    expect(filesDelete).not.toHaveBeenCalled()
    expect(fileDelete).not.toHaveBeenCalled()
  })

  it('引用计数 >1 且非强制 → 只减计数，返回 true', async () => {
    filesGet.mockResolvedValue(file('f1', 3))

    await expect(FileManager.deleteFile('f1')).resolves.toBe(true)
    expect(filesUpdate).toHaveBeenCalledWith('f1', expect.objectContaining({ count: 2 }))
    expect(filesDelete).not.toHaveBeenCalled()
  })
})

describe('FileManager.deleteFiles', () => {
  it('部分失败 → 返回真实计数并弹可见信号', async () => {
    filesGet.mockImplementation((id: string) => Promise.resolve(file(id)))
    fileDelete.mockImplementation((name: string) =>
      name === 'f2.png' ? Promise.reject(new Error('EBUSY')) : Promise.resolve(undefined)
    )

    const result = await FileManager.deleteFiles([file('f1'), file('f2'), file('f3')])

    expect(result).toEqual({ succeeded: 2, failed: 1 })
    expect(toastError).toHaveBeenCalledTimes(1)
  })

  it('全部成功 → 不弹错误', async () => {
    filesGet.mockImplementation((id: string) => Promise.resolve(file(id)))

    const result = await FileManager.deleteFiles([file('f1'), file('f2')])

    expect(result).toEqual({ succeeded: 2, failed: 0 })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('空输入 → 0/0', async () => {
    await expect(FileManager.deleteFiles([])).resolves.toEqual({ succeeded: 0, failed: 0 })
  })
})

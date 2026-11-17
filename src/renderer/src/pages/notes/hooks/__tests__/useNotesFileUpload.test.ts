/**
 * 拖入文件夹时 `readEntries` 只调一次。
 *
 * `FileSystemDirectoryReader.readEntries()` 按规范分批返回（Chromium 每批 100 项），只有拿到
 * 空批次才代表读完。旧实现只取第一批：拖入 100+ 项的文件夹时后 100 项被静默丢弃，页面照常弹
 * `notes.upload_success`；`files.length === 0` 的分支则完全静默。
 *
 * 行为级断言：
 *   ① 3 批（100 + 2 + 空）必须全部并入上传集合 → onUploadFiles 收到 102 个文件；
 *   ② 一个文件都没有时 onUploadFiles 不得被调用，且必须给出 `notes.no_valid_files` 警告。
 */
import { act, renderHook } from '@testing-library/react'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useNotesFileUpload } from '../useNotesFileUpload'

function makeFileEntry(name: string): FileSystemEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (callback: (file: File) => void) => callback(new File(['body'], name, { type: 'text/markdown' }))
  } as unknown as FileSystemEntry
}

function makeDirectoryEntry(name: string, batches: FileSystemEntry[][]): FileSystemDirectoryEntry {
  let call = 0
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (onSuccess: (entries: FileSystemEntry[]) => void) => {
        const batch = batches[call] ?? []
        call += 1
        onSuccess(batch)
      }
    })
  } as unknown as FileSystemDirectoryEntry
}

function makeDropEvent(entry: FileSystemEntry): React.DragEvent {
  return {
    preventDefault: vi.fn(),
    dataTransfer: {
      items: [{ webkitGetAsEntry: () => entry }],
      files: []
    }
  } as unknown as React.DragEvent
}

describe('useNotesFileUpload（目录批次读取）', () => {
  const onUploadFiles = vi.fn()
  const setIsDragOverSidebar = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as unknown as { toast: unknown }).toast = {
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn()
    }
  })

  it('读完目录的每一批：100 + 2 + 空 ⇒ 102 个文件全部进入上传集合', async () => {
    const firstBatch = Array.from({ length: 100 }, (_, index) => makeFileEntry(`a${index}.md`))
    const secondBatch = [makeFileEntry('b0.md'), makeFileEntry('b1.md')]
    const directory = makeDirectoryEntry('notes', [firstBatch, secondBatch, []])

    const { result } = renderHook(() => useNotesFileUpload({ onUploadFiles, setIsDragOverSidebar }))

    await act(async () => {
      await result.current.handleDropFiles(makeDropEvent(directory))
    })

    expect(onUploadFiles).toHaveBeenCalledTimes(1)
    const uploaded = onUploadFiles.mock.calls[0][0] as File[]
    // 旧实现只读第一批 ⇒ 这里会是 100。
    expect(uploaded).toHaveLength(102)
    expect(uploaded[101].name).toBe('b1.md')
    // 目录结构经 webkitRelativePath 保留（相对根目录的第一层前缀）。
    expect(uploaded[101].webkitRelativePath).toBe('notes/b1.md')
  })

  it('一个文件都没有时：不调上传，且给出可见警告（旧实现直接静默返回）', async () => {
    const directory = makeDirectoryEntry('empty', [[]])

    const { result } = renderHook(() => useNotesFileUpload({ onUploadFiles, setIsDragOverSidebar }))

    await act(async () => {
      await result.current.handleDropFiles(makeDropEvent(directory))
    })

    expect(onUploadFiles).not.toHaveBeenCalled()
    expect(window.toast.warning).toHaveBeenCalledTimes(1)
    // i18n 在 renderer.setup 已初始化：断言翻译后的用户可见文案而非裸键。
    expect(window.toast.warning).toHaveBeenCalledWith('No valid file was uploaded')
  })
})

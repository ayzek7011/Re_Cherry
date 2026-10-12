/**
 * 失败语义测试（钉死上游 cherry-studio v2 `useCodeHighlight` 的实现语义）：
 *
 * 1) 高亮失败时错误**向上抛出**（hook 内 try/finally，无 catch 吞错）；
 * 2) 失败不清空 tokenLines——已高亮状态保留，由下一次增量自然重试；
 * 3) processingRef 在 finally 复位，失败后下一次调用可正常继续；
 * 4) resetHighlight（主题切换）后，reset 之前起飞的旧结果按 generation 丢弃，不写回。
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import type { HighlightChunkResult } from '@renderer/services/ShikiStreamService'
import type { ThemedToken } from 'shiki/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useCodeHighlight } from '../useCodeHighlight'

const { cleanupTokenizersMock, highlightStreamingCodeMock } = vi.hoisted(() => ({
  cleanupTokenizersMock: vi.fn(),
  highlightStreamingCodeMock: vi.fn<() => Promise<HighlightChunkResult>>(async () => ({ lines: [], recall: 0 }))
}))

vi.mock('@renderer/context/CodeStyleProvider', () => ({
  useCodeStyle: () => ({
    activeShikiTheme: 'one-light',
    highlightStreamingCode: highlightStreamingCodeMock,
    cleanupTokenizers: cleanupTokenizersMock,
    getShikiPreProperties: async () => ({ class: '', style: '', tabindex: 0 }),
    isShikiThemeDark: false
  })
}))

const token = (content: string, color: string): ThemedToken => ({ content, color }) as ThemedToken

describe('useCodeHighlight failure semantics', () => {
  beforeEach(() => {
    cleanupTokenizersMock.mockClear()
    highlightStreamingCodeMock.mockClear()
    highlightStreamingCodeMock.mockImplementation(async () => ({ lines: [], recall: 0 }))
  })

  it('propagates the error and keeps the previous highlight when a later streaming call fails', async () => {
    const firstLines = [[token('const a = 1', '#111111')]]
    highlightStreamingCodeMock.mockResolvedValueOnce({ lines: firstLines, recall: -1 })

    const { result, rerender } = renderHook(
      ({ rawLines }: { rawLines: string[] }) =>
        useCodeHighlight({ rawLines, language: 'typescript', callerId: 'fail-caller' }),
      { initialProps: { rawLines: ['const a = 1'] } }
    )

    await act(async () => {
      await result.current.highlightLines()
    })
    expect(result.current.tokenLines).toEqual(firstLines)

    // 第二次增量失败：错误向上抛出（hook 不吞错），tokenLines 保持第一次的结果不被清空
    highlightStreamingCodeMock.mockRejectedValueOnce(new Error('boom'))
    rerender({ rawLines: ['const a = 1', 'const b = 2'] })
    await act(async () => {
      await expect(result.current.highlightLines()).rejects.toThrow('boom')
    })

    expect(result.current.tokenLines).toEqual(firstLines)
  })

  it('recovers on the next call after a failure (processingRef not wedged)', async () => {
    const firstLines = [[token('const a = 1', '#111111')]]
    highlightStreamingCodeMock.mockResolvedValueOnce({ lines: firstLines, recall: -1 })

    const { result, rerender } = renderHook(
      ({ rawLines }: { rawLines: string[] }) =>
        useCodeHighlight({ rawLines, language: 'typescript', callerId: 'recover-caller' }),
      { initialProps: { rawLines: ['const a = 1'] } }
    )
    await act(async () => {
      await result.current.highlightLines()
    })

    highlightStreamingCodeMock.mockRejectedValueOnce(new Error('boom'))
    rerender({ rawLines: ['const a = 1', 'const b = 2'] })
    await act(async () => {
      await expect(result.current.highlightLines()).rejects.toThrow('boom')
    })
    expect(result.current.tokenLines).toEqual(firstLines)

    // 失败后下一次调用恢复正常：processingRef 已在 finally 复位，新结果写入
    const secondLines = [...firstLines, [token('const b = 2', '#222222')]]
    highlightStreamingCodeMock.mockResolvedValueOnce({ lines: secondLines, recall: -1 })
    await act(async () => {
      await result.current.highlightLines()
    })

    expect(result.current.tokenLines).toEqual(secondLines)
    expect(highlightStreamingCodeMock).toHaveBeenCalledTimes(3)
  })

  it('discards an in-flight result that resolves after resetHighlight (generation guard)', async () => {
    let resolveInFlight!: (value: { lines: ThemedToken[][]; recall: number }) => void
    highlightStreamingCodeMock.mockImplementationOnce(
      () =>
        new Promise<{ lines: ThemedToken[][]; recall: number }>((resolve) => {
          resolveInFlight = resolve
        })
    )

    const { result } = renderHook(() =>
      useCodeHighlight({ rawLines: ['const a = 1', 'const b = 2'], language: 'typescript', callerId: 'gen-caller' })
    )

    let inFlight: Promise<void> = Promise.resolve()
    act(() => {
      inFlight = result.current.highlightLines()
    })
    await waitFor(() => expect(highlightStreamingCodeMock).toHaveBeenCalledTimes(1))

    // 主题切换：resetHighlight 清空并递增 generation
    act(() => {
      result.current.resetHighlight()
    })
    expect(result.current.tokenLines).toEqual([])

    // 旧结果此刻才返回：必须被丢弃，不得把旧主题 token 写回
    await act(async () => {
      resolveInFlight({ lines: [[token('stale', '#000000')]], recall: -1 })
    })
    await inFlight

    expect(result.current.tokenLines).toEqual([])
  })
})

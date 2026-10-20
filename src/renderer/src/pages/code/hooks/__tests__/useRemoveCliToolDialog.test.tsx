/**
 * useRemoveCliToolDialog 的 Promise<boolean> 语义（行为级）。
 *
 * 裁决是"卸载完成后关闭确认窗；失败保留窗口便于就地重试"。此前装配点把 remove 的
 * Promise<boolean> 吞成 void——失败（返回 false）也照常关窗，裁决在类型缝上断裂。
 * 这里把两侧都钉住：false ⇒ 窗保持打开；true ⇒ 关窗。
 */
import { CodeCli } from '@shared/types/codeCli'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useRemoveCliToolDialog } from '../useRemoveCliToolDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

describe('useRemoveCliToolDialog（失败保窗裁决）', () => {
  it('remove 返回 false：确认窗保持打开（可就地重试）', async () => {
    const remove = vi.fn(async () => false)
    const { result } = renderHook(() => useRemoveCliToolDialog({ toolName: 'DeepSeek Harness', remove }))

    act(() => {
      result.current.requestRemove(CodeCli.DEEPSEEK_HARNESS)
    })
    expect(result.current.removeDialogProps.open).toBe(true)

    await act(async () => {
      await result.current.removeDialogProps.onConfirm?.()
    })
    expect(remove).toHaveBeenCalledWith(CodeCli.DEEPSEEK_HARNESS)
    expect(result.current.removeDialogProps.open).toBe(true)
    expect(result.current.removeDialogProps.confirmLoading).toBe(false)
  })

  it('remove 返回 true：确认窗关闭', async () => {
    const remove = vi.fn(async () => true)
    const { result } = renderHook(() => useRemoveCliToolDialog({ toolName: 'DeepSeek Harness', remove }))

    act(() => {
      result.current.requestRemove(CodeCli.DEEPSEEK_HARNESS)
    })
    await act(async () => {
      await result.current.removeDialogProps.onConfirm?.()
    })
    expect(result.current.removeDialogProps.open).toBe(false)
  })
})

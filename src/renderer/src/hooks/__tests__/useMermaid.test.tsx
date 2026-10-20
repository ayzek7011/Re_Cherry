/**
 * useMermaid 模块级单点状态机（2026-10-20 重写）的行为级契约。
 *
 * 旧实现每个消费者各自 initialize（CodeStyleProvider + N 个预览 = N+1 次全局副作用，
 * 主题切换时各实例 forceRenderKey 各自 bump）。现契约：
 * ① initialize 只在（模块, 主题）组合变化时执行一次，并发消费者单飞；
 * ② 主题切换 → re-initialize + generation 递增广播；
 * ③ 同主题重挂载不再 initialize；
 * ④ initialize 失败落地 error，且不锁死重试路径（旧实现失败后 promise 恒 rejected）。
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { useMermaid as useMermaidHook } from '../useMermaid'

const { initialize, themeRef } = vi.hoisted(() => ({
  initialize: vi.fn(),
  themeRef: { current: 'light' as string }
}))

vi.mock('mermaid', () => ({ default: { initialize } }))
vi.mock('@renderer/context/ThemeProvider', () => ({
  useTheme: () => ({ theme: themeRef.current })
}))

describe('useMermaid（模块级单点状态机）', () => {
  // 运行时经动态 import 取**重置后**的模块实例（模块级状态跨用例隔离）；类型用静态导入。
  let useMermaid: typeof useMermaidHook

  beforeEach(async () => {
    vi.resetModules()
    initialize.mockReset()
    themeRef.current = 'light'
    useMermaid = (await import('../useMermaid')).useMermaid
  })

  it('① 首次挂载：加载并按当前主题 initialize 一次，generation 落 1', async () => {
    const { result } = renderHook(() => useMermaid())
    await act(async () => {})
    expect(initialize).toHaveBeenCalledTimes(1)
    expect(initialize).toHaveBeenCalledWith({ startOnLoad: false, theme: 'default' })
    expect(result.current.generation).toBe(1)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('② 并发消费者单飞：initialize 只跑一次', async () => {
    renderHook(() => useMermaid())
    const second = renderHook(() => useMermaid())
    await act(async () => {})
    expect(initialize).toHaveBeenCalledTimes(1)
    expect(second.result.current.generation).toBe(1)
  })

  it('③ 主题切换：按新主题 re-initialize，generation 递增', async () => {
    const { result, rerender } = renderHook(() => useMermaid())
    await act(async () => {})
    expect(result.current.generation).toBe(1)

    themeRef.current = 'dark'
    rerender()
    await act(async () => {})
    expect(initialize).toHaveBeenLastCalledWith({ startOnLoad: false, theme: 'dark' })
    expect(result.current.generation).toBe(2)
  })

  it('④ 同主题卸载重挂：不再 initialize', async () => {
    const first = renderHook(() => useMermaid())
    await act(async () => {})
    first.unmount()

    const second = renderHook(() => useMermaid())
    await act(async () => {})
    expect(initialize).toHaveBeenCalledTimes(1)
    expect(second.result.current.generation).toBe(1)
  })

  it('⑤ initialize 失败：error 落地且可重试（不锁死）', async () => {
    initialize.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const first = renderHook(() => useMermaid())
    await act(async () => {})
    expect(first.result.current.error).toBe('boom')
    expect(first.result.current.mermaid).toBeNull()

    // 重试（重挂载）：失败不留在模块状态里挡路。
    const second = renderHook(() => useMermaid())
    await act(async () => {})
    expect(second.result.current.error).toBeNull()
    expect(second.result.current.mermaid).toBeDefined()
    expect(second.result.current.generation).toBe(1)
  })
})

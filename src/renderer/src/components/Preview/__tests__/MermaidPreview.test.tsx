/**
 * MermaidPreview 渲染管线（2026-10-20 重写）的行为级契约。
 *
 * 背景（"渲染框在、内容看不见"）：旧实现在零宽容器里静默 return（空白框、无错无加载），
 * 绕过守卫的渲染让 mermaid 量出 0 宽、产出平移到画布外的图形（历史 scar：只对
 * translate(undefined, NaN) 打过一个正则补丁）；且没有任何宽度监听，坏图永远坏着。
 *
 * 六条契约：
 *   ① 正常路径：parse → render → 写 shadow host，diagramId 每次全新；
 *   ② 零宽搁置：不渲染、不报错，宽度出现（ResizeObserver）即补渲染；
 *   ③ 宽度变化 → 重渲染；阈值内不折腾；
 *   ④ 流式中间态失败：保持旧图、不闪错误块；
 *   ⑤ 稳定后失败：显示错误；恢复后清除；
 *   ⑥ 渲染纪元：慢的旧渲染不得覆盖新结果。
 */
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MermaidPreview } from '..'

const mocks = vi.hoisted(() => ({
  useMermaid: vi.fn(),
  ImagePreviewLayout: vi.fn(({ children, loading, error, enableToolbar, source }) => (
    <div data-testid="image-preview-layout" data-source={source}>
      {enableToolbar && <div data-testid="toolbar">Toolbar</div>}
      {loading && <div data-testid="loading">Loading...</div>}
      {error && <div data-testid="error">{error}</div>}
      <div data-testid="preview-content">{children}</div>
    </div>
  )),
  nanoidState: { counter: 0 }
}))

vi.mock('@renderer/hooks/useMermaid', () => ({
  useMermaid: () => mocks.useMermaid()
}))

vi.mock('@renderer/components/Preview/ImagePreviewLayout', () => ({
  default: mocks.ImagePreviewLayout
}))

vi.mock('@reduxjs/toolkit', () => ({
  nanoid: () => `id${++mocks.nanoidState.counter}`
}))

const { renderSvgInShadowHost } = vi.hoisted(() => ({
  renderSvgInShadowHost: vi.fn()
}))
vi.mock('../utils', () => ({
  renderSvgInShadowHost: renderSvgInShadowHost
}))

const SVG_RESULT = { svg: '<svg class="flowchart" viewBox="0 0 100 100"><g>test diagram</g></svg>' }
const mermaidCode = 'graph TD\nA-->B'

/** jsdom 没有 ResizeObserver；替身记录实例，测试手动触发回调（真实 RO 在 observe 后
 *  立即回报一次当前尺寸，这里由测试显式触发等价事件）。 */
class MockResizeObserver {
  static instances: MockResizeObserver[] = []
  callback: ResizeObserverCallback
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    MockResizeObserver.instances.push(this)
  }
  trigger(width: number): void {
    this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
}

/** 触发最新挂载实例的 RO 回调（组件 effect 在 observe 后即挂起回调）。 */
function triggerResize(width: number): void {
  const instance = MockResizeObserver.instances.at(-1)
  expect(instance).toBeDefined()
  act(() => {
    instance?.trigger(width)
  })
}

describe('MermaidPreview（重写后的渲染管线）', () => {
  const mockMermaid = {
    parse: vi.fn(),
    render: vi.fn()
  }

  beforeEach(() => {
    mocks.nanoidState.counter = 0
    MockResizeObserver.instances = []
    mocks.useMermaid.mockReturnValue({
      mermaid: mockMermaid,
      isLoading: false,
      error: null,
      generation: 1
    })
    mockMermaid.parse.mockResolvedValue(true)
    mockMermaid.render.mockResolvedValue(SVG_RESULT)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  async function mountAndSettle(content: string = mermaidCode) {
    const screen = render(<MermaidPreview>{content}</MermaidPreview>)
    // RO 初始回报（observe 后的等价事件）+ 防抖窗口 + promise 链冲刷。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      triggerResize(800)
      await vi.advanceTimersByTimeAsync(500)
    })
    return screen
  }

  it('① 正常路径：parse → render → 写 shadow host；diagramId 每次全新', async () => {
    await mountAndSettle()

    expect(mockMermaid.parse).toHaveBeenCalledWith(mermaidCode)
    expect(mockMermaid.render).toHaveBeenCalledTimes(1)
    const [diagramId, text, measureEl] = mockMermaid.render.mock.calls[0]
    expect(diagramId).toBe('mermaid-viz-id1')
    expect(text).toBe(mermaidCode)
    expect(measureEl).toBeInstanceOf(HTMLDivElement)
    expect(renderSvgInShadowHost).toHaveBeenCalledTimes(1)
    expect(renderSvgInShadowHost).toHaveBeenCalledWith(SVG_RESULT.svg, expect.any(HTMLDivElement))
  })

  it('② 零宽搁置：不渲染不报错；宽度出现即补渲染', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(0)
    const screen = render(<MermaidPreview>{mermaidCode}</MermaidPreview>)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      triggerResize(0)
      await vi.advanceTimersByTimeAsync(1000)
    })
    // 旧实现在这里静默 return 出空白框；新契约：不渲染、无错误、无成功写入。
    expect(mockMermaid.render).not.toHaveBeenCalled()
    expect(renderSvgInShadowHost).not.toHaveBeenCalled()
    expect(screen.queryByTestId('error')).toBeNull()

    // 宽度出现（折叠展开/挂载完成）→ 立即补渲染。
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    await act(async () => {
      triggerResize(800)
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(mockMermaid.render).toHaveBeenCalledTimes(1)
    expect(renderSvgInShadowHost).toHaveBeenCalledTimes(1)
  })

  it('③ 宽度变化 → 重渲染；阈值内不折腾', async () => {
    await mountAndSettle()
    expect(mockMermaid.render).toHaveBeenCalledTimes(1)

    await act(async () => {
      triggerResize(1024)
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(mockMermaid.render).toHaveBeenCalledTimes(2)

    // 阈值内（≤16px）不重渲染。
    await act(async () => {
      triggerResize(1030)
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(mockMermaid.render).toHaveBeenCalledTimes(2)
  })

  it('④ 流式中间态失败：保持旧图、不闪错误块；语法完整后自行恢复', async () => {
    mockMermaid.parse.mockRejectedValue(new Error('Incomplete diagram'))
    const screen = render(<MermaidPreview>{mermaidCode}</MermaidPreview>)
    await act(async () => {
      triggerResize(800)
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(renderSvgInShadowHost).not.toHaveBeenCalled()
    expect(screen.queryByTestId('error')).toBeNull()

    // 流式推进（内容变化重置 settle 窗口）+ 语法补全 → 下一轮渲染成功。
    mockMermaid.parse.mockResolvedValue(true)
    screen.rerender(<MermaidPreview>{`${mermaidCode}\nB-->C`}</MermaidPreview>)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(renderSvgInShadowHost).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('error')).toBeNull()
  })

  it('⑤ 稳定后失败：显示错误；恢复后清除', async () => {
    mockMermaid.parse.mockRejectedValue(new Error('Syntax error in graph'))
    const screen = render(<MermaidPreview>{mermaidCode}</MermaidPreview>)
    // 越过流式 settle 窗口再触发：这是稳定内容上的确定性失败，必须可见。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600)
      triggerResize(800)
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(screen.getByTestId('error')).toHaveTextContent('Syntax error in graph')

    mockMermaid.parse.mockResolvedValue(true)
    await act(async () => {
      triggerResize(1024)
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(screen.queryByTestId('error')).toBeNull()
  })

  it('⑥ 渲染纪元：慢的旧渲染不得覆盖新结果', async () => {
    await mountAndSettle()
    expect(renderSvgInShadowHost).toHaveBeenCalledTimes(1)

    // 第一次宽度渲染挂起（epoch2：1024px 的图还没算完）。
    let resolveStale!: (value: { svg: string }) => void
    mockMermaid.render.mockImplementationOnce(
      () => new Promise((resolve) => (resolveStale = resolve as (value: { svg: string }) => void))
    )
    await act(async () => {
      triggerResize(1024)
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(mockMermaid.render).toHaveBeenCalledTimes(2)

    // 更宽的容器再触发（epoch3，立即完成）——后来者先写入。
    await act(async () => {
      triggerResize(1200)
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(mockMermaid.render).toHaveBeenCalledTimes(3)
    expect(renderSvgInShadowHost).toHaveBeenCalledTimes(2)

    // 挂起的旧渲染此刻才完成：纪元已过期，写入必须被丢弃。
    await act(async () => {
      resolveStale({ svg: '<svg class="stale"></svg>' })
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(renderSvgInShadowHost).toHaveBeenCalledTimes(2)
    expect(renderSvgInShadowHost).not.toHaveBeenCalledWith('<svg class="stale"></svg>', expect.anything())
  })
})

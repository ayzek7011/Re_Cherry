/**
 * 图片视图整页 DOM 展开。
 *
 * 图片分类是唯一会随使用量单调增长的数据面（AI 出图与上传图片都归 image）。旧实现一次性为
 * **全部**图片渲染 `Image` + `Spin` + 删除按钮 + 信息条四层节点，几百张图时首帧明显卡顿。
 *
 * 行为级断言：
 *   ① 首帧只渲染首批（24 张），不是全部 30 张；
 *   ② 底部哨兵进入视口后才追加渲染剩余图片（30 张全部就位）；
 * ③ 图片总数少于一批时一次性渲染完，且不出现哨兵（不静默少显示）。
 */
import { configureStore } from '@reduxjs/toolkit'
import type { FileMetadata } from '@renderer/types'
import { act, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import FileList from '../FileList'

vi.mock('@renderer/services/FileManager', () => ({
  default: { getFileUrl: (file: { id: string }) => `file:///${file.id}.png` }
}))

// FileList 订阅 runtime.filesPath（启动竞态修复：路径晚到才揭示图片），测试态给固定值。
const store = configureStore({ reducer: { runtime: () => ({ filesPath: 'C:\\userData\\Data\\Files' }) } })
const withStore = (ui: React.ReactElement) => <Provider store={store}>{ui}</Provider>

vi.mock('@renderer/services/FileAction', () => ({
  handleDelete: vi.fn()
}))

vi.mock('@renderer/components/VirtualList', () => ({
  DynamicVirtualList: () => <div data-testid="virtual-list" />
}))

type ObserverCallback = ConstructorParameters<typeof IntersectionObserver>[0]

let observerCallbacks: ObserverCallback[] = []
let observedCount = 0

class MockIntersectionObserver implements IntersectionObserver {
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds: ReadonlyArray<number> = []
  constructor(callback: ObserverCallback) {
    observerCallbacks.push(callback)
  }
  observe() {
    observedCount += 1
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

function makeFile(index: number): FileMetadata {
  return {
    id: `file-${index}`,
    origin_name: `image-${index}.png`,
    name: `file-${index}.png`,
    path: `/files/file-${index}.png`,
    ext: '.png',
    type: 'image',
    size: 1024,
    count: 1,
    created_at: '2026-01-01T00:00:00.000Z'
  } as unknown as FileMetadata
}

const list = [] as {
  key: string
  file: React.ReactNode
  size: string
  ext: string
  created_at: string
  actions: React.ReactNode
}[]

describe('FileList · 图片视图（按需揭示）', () => {
  beforeEach(() => {
    observerCallbacks = []
    observedCount = 0
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
    // antd 的响应式栅格（Row/Col）需要 matchMedia，jsdom 不提供。
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })

  it('30 张图：首帧只渲染 24 张并挂出哨兵，哨兵进入视口后补齐 30 张', () => {
    const files = Array.from({ length: 30 }, (_, index) => makeFile(index))
    const { container, getByTestId } = render(withStore(<FileList id="image" list={list} files={files} />))

    expect(container.querySelectorAll('img')).toHaveLength(24)
    expect(getByTestId('file-list-reveal-sentinel')).toBeInTheDocument()
    expect(observedCount).toBe(1)

    act(() => {
      observerCallbacks[observerCallbacks.length - 1](
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })

    expect(container.querySelectorAll('img')).toHaveLength(30)
    // 全部到位后不再挂哨兵（否则会无限追加）。
    expect(container.querySelector('[data-testid="file-list-reveal-sentinel"]')).toBeNull()
  })

  it('6 张图（不足一批）：一次性渲染全部，且没有哨兵', () => {
    const files = Array.from({ length: 6 }, (_, index) => makeFile(index))
    const { container } = render(withStore(<FileList id="image" list={list} files={files} />))

    expect(container.querySelectorAll('img')).toHaveLength(6)
    expect(container.querySelector('[data-testid="file-list-reveal-sentinel"]')).toBeNull()
  })
})

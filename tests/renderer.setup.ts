import '@testing-library/jest-dom/vitest'

import { createRequire } from 'node:module'
import { styleSheetSerializer } from 'jest-styled-components/serializer'
import { expect, vi } from 'vitest'

import { initI18n } from '../src/renderer/src/i18n'

const require = createRequire(import.meta.url)
const bufferModule = require('buffer')
if (!bufferModule.SlowBuffer) {
  bufferModule.SlowBuffer = bufferModule.Buffer
}

expect.addSnapshotSerializer(styleSheetSerializer)

// Mock LoggerService globally for renderer tests
vi.mock('@logger', async () => {
  const { MockRendererLoggerService, mockRendererLoggerService } = await import('./__mocks__/RendererLoggerService')
  return {
    LoggerService: MockRendererLoggerService,
    loggerService: mockRendererLoggerService
  }
})

// Mock uuid globally for renderer tests
let uuidCounter = 0
vi.mock('uuid', () => ({
  v4: () => 'test-uuid-' + ++uuidCounter
}))

vi.mock('axios', () => {
  const defaultAxiosMock = {
    get: vi.fn().mockResolvedValue({ data: {} }), // Mocking axios GET request
    post: vi.fn().mockResolvedValue({ data: {} }) // Mocking axios POST request
    // You can add other axios methods like put, delete etc. as needed
  }

  const isAxiosError = (error: unknown): error is { isAxiosError?: boolean } =>
    Boolean((error as { isAxiosError?: boolean } | undefined)?.isAxiosError)

  return {
    default: defaultAxiosMock,
    isAxiosError
  }
})

// Mock ResizeObserver for jsdom environment
vi.stubGlobal(
  'ResizeObserver',
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
)

vi.stubGlobal('electron', {
  ipcRenderer: {
    on: vi.fn(),
    send: vi.fn(),
    invoke: vi.fn().mockResolvedValue(undefined)
  }
})
vi.stubGlobal('api', {
  file: {
    read: vi.fn().mockResolvedValue('[]'),
    writeWithId: vi.fn().mockResolvedValue(undefined)
  }
})

if (typeof globalThis.localStorage === 'undefined' || typeof (globalThis.localStorage as any).getItem !== 'function') {
  let store = new Map<string, string>()

  const localStorageMock = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value))
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    }
  }

  vi.stubGlobal('localStorage', localStorageMock)
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: localStorageMock })
  }
}

// i18n 懒语言包（问题5 #4）：i18n/index.ts 不再在模块导入时自初始化，改为三窗口
// 入口显式 initI18n()。渲染层测试在 setup 里完成等价初始化，组件拿到的实例与生产一致。
await initI18n()

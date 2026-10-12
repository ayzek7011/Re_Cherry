/* oxlint-disable @typescript-eslint/no-empty-function */

// Simple mock LoggerService class for renderer process
export class MockRendererLoggerService {
  private static instance: MockRendererLoggerService

  public static getInstance(): MockRendererLoggerService {
    if (!MockRendererLoggerService.instance) {
      MockRendererLoggerService.instance = new MockRendererLoggerService()
    }
    return MockRendererLoggerService.instance
  }

  public static resetInstance(): void {
    MockRendererLoggerService.instance = new MockRendererLoggerService()
  }

  // 与真实 LoggerService.initWindowSource（返回 LoggerService 实例，支持链式 `.withContext`）同契约。
  // 返回 void 会让 `initWindowSource('W').withContext(...)` 的模块顶层链式调用在测试里炸掉
  // （shiki-stream.worker.ts 即此写法）。
  public initWindowSource(): MockRendererLoggerService {
    return this
  }
  public withContext(): MockRendererLoggerService {
    return this
  }
  public setLevel(): void {}
  public getLevel(): string {
    return 'silly'
  }
  public resetLevel(): void {}
  public error(...args: any[]): void {
    console.error(...args)
  }
  public warn(...args: any[]): void {
    console.warn(...args)
  }
  public info(...args: any[]): void {
    console.info(...args)
  }
  public verbose(...args: any[]): void {
    console.log(...args)
  }
  public debug(...args: any[]): void {
    console.debug(...args)
  }
  public silly(...args: any[]): void {
    console.log(...args)
  }
}

// Create and export the mock instance
export const mockRendererLoggerService = MockRendererLoggerService.getInstance()

// Mock the LoggerService module
const RendererLoggerServiceMock = {
  LoggerService: MockRendererLoggerService,
  loggerService: mockRendererLoggerService
}

export default RendererLoggerServiceMock

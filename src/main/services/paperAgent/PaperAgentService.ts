// fork 缝（原创）：Paper-Agent 受管 Web UI 生命周期。
// 与 DeepSeekHarnessService/HermesDashboardService 同构（单例 + operationMutex + 状态广播 +
// killSync 同步杀树），差别有三，都是源码型工具固有：
// ① 启动物是受管 venv 解释器（不是 PATH 上的可执行物）：`python -m uvicorn main:app`；
// ② 代码与用户态分离靠 uvicorn `--app-dir`：cwd = home/paper-agent（用户态根：config/
//    model.json、config/system.yaml、data/、logs/、front/dist——该工具全部路径都是 cwd
//    相对，见 src/api/app.py 的 _mount_frontend 与 src/llm/config.py），代码树在
//    tools/paper-agent/src。于是升级整树替换源码时用户数据天然不受影响。
// ③ 不经 main.py 启动：它的 uvicorn.run(reload=True) 是开发语义（文件监视器 + 双进程），
//    受管启动要的是单进程生产形态，因此直接跑 uvicorn 模块。
// 端口取 0（自动分配）→ 从 uvicorn 启动行解析实际端口（dsh parseReadyUrl 同款做法）。

import { type ChildProcess, execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { isWin } from '@main/constant'
import {
  sourceTreeDir as managedSourceTreeDir,
  sourceVenvPython as managedSourceVenvPython,
  toolDir as managedToolDir
} from '@main/services/binaryManager/layout'
import { codeMateToolHome } from '@main/services/deepSeekHarness/paths'
import { crossPlatformSpawn, terminateProcessTree, waitForProcessExit } from '@main/utils/processRunner'
import { IpcChannel } from '@shared/IpcChannel'
import type { ManagedToolStatus, ManagedToolStatusState } from '@shared/types/managedTool'
import { redactSecretText } from '@shared/utils/redaction'
import { Mutex } from 'async-mutex'
import { BrowserWindow } from 'electron'

const logger = loggerService.withContext('PaperAgentService')

const HOST = '127.0.0.1'
const START_TIMEOUT_MS = 60_000
const READY_PROBE_INTERVAL_MS = 300
const READY_PROBE_TIMEOUT_MS = 2_000
const GRACEFUL_STOP_TIMEOUT_MS = 3_000
const FORCE_STOP_TIMEOUT_MS = 1_000
const OUTPUT_CAPTURE_LIMIT = 32 * 1024
const DIAGNOSTIC_LIMIT = 2_000
const TOOL_NAME = 'paper-agent'
const VERSION_MARKER = '.codemate-version'

export type PaperAgentStartFailureReason = 'not_installed' | 'cancelled' | 'startup_failed'

class PaperAgentStartError extends Error {
  constructor(
    readonly reason: PaperAgentStartFailureReason,
    message: string
  ) {
    super(message)
    this.name = 'PaperAgentStartError'
  }
}

/** 受管布局（取自 binaryManager/layout.ts 单点——本服务此前各自维护一份
 * toolDir/venvPython/sourceTreeDir，与安装器、解析器三处并列，正是会漂移的那种清单）。 */
function toolDir(): string {
  return managedToolDir(TOOL_NAME)
}
function sourceTreeDir(): string {
  return managedSourceTreeDir(TOOL_NAME)
}
function venvPython(): string {
  return managedSourceVenvPython(TOOL_NAME)
}
function userHome(): string {
  return codeMateToolHome(TOOL_NAME)
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

function appendBounded(current: string, chunk: Buffer | string): string {
  return `${current}${chunk.toString()}`.slice(-OUTPUT_CAPTURE_LIMIT)
}

function sanitizeDiagnostic(value: string): string {
  return redactSecretText(value).slice(0, DIAGNOSTIC_LIMIT)
}

/** ANSI 颜色码：正则字面量里的 ESC 控制字符会触发 no-control-regex，故用字符码构造
 * （uvicorn 在管道下通常无色，这里只防上游将来打开颜色）。 */
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/** uvicorn 启动行 → 实际端口。 */
function parseReadyPort(output: string): number | undefined {
  const plain = output.replace(ANSI_PATTERN, '')
  for (const match of plain.matchAll(/Uvicorn running on http:\/\/127\.0\.0\.1:(\d+)/g)) {
    const port = Number(match[1])
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port
  }
  return undefined
}

class PaperAgentService {
  private readonly operationMutex = new Mutex()
  private status: ManagedToolStatus = 'stopped'
  private url: string | undefined
  private child: ChildProcess | null = null
  private stoppingChild: ChildProcess | null = null
  private readonly startupAbortControllers = new Set<AbortController>()
  // Bumped by every status publication; request paths use it to detect no-op completions.
  private statusTransitionId = 0

  constructor() {
    this.publishStatus()
  }

  getStatus(): ManagedToolStatusState {
    return { status: this.status, ...(this.url ? { url: this.url } : {}) }
  }

  /** before-quit 同步杀进程用（Windows 子进程不随父退出；异步 will-quit 跑不完）。 */
  get runningPid(): number | undefined {
    return this.child?.pid ?? undefined
  }

  killSync(): void {
    const pid = this.child?.pid
    if (!pid) return
    try {
      if (isWin) {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 5000, windowsHide: true })
      } else {
        process.kill(-pid, 'SIGKILL')
      }
      logger.info(`code-mate: killed paper-agent process tree (pid ${pid}) on quit`)
    } catch (error) {
      logger.warn(`code-mate: failed to kill paper-agent process tree on quit`, error as Error)
    }
    this.child = null
    this.status = 'stopped'
    this.url = undefined
  }

  /** Single status-transition point（全窗口事件广播）。 */
  private setStatus(status: ManagedToolStatus, options?: { force?: boolean }): void {
    if (!options?.force && this.status === status) return
    this.status = status
    this.statusTransitionId++
    this.publishStatus()
  }

  private publishStatus(): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IpcChannel.CodeCli_PaperAgent_Status, this.getStatus())
    }
  }

  async start(): Promise<
    { success: true; url: string } | { success: false; reason: PaperAgentStartFailureReason; message: string }
  > {
    const startupAbortController = new AbortController()
    this.startupAbortControllers.add(startupAbortController)
    try {
      return await this.operationMutex.runExclusive(async () => {
        if (startupAbortController.signal.aborted) {
          return { success: false as const, reason: 'cancelled' as const, message: 'Paper-Agent startup was cancelled' }
        }
        // 幂等：已在运行 → 直接给当前 URL（不重启进程）。
        // （）：这里总是重播一次状态——幂等成功不产生状态变化（也就不会自动广播），
        // 而渲染层可能错过过更早的更新。原写法先取 transitionBefore 再立刻比较，条件恒真
        // （复制自 stop() 的形状，那里跨 await 才有意义），是死条件而非判断。
        if (this.child && this.status === 'running' && this.url) {
          this.setStatus('running', { force: true })
          return { success: true as const, url: this.url }
        }

        const pythonBin = venvPython()
        if (!(await pathExists(pythonBin)) || !(await pathExists(path.join(toolDir(), VERSION_MARKER)))) {
          return {
            success: false as const,
            reason: 'not_installed' as const,
            message: 'Paper-Agent is not installed'
          }
        }
        // 用户态部署产物缺失（安装中断的形态）——启动会得到 FastAPI 的空壳页，显式拒绝。
        const home = userHome()
        if (!(await pathExists(path.join(home, 'front', 'dist', 'index.html')))) {
          return {
            success: false as const,
            reason: 'not_installed' as const,
            message: 'Paper-Agent Web UI assets are missing; reinstall the tool'
          }
        }
        await fsp.mkdir(path.join(home, 'logs'), { recursive: true })

        try {
          // Reaping a leftover child belongs inside the try so a failing stop is mapped to
          // a failure Result, not thrown out of start()（hermes 同款；裸 reject 会被 handler
          // 兜成语义错误的 startup_failed 且无状态广播）。
          if (this.child) await this.stopOwnedProcessLocked()
          this.url = undefined
          this.setStatus('starting')
          const url = await this.spawnAndWaitForReady(pythonBin, home, startupAbortController.signal)
          this.url = url
          this.setStatus('running')
          return { success: true as const, url }
        } catch (error) {
          // Terminal state first: the cleanup-driven termination handler must not
          // publish 'stopped' for a failed launch on its way to 'error'.
          this.url = undefined
          this.setStatus('error')
          const aborted = startupAbortController.signal.aborted
          const message = error instanceof Error ? error.message : 'Failed to start Paper-Agent'
          if (!aborted) {
            logger.warn('Paper-Agent failed to start', { message: sanitizeDiagnostic(message) })
          }
          await this.stopOwnedProcessLocked().catch((stopError) => {
            logger.warn('Failed to stop Paper-Agent after launch failure', stopError as Error)
          })
          return {
            success: false as const,
            reason: aborted ? ('cancelled' as const) : ('startup_failed' as const),
            message: sanitizeDiagnostic(message) || 'Failed to start Paper-Agent'
          }
        }
      })
    } finally {
      this.startupAbortControllers.delete(startupAbortController)
    }
  }

  async stop(): Promise<void> {
    for (const startup of this.startupAbortControllers) startup.abort()
    await this.operationMutex.runExclusive(async () => {
      const transitionBefore = this.statusTransitionId
      try {
        await this.stopOwnedProcessLocked()
        this.url = undefined
        this.setStatus('stopped')
        // A no-op stop (already stopped) still confirms the terminal state to the renderer.
        if (this.statusTransitionId === transitionBefore) this.setStatus('stopped', { force: true })
      } catch (error) {
        // stop 失败是故障态：先落 error 再上抛（与 hermes 同构——失败后状态不得停在 running）。
        this.setStatus('error')
        throw error
      }
    })
  }

  private async spawnAndWaitForReady(pythonBin: string, home: string, signal: AbortSignal): Promise<string> {
    const sourceDir = sourceTreeDir()
    if (!(await pathExists(path.join(sourceDir, 'main.py')))) {
      throw new PaperAgentStartError('not_installed', `Paper-Agent source tree is missing at ${sourceDir}`)
    }
    // PYTHONUTF8/PYTHONUNBUFFERED：管道下 Python 默认按 ANSI 代码页写 stdout（中文日志在这
    // 一侧会解码成乱码），且块缓冲会让启动行/崩溃栈迟到——两个都钉住。
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONUNBUFFERED: '1',
      PAPERS_LOG_DIR: path.join(home, 'logs')
    }
    const child = crossPlatformSpawn(
      pythonBin,
      ['-m', 'uvicorn', 'main:app', '--app-dir', sourceDir, '--host', HOST, '--port', '0'],
      {
        cwd: home,
        env,
        detached: !isWin,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    this.child = child
    const handleTermination = (code: number | null, signal: NodeJS.Signals | null) =>
      this.handleChildTermination(child, code, signal)
    child.once('exit', handleTermination)
    child.once('close', handleTermination)
    child.on('error', (error) => {
      if (this.child === child && this.status === 'running') this.setStatus('error')
      logger.warn('Managed Paper-Agent process error', { message: sanitizeDiagnostic(error.message) })
    })

    return waitForReady(child, signal)
  }

  private handleChildTermination(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return
    this.child = null
    this.url = undefined
    if (this.stoppingChild === child) {
      this.stoppingChild = null
      if (this.status === 'starting' || this.status === 'running') this.setStatus('stopped')
      return
    }
    if (this.status === 'starting' || this.status === 'running') {
      this.setStatus('error')
      logger.warn('Managed Paper-Agent process exited unexpectedly', { code, signal })
    }
  }

  private async stopOwnedProcessLocked(): Promise<void> {
    const child = this.child
    if (!child) return
    this.stoppingChild = child
    try {
      await terminateProcessTree(child, false, 'Paper-Agent')
      if (await waitForProcessExit(child, GRACEFUL_STOP_TIMEOUT_MS)) return

      await terminateProcessTree(child, true, 'Paper-Agent')
      if (!(await waitForProcessExit(child, FORCE_STOP_TIMEOUT_MS))) {
        throw new Error('Paper-Agent did not exit after forced termination')
      }
    } catch (error) {
      // 清掉 stoppingChild 再上抛：否则该 child 真正退出时会被迟到回调当成受控停止分支
      // 处理（hermes 同款清理）。
      if (this.stoppingChild === child) this.stoppingChild = null
      throw error
    }
  }
}

/** 就绪探测：解析 uvicorn 启动行拿到端口 → HTTP 探活（2xx/3xx/304 皆就绪）。 */
function waitForReady(child: ChildProcess, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let probing = false

    const cleanup = () => {
      clearTimeout(timeout)
      child.stdout?.off('data', onStdout)
      child.stderr?.off('data', onStderr)
      child.off('error', onError)
      child.off('exit', onClose)
      child.off('close', onClose)
      signal.removeEventListener('abort', onAbort)
      child.stdout?.resume()
      child.stderr?.resume()
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      const diagnostic = sanitizeDiagnostic([error.message, stderr, stdout].filter(Boolean).join('\n'))
      reject(new Error(diagnostic || 'Paper-Agent failed during startup'))
    }
    const probe = async (port: number) => {
      const url = `http://${HOST}:${port}`
      const deadline = Date.now() + START_TIMEOUT_MS
      while (!settled && Date.now() < deadline) {
        if (signal.aborted) {
          fail(new PaperAgentStartError('cancelled', 'Paper-Agent startup was cancelled'))
          return
        }
        try {
          const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(READY_PROBE_TIMEOUT_MS) })
          await response.body?.cancel()
          // 就绪的事实是"HTTP 服务在响应"——不锚重定向目标（dsh 批次事故：上游改重定向
          // 目标把活着的服务误杀）。
          if ((response.status >= 200 && response.status < 400) || response.status === 304) {
            if (settled) return
            settled = true
            cleanup()
            resolve(url)
            return
          }
        } catch {
          // 端口已 bind 但路由未就绪 → 继续轮询。
        }
        await new Promise((r) => setTimeout(r, READY_PROBE_INTERVAL_MS))
      }
      if (!settled) fail(new Error(`Paper-Agent Web UI did not become ready at ${url}`))
    }
    const onStdout = (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk)
      if (probing) return
      const port = parseReadyPort(stdout)
      if (!port) return
      probing = true
      void probe(port)
    }
    const onStderr = (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk)
    }
    const onError = (error: Error) => fail(error)
    const onAbort = () => fail(new PaperAgentStartError('cancelled', 'Paper-Agent startup was cancelled'))
    const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
      fail(new Error(`Paper-Agent exited before it was ready (code ${String(code)}, signal ${String(signal)})`))
    const timeout = setTimeout(() => fail(new Error('Paper-Agent startup timed out')), START_TIMEOUT_MS)

    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.once('error', onError)
    child.once('exit', onClose)
    child.once('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

export const paperAgentService = new PaperAgentService()

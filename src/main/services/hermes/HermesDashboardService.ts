// fork 移植自 cherry-studio v2 src/main/services/HermesDashboardService.ts
// （2026-09-24）。启动互斥 / findAvailablePort / HERMES_HOME 钉住 / /api/status
// 探活（home 匹配 + realpath 兜底）/ 停止语义（SIGTERM→3s→SIGKILL→1s）/ 诊断卫生化逐字。
// 缝点（行内标注 `// fork 缝：`）：
// ① V2 生命周期容器（BaseService/@Injectable/@ServicePhase/onInit/onStop）→ fork 单例壳
//    （照 deepSeekHarness/DeepSeekHarnessService.ts 先例）：onInit 的 CacheService 发布 →
//    构造器 publishStatus() 全窗口广播；onStop 不搬（见 isLifecycleStopping 字段缝注）。
// ② V2 的 HermesDashboardStatus / HermesDashboardStartFailureReason 定义在
//    @shared/ipc/schemas/hermesDashboard（zod 路由层，fork 不引入；本批清单只许改三个
//    文件）→ 收进本文件导出，status 同形于 @shared/types/managedTool 的 ManagedToolStatus。
// ③ BinaryManager.getToolSnapshots（definition/operation 安装态分支）→ 的 PATH
// 探测 resolveBinary('hermes')，availability 收窄为 null 判定；安装器升级。
// ④ CacheService.setShared('feature.hermes_dashboard.status') → 全窗口事件广播
//    （publishStatus，逐窗 webContents.send）。
// ⑤ V2 的 hermes home 经 application.getPath(...)（pathRegistry）→ getHermesHome()
//    （services/codeCli/hermesHome.ts，钉进 CodeMate 子树）；AbsoluteFilePath 品牌类型
//    未移植，退化为 string。V2 无 workspace 概念（spawn 无 cwd），fork 不造。

import type { ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'

import { loggerService } from '@logger'
import { isWin } from '@main/constant'
import { crossPlatformSpawn, terminateProcessTree, waitForProcessExit } from '@main/utils/processRunner'
import { getRawShellEnv, refreshShellEnv } from '@main/utils/shellEnv'
import { IpcChannel } from '@shared/IpcChannel'
import type { ManagedToolStatusState } from '@shared/types/managedTool'
import { redactSecretText } from '@shared/utils/redaction'
import { Mutex } from 'async-mutex'
import { BrowserWindow } from 'electron'

import { getHermesHome } from '../codeCli/hermesHome'
import { resolveBinary } from '../codeCli/resolveBinary'

// fork 缝②：见文件头。
export type HermesDashboardStatus = 'stopped' | 'starting' | 'running' | 'error'
export type HermesDashboardStartFailureReason =
  | 'not_installed'
  | 'dashboard_dependencies_missing'
  | 'cancelled'
  | 'startup_failed'

const logger = loggerService.withContext('HermesDashboardService')

const DASHBOARD_HOST = '127.0.0.1'
const START_TIMEOUT_MS = 30_000
const HEALTH_PROBE_TIMEOUT_MS = 2_000
const HEALTH_PROBE_INTERVAL_MS = 250
const GRACEFUL_STOP_TIMEOUT_MS = 3_000
const FORCE_STOP_TIMEOUT_MS = 1_000
const OUTPUT_CAPTURE_LIMIT = 32 * 1024
const DIAGNOSTIC_LIMIT = 2_000

// fork 缝⑤：AbsoluteFilePath → string。
interface HermesDashboardRuntime {
  env: NodeJS.ProcessEnv
  executablePath: string
  home: string
}

class HermesDashboardStartError extends Error {
  constructor(
    readonly reason: HermesDashboardStartFailureReason,
    message: string
  ) {
    super(message)
    this.name = 'HermesDashboardStartError'
  }
}

export class HermesDashboardService {
  private readonly operationMutex = new Mutex()
  private readonly startupAbortControllers = new Set<AbortController>()
  private child: ChildProcess | null = null
  // V2 用 onStop 置位的 `isLifecycleStopping` 与它守护的早退分支已删除——
  // fork 没有生命周期容器，该字段自始至终恒 false，那条 `reason: 'cancelled'` 是不可达路径。
  // 「退出窗口期拒绝启动」的真守卫在下面那条 `signal.aborted` 检查里（可实际触发）。
  private status: HermesDashboardStatus = 'stopped'
  private stoppingChild: ChildProcess | null = null
  private url: string | undefined
  // Bumped by every status publication; request paths use it to detect no-op completions.
  private statusTransitionId = 0

  constructor() {
    this.publishStatus()
  }

  getStatus(): ManagedToolStatusState {
    return { status: this.status, ...(this.url ? { url: this.url } : {}) }
  }

  /** before-quit 同步杀进程用（同 DeepSeekHarnessService.runningPid）。 */
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
      logger.info(`code-mate: killed hermes process tree (pid ${pid}) on quit`)
    } catch (error) {
      logger.warn(`code-mate: failed to kill hermes process tree on quit`, error as Error)
    }
    this.child = null
    this.status = 'stopped'
    this.url = undefined
  }

  /** Serializes native Hermes config mutations with the Dashboard lifecycle. */
  async writeConfigFiles<T>(write: () => Promise<T>): Promise<T> {
    return this.operationMutex.runExclusive(async () => {
      if (this.child || this.stoppingChild || this.status === 'starting' || this.status === 'running') {
        throw new Error('Hermes Agent web UI is running, so its configuration cannot be changed')
      }
      return write()
    })
  }

  async start(): Promise<
    { success: true; url: string } | { success: false; reason: HermesDashboardStartFailureReason; message: string }
  > {
    const startupAbortController = new AbortController()
    this.startupAbortControllers.add(startupAbortController)
    try {
      return await this.operationMutex.runExclusive(async () => {
        if (startupAbortController.signal.aborted) {
          return { success: false, reason: 'cancelled', message: 'Hermes Dashboard startup was cancelled' }
        }
        if (this.child && this.status === 'running' && this.url) {
          // Idempotent success publishes nothing on its own — republish so a
          // renderer that missed an earlier update is corrected by this request.
          this.setStatus('running', this.url, { force: true })
          return { success: true, url: this.url }
        }

        try {
          // Reaping a leftover child belongs inside the try so a failing stop is
          // mapped to a failure Result, not thrown out of start().
          if (this.child) await this.stopOwnedProcessLocked()
          this.setStatus('starting')
          const runtime = await this.resolveRuntime()
          if (startupAbortController.signal.aborted) {
            throw new HermesDashboardStartError('cancelled', 'Hermes Dashboard startup was cancelled')
          }
          const port = await findAvailablePort()
          if (startupAbortController.signal.aborted) {
            throw new HermesDashboardStartError('cancelled', 'Hermes Dashboard startup was cancelled')
          }
          const url = `http://${DASHBOARD_HOST}:${port}`
          await this.spawnAndWaitForReady(runtime, port, url, startupAbortController.signal)
          if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) {
            throw new HermesDashboardStartError(
              'startup_failed',
              'Hermes Dashboard exited immediately after becoming ready'
            )
          }
          this.setStatus('running', url)
          return { success: true, url }
        } catch (error) {
          await this.stopOwnedProcessLocked().catch((stopError) => {
            logger.warn('Failed to stop Hermes Dashboard after launch failure', stopError as Error)
          })
          this.setStatus('error')
          const message = sanitizeDiagnostic(
            error instanceof Error ? error.message : 'Failed to start Hermes Dashboard'
          )
          return {
            success: false,
            reason: getStartFailureReason(error, message),
            message
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
        this.setStatus('stopped')
        // A no-op stop (already stopped) still confirms the terminal state to the renderer.
        if (this.statusTransitionId === transitionBefore) this.setStatus('stopped', undefined, { force: true })
      } catch (error) {
        this.setStatus('error')
        throw error
      }
    })
  }

  // fork 缝③⑤：V2 走 BinaryManager 快照并按 snapshot.availability（definition/operation）
  // 分支；只有 PATH 探测——availability 收窄为 resolveBinary 的 null 判定，
  // executablePath 免 parse（AbsoluteFilePathSchema 未移植）。HERMES_HOME 钉住逻辑逐字。
  private async resolveRuntime(): Promise<HermesDashboardRuntime> {
    const binary = await resolveBinary('hermes')
    if (!binary) {
      throw new HermesDashboardStartError('not_installed', 'Hermes is not installed')
    }
    // 真机加固：PATH 命中 ≠ 可用——hermes 若装的时候没带 [web] extras（没有
    // dashboard 子命令）或为损坏/旧版安装，`--version` 探针都可能过不了；启动前显式
    // 拒绝并指引导向受管安装，不再放行到 "exited before it was ready" 哑弹。
    if (!binary.runnable) {
      throw new HermesDashboardStartError(
        'not_installed',
        `Found Hermes at ${binary.path} but it failed to run (--version).${binary.probeDetail ? ` Reason: ${binary.probeDetail}.` : ''} It may lack the dashboard capability or be a broken installation — install the managed version from the CodeMate panel.`
      )
    }
    const env = binary.source === 'system' ? await getRawShellEnv() : await refreshShellEnv()
    const home = await getHermesHome()
    // Pin the Dashboard to the same home config writes target, so it reads what
    // Cherry wrote regardless of how Hermes would resolve its default.
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'hermes_home') delete env[key]
    }
    env.HERMES_HOME = home
    return { env, executablePath: binary.path, home }
  }

  private async spawnAndWaitForReady(
    runtime: HermesDashboardRuntime,
    port: number,
    url: string,
    signal: AbortSignal
  ): Promise<void> {
    const child = crossPlatformSpawn(
      runtime.executablePath,
      ['dashboard', '--host', DASHBOARD_HOST, '--port', String(port), '--no-open'],
      {
        env: runtime.env,
        detached: !isWin,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    )
    this.child = child
    const handleTermination = (code: number | null, childSignal: NodeJS.Signals | null) =>
      this.handleChildTermination(child, code, childSignal)
    child.once('exit', handleTermination)
    child.once('close', handleTermination)
    child.on('error', (error) => {
      if (this.child === child && this.status === 'running') this.setStatus('error')
      logger.warn('Managed Hermes Dashboard process error', { message: sanitizeDiagnostic(error.message) })
    })

    await waitForReady(child, url, runtime.home, signal)
  }

  private handleChildTermination(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return
    this.child = null
    if (this.stoppingChild === child) {
      this.stoppingChild = null
      this.setStatus('stopped')
      return
    }
    if (this.status === 'starting' || this.status === 'running') {
      this.setStatus('error')
      logger.warn('Managed Hermes Dashboard process exited unexpectedly', { code, signal })
    }
  }

  /** Single status-transition point（fork 缝④：V2 的 CacheService.setShared → 全窗口广播）。 */
  private setStatus(status: HermesDashboardStatus, url?: string, options?: { force?: boolean }): void {
    if (!options?.force && this.status === status) return
    this.status = status
    this.url = url
    this.statusTransitionId++
    this.publishStatus()
  }

  private publishStatus(): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IpcChannel.CodeCli_HermesDashboard_Status, this.getStatus())
    }
  }

  private async stopOwnedProcessLocked(): Promise<void> {
    const child = this.child
    if (!child) return
    if (!child.pid) {
      this.child = null
      if (this.stoppingChild === child) this.stoppingChild = null
      return
    }
    this.stoppingChild = child
    try {
      await terminateProcessTree(child, false, 'Hermes Dashboard')
      if (await waitForProcessExit(child, GRACEFUL_STOP_TIMEOUT_MS)) return

      await terminateProcessTree(child, true, 'Hermes Dashboard')
      if (!(await waitForProcessExit(child, FORCE_STOP_TIMEOUT_MS))) {
        throw new Error('Hermes Dashboard did not exit after forced termination')
      }
    } catch (error) {
      if (this.stoppingChild === child) this.stoppingChild = null
      throw error
    }
  }
}

async function findAvailablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, DASHBOARD_HOST, () => resolve())
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  if (!address || typeof address === 'string' || address.port < 1) {
    throw new Error('Failed to allocate a local port for Hermes Dashboard')
  }
  return address.port
}

class HermesHomeMismatchError extends Error {}

async function assertDashboardReady(url: string, expectedHome: string): Promise<void> {
  const response = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Hermes Dashboard returned HTTP ${response.status}`)
  }
  // A foreign process can grab the freshly-freed port first; body shape + home check
  // filter accidental squatters but cannot prove the responder is our child process.
  const body = await response.json().catch(() => null)
  if (!isHermesStatusBody(body)) {
    throw new Error('Hermes Dashboard health endpoint returned an unrecognized response')
  }
  const reportedHome = normalizeHome(body.hermes_home)
  if (reportedHome === normalizeHome(expectedHome)) return
  // Symlink aliases only (macOS /tmp, /var): realpath the trusted pin — never the
  // reported string, and only off the fast path (network homes can hang realpath).
  const pinnedCanonicalHome = normalizeHome(await realpath(expectedHome).catch(() => expectedHome))
  if (reportedHome !== pinnedCanonicalHome) {
    throw new HermesHomeMismatchError(
      `Hermes Dashboard is using a different configuration home (reported ${body.hermes_home}, expected ${expectedHome})`
    )
  }
}

/** Lexical normalization only: resolve, plus Windows separator and casing folding. */
function normalizeHome(value: string): string {
  // path.win32 keeps the Windows normalization testable from POSIX hosts.
  const resolved = (isWin ? path.win32 : path).resolve(value)
  return isWin ? resolved.toLowerCase() : resolved
}

function isHermesStatusBody(body: unknown): body is { hermes_home: string; gateway_running: unknown } {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as Record<string, unknown>).hermes_home === 'string' &&
    'gateway_running' in body
  )
}

function appendBounded(current: string, chunk: Buffer | string): string {
  return `${current}${chunk.toString()}`.slice(-OUTPUT_CAPTURE_LIMIT)
}

function sanitizeDiagnostic(value: string): string {
  return redactSecretText(value).slice(0, DIAGNOSTIC_LIMIT)
}

function getStartFailureReason(error: unknown, message: string): HermesDashboardStartFailureReason {
  if (error instanceof HermesDashboardStartError) return error.reason
  if (/dashboard startup was cancelled/i.test(message)) return 'cancelled'
  return 'startup_failed'
}

function isMissingDashboardDependencyDiagnostic(value: string): boolean {
  return /web ui requires\b.*\bfastapi\b.*\buvicorn\b/i.test(value)
}

function waitForReady(child: ChildProcess, url: string, expectedHome: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let checkingHealth = false

    const cleanup = () => {
      clearTimeout(timeout)
      clearInterval(healthInterval)
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
      const rawDiagnostic = [error.message, stderr, stdout].filter(Boolean).join('\n')
      const diagnostic = sanitizeDiagnostic(rawDiagnostic)
      if (isMissingDashboardDependencyDiagnostic(rawDiagnostic)) {
        reject(
          new HermesDashboardStartError(
            'dashboard_dependencies_missing',
            diagnostic || 'Hermes Dashboard dependencies are missing'
          )
        )
        return
      }
      reject(new Error(diagnostic || 'Hermes Dashboard failed during startup'))
    }
    const succeed = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const checkHealth = () => {
      if (checkingHealth || settled) return
      checkingHealth = true
      void assertDashboardReady(url, expectedHome)
        .then(succeed)
        // The reported home is fixed at spawn: a mismatch can never heal, so fail
        // fast instead of probing into the startup timeout.
        .catch((error) => {
          if (error instanceof HermesHomeMismatchError) fail(error)
        })
        .finally(() => {
          checkingHealth = false
        })
    }
    const onStdout = (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk)
    }
    const onStderr = (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk)
    }
    const onError = (error: Error) => fail(error)
    const onAbort = () => fail(new Error('Hermes Dashboard startup was cancelled'))
    const onClose = (code: number | null, childSignal: NodeJS.Signals | null) =>
      fail(
        new Error(`Hermes Dashboard exited before it was ready (code ${String(code)}, signal ${String(childSignal)})`)
      )
    const timeout = setTimeout(() => fail(new Error('Hermes Dashboard startup timed out')), START_TIMEOUT_MS)
    const healthInterval = setInterval(checkHealth, HEALTH_PROBE_INTERVAL_MS)

    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.once('error', onError)
    child.once('exit', onClose)
    child.once('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    else checkHealth()
  })
}

export const hermesDashboardService = new HermesDashboardService()

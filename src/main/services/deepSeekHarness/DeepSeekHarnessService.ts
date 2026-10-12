// fork 移植自 cherry-studio v2 src/main/services/deepSeekHarness/DeepSeekHarnessService.ts
// （2026-09-24）。进程管理 / 就绪探测 / 配置事务调用 / 诊断卫生化逐字。
// 缝点（行内标注）：
// ① V2 生命周期容器（BaseService/@Injectable/application.get）→ fork 单例 + 状态事件广播；
// ② providerService/modelService → Dsh_SyncProviders 快照（providerSnapshot.ts，同
//    setLightLlmProviderRoutes 先例）；apiKey 取快照明文（主进程内存，同内核信任边界）；
// ③ BinaryManager → 的 PATH 探测（resolveBinary.ts，升级）；
// ④ application.getPath(...) → paths.ts 的 CodeMate 子树；
// ⑤ gateway 分支经 gatewayRuntime.ts（接入 ApiGateway 后填充）。

import { type ChildProcess, execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { isWin } from '@main/constant'
import type { KernelModelInput } from '@main/kernel/providers'
import { crossPlatformSpawn, executeCommand, terminateProcessTree, waitForProcessExit } from '@main/utils/processRunner'
import { getRawShellEnv, refreshShellEnv, withPathPrepend } from '@main/utils/shellEnv'
import { IpcChannel } from '@shared/IpcChannel'
import type { DeepSeekHarnessPermissionMode, DeepSeekHarnessSettings } from '@shared/types/codeCli'
import type { ManagedToolStatus, ManagedToolStatusState } from '@shared/types/managedTool'
import { parseUniqueModelId, type UniqueModelId } from '@shared/types/uniqueModelId'
import { formatGatewayModelId } from '@shared/utils/apiGateway'
import { isNonChatModel } from '@shared/utils/model'
import { isLoginBasedProvider } from '@shared/utils/provider'
import { redactLiteral, redactSecretText } from '@shared/utils/redaction'
import { Mutex } from 'async-mutex'
import { app, BrowserWindow } from 'electron'

import { ensureMarketInstalled, isMarketUsable } from '../binaryManager/marketBaseline'
import { NPM_REGISTRY_MIRROR } from '../binaryManager/registry'
import { NODE_VERSION } from '../binaryManager/runtimeDownloader'
import { getCodeMateProvider } from '../codeCli/providerSnapshot'
import { resolveBinary } from '../codeCli/resolveBinary'
import {
  createDeepSeekHarnessDirectIdentity,
  type DeepSeekHarnessConfigReceipt,
  type DeepSeekHarnessMode,
  type DeepSeekHarnessModelProjection,
  type DeepSeekHarnessProjection,
  resolveDeepSeekHarnessEndpoint,
  rollbackDeepSeekHarnessConfig,
  writeDeepSeekHarnessConfig
} from './config'
import { managedToolBinDirs } from '@main/services/binaryManager/layout'
import { startGatewayForCodeMate } from './gatewayRuntime'
import { cacheRoot, codeMateToolsRoot, deepSeekHarnessHome, deepSeekHarnessWorkspace, nodeRuntimeDir } from './paths'

const logger = loggerService.withContext('DeepSeekHarnessService')

const START_TIMEOUT_MS = 30_000
const GRACEFUL_STOP_TIMEOUT_MS = 3000
const FORCE_STOP_TIMEOUT_MS = 1000
const OUTPUT_CAPTURE_LIMIT = 32 * 1024
const DIAGNOSTIC_LIMIT = 2000
// fork 缝②：V2 的 NO_KEY_PLACEHOLDER（authOptional provider 无 key 时占位）不搬——
// fork provider 契约无 authOptional，无 key 一律显式报错。
const GATEWAY_ROUTE = 'cherry-studio-codemate-gateway'
const GATEWAY_CREDENTIAL_REF = 'CHERRY_STUDIO_CODEMATE_GATEWAY_API_KEY'
const MANAGED_CREDENTIAL_ENV = /^CHERRY_STUDIO_CODEMATE_(?:[A-F0-9]{12}|GATEWAY)_API_KEY$/i
// registry 钉 npmmirror，harness 内 dshmarket 的 pnpm/npm 子进程继承。
// 常量单点到 binaryManager/registry.ts（原为"与 BinaryManager 同值"的复制件，
// 复制件正是会漂移的那种东西——一处改了另一处不改，市场抓包与版本解析就走两个源）。

/** fork 缝②：KernelModelInput.input 是 string[]（内核已卫生化），此处收窄为投影形状。 */
function toModelProjection(model: KernelModelInput): DeepSeekHarnessModelProjection {
  const input = (model.input ?? ['text']).filter(
    (value): value is 'text' | 'image' => value === 'text' || value === 'image'
  )
  return {
    name: model.name ?? model.id,
    input: input.length > 0 ? input : ['text'],
    reasoningEfforts: model.reasoningEfforts
  }
}

interface DeepSeekHarnessStartInput extends DeepSeekHarnessSettings {
  mode: DeepSeekHarnessMode
  uniqueModelId: UniqueModelId
}

interface DeepSeekHarnessRuntime {
  path: string
  env: NodeJS.ProcessEnv
}

class DeepSeekHarnessService {
  private readonly operationMutex = new Mutex()
  private status: ManagedToolStatus = 'stopped'
  private url: string | undefined
  private child: ChildProcess | null = null
  private stoppingChild: ChildProcess | null = null
  private runningPermissionMode: DeepSeekHarnessPermissionMode | undefined
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

  /** 同步杀进程树（before-quit 用；与 stop() 的异步树杀语义等价但阻塞到完成）。 */
  killSync(): void {
    const pid = this.child?.pid
    if (!pid) return
    try {
      if (isWin) {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 5000, windowsHide: true })
      } else {
        process.kill(-pid, 'SIGKILL')
      }
      logger.info(`code-mate: killed dsh process tree (pid ${pid}) on quit`)
    } catch (error) {
      logger.warn(`code-mate: failed to kill dsh process tree on quit`, error as Error)
    }
    this.child = null
    this.status = 'stopped'
    this.url = undefined
  }

  /** Single status-transition point（fork 缝①：共享缓存 → 全窗口事件广播）。 */
  private setStatus(status: ManagedToolStatus, options?: { force?: boolean }): void {
    if (!options?.force && this.status === status) return
    this.status = status
    this.statusTransitionId++
    this.publishStatus()
  }

  private publishStatus(): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IpcChannel.CodeCli_DeepseekHarness_Status, this.getStatus())
    }
  }

  async start(
    input: DeepSeekHarnessStartInput
  ): Promise<{ success: true; url: string } | { success: false; message: string }> {
    const startupAbortController = new AbortController()
    this.startupAbortControllers.add(startupAbortController)
    try {
      return await this.operationMutex.runExclusive(async () => {
        if (startupAbortController.signal.aborted) {
          return { success: false, message: 'DeepSeek Harness startup was cancelled' }
        }
        if (
          this.child &&
          this.status === 'running' &&
          this.url &&
          this.runningPermissionMode === input.permissionMode
        ) {
          const runningChild = this.child
          const transitionBefore = this.statusTransitionId
          try {
            const { receipt } = await this.syncConfig(input)
            if (
              startupAbortController.signal.aborted ||
              this.child !== runningChild ||
              this.status !== 'running' ||
              !this.url
            ) {
              await this.rollbackLaunchConfig(receipt)
              throw new Error(
                startupAbortController.signal.aborted
                  ? 'DeepSeek Harness startup was cancelled'
                  : 'DeepSeek Harness exited while updating its configuration'
              )
            }
            // Idempotent success publishes nothing on its own — republish so a
            // renderer that missed an earlier update is corrected by this request.
            if (this.statusTransitionId === transitionBefore) this.setStatus('running', { force: true })
            return { success: true, url: this.url }
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to update DeepSeek Harness configuration'
            return { success: false, message: sanitizeDiagnostic(message) }
          }
        }
        if (this.child) await this.stopOwnedProcessLocked()
        if (startupAbortController.signal.aborted) {
          return { success: false, message: 'DeepSeek Harness startup was cancelled' }
        }

        let receipt: DeepSeekHarnessConfigReceipt | undefined
        let runtime: DeepSeekHarnessRuntime | undefined
        try {
          this.url = undefined
          this.setStatus('starting')
          runtime = await this.resolveRuntime()
          if (startupAbortController.signal.aborted) {
            throw new Error('DeepSeek Harness startup was cancelled')
          }
          // 启动前对齐插件市场基线。dshmarket 不是官方包（只是 profile 里的一个
          // 普通依赖），核心升级后它不会跟着走——旧版市场与本代核心不兼容正是"插件市场
          // 不可用"的根因（真机反馈）。此处 Harness 已停，是唯一能安全替换共享树包的时机。
          await this.ensureMarketBundle()
          if (startupAbortController.signal.aborted) {
            throw new Error('DeepSeek Harness startup was cancelled')
          }
          const synced = await this.syncConfig(input)
          const projection = synced.projection
          receipt = synced.receipt
          if (startupAbortController.signal.aborted) {
            throw new Error('DeepSeek Harness startup was cancelled')
          }
          const url = await this.spawnAndWaitForReady(
            runtime,
            projection,
            input.permissionMode,
            startupAbortController.signal
          )
          if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) {
            throw new Error('DeepSeek Harness exited immediately after becoming ready')
          }
          this.url = url
          this.setStatus('running')
          this.runningPermissionMode = input.permissionMode
          return { success: true, url }
        } catch (error) {
          // Terminal state first: the cleanup-driven termination handler must not
          // publish 'stopped' for a failed launch on its way to 'error'.
          this.url = undefined
          this.setStatus('error')
          // No storage-content gate by design (#20395): archive-only homes are valid to the
          // runtime, so only its own startup verdict fails launch; record its version for reports.
          const aborted = startupAbortController.signal.aborted
          const dshVersion = !aborted && runtime ? await readDshVersion(runtime.path) : undefined
          // failure message 已含 waitForReady 捕获的子进程 stderr/stdout 尾巴
          // ——不进日志的话真机排障只能看到一句 "failed to start"（本轮排障实证）。
          const failMessage = error instanceof Error ? error.message : 'Failed to start DeepSeek Harness'
          if (!aborted) {
            logger.warn('DeepSeek Harness failed to start', {
              ...(dshVersion ? { dshVersion } : {}),
              message: sanitizeDiagnostic(failMessage)
            })
          }
          await this.stopOwnedProcessLocked().catch((stopError) => {
            logger.warn('Failed to stop DeepSeek Harness after launch failure', stopError as Error)
          })
          if (receipt) await this.rollbackLaunchConfig(receipt)
          return { success: false, message: sanitizeDiagnostic(failMessage) }
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
      await this.stopOwnedProcessLocked()
      this.url = undefined
      this.runningPermissionMode = undefined
      this.setStatus('stopped')
      // A no-op stop (already stopped) still confirms the terminal state to the renderer.
      if (this.statusTransitionId === transitionBefore) this.setStatus('stopped', { force: true })
    })
  }

  /**
   * 启动前的市场补装（dshmarket 只是 profile 里的普通依赖，核心升级它不会跟着走；
   * 缺失/不可读/链接残留/上次没修完时补一次）。
   *
   * 快路径是两三次文件读（未声明市场 / 已装且可读 → 直接返回）。需要补时装完会读回实际版本
   * 核验；**失败不阻断启动**——受限网络或 dsh 拒收该版本都会失败，只要现有市场还能加载就
   * 保留它，未完成的标记留给下次启动重试。只有"市场缺失/不可读/仍是链接形态"才让启动失败，
   * 因为那种 profile 起来也是没有市场的坏状态（失败原因随启动失败一起给用户看）。
   */
  private async ensureMarketBundle(): Promise<void> {
    try {
      const outcome = await ensureMarketInstalled()
      if (outcome.installed) {
        logger.info(`code-mate: dshmarket (re)installed at ${outcome.version ?? 'unknown'}`)
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      let marketUsable = false
      try {
        marketUsable = await isMarketUsable()
      } catch (inspectError) {
        // 探不动的市场按不可用处理（fail-closed 到启动失败），但要留下为什么探不动。
        logger.warn('code-mate: could not inspect the installed dshmarket', inspectError as Error)
      }
      if (marketUsable) {
        logger.warn(
          `code-mate: dshmarket install deferred, keeping the installed market: ${sanitizeDiagnostic(reason)}`
        )
        return
      }
      throw new Error(`dshmarket could not be installed: ${sanitizeDiagnostic(reason)}`)
    }
  }

  private async rollbackLaunchConfig(receipt: DeepSeekHarnessConfigReceipt): Promise<void> {
    try {
      const rolledBack = await rollbackDeepSeekHarnessConfig(receipt)
      if (!rolledBack) logger.warn('Skipped DeepSeek Harness config rollback because the files changed concurrently')
    } catch (error) {
      logger.warn('Failed to roll back DeepSeek Harness config after launch failure', error as Error)
    }
  }

  // fork 缝③：V2 走 BinaryManager 快照；先 PATH 探测（升级为 portable 安装器）。
  private async resolveRuntime(): Promise<DeepSeekHarnessRuntime> {
    const binary = await resolveBinary('dsh')
    if (!binary) throw new Error('DeepSeek Harness is not installed')
    // 真机加固：PATH 命中 ≠ 可用——`--version` 探针失败的系统件（旧版缺 web 子命令、
    // 损坏安装、同名异物）在启动前显式拒绝，不再放行到子进程退出后的英文哑弹。
    // 原因照实带上（探针此前把退出码/stderr 全丢了，用户只看到"可能损坏或过时"这句猜测）。
    if (!binary.runnable) {
      throw new Error(
        `Found DeepSeek Harness at ${binary.path} but it failed to run (--version).${binary.probeDetail ? ` Reason: ${binary.probeDetail}.` : ''} It may be a broken or outdated installation — install the managed version from the CodeMate panel.`
      )
    }
    const env = binary.source === 'system' ? await getRawShellEnv() : await refreshShellEnv()
    return { path: binary.path, env }
  }

  private async syncConfig(input: DeepSeekHarnessStartInput): Promise<{
    projection: DeepSeekHarnessProjection
    receipt: DeepSeekHarnessConfigReceipt
  }> {
    const projection = await this.resolveProjection(input)
    const receipt = await writeDeepSeekHarnessConfig(deepSeekHarnessHome(), projection)
    return { projection, receipt }
  }

  // fork 缝②：provider/model 数据来自 Dsh_SyncProviders 快照（形状 KernelProviderInput）。
  private async resolveProjection(input: DeepSeekHarnessStartInput): Promise<DeepSeekHarnessProjection> {
    const { providerId, modelId } = parseUniqueModelId(input.uniqueModelId)
    const provider = getCodeMateProvider(providerId)
    if (!provider) throw new Error(`Provider ${providerId} is not configured`)
    const model = provider.models?.find((candidate) => candidate.id === modelId)
    if (!model) throw new Error(`Model ${modelId} was not found in provider ${providerId}`)
    if (isNonChatModel(model)) throw new Error('The selected DeepSeek Harness model must support chat')

    if (input.mode === 'gateway') {
      const gateway = await startGatewayForCodeMate()
      return {
        route: GATEWAY_ROUTE,
        credentialRef: GATEWAY_CREDENTIAL_REF,
        credentialValue: gateway.credentialValue,
        // fork 缝：V2 品牌名 "Cherry Studio Unified Gateway" → 本仓品牌。
        displayName: 'Re_Cherry Unified Gateway',
        protocol: 'openai-completions',
        baseUrl: `${gateway.baseUrl}/v1`,
        modelId: formatGatewayModelId(providerId, modelId),
        model: toModelProjection(model),
        agentPreset: input.agentPreset
      }
    }

    if (isLoginBasedProvider(provider)) {
      throw new Error('This provider must be used through the Unified Gateway')
    }
    const { protocol, baseUrl } = resolveDeepSeekHarnessEndpoint(provider)
    const { route, credentialRef } = createDeepSeekHarnessDirectIdentity(provider.id, protocol)
    // fork 缝②续：V2 取 providerService.getApiKeys(...)[0]；fork 快照里是渲染层推送的
    // 明文 key（多 key 逗号串直接作为 credentialValue 写入 dsh .credentials.yaml，
    // 由 dsh 自行解析；内核侧的多 key 轮换语义在网关模式下天然生效）。
    const apiKey = provider.apiKey
    if (!apiKey) throw new Error(`Provider ${provider.id} has no enabled API key`)

    return {
      route,
      credentialRef,
      credentialValue: apiKey,
      displayName: `Re_Cherry: ${provider.name ?? provider.id}`,
      protocol,
      baseUrl,
      model: toModelProjection(model),
      modelId,
      agentPreset: input.agentPreset
    }
  }

  private async spawnAndWaitForReady(
    runtime: DeepSeekHarnessRuntime,
    projection: DeepSeekHarnessProjection,
    permissionMode: DeepSeekHarnessPermissionMode,
    signal: AbortSignal
  ): Promise<string> {
    // fork 缝④：workspace 由 paths.ts 落在 CodeMate 子树，这里显式建目录
    // （V2 由 pathRegistry 生命周期负责）。
    const workspace = deepSeekHarnessWorkspace()
    await fs.mkdir(workspace, { recursive: true })

    const env = stripManagedCredentialEnv({
      ...runtime.env,
      DSH_HOME: deepSeekHarnessHome(),
      DSH_PERMISSION_MODE: permissionMode
    })
    // harness 内的 dshmarket 会自己装插件（pnpm/npm 子进程）——环境不钉住
    // 就是"指定位置外乱拉屎"：pnpm store 落全局、npm -g 落系统前缀。PATH 前置我们的
    // pnpm shim（installNpmTool 装进 tools/dsh/node_modules/.bin）+ 受管 node bin；
    // store/cache/registry 全钉 CodeMate 子树 → dshmarket 的 provisionPnpm 探测立即
    // 命中，任何子进程的写面都在子树内。
    // PATH 键经 withPathPrepend 规范化（Windows shell env 键名是 'Path'，普通对象上
    // env.PATH 是 undefined——上一版直接拼 env.PATH 把整个系统 PATH 截没了，真机
    // 症状：'"node" 不是内部或外部命令'）。
    const pathSep = isWin ? ';' : ':'
    const nodeBinDir = isWin ? nodeRuntimeDir(NODE_VERSION) : path.join(nodeRuntimeDir(NODE_VERSION), 'bin')
    const childEnv = stripManagedCredentialEnv(
      withPathPrepend(
        {
          ...env,
          DSH_HOME: deepSeekHarnessHome(),
          DSH_PERMISSION_MODE: permissionMode
        },
        [nodeBinDir, ...managedToolBinDirs()],
        pathSep
      )
    )
    childEnv.npm_config_cache = path.join(cacheRoot(), 'npm')
    childEnv.npm_config_store_dir = path.join(cacheRoot(), 'pnpm-store')
    childEnv.npm_config_registry = NPM_REGISTRY_MIRROR

    // 真机事故（25 个必需插件 failed to import）：0.1.7 的插件以裸名导入
    // @deepseek-ai/* 宿主包——Node 从插件物理位置解析，安装树不在其回退链上。社区
    // 桌面壳的解法（harness-node-entry.mjs + host-module-fallback.mjs，MIT，原样搬运）：
    // node 先加载引导入口注册解析回退钩子（宿主包失败 → 以 dsh 安装树为父重试），再
    // import 真正的 dsh 入口并调用 runCli()。附带获得子进程 windowsHide 修复（#233）。
    // 入口文件缺失时退回直启（兼容 0.1.5 树）。
    const appRoot = app.getAppPath().replace('app.asar', 'app.asar.unpacked')
    const hostEntry = path.join(appRoot, 'resources', 'codemate', 'host', 'harness-node-entry.mjs')
    const dshEntry = path.join(codeMateToolsRoot(), 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const hostEntryReady =
      (await fs.access(hostEntry).then(
        () => true,
        () => false
      )) &&
      (await fs.access(dshEntry).then(
        () => true,
        () => false
      ))
    const nodeBin = path.join(nodeBinDir, isWin ? 'node.exe' : 'node')
    const spawnFile = hostEntryReady ? nodeBin : runtime.path
    const spawnArgs = hostEntryReady
      ? [hostEntry, dshEntry, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open']
      : ['web', '--host', '127.0.0.1', '--port', '0', '--no-open']

    const child = crossPlatformSpawn(spawnFile, spawnArgs, {
      cwd: workspace,
      env: childEnv,
      detached: !isWin,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child = child
    const handleTermination = (code: number | null, signal: NodeJS.Signals | null) =>
      this.handleChildTermination(child, code, signal)
    child.once('exit', handleTermination)
    child.once('close', handleTermination)
    child.on('error', (error) => {
      if (this.child === child && this.status === 'running') this.setStatus('error')
      logger.warn('Managed DeepSeek Harness process error', { message: sanitizeDiagnostic(error.message) })
    })

    try {
      return await waitForReady(child, projection.credentialValue, signal)
    } catch (error) {
      throw error instanceof Error ? error : new Error('DeepSeek Harness failed during startup')
    }
  }

  private handleChildTermination(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return
    this.child = null
    this.url = undefined
    this.runningPermissionMode = undefined
    if (this.stoppingChild === child) {
      this.stoppingChild = null
      // A teardown that began after the state already left starting/running (failed-launch
      // cleanup sets 'error' first) must not revive 'stopped'.
      if (this.status === 'starting' || this.status === 'running') this.setStatus('stopped')
      return
    }
    if (this.status === 'starting' || this.status === 'running') {
      this.setStatus('error')
      logger.warn('Managed DeepSeek Harness process exited unexpectedly', { code, signal })
    }
  }

  private async stopOwnedProcessLocked(): Promise<void> {
    const child = this.child
    if (!child) return
    this.stoppingChild = child
    await terminateProcessTree(child, false, 'DeepSeek Harness')
    if (await waitForProcessExit(child, GRACEFUL_STOP_TIMEOUT_MS)) return

    await terminateProcessTree(child, true, 'DeepSeek Harness')
    if (!(await waitForProcessExit(child, FORCE_STOP_TIMEOUT_MS))) {
      throw new Error('DeepSeek Harness did not exit after forced termination')
    }
  }
}

function appendBounded(current: string, chunk: Buffer | string): string {
  return `${current}${chunk.toString()}`.slice(-OUTPUT_CAPTURE_LIMIT)
}

function sanitizeDiagnostic(value: string, secret?: string): string {
  return redactSecretText(redactLiteral(value, secret)).slice(0, DIAGNOSTIC_LIMIT)
}

function stripManagedCredentialEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const name of Object.keys(env)) {
    if (MANAGED_CREDENTIAL_ENV.test(name)) delete env[name]
  }
  return env
}

function readDshVersion(binaryPath: string): Promise<string | undefined> {
  // execFile → executeCommand（受管 dsh 是 node_modules/.bin/dsh.cmd，Windows 裸
  // spawn EINVAL——与 resolveBinary 探针同款事故；cross-spawn 处理 .cmd 转发）。
  // 失败语义不变：undefined（版本只作启动失败时的诊断注记）。
  return executeCommand(binaryPath, ['--version'], {
    timeout: 3000,
    env: stripManagedCredentialEnv({ ...process.env })
  })
    .then((stdout) => stdout.split('\n', 1)[0]?.trim().slice(0, 80) || undefined)
    .catch(() => undefined)
}

function parseReadyUrl(output: string): string | undefined {
  for (const match of output.matchAll(/^dsh web: (\S+)\r?\n/gm)) {
    const candidate = match[1]
    const address = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})/.exec(candidate)
    if (!address) continue
    const port = Number(address[1])
    if (port > 65535) continue

    try {
      const url = new URL(candidate)
      if (
        url.protocol !== 'http:' ||
        url.hostname !== '127.0.0.1' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.hash
      ) {
        continue
      }

      const baseUrl = `http://127.0.0.1:${address[1]}`
      if (!url.search) {
        if (candidate !== baseUrl && candidate !== `${baseUrl}/`) continue
        return baseUrl
      }

      const params = [...url.searchParams]
      const token = params.length === 1 && params[0][0] === 'token' ? params[0][1] : undefined
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token) || candidate !== `${baseUrl}/?token=${token}`) continue
      return candidate
    } catch {
      continue
    }
  }
  return undefined
}

async function assertWebReady(url: string): Promise<void> {
  const readyUrl = new URL(url)
  const response = await fetch(readyUrl.toString(), { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  await response.body?.cancel()
  // 真机事故：0.1.5 校验 303→location==='/'（token 换取页）；0.1.7 的重定向目标
  // 变了 → 原精确匹配失败 → 活着的 harness 被我们误杀。就绪的事实是"HTTP 服务在响应"——
  // 放宽为 2xx/3xx 皆就绪，location 记日志供未来版本差异诊断。
  const location = response.headers.get('location')
  const serverResponded = (response.status >= 200 && response.status < 400) || response.status === 304
  if (!serverResponded) {
    throw new Error(
      `DeepSeek Harness Web UI returned HTTP ${response.status}${location ? ` (location: ${location})` : ''}`
    )
  }
  logger.debug?.(`Web UI readiness: HTTP ${response.status}${location ? ` -> ${location}` : ''}`)
}

function waitForReady(child: ChildProcess, secret: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let checkingUrl = false
    let settled = false

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
      const diagnostic = sanitizeDiagnostic([error.message, stderr, stdout].filter(Boolean).join('\n'), secret)
      reject(new Error(diagnostic || 'DeepSeek Harness failed during startup'))
    }
    const onStdout = (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk)
      const url = parseReadyUrl(stdout)
      if (!url || checkingUrl) return
      checkingUrl = true
      void assertWebReady(url)
        .then(() => {
          if (settled) return
          settled = true
          cleanup()
          resolve(url)
        })
        .catch((error) => fail(error instanceof Error ? error : new Error('DeepSeek Harness Web UI is unavailable')))
    }
    const onStderr = (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk)
    }
    const onError = (error: Error) => fail(error)
    const onAbort = () => fail(new Error('DeepSeek Harness startup was cancelled'))
    const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
      fail(new Error(`DeepSeek Harness exited before it was ready (code ${String(code)}, signal ${String(signal)})`))
    const timeout = setTimeout(() => fail(new Error('DeepSeek Harness startup timed out')), START_TIMEOUT_MS)

    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.once('error', onError)
    child.once('exit', onClose)
    child.once('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

export const deepSeekHarnessService = new DeepSeekHarnessService()

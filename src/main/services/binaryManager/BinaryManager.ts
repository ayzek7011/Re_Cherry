// fork 缝（原创）：V2 为 mise 驱动，本件为 portable 等价实现——快照/操作状态机/mutex 串行/
// availability 广播的形状照抄 V2 src/main/services/binaryManager/BinaryManager.ts，mise 命令
// 面全部替换为 npm --prefix / python venv + pip（设计来源：V2 BinaryManager + pythonRuntime，
// 勾勒自勘查报告结论）。一切钉在 {userData}/Data/CodeMate/ 子树：不改
// 系统 PATH、不写用户全局配置，卸载 = 删子树。BinaryToolSnapshot 为 V2
// src/shared/types/binary.ts 的子集抄形状（fork 不建 shared 文件，operation/definition 面若
// UI 需要随 再补）。

import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import { loggerService } from '@logger'
import { isWin } from '@main/constant'
import { probeBinaryDetailed, probeBinary, probeSystemPath } from '@main/services/codeCli/resolveBinary'
import {
  cacheRoot,
  codeMateRuntimeRoot,
  codeMateToolHome,
  deepSeekHarnessHome
} from '@main/services/deepSeekHarness/paths'
import { invalidateManagedSearchDirs, withPathPrepend } from '@main/utils/shellEnv'
import { IpcChannel } from '@shared/IpcChannel'
import type { InstallProgressPayload, InstallProgressStep } from '@shared/types/installProgress'
import { buildInstallProgressPayload, createStageTracker } from '@shared/types/installProgress'
import { redactSecretText } from '@shared/utils/redaction'
import { Mutex, type MutexInterface, tryAcquire } from 'async-mutex'
import { BrowserWindow } from 'electron'

import { judgeManagedApplication } from './applicationStatus'
import { buildInPlace } from './atomicSwap'
import { createProgressThrottle, type DownloadProgress, selectProgressUpdate } from './downloadFile'
import {
  managedBinaryPathFor,
  type ManagedToolKind,
  managedToolKind,
  sourceTreeDir,
  sourceVenvDir,
  sourceVenvPython,
  toolDir
} from './layout'
import { installMarketBundle, nodeMarketIo, readProfileBundleVersion } from './marketBaseline'
import { resolveNpmBinTarget as resolveNpmBinTargetFrom } from './packageBin'
import { createPipProgress, feedPipProgress, formatPipProgress } from './pipProgress'
import { BINARY_TOOL_PRESETS, type BinaryToolName, type BinaryToolPreset } from './presets'
import { PYPI_VERSION_SOURCES } from './pypiSources'
import { NPM_REGISTRY_MIRROR } from './registry'
import { removeTreeWithRetry } from './removeTree'
import { DEFAULT_COMMAND_TIMEOUT_MS, runBoundedCommand } from './runCommand'
import { ensureNodeRuntime, ensurePythonRuntime, isNodeRuntimeInstalled, NODE_VERSION } from './runtimeDownloader'
import {
  deployFrontDist,
  downloadSourceZip,
  extractSourceTree,
  parsePyprojectDependencies,
  resolveHeadSha,
  seedUserConfig
} from './sourceInstaller'

const logger = loggerService.withContext('BinaryManager')

// 快照 stale-while-revalidate 的缓存文件与后台重探冷却。
const SNAPSHOT_CACHE_FILENAME = 'snapshot-cache.json'
const SNAPSHOT_REFRESH_COOLDOWN_MS = 15_000

// V2 快照/操作超时预算的等价裁剪：安装是分钟级（V2 MISE_INSTALL_TIMEOUT_MS 同量级），
// 查询是秒级。命令超时预算已抽到 runCommand（市场通道共用同一个默认值）。
const NPM_VIEW_TIMEOUT_MS = 15_000
const PYPI_TIMEOUT_MS = 10_000

// fork 缝：registry 固定走 npmmirror（V2 走用户代理/区域策略 + mise 内部解析；portable
// 安装器为可预期行为写死镜像）。pip 源 official 在前、清华镜像在后（pip 按序尝试）——
// 与 V2 的清华镜像策略对应（V2 另有腾讯镜像背书，fork 裁为单镜像）。
// 镜像/备用源常量已单点到 registry.ts（市场通道共用同一份，见该件注释）。
// （用户裁决）：dsh 通道锚 npm 的 `next` dist-tag——社区的当前代际发在 next
// （0.1.7-rc.2），`latest` 停在 0.1.5-rc.3 不动；锚 latest 就永远收不到新一代（真机
// 取证：用户对比社区桌面壳发现"已经到 0.17 而这里还是 0.15 且没有推送更新"）。
// 安装与更新检查共用此 tag，语义恒对齐。
const DSH_NPM_DIST_TAG = 'next'
/**
 * PyPI 的两台索引。**镜像在前**（用户裁决 2026-09-29："那肯定是镜像优先啊"）——与运行时档案
 * （npmmirror 主 / 官方备）、源码归档（加速前缀主 / codeload 备）同一条策略：墙内先走镜像，
 * 官方源留作回退。
 *
 * 实测（本机 2026-09-29）：旧顺序（pypi.org 主 + 清华 extra）解析 paper-agent 的依赖树跑了 3 分钟
 * 仍未结束；pypi.org 在墙内既可能打不通（当日 app 内 `pypi.org/pypi -> fetch failed`）也可能
 * 慢到让每个包的元数据请求都变成长尾。镜像在前把这段长尾去掉，官方源仍在 extra 位上兜底
 * （镜像同步滞后的包照样装得上）。
 */
const PYPI_PRIMARY_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple'
const PYPI_FALLBACK_INDEX = 'https://pypi.org/simple'

/**
 * pip 安装的时长预算：默认的 15 分钟**不足以**装完这两个工具的 Python 依赖。
 *
 * 真机取证（app-error.2026-09-29.log 18:12:15）：`pip install paper-agent dependencies timed
 * out after 900000ms`——一次健康的依赖安装在 15 分钟被我们杀掉（`buildInPlace` 随即回滚，
 * 用户失去整次安装）。pip 是"依赖树自己解析 + 逐个下载"的长活（几十到上百个包），
 * 墙内镜像慢时分钟级到十几分钟是常态，不是异常；僵死的 pip 由 pip 自身的重试/socket 超时
 * 兜底（它会打 WARNING 并最终非 0 退出），我们的总时长只该当最后一道保险。
 */
const PIP_INSTALL_TIMEOUT_MS = 45 * 60_000

const TOOL_VERSION_MARKER = '.codemate-version'

/**
 * 安装收尾"启动核验"（launch 阶段）探测受管可执行物的时长预算。
 *
 * 比快照/启动通道的 5 秒宽得多：那 5 秒是给"已经在跑的稳定环境"定的，而这里是**安装刚结束**
 * 的时刻——npm 树是刚从几百个包里落盘的，`E:\` 这类移动盘/网络盘上首次 node 冷启动 + 首次
 * 载入整棵依赖树，超过 5 秒完全正常。用 5 秒判"装坏了"会把好安装判死；用分钟级预算才既能
 * 抓住"真的起不来"，又不会把"慢"误报成"坏"。
 */
const LAUNCH_PROBE_TIMEOUT_MS = 90_000

/** 失败原因在快照里保留的字符数（够看到 pnpm/npm 的关键几行，又不至于把缓存写肿）。 */
const INSTALL_FAILURE_DETAIL_LIMIT = 600

/**
 * 变更闸被占用时的用户可见消息（英文，与 removeTool 既有的 "Some files are still in use…"
 * 同风格——主进程消息不参与 i18n，渲染层直接展示）。
 */
const OPERATION_BUSY_MESSAGE = 'Another install or removal is already running. Wait for it to finish, then retry.'

// （用户裁决）：通道版本可见化——主进程启动即打一行安装通道，日志里一眼
// 可辨运行中的代码是否加载了本次改动（真机取证：dev 未重启时 npm 日志显示旧 spec，
// "改了没生效"与"代码没改"无法区分——这行日志终结歧义）。
logger.info(`dsh install channel: @${DSH_NPM_DIST_TAG} (node ${NODE_VERSION})`)

// ---------------------------------------------------------------------------
// 类型：V2 src/shared/types/binary.ts 子集抄形状
// ---------------------------------------------------------------------------

export type BinaryApplicationStatus = 'applied' | 'broken' | 'absent'

export type BinaryAvailability =
  | { source: 'managed'; path: string; version?: string }
  | { source: 'system'; path: string }
  | { source: 'none' }

export type BinaryToolSnapshot = {
  name: string
  application: BinaryApplicationStatus
  availability: BinaryAvailability
  /**
   * 该工具**最近一次**安装/升级失败的原始原因（已 redactSecretText 清洗）。
   * 主进程持有并随快照下发/落盘，故渲染层的失败行刷新页面后依然在——此前失败原因只活在
   * 一次 toast 里，用户回头再看就没了。
   */
  lastFailure?: string
  /**
   * v1（W4-4）：该工具**当前正在跑**的操作（安装/卸载），无操作时缺省。
   *
   * 为什么必须由主进程持有：安装跑在主进程，而"正在安装 + 进度"此前只活在渲染层组件的
   * 局部 state 里——切走 `/code` 页组件即销毁，回来时主进程还在装、渲染层却已认为空闲
   * （按钮变回"可安装"、进度行不渲染）。同步进快照（与 lastFailure 同一条路：把只活在
   * 一次性事件里的东西变成可查事实）后，页面重挂载/整页刷新都能恢复。
   *
   * 瞬态字段：只随 `getToolSnapshots` 的内存应答下发，**不写进快照缓存文件**。
   */
  operation?: BinaryToolOperation
}

/**
 * v1（W4-4）：主进程当前操作的类型。安装与升级在 IPC 面是同一次 `install_tool`（渲染层
 * 才知道自己按的是"安装"还是"升级"），故主进程只区分 install 与 remove。
 */
export type BinaryToolOperationKind = 'install' | 'remove'

export type BinaryToolOperation = {
  kind: BinaryToolOperationKind
  /** 开始时刻（epoch ms）。 */
  at: number
  /** 该操作最近一次进度载荷（与 `onInstallProgress` 同一份契约）。 */
  progress?: InstallProgressPayload
}

export type BinaryOperationResult = { success: true } | { success: false; message: string }

export type BinaryRemoveResult = { removed: boolean; message?: string }

/**
 * 阶段进入器：一次安装进度广播。由 `stepper()` 产出——它负责把"第 n 步 / 共 m 步"补进载荷，
 * 所以安装函数里所有进度上报都只剩"进哪一步 + 这次测到了什么"，不再各写一份广播参数。
 */
export type InstallProgressEnter = (step: InstallProgressStep, extra?: { detail?: string; fraction?: number }) => void

/** 手动检查更新的结论（渲染层按钮的结果反馈与版本卡注入面）。
 * （）：加 `source` 分态——只有受管安装才谈得上"本应用可升级"。 */
export type BinaryCheckUpdatesResult =
  | {
      success: true
      /** 解析到的安装来源；非 managed 时 latest/current 无意义（不查、也不比）。 */
      source: BinaryAvailability['source']
      current?: string
      latest?: string
      canUpgrade: boolean
    }
  | { success: false; message: string }

// ---------------------------------------------------------------------------
// 工具计划：shared 预设 → fork 安装后端（install: 'npm' → npm --prefix；'pipx' → venv）
// ---------------------------------------------------------------------------

interface ToolPlan {
  name: string
  preset: BinaryToolPreset
  kind: ManagedToolKind
  /** 1:1 运行时映射（node↔dsh、python↔hermes/paper-agent；fork 缝：写死，V2 由 mise 统一管理）。 */
  runtime: 'node' | 'python'
}

function toToolPlan(preset: BinaryToolPreset): ToolPlan | undefined {
  const kind = managedToolKind(preset)
  if (!kind) {
    logger.warn(`Managed installer does not support backend "${preset.install}" for tool ${preset.executable}`)
    return undefined
  }
  // 源码型（'source'：GitHub 树 + venv 依赖 + 前端构建）与 venv 型同为受管 CPython。
  return { name: preset.executable, preset, kind, runtime: kind === 'npm' ? 'node' : 'python' }
}

const TOOL_PLANS: ReadonlyMap<string, ToolPlan> = new Map(
  BINARY_TOOL_PRESETS.map((preset) => [preset.executable, toToolPlan(preset)]).filter(
    (entry): entry is [string, ToolPlan] => entry[1] !== undefined
  )
)

// V2 BinaryManager.ts 的 MISE_REQUIRED_PEERS 等价物：键从 miseTool 换成 executable。
const REQUIRED_PEERS: ReadonlyMap<string, { host: string; peer: string }> = new Map(
  BINARY_TOOL_PRESETS.flatMap((preset) =>
    preset.requiredPeer ? [[preset.executable, preset.requiredPeer] as const] : []
  )
)

/** codeload zip 的顶层包裹目录名（GitHub 固定为 `<RepoName>-<sha>`）。 */
function sourceRepoName(plan: ToolPlan): string {
  const slug = plan.preset.repo ?? plan.preset.packageName
  return slug.split('/')[1] ?? plan.name
}

/**
 * 受管可执行文件的落点（布局知识单点到 layout.ts，resolveBinary 与
 * PaperAgentService 共用同一份）。此处的 throw 只在"预设表出现无布局的后端"时可达——
 * 那是安装器自己的配置错误，应当响亮失败而不是猜路径。
 */
function managedBinaryPath(plan: ToolPlan): string {
  const target = managedBinaryPathFor(plan.name)
  if (!target) throw new Error(`No managed layout is registered for tool "${plan.name}"`)
  return target
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

async function readToolVersionMarker(name: string): Promise<string | undefined> {
  try {
    return (await fsp.readFile(path.join(toolDir(name), TOOL_VERSION_MARKER), 'utf-8')).trim() || undefined
  } catch {
    return undefined
  }
}

async function listDirForDiagnostics(dir: string): Promise<string> {
  try {
    return (await fsp.readdir(dir)).join(', ') || '(empty)'
  } catch {
    return '(unreadable)'
  }
}

function parsePipShowVersion(stdout: string): string {
  return /^Version:\s*(\S+)\s*$/m.exec(stdout)?.[1] ?? ''
}

async function readNpmPackageVersion(packageJsonPath: string): Promise<string> {
  try {
    const parsed = JSON.parse(await fsp.readFile(packageJsonPath, 'utf-8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : ''
  } catch {
    return ''
  }
}

/**
 * npm 包 `package.json` 的 `bin` 里、`binName` 对应的**入口文件绝对路径**；没有该声明或
 * 读不到 manifest 返回 undefined。
 *
 * 用途：`.bin/<name>.cmd` 这个 shim 只是转发器（真机 shim 内容：`"%_prog%" "%dp0%\..\<pkg>\
 * lib\bin.js" %*`）——它存在、`npm install` 退出 0，但入口文件缺失时**一样起不来**。此前安装
 * 只检查 shim 在不在，于是"装完了但起不来"能一路报到安装成功。
 *
 * 解析逻辑（含各种 manifest 形态与路径逃逸防护）单点到 packageBin.ts 并有单测；此处只做 I/O 装配。
 */
function resolveNpmBinTarget(packageDir: string, binName: string): Promise<string | undefined> {
  return resolveNpmBinTargetFrom(
    { readFile: (filePath) => fsp.readFile(filePath, 'utf-8') },
    packageDir,
    binName,
    path.sep
  )
}

// ---------------------------------------------------------------------------
// 安装器主体
// ---------------------------------------------------------------------------

export class BinaryManager {
  /**
   * 变更类操作（安装/卸载）的串行闸。
   *
   * 真机事故：原先用普通 mutex 的 `runExclusive` —— 一个长安装（paper-agent 的 pip
   * 超时预算 15 分钟）会把**所有**工具的安装与卸载都堵在队列里，而渲染层只看到转圈：
   * 整份主进程日志里连一条 remove 记录都没有（请求根本没进到方法体），用户看到的就是
   * "卸载始终卸不掉"。改用 tryAcquire 包装：拿不到闸**立刻**拒绝，并如实告诉用户
   * "有另一个安装/卸载在跑"，而不是无限排队。
   */
  private readonly operationGate = tryAcquire(new Mutex(), new Error(OPERATION_BUSY_MESSAGE))
  private snapshotCache: { data: Record<string, BinaryToolSnapshot>; at: number } | null = null
  private snapshotProbeInFlight: Promise<void> | null = null
  /**
   * 每个工具最近一次的安装失败原因（executable → 已清洗的消息）。
   * 生命周期与工具状态同档：开始新一次尝试时清除、失败时写入、卸载成功时清除。随快照落盘，
   * 故"上次为什么失败"在重启后仍可读。
   */
  private readonly installFailures = new Map<string, string>()
  /**
   * 本次安装解析出的版本号，由各安装函数登记、由 installTool 在**收尾核验通过之后**统一写进
   * 版本标记文件。
   *
   * 此前各安装函数自己写标记（写在最后一行），语义是"跑到这行就算装好"；现在收尾多了一道
   * 启动核验，标记必须等它通过才能落盘——否则核验失败时用户手上会留一棵"带版本标记、看起来
   * 装好了"的坏树，快照还会把它判成 applied。生命周期与一次安装同长（finally 里清掉）。
   */
  private readonly installedVersions = new Map<string, string>()
  /**
   * v1（W4-4）：当前正在跑的操作（同一时刻至多一个——`operationGate` 是全局互斥）。
   * 随快照下发（见 overlayOperation），不落盘。
   */
  private currentOperation: (BinaryToolOperation & { name: string }) | null = null

  /** 取变更闸；拿不到返回 undefined（调用方据此给出"有别的安装/卸载在跑"的明确结果）。 */
  private async acquireOperationGate(): Promise<MutexInterface.Releaser | undefined> {
    try {
      return await this.operationGate.acquire()
    } catch {
      // tryAcquire 的唯一失败原因就是"已被占用"——错误文本即上面的自定义消息。
      return undefined
    }
  }

  /**
   * 本次安装的阶段序列（末尾恒为 launch 启动核验）。
   *
   * 三个工具的阶段不同（npm：运行时→装包→工具链→市场→PPT；pipx 等价：运行时→venv→pip；
   * 源码：…→前端构建→部署），但**收尾那一关完全同形**：把刚装好的受管可执行物真的跑一次。
   * 写在这里而不是各安装函数里，是为了让"装完必须验能不能启动"成为唯一一份、不可能被某个
   * 分支漏掉的约定。
   */
  private installPipelineFor(plan: ToolPlan): readonly InstallProgressStep[] {
    switch (plan.kind) {
      case 'npm':
        return ['runtime', 'extract', 'install', 'toolchain', 'market', 'ppt', 'launch']
      case 'venv':
        return ['runtime', 'extract', 'venv', 'pip', 'launch']
      case 'source':
        return ['runtime', 'extract', 'source', 'unpack', 'venv', 'deps', 'front', 'build', 'deploy', 'launch']
    }
  }

  /**
   * 安装收尾的启动核验（launch 阶段）。
   *
   * 这是"装完了但起不来"这类缺陷的正面防线：在此之前，安装成功的判据只有"命令退出 0 +
   * 可执行文件存在"——npm 装完 shim 在、venv 建好解释器在，于是安装报成功、版本标记照写；
   * 等到用户点"启动"才由生命周期服务炸出 "exited before it was ready"（真机报错：
   * `...\tools\dsh\node_modules\.bin\dsh.cmd ... it failed to run (--version)`）。
   * 现在把这个发现提前到安装里，并**带上探针的真实失败原因**（退出码 / stderr / 是不是超时），
   * 而不是留给用户一句"可能损坏或过时"的猜测——装出来的东西不能用，就该在装的时候说清楚。
   *
   * 探针的 env 走 `getShellEnv()`（executeCommand 的默认），而它现在会把受管 node 运行时
   * 目录挂进 PATH——npm 的 bin shim 自己不带 node，缺这一步会把好安装判死。
   */
  private async verifyLaunch(plan: ToolPlan, enter: InstallProgressEnter, extraDetail?: string): Promise<void> {
    const target = managedBinaryPath(plan)
    enter('launch', {
      detail: extraDetail ?? `running ${path.basename(target)} --version`
    })
    const probe = await probeBinaryDetailed(target, { timeout: LAUNCH_PROBE_TIMEOUT_MS })
    if (probe.runnable) {
      logger.info(`Managed tool ${plan.name} passed the post-install launch check (${probe.version ?? 'no version'})`)
      return
    }
    throw new Error(
      `The installation finished but ${target} could not be run (--version): ${probe.detail ?? 'no diagnostics'}. ` +
        `Common reasons: the managed runtime is not on PATH, an antivirus blocked the command shim, ` +
        `or the download did not complete — retry the install, and if it keeps failing report the reason above.`
    )
  }

  /**
   * v1（W4-4）：登记当前操作并广播一次——渲染层据此**立刻**从快照里看到"正在装"，
   * 而不是等最后一次进度事件或本次操作结束。
   */
  private beginOperation(name: string, kind: BinaryToolOperationKind): void {
    this.currentOperation = { name, kind, at: Date.now() }
    this.broadcastChanged()
  }

  /** v1（W4-4）：本次操作结束（成功/失败/卸载皆同）——清掉进行态并广播。 */
  private endOperation(): void {
    this.currentOperation = null
  }

  /**
   * v1（W4-4）：把"当前操作"叠加到内存应答上。**不改缓存对象**（新建一份），
   * 因此持久化的快照缓存文件里永远没有这个瞬态字段。
   */
  private overlayOperation(data: Record<string, BinaryToolSnapshot>): Record<string, BinaryToolSnapshot> {
    const operation = this.currentOperation
    if (operation === null) return data
    const target = data[operation.name]
    if (target === undefined) return data
    const { progress } = operation
    return {
      ...data,
      [operation.name]: {
        ...target,
        operation: { kind: operation.kind, at: operation.at, ...(progress === undefined ? {} : { progress }) }
      }
    }
  }

  /**
   * 主计算的工具快照（V2 getToolSnapshots 形状：application 与 availability 是两个独立
   * 事实）。刻意不取 mutation mutex——慢安装不得隐藏已发布的事实（V2 同款注释语义）。
   */
  async getToolSnapshots(names: readonly string[]): Promise<Record<string, BinaryToolSnapshot>> {
    names // 探针面固定为全部预设（2 项），names 仅供 IPC 合同兼容。
    // （用户裁决）：快照缓存 + 后台重探（stale-while-revalidate）——/code 页
    // 打开时的"安装"按钮假象来自 3-5s 的探针窗口（hermes 系统 .exe 的 --version 挂到
    // 超时）。有缓存即秒回旧状态，后台重探完成后 broadcastChanged → 渲染层经
    // onChanged 回路自动刷新。冷却 15s 防重探风暴；安装/卸载后强制重探。
    //
    // 判定顺序此前是「重探在飞 ⇒ await 它再返回」，于是**恰好在最该秒回
    // 的窗口**（后台重探进行中，时长可达探针超时级）读路径反而挂起，同一时刻多个渲染层请求
    // 一起悬着。改为「有缓存即以缓存作答」，重探结果只经 broadcastChanged 通知刷新；
    // 只有**完全无缓存**时才 await 首次探针。
    const cached = this.snapshotCache
    if (cached) {
      if (Date.now() - cached.at > SNAPSHOT_REFRESH_COOLDOWN_MS && this.snapshotProbeInFlight === null) {
        this.startBackgroundSnapshotRefresh()
      }
      return this.overlayOperation(cached.data)
    }
    if (this.snapshotProbeInFlight !== null) {
      await this.snapshotProbeInFlight
      return this.overlayOperation(this.snapshotCache?.data ?? {})
    }
    const seeded = await this.readSnapshotCacheFile()
    if (seeded) {
      this.snapshotCache = { data: seeded, at: Date.now() }
      this.startBackgroundSnapshotRefresh()
      return this.overlayOperation(seeded)
    }
    return this.overlayOperation(await this.refreshSnapshotCache())
  }

  private startBackgroundSnapshotRefresh(): void {
    this.snapshotProbeInFlight = this.refreshSnapshotCache()
      .then(() => this.broadcastChanged())
      .catch((error) => logger.warn('Background snapshot refresh failed', error as Error))
      .finally(() => {
        this.snapshotProbeInFlight = null
      })
  }

  /** 并行探针全部工具 + 更新内存/文件缓存。 */
  private async refreshSnapshotCache(): Promise<Record<string, BinaryToolSnapshot>> {
    const names = BINARY_TOOL_PRESETS.map((preset) => preset.executable)
    const entries = await Promise.all(
      names.map(async (name) => {
        const plan = TOOL_PLANS.get(name)
        const snapshot: BinaryToolSnapshot = plan
          ? await this.snapshotTool(plan)
          : { name, application: 'absent', availability: { source: 'none' } }
        return [name, snapshot] as const
      })
    )
    const data = Object.fromEntries(entries)
    this.snapshotCache = { data, at: Date.now() }
    await this.writeSnapshotCacheFile(data).catch((error) => {
      logger.warn('Failed to persist snapshot cache', error as Error)
    })
    return data
  }

  private async readSnapshotCacheFile(): Promise<Record<string, BinaryToolSnapshot> | null> {
    try {
      const raw = await fsp.readFile(path.join(cacheRoot(), SNAPSHOT_CACHE_FILENAME), 'utf-8')
      const parsed = JSON.parse(raw) as { data?: Record<string, BinaryToolSnapshot> }
      return parsed.data ?? null
    } catch {
      return null
    }
  }

  private async writeSnapshotCacheFile(data: Record<string, BinaryToolSnapshot>): Promise<void> {
    // 真机日志：首装时 cache 目录还不存在 → ENOENT，快照缓存永远写不下（每次启动
    // 全量重探）。写入前把父目录建出来。
    await fsp.mkdir(cacheRoot(), { recursive: true })
    await fsp.writeFile(
      path.join(cacheRoot(), SNAPSHOT_CACHE_FILENAME),
      JSON.stringify({ at: Date.now(), data }, null, 2),
      'utf-8'
    )
  }

  private async snapshotTool(plan: ToolPlan): Promise<BinaryToolSnapshot> {
    const managedPath = managedBinaryPath(plan)
    if (await pathExists(managedPath)) {
      const version = await readToolVersionMarker(plan.name)
      // 判定抽到 applicationStatus.ts（纯函数 + 单测）。最要紧的一条是**版本标记
      // 缺失 ⇒ broken**——安装器把它写在最后，"核心换新、市场没换"的半成品此前被判 applied
      // 且显示"最新版本"（真机反馈：升级成功但插件市场不可用，还没有重试入口）。
      const probe = await probeBinary(managedPath)
      const application = judgeManagedApplication({
        kind: plan.kind,
        hasVersionMarker: !!version,
        probeRunnable: probe.runnable,
        ...(plan.kind === 'npm' && plan.preset.requiredPeer
          ? { requiredPeerSatisfied: this.hasRequiredRuntimeDependencies(plan.name, managedPath) }
          : {}),
        ...(plan.kind === 'source'
          ? {
              frontDeployed: await pathExists(path.join(codeMateToolHome(plan.name), 'front', 'dist', 'index.html'))
            }
          : {})
      })
      return {
        name: plan.name,
        application,
        availability: {
          source: 'managed',
          path: managedPath,
          ...((version ?? probe.version) ? { version: version ?? probe.version } : {})
        },
        ...(this.installFailures.get(plan.name) ? { lastFailure: this.installFailures.get(plan.name) } : {})
      }
    }
    // 源码型无 PATH 可执行物（其入口恒为受管 venv 解释器）——不探系统 PATH，
    // 免得路径上恰好有个同名异物被当成"已装（系统）"。
    if (plan.kind === 'source') {
      return { name: plan.name, application: 'absent', availability: { source: 'none' } }
    }
    const systemPath = await probeSystemPath(plan.preset.executable)
    if (systemPath) {
      // 真机加固：PATH 命中 ≠ 可执行（同名异物/缺子命令/损坏安装）。availability
      // 授权执行——探针失败按 V2 语义收敛为 source:'none'（不为不可跑的二进制背书），
      // UI 回落到安装面；探针输出的版本照实携带供展示。
      const probe = await probeBinary(systemPath)
      if (!probe.runnable) {
        logger.warn(
          `code-mate: system "${plan.preset.executable}" at ${systemPath} failed the --version probe; treating as not available`
        )
        return { name: plan.name, application: 'absent', availability: { source: 'none' } }
      }
      return {
        name: plan.name,
        application: 'absent',
        availability: { source: 'system', path: systemPath, ...(probe.version ? { version: probe.version } : {}) }
      }
    }
    return { name: plan.name, application: 'absent', availability: { source: 'none' } }
  }

  /**
   * V2 BinaryManager.ts:1194-1216 逐字移植（MISE_REQUIRED_PEERS → REQUIRED_PEERS，其余
   * 不动）：requiredPeer 以宿主自身入口的解析方式校验；宿主缺失视为配方重组而非丢 peer
   * （never fail closed），peer 缺失才判 broken。
   */
  private hasRequiredRuntimeDependencies(tool: string, entryPath: string): boolean {
    const required = REQUIRED_PEERS.get(tool)
    if (!required) return true
    let hostEntry: string
    try {
      hostEntry = createRequire(entryPath).resolve(required.host)
    } catch {
      // An absent host means the recipe restructured its packages, which is not
      // evidence that THIS install lost the peer — never fail a tool closed on it.
      return true
    }
    try {
      createRequire(hostEntry).resolve(required.peer)
      return true
    } catch (error) {
      logger.warn('Managed tool dependency tree is incomplete', {
        tool,
        ...required,
        error: this.errorMessage(error)
      })
      return false
    }
  }

  /**
   * 安装（变更闸串行；被占用即拒绝，不排队）。message 经 redactSecretText 清洗。
   *
   * `targetVersion`来自渲染层"检查更新"的结论：检查到 A 就装 A。此前这个入参
   * 被渲染层 `void` 掉，装的恒是"点按钮那一刻的通道最新版"（`@next` 这类漂移 tag 下就是
   * "报 A 装 B"）。npm/venv 型按精确版本下 spec；源码型见 installSourceTool 的说明。
   */
  async installTool(name: BinaryToolName, targetVersion?: string): Promise<BinaryOperationResult> {
    const plan = TOOL_PLANS.get(name)
    if (!plan) return { success: false, message: `Unknown managed tool: ${name}` }
    const release = await this.acquireOperationGate()
    if (!release) return { success: false, message: OPERATION_BUSY_MESSAGE }
    // 新一次尝试开始：清掉上一次的失败记忆（失败行只在"上次失败且当前不在忙"时出现）。
    this.installFailures.delete(name)
    // v1（W4-4）：登记进行态（随快照下发）——渲染层切页/重挂载后靠它恢复"正在安装"。
    this.beginOperation(name, 'install')
    try {
      // 本次唯一的阶段器：阶段序列在这里定死（含收尾的 launch 核验），三个安装函数共用它，
      // 不再各自算一份——否则"某条分支漏掉收尾核验"就会成为静默的常驻缺陷。
      const pipeline = this.installPipelineFor(plan)
      const enter = this.stepper(plan, pipeline)
      let launchDetail: string | undefined
      if (plan.kind === 'npm') await this.installNpmTool(plan, enter, targetVersion)
      else if (plan.kind === 'venv') await this.installVenvTool(plan, enter, targetVersion)
      else launchDetail = await this.installSourceTool(plan, enter, targetVersion)
      // 收尾核验（唯一写版本标记之前的最后一关）：装好的东西必须真的能跑。
      await this.verifyLaunch(plan, enter, launchDetail)
      // 成功后才写版本标记——"标记在 = 装好了"这条既有语义保持成立（此前标记由各安装函数
      // 自己写，收尾一旦有核验就必须把写入提到它之后，否则核验失败会留下一个"看起来装好了"的树）。
      await fsp.writeFile(
        path.join(toolDir(name), TOOL_VERSION_MARKER),
        this.installedVersions.get(name) ?? '',
        'utf-8'
      )
      // 成功后强制重探——紧随的 broadcast 让渲染层直接命中新状态，
      // 不再闪回安装前旧态。
      // 先作废 shellEnv 的受管目录记忆：首次安装时应用的第一个子进程早已把"没有受管
      // node"记进 memo，不作废的话紧随的重探仍然拿不到 node，装完照样判"损坏"。
      invalidateManagedSearchDirs()
      await this.refreshSnapshotCache().catch((error) =>
        logger.warn('Post-install snapshot refresh failed', error as Error)
      )
      return { success: true as const }
    } catch (error) {
      const message = redactSecretText(error instanceof Error ? error.message : this.errorMessage(error))
      logger.warn(`Failed to install managed tool ${name}`, { error: message })
      // 把原因留在主进程（随快照下发/落盘）——渲染层的失败行据此持久显示，
      // 不再"刷新一下就没原因了"。截断避免把整段 pnpm 输出写进快照缓存。
      this.installFailures.set(name, message.slice(0, INSTALL_FAILURE_DETAIL_LIMIT))
      return { success: false as const, message }
    } finally {
      this.installedVersions.delete(name)
      this.endOperation()
      release()
      this.broadcastChanged()
    }
  }

  /** dsh（npm 型）：受管 node → npm install --prefix → 版本标记 → bundle 装配（dshmarket + PPT）。 */
  private async installNpmTool(plan: ToolPlan, enter: InstallProgressEnter, targetVersion?: string): Promise<void> {
    // 本次安装的阶段序列由 installTool 统一给出（含收尾核验），此处只消费。
    const pipeline = this.installPipelineFor(plan)
    enter('runtime')
    const runtime = await ensureNodeRuntime(this.progressCallbacks(plan, pipeline, 'runtime'))
    const dir = toolDir(plan.name)
    await fsp.mkdir(dir, { recursive: true })
    // PATH 首位钉受管 node（npm shim 再启 node 时取它）；缓存钉 CodeMate 子树。
    // PATH 键经 withPathPrepend 规范化（Windows process.env 副本的键名是 'Path'，
    // 与新写的 'PATH' 并存时 spawn 生效方是未定义行为）。
    const pathSep = isWin ? ';' : ':'
    const nodeBinDir = isWin ? runtime.dir : path.join(runtime.dir, 'bin')
    const env: NodeJS.ProcessEnv = withPathPrepend(process.env, [nodeBinDir], pathSep)
    env.npm_config_cache = path.join(cacheRoot(), 'npm')
    env.npm_config_registry = NPM_REGISTRY_MIRROR
    // pnpm store 也钉进 CodeMate 子树（dshmarket 在 harness 内装插件时
    // 继承此 env → pnpm 子进程的 store 落点受控，卸载=删子树仍成立）。
    env.npm_config_store_dir = path.join(cacheRoot(), 'pnpm-store')
    enter('install')
    // （）：带了检查到的版本就钉精确版——"报 A 装 B"正是通道 tag 漂移下的常态。
    // 不设静默回退：装到与用户要求不同的版本，等于把刚修掉的问题换个地方放回去；精确版若
    // 已从 registry 撤下，就如实失败（失败原因现在会持久显示，用户可再点一次检查更新）。
    const npmSpec = targetVersion
      ? `${plan.preset.packageName}@${targetVersion}`
      : `${plan.preset.packageName}@${DSH_NPM_DIST_TAG}`
    await this.runCommand(runtime.npmBin, ['install', '--prefix', dir, npmSpec], {
      env,
      label: `npm install ${npmSpec}`
    })

    const managedPath = managedBinaryPath(plan)
    if (!(await pathExists(managedPath))) {
      throw new Error(
        `npm install finished but ${managedPath} is missing; ${dir} contains: ${await listDirForDiagnostics(dir)}`
      )
    }
    // shim 在 ≠ 能用：`.bin/<name>.cmd` 只是转发器，它指向的入口文件才是本体（真机报错
    // `...\node_modules\bin\dsh.cmd ... failed to run (--version)` 就卡在这一层）。声明与文件
    // 分开核验——缺哪个都能指名道姓地说出来，而不是留给启动时才炸。
    const packageDir = path.join(dir, 'node_modules', ...plan.preset.packageName.split('/'))
    const binTarget = await resolveNpmBinTarget(packageDir, plan.name)
    if (binTarget && !(await pathExists(binTarget))) {
      throw new Error(`npm install registered the "${plan.name}" command but its entry file is missing: ${binTarget}`)
    }

    // bundle 装配——dshmarket（插件市场）+ PPT（社区预构建 tgz）。
    // 全走 dsh 自带的 `plugin add` 命令（官方 bundle 安装通道：pnpm add 到 profile 树
    // + reconcilePlugins 自动把声明 dsh.bundle 的依赖加进 dsh.profile.bundles）。
    // 市场那一条已改走受管市场通道（见 marketBaseline.ts）——裸 `add dshmarket`
    // 没有版本契约、没有 --workspace-root、没有装后核验，核心升级后市场停旧版就是这个
    // 缺口造成的（真机反馈"新版本的插件市场不可用"）。
    //
    // 两次真机事故的命门都在这条链的环境上：
    // ① DSH_HOME 必须显式传入——runPlugin 内 resolveProfileDir → resolveDshHome() 读
    //    此环境变量；缺省时 profile 解析到 ~/.dsh（默认 home），而 harness 启动时带
    //    DSH_HOME={CodeMate}/home/dsh → 装进 A 处、运行读 B 处，市场永远不出现。
    // ② pnpm 供给弃用 corepack——corepack 只造 shim，pnpm 本体在首次运行时才下载，
    //    且 corepack 不吃 npm_config_registry（有自己的 COREPACK_NPM_REGISTRY），
    //    网络不佳时静默挂死。改用 npm 装进 dsh 安装树（npmmirror 钉死、shim 落
    //    node_modules/.bin——已在 PATH）。
    const binJs = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    enter('toolchain')
    await this.runCommand(runtime.npmBin, ['install', '--prefix', dir, 'pnpm'], {
      env,
      label: 'npm install pnpm (bundle toolchain)'
    })
    const bundleEnv = withPathPrepend(env, [path.join(dir, 'node_modules', '.bin')], pathSep)
    bundleEnv.DSH_HOME = deepSeekHarnessHome()
    // 真机事故：pnpm **不吃 npm_config_registry**（`pnpm config get registry`
    // 恒返回 npmjs.org——真机取证；社区 #337 同款坑）→ 所有 pnpm 操作直连官方 registry，
    // 国内网络下 add 挂死 10 分钟。修复两层：①profile 目录写项目级 .npmrc（pnpm 读
    // 项目配置，且 dshmarket 墙内装插件的 pnpm 子进程 cwd 同在 profile——一并生效）；
    // ②每条 plugin add 显式带 --registry（社区 #337 的修复形态）。
    const webProfileDir = path.join(deepSeekHarnessHome(), 'profiles', 'web')
    const pnpmRegistryArgs = [`--registry=${NPM_REGISTRY_MIRROR}`]
    // 真机事故（首装无市场）：首次安装时 profile 尚不存在（harness 首次启动才
    // 创建）——不 mkdir 则 .npmrc 写入 ENOENT → bundle 装配链整体中断，dsh 能启动但
    // 没有市场；卸载不删 home 树 → 首次启动建好 profile 后重装才有。真机现象完全吻合。
    // 更正：pnpm ≥10 已不从 .npmrc 读链接器/registry 设置（harness 自己的
    // initProfile 写的是 pnpm-workspace.yaml）——本行对 npm 通道与旧 pnpm 仍有意义，
    // 真正生效的是各条命令的 --registry 与 marketBaseline 的命令环境。
    await fsp.mkdir(webProfileDir, { recursive: true })
    await fsp.writeFile(
      path.join(webProfileDir, '.npmrc'),
      `registry=${NPM_REGISTRY_MIRROR}\nstore-dir=${path.join(cacheRoot(), 'pnpm-store')}\n`,
      'utf-8'
    )
    enter('market')
    // 真机回归修正：**插件 bundle 装不上不得让 dsh 装不上**。市场与 PPT 都是
    // bundle，不是工具本体；让它们的失败掀翻整个安装的后果是"标记不写 → 工具判 broken →
    // 用户既用不了也没法升级"（真机日志：dsh 0.2.0-rc.2 以 peer 不兼容拒收被钉死的
    // dshmarket@1.45.1）。失败改成**软失败**：记日志 + 记进快照的 lastFailure（渲染层会
    // 持久显示"哪一步没装上"），声明留在 profile 里交给启动前的补装通道重试。
    const bundleFailures: string[] = []
    try {
      const market = await installMarketBundle()
      logger.info(`dshmarket bundle installed (${market.version ?? 'version unreadable'})`)
    } catch (error) {
      const message = this.errorMessage(error)
      bundleFailures.push(`dshmarket: ${message}`)
      logger.warn('dshmarket could not be installed; DeepSeek Harness itself is unaffected', { error: message })
    }

    // 真机修正：PPT 从 registry 装 `dsh-ppt@latest`（0.4.5，官方 DSH 演示文稿
    // 插件——技能+工具形态，声明 dsh.bundle ✓）。弃用社区 tgz（0.1.1-rc.2-desktop 旧
    // 构建，挂载形态在新代际下 failed to import）与其 composer（npm 私有件，依赖
    // dsh-ppt@0.1.1-rc.2 在 registry 已被 0.4.5 取代 → ERR_PNPM_NO_MATCHING_VERSION，
    // 真机复现实证）。显式 @latest spec：file:/旧 spec 已存在时 `add <name>` 会被
    // "lockfile up to date" 短路（真机复现），带版本 spec 强制重解析。
    enter('ppt')
    try {
      await this.runCommand(
        runtime.nodeBin,
        [binJs, 'plugin', '--profile', 'web', 'add', 'dsh-ppt@latest', ...pnpmRegistryArgs],
        { env: bundleEnv, label: 'dsh plugin add dsh-ppt', timeoutMs: 300_000 }
      )
      // pnpm 退出 0 ≠ 插件生效。核验"装没装上"——缺了就记软失败（同市场那条）。
      const pptVersion = await readProfileBundleVersion(nodeMarketIo, webProfileDir, 'dsh-ppt')
      if (!pptVersion) {
        throw new Error(
          `dsh plugin add dsh-ppt reported success, but ${path.join(webProfileDir, 'node_modules', 'dsh-ppt')} is not installed`
        )
      }
      logger.info(`dsh-ppt bundle installed (${pptVersion})`)
    } catch (error) {
      const message = this.errorMessage(error)
      bundleFailures.push(`dsh-ppt: ${message}`)
      logger.warn('dsh-ppt could not be installed; DeepSeek Harness itself is unaffected', { error: message })
    }
    if (bundleFailures.length > 0) {
      // 工具本体装好了（标记照写），但 bundle 那几步有失败——把它摆到用户看得见的地方：
      // 快照的 lastFailure 会在版本卡上持久显示（刷新/重启后仍在）。
      this.installFailures.set(
        plan.name,
        `bundle assembly incomplete:\n${bundleFailures.join('\n')}`.slice(0, INSTALL_FAILURE_DETAIL_LIMIT)
      )
    }

    const version = await readNpmPackageVersion(
      path.join(dir, 'node_modules', ...plan.preset.packageName.split('/'), 'package.json')
    )
    this.installedVersions.set(plan.name, version)
  }

  /** hermes（pipx 型 → venv 等价）：受管 CPython → python -m venv → venv pip install。 */
  private async installVenvTool(plan: ToolPlan, enter: InstallProgressEnter, targetVersion?: string): Promise<void> {
    // 阶段序列由 installTool 统一给出（含收尾核验）；此段只消费，不再自建。
    // pip 阶段没有任何诚实的百分比（分母要等 pip 自己解析完才知道），所以它靠
    // "上一段已完成 + 段内包数/字节数"表达进度（真机反馈"hermes 进度条不动"就在这一段）。
    const pipeline = this.installPipelineFor(plan)
    enter('runtime')
    const { pythonBin } = await ensurePythonRuntime(this.progressCallbacks(plan, pipeline, 'runtime'))
    // 路径用变量名与本类其余处一致，便于对照（venv 的受管布局见 managedBinaryPath）。
    const dir = toolDir(plan.name)
    // 改走 buildInPlace——旧实现在建 venv 之前就把整个工具目录删了，pip 阶段一失败
    // 用户手上就只剩残骸（没有旧安装可退）。venv 必须在最终路径上生成（launcher/脚本把绝对
    // 路径写死），故不能走 staging 改名。
    await buildInPlace(dir, async (target) => {
      enter('venv')
      await this.runCommand(pythonBin, ['-m', 'venv', target], {
        env: { ...process.env },
        label: `python -m venv ${plan.name}`
      })
      const builtPython = isWin ? path.join(target, 'Scripts', 'python.exe') : path.join(target, 'bin', 'python3')
      if (!(await pathExists(builtPython))) {
        throw new Error(
          `venv created but ${builtPython} is missing; ${target} contains: ${await listDirForDiagnostics(target)}`
        )
      }
      // fork 缝：extras 数据（pipxExtras:['web']）留在 shared 预设，venv 规格按用户裁决写死
      // 为 <packageName>[web]；索引顺序见 PYPI_PRIMARY_INDEX 注释（**镜像在前**）。
      // （）：带了检查到的版本就钉 `==<版本>`（PyPI 上"报 A 装 B"同样可能——
      // 检查走 JSON API、安装走 pip 解析，两者跨源跨时刻）。
      const pipSpec = targetVersion
        ? `${plan.preset.packageName}[web]==${targetVersion}`
        : `${plan.preset.packageName}[web]`
      enter('pip')
      await this.runCommand(
        builtPython,
        [
          '-m',
          'pip',
          'install',
          '--cache-dir',
          path.join(cacheRoot(), 'pip'),
          '--index-url',
          PYPI_PRIMARY_INDEX,
          '--extra-index-url',
          PYPI_FALLBACK_INDEX,
          // 优先取 wheel。两台索引并存时，pip 可能选中"更新的 sdist"而不是"稍旧的
          // wheel"，接着就地编译 C 扩展——那正是"卡很久"的最坏形态（几分钟到十几分钟），
          // 而且编译失败还会整个安装失败。`--prefer-binary` 只改**偏好**：没有 wheel 时照旧退回
          // sdist，不改变能装/不能装的结论。
          '--prefer-binary',
          // `--progress-bar` 保持 pip 默认（非 TTY 下输出 collect/download 行，
          // 由此处的行回调解析成"N 个包 · X MB"）。不传 --quiet：那会把唯一的事实源也吞掉。
          pipSpec
        ],
        {
          env: { ...process.env },
          label: `pip install ${pipSpec}`,
          timeoutMs: PIP_INSTALL_TIMEOUT_MS,
          onOutputLine: this.pipProgressReporter(enter, 'pip')
        }
      )
      // pip 退出 0 ≠ 命令能用。npm 型在装完后就核验受管可执行物，venv 型此前没有
      // 这一步——pip 成功但 console script 没生成（上游改了 entry point / 装了不含脚本的
      // wheel）时，标记照写、installTool 照样返回成功，渲染层弹"安装成功"，而快照探针同一时刻
      // 判它 broken：用户看到的是互相矛盾的两句话。这里对齐 npm 型，先核验再写标记。
      const launcher = managedBinaryPath(plan)
      if (!(await pathExists(launcher))) {
        throw new Error(
          `pip install finished but ${launcher} is missing; ${target} contains: ${await listDirForDiagnostics(target)}`
        )
      }
      // 版本登记：pip show 解析 Version 行；解析失败留空。标记文件由 installTool 在收尾
      // 核验通过后统一写（见 installedVersions 注释）。
      let version = ''
      try {
        version = parsePipShowVersion(
          await this.runCommand(builtPython, ['-m', 'pip', 'show', plan.preset.packageName], {
            env: { ...process.env },
            label: `pip show ${plan.preset.packageName}`
          })
        )
      } catch (error) {
        logger.warn(`Failed to resolve installed version of ${plan.preset.packageName}`, {
          error: this.errorMessage(error)
        })
      }
      this.installedVersions.set(plan.name, version)
    })
  }

  /**
   * 源码型（paper-agent）：GitHub 源码树 → 受管 CPython venv 装依赖 → 受管 node
   * 构建前端 → 用户态播种 + 产物部署 → 登记 commit SHA 版本。
   *
   * 升级语义 = 再装一次：源码树整目录替换（纯上游代码，无用户态混入），venv 保留（pip
   * 增量解析依赖变更），用户态在 home/<tool> 全程不受影响。"装的恒是该分支当前 HEAD"
   * 沿用 fork 既有的 name-only 安装语义（不做 SHA 钉定）。
   *
   * 返回值是收尾核验的 detail 文案（这一段最后一次长命令是 vite build，值得在核验阶段
   * 说明"刚跑完构建"），由 installTool 传给 verifyLaunch。
   */
  private async installSourceTool(
    plan: ToolPlan,
    enter: InstallProgressEnter,
    targetVersion?: string
  ): Promise<string> {
    const { repo, branch } = plan.preset
    if (!repo || !branch) {
      throw new Error(`Source tool "${plan.name}" has no repo/branch configured`)
    }
    // 阶段序列由 installTool 统一给出：那里的骨架**恒含** venv 段（venv 是否真跑由 needsVenv
    // 决定），因此这里不能再按 needsVenv 组序列——两处序列一不一致，阶段位置就会算错
    // （"第 N 步 / 共 M 步"与实际不符）。venv 只在第一次安装（或 venv 被清掉）时才建。
    const pipeline = this.installPipelineFor(plan)
    const needsVenv = !(await pathExists(sourceVenvPython(plan.name)))
    enter('runtime')
    // 两个运行时**串行**下载。原先并行是为了快，但两个各 ~30MB 的档案同时上报
    // 字节进度，进度条会在两条曲线之间来回跳（"真实进度"变成噪声）；串行的总字节数不变，
    // 换来的是一个单调可信的条。
    const { pythonBin } = await ensurePythonRuntime(this.progressCallbacks(plan, pipeline, 'runtime'))
    const nodeRuntime = await ensureNodeRuntime(this.progressCallbacks(plan, pipeline, 'runtime'))

    enter('source')
    // 先钉 SHA 再按 SHA 取 zip：分支在两次请求之间被推进也不会装到"另一半"。
    const sha = await resolveHeadSha(repo, branch)
    // （）：源码型**无法**按渲染层给的短 SHA 钉定——codeload 要完整 40 位 SHA，
    // 而版本卡展示的是 8 位短 SHA。这里如实记录"装的是分支当前 HEAD、而非检查时那一个提交"，
    // 卡片会在安装后按实际 SHA 自校正（marker 写的是真 SHA）。
    if (targetVersion && !sha.startsWith(targetVersion)) {
      logger.warn(
        `Source tool ${plan.name}: installing ${sha.slice(0, 8)} while the checked commit was ${targetVersion} (the branch moved)`
      )
    }
    const archivePath = await downloadSourceZip(repo, sha, cacheRoot(), {
      onProgress: this.downloadProgressReporter(enter, 'source')
    })
    const dir = toolDir(plan.name)
    await fsp.mkdir(dir, { recursive: true })
    const sourceDir = sourceTreeDir(plan.name)
    try {
      // 下载到 100% 之后还要解压——不换阶段的话条会冻在 100%（三家工具同款形态）。
      // 用 unpack 而不是 extract：extract 指的是运行时归档（在 runtime 段之后），源码树解压
      // 排在 source 段之后，复用 extract 会让条倒着走一格。
      enter('unpack')
      // （）：把钉住的 SHA 一起交下去——归档顶层目录名必须是 <Repo>-<sha>，
      // 这样"从镜像/代理取回的东西"也能被证伪（对不上即拒绝，见 selectSourceTreeEntry）。
      await extractSourceTree(archivePath, sourceDir, sourceRepoName(plan), sha)
    } finally {
      await fsp.rm(archivePath, { force: true }).catch(() => undefined)
    }

    const venvPython = sourceVenvPython(plan.name)
    if (needsVenv) {
      enter('venv')
      // venv 用 buildInPlace（在最终路径上生成 + 失败回滚），不再"先删 venv 再建"。
      const venvDir = sourceVenvDir(plan.name)
      await buildInPlace(venvDir, async (target) => {
        await this.runCommand(pythonBin, ['-m', 'venv', target], {
          env: { ...process.env },
          label: `python -m venv ${plan.name}`
        })
        const built = sourceVenvPython(plan.name)
        if (!(await pathExists(built))) {
          throw new Error(
            `venv created but ${built} is missing; ${target} contains: ${await listDirForDiagnostics(target)}`
          )
        }
      })
    }

    enter('deps')
    const pyprojectPath = path.join(sourceDir, 'pyproject.toml')
    const dependencies = parsePyprojectDependencies(await fsp.readFile(pyprojectPath, 'utf-8'))
    if (dependencies.length === 0) {
      // 上游布局变了就显式失败——装个空 venv 只会在启动时炸成难懂的 ImportError。
      throw new Error(`No dependencies found in ${pyprojectPath}; the upstream project layout may have changed`)
    }
    await this.runCommand(
      venvPython,
      [
        '-m',
        'pip',
        'install',
        '--cache-dir',
        path.join(cacheRoot(), 'pip'),
        // 镜像在前、官方兜底、优先 wheel —— 见 PYPI_PRIMARY_INDEX 注释（paper-agent 的依赖树
        // 是这两个工具里最大的一棵：chromadb + langgraph 合计数百 MB，顺序与 wheel 偏好直接
        // 决定这一段是几分钟还是十几分钟）。
        '--index-url',
        PYPI_PRIMARY_INDEX,
        '--extra-index-url',
        PYPI_FALLBACK_INDEX,
        '--prefer-binary',
        ...dependencies
      ],
      {
        env: { ...process.env },
        label: `pip install ${plan.name} dependencies`,
        timeoutMs: PIP_INSTALL_TIMEOUT_MS,
        onOutputLine: this.pipProgressReporter(enter, 'deps')
      }
    )

    enter('front')
    const pathSep = isWin ? ';' : ':'
    const nodeBinDir = isWin ? nodeRuntime.dir : path.join(nodeRuntime.dir, 'bin')
    const frontEnv = withPathPrepend(process.env, [nodeBinDir], pathSep)
    frontEnv.npm_config_cache = path.join(cacheRoot(), 'npm')
    frontEnv.npm_config_registry = NPM_REGISTRY_MIRROR
    const frontDir = path.join(sourceDir, 'front')
    await this.runCommand(nodeRuntime.npmBin, ['install', '--prefix', frontDir], {
      env: frontEnv,
      label: `npm install ${plan.name} front`
    })
    // 直接跑 vite build（跳过上游 `npm run build` 里的 vue-tsc 类型检查——那是开发卫生，
    // 不是安装关键路径；vite 自身仍会捕获导入/语法错误）。
    const viteBin = path.join(frontDir, 'node_modules', '.bin', isWin ? 'vite.cmd' : 'vite')
    if (!(await pathExists(viteBin))) {
      throw new Error(`vite is missing after npm install: ${viteBin}`)
    }
    // npm install 与 vite build 是两段独立的长活（各自的分钟级），合成一段的话条会在整段里
    // 一动不动——分开后前一段完成即是可见的推进。
    enter('build')
    await this.runCommand(viteBin, ['build'], {
      env: frontEnv,
      cwd: frontDir,
      label: `vite build ${plan.name}`,
      timeoutMs: 5 * 60_000
    })

    enter('deploy')
    const home = codeMateToolHome(plan.name)
    await seedUserConfig(sourceDir, home)
    await deployFrontDist(sourceDir, home)

    // 版本 = 短 SHA（展示与更新对比都以它为准；完整 SHA 只用于下载 URL）。标记文件由
    // installTool 在收尾核验通过后统一写。
    this.installedVersions.set(plan.name, sha.slice(0, 8))
    // 收尾核验的 detail：这一型"可执行物"是 venv 解释器，真启动面是 home 下的源码 + 前端产物，
    // 说清楚验的是哪个，用户/日志才知道这一关到底保证了什么。
    return `running ${path.basename(sourceVenvPython(plan.name))} --version (source tree at ${sourceDir}, front deployed to ${home})`
  }

  /** 该类运行时是否仍被别的已装工具需要（paper-agent 与 hermes 共享 CPython）。 */
  private async isRuntimeStillNeeded(runtime: 'node' | 'python', removing: string): Promise<boolean> {
    for (const [name, candidate] of TOOL_PLANS) {
      if (name === removing || candidate.runtime !== runtime) continue
      if (await pathExists(toolDir(name))) return true
    }
    return false
  }

  /** 卸载（变更闸串行；被占用即拒绝，不排队）：删工具目录 + 整个同类运行时根。
   * 真机事故修复：taskkill 后原生 .node 的 DLL 锁异步释放，立即 rm 撞 EPERM
   * （sharp-win32-x64.node 实证）——改逐项遍历删除 + 重试退避（removeTree.ts）。
   * 运行时改为删 kind 根（runtime/node 整目录）——NODE_VERSION 跨版本升级
   * 后旧版本目录不再残留，portable"卸载=零残留"在版本演进下仍成立。
   * paper-agent 与 hermes 共享受管 CPython——运行时根改为"该类运行时已无任何
   * 已装工具时才删"（此前 1:1 映射会把对方的解释器一起删掉）；工具目录删除失败时
   * 不删运行时（fail-closed）。用户态 home/<tool> 不删（dsh home 先例）。
   * 真机事故：见 operationGate 注释——被占用时**立即**返回可读原因，不再无限排队
   *（"卸载始终卸不掉"且日志里一条记录都没有，就是这个排队造成的）。 */
  async removeTool(name: BinaryToolName): Promise<BinaryRemoveResult> {
    const plan = TOOL_PLANS.get(name)
    if (!plan) return { removed: false, message: `Unknown managed tool: ${name}` }
    const release = await this.acquireOperationGate()
    if (!release) {
      logger.warn(`Refused to remove managed tool ${name}: another operation is running`)
      return { removed: false, message: OPERATION_BUSY_MESSAGE }
    }
    // v1（W4-4）：卸载同样登记进行态——否则切页回来会看到一个像空闲的"卸载"按钮。
    this.beginOperation(name, 'remove')
    try {
      // （真机"卸载耗时过长"）：卸载耗时此前**没有任何日志**——用户说慢，日志里一条都
      // 查不到，只能靠事后复刻基准测量（本次即如此）。删树 + 运行时 + 重探各记一次耗时，
      // 下次这类反馈可以直接从日志读出是哪一段慢。
      const startedAt = Date.now()
      const toolGone = await removeTreeWithRetry(toolDir(plan.name))
      const toolMs = Date.now() - startedAt
      const runtimeKindRoot = path.join(codeMateRuntimeRoot(), plan.runtime)
      const runtimeStart = Date.now()
      const runtimeGone =
        toolGone && !(await this.isRuntimeStillNeeded(plan.runtime, plan.name))
          ? await removeTreeWithRetry(runtimeKindRoot)
          : toolGone
      const runtimeMs = Date.now() - runtimeStart
      if (!toolGone || !runtimeGone) {
        const locked = !toolGone ? toolDir(plan.name) : runtimeKindRoot
        const message = `Some files are still in use (locked by a running process or antivirus). Close the tool and retry in a moment. Locked: ${locked}`
        logger.warn(`Failed to fully remove managed tool ${name}: ${message}`, { toolMs, runtimeMs })
        return { removed: false, message: redactSecretText(message) }
      }
      // 同安装——卸载后强制重探，广播命中的是已移除状态。
      // 工具没了，它的失败记忆也没意义。
      this.installFailures.delete(name)
      const refreshStart = Date.now()
      await this.refreshSnapshotCache().catch((error) =>
        logger.warn('Post-remove snapshot refresh failed', error as Error)
      )
      logger.info(
        `Removed managed tool ${name} in ${Date.now() - startedAt}ms (tree ${toolMs}ms, runtime ${runtimeMs}ms, refresh ${Date.now() - refreshStart}ms)`
      )
      return { removed: true }
    } catch (error) {
      const message = redactSecretText(error instanceof Error ? error.message : this.errorMessage(error))
      logger.warn(`Failed to remove managed tool ${name}`, { error: message })
      return { removed: false, message }
    } finally {
      this.endOperation()
      release()
      this.broadcastChanged()
    }
  }

  /** 最新版本（尽力而为，失败即空值不抛）：dsh 走受管 npm view；hermes 走 PyPI 版本源。
   * 查询通道本身改为"失败即抛"（见 latestNpmVersion），**这里**按场景容忍——本方法
   * 由页面挂载自动调用，只用来展示"最新版"一行；用户点"检查更新"的那条路走 checkUpdates，
   * 那里失败会如实返回错误而不是"已是最新"。 */
  async getLatestVersions(): Promise<Record<BinaryToolName, string | undefined>> {
    const [dsh, hermes] = await Promise.all([
      this.latestNpmVersion('dsh').catch(() => undefined),
      this.latestPypiVersion('hermes').catch(() => undefined)
    ])
    // （用户裁决）：paper-agent 纯手动检查——本通道由渲染层在页面挂载时自动调用，
    // 恒不触 GitHub（匿名 API 限流也不该被页面挂载烧掉）。它的最新版本只由 checkUpdates
    // 显式拉取。
    return { dsh, hermes, 'paper-agent': undefined }
  }

  /**
   * 手动"检查更新"。与 getLatestVersions 的区别是**强制重探**——绕过快照 15s
   * 冷却与 stale-while-revalidate，并立刻广播变化，让版本卡的当前版本与结论同一时刻。
   *
   * 每个工具的最新版本来源：npm 型 = `npm view <pkg>@next`；venv 型 = PyPI JSON；
   * source 型 = GitHub 分支 HEAD 的短 SHA（上游无 tag/release，pyproject 版本号恒定）。
   */
  async checkUpdates(name: BinaryToolName): Promise<BinaryCheckUpdatesResult> {
    const plan = TOOL_PLANS.get(name)
    if (!plan) return { success: false, message: `Unknown managed tool: ${name}` }
    try {
      const snapshots = await this.refreshSnapshotCache()
      this.broadcastChanged()
      const availability = snapshots[name]?.availability
      // （）：**非受管安装不谈"版本"**。系统来源（PATH 上的同名工具）本应用既
      // 不知道它是什么版本、也升不了它；旧实现在这种情况下 current 恒为 undefined →
      // canUpgrade:false → 渲染层弹"已是最新版本"，那是对用户的假陈述。这里直接给出来源，
      // 由渲染层说人话（"该系统安装不受本应用管理"）。
      if (availability?.source !== 'managed') {
        return { success: true, source: availability?.source ?? 'none', canUpgrade: false }
      }
      const current = availability.version
      let latest: string | undefined
      if (plan.kind === 'npm') latest = await this.latestNpmVersion(name)
      else if (plan.kind === 'venv') latest = await this.latestPypiVersion(name)
      else {
        const { repo, branch } = plan.preset
        if (!repo || !branch) {
          return { success: false, message: `Source tool "${name}" has no repo/branch configured` }
        }
        latest = (await resolveHeadSha(repo, branch)).slice(0, 8)
      }
      return {
        success: true,
        source: 'managed',
        ...(current ? { current } : {}),
        ...(latest ? { latest } : {}),
        // 升级的前提是"装着一个版本"：未安装时 latest 只是"可装的最新版"，不是"可升级"。
        // 判据是不等（非语义版本串——SHA、预发布串——上这正是"有变化"的诚实含义，与渲染层
        // isNewerVersion 的非语义回退一致）。
        canUpgrade: !!latest && !!current && latest !== current
      }
    } catch (error) {
      const message = redactSecretText(this.errorMessage(error))
      logger.warn(`Failed to check updates for managed tool ${name}`, { error: message })
      return { success: false, message }
    }
  }

  /**
   * 最新版本查询（npm 通道 tag）。与 latestPypiVersion 同一条契约：**查不到就抛**——
   * "查不到"不得冒充"已是最新"（见该方法的说明）。
   */
  private async latestNpmVersion(name: string): Promise<string> {
    const plan = TOOL_PLANS.get(name)
    if (!plan || plan.kind !== 'npm') throw new Error(`Managed tool ${name} is not an npm-installed tool`)
    if (!(await isNodeRuntimeInstalled())) throw new Error('the managed Node runtime is not installed')
    try {
      const runtime = await ensureNodeRuntime()
      // 通道与安装同锚（DSH_NPM_DIST_TAG）：查 next tag 的版本，与安装语义恒一致。
      const stdout = await this.runCommand(
        runtime.npmBin,
        ['view', `${plan.preset.packageName}@${DSH_NPM_DIST_TAG}`, 'version'],
        {
          env: { ...process.env, npm_config_registry: NPM_REGISTRY_MIRROR },
          label: `npm view ${plan.preset.packageName}@${DSH_NPM_DIST_TAG}`,
          timeoutMs: NPM_VIEW_TIMEOUT_MS
        }
      )
      const version = stdout.trim().split(/\r?\n/, 1)[0]?.trim()
      if (!version) throw new Error('npm view returned an empty version')
      return version
    } catch (error) {
      logger.warn(`Failed to query latest version of ${plan.preset.packageName}`, { error: this.errorMessage(error) })
      throw error instanceof Error ? error : new Error(this.errorMessage(error))
    }
  }

  /**
   * 最新版本查询（PyPI）。源表与载荷解析在 pypiSources.ts（**每源各自的端点**——镜像不实现
   * JSON API 这一事实写在那张表里，不再两源共用一个路径模板）。
   *
   * 查不到就**抛**，不返回 undefined。"查不到"与"最新版就是当前版"是两回事，
   * 旧实现让后者冒充前者（渲染层据此弹"已是最新版本"）；调用方按场景决定是容忍（页面挂载时
   * 的自动查询）还是如实报错（用户点"检查更新"）。
   */
  private async latestPypiVersion(name: string): Promise<string> {
    const plan = TOOL_PLANS.get(name)
    if (!plan || plan.kind !== 'venv') throw new Error(`Managed tool ${name} is not a PyPI-installed tool`)
    const failures: string[] = []
    for (const source of PYPI_VERSION_SOURCES) {
      try {
        const response = await fetch(source.url(plan.preset.packageName), {
          ...(source.headers ? { headers: source.headers } : {}),
          signal: AbortSignal.timeout(PYPI_TIMEOUT_MS)
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const version = source.read(await response.json())
        if (version) return version
        throw new Error('the response carried no readable version')
      } catch (error) {
        // ASCII 箭头：→ 会被 GBK 控制台啃成乱码（真机日志取证）。
        failures.push(`${source.label} -> ${this.errorMessage(error)}`)
      }
    }
    logger.warn(`Failed to query latest version of ${plan.preset.packageName}`, { failures })
    throw new Error(`no PyPI source returned a version (${failures.join('; ')})`)
  }

  /** V2 broadcastAvailabilityChanged 的 fork 等价：无载荷全窗广播，消费者重拉快照。 */
  private broadcastChanged(): void {
    try {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(IpcChannel.CodeCli_Binary_Changed)
      }
    } catch (error) {
      // 下一份快照是权威事实；通知失败可恢复（V2 同款注释语义）。
      logger.warn('Failed to broadcast binary availability change', { error: this.errorMessage(error) })
    }
  }

  /** （用户裁决）：安装步骤进度广播——渲染层进度条的数据源。step 为 i18n 键尾
   * （code.install_progress.<step>），由渲染层翻译；detail 为语言无关的补充事实（下载字节
   * 数），fraction 为**进度条本体的确定性比例**（0..1，只有可测的阶段才有）；stage 为本次
   * 安装在阶段序列里的位置（进度条据此分段）。
   *
   * （用户反馈"进度条不反映真实下载进度"）：旧载荷只有步骤名，渲染层只能画一个
   * 匀速脉冲的假条。可测的阶段（下载）带上 fraction，渲染层画真条；不可测的阶段
   * （npm/pip/vite 的执行）不编造比例，保持不确定态——**宁可显示"不确定"，不显示假进度**。
   *
   * 载荷字段的类型取自共享契约（`Omit<InstallProgressPayload, 'tool' | 'step'>`）：契约加字段
   * 时这里会跟着报错，不会出现"主进程发了、广播悄悄丢掉"——`{...spread}` 恰好会绕过对象字面量
   * 多余属性检查，的 stage 就这样丢过一次（渲染层永远收不到 stage）。 */
  private broadcastInstallProgress(
    tool: BinaryToolName,
    step: InstallProgressStep,
    options: Omit<InstallProgressPayload, 'tool' | 'step'> = {}
  ): void {
    try {
      const payload = buildInstallProgressPayload(tool, step, options)
      // v1（W4-4）：进度同时记进"当前操作"——页面重挂载后靠快照里的这一份恢复步骤名/比例，
      // 不必等下一次事件（长阶段里事件稀疏，"等下一次"看起来就是进度丢了）。
      if (this.currentOperation !== null && this.currentOperation.name === tool) {
        this.currentOperation.progress = payload
      }
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(IpcChannel.CodeCli_Binary_InstallProgress, payload)
        }
      }
    } catch (error) {
      logger.warn('Failed to broadcast install progress', { error: this.errorMessage(error) })
    }
  }

  /**
   * 下载字节进度 → 进度条（detail 文本 + fraction 比例）。
   *
   * 判定逻辑（节流 / 完成必报 / 单调）是 downloadFile.ts 的纯函数 `selectProgressUpdate`——
   * 放那里是为了可单测；此处只负责 I/O（广播）与"一个 throttle 实例 = 一个阶段"的约定：
   * 调用方按阶段建各自的 reporter，阶段一变就换实例，比例随之从头开始。
   */
  private downloadProgressReporter(
    enter: InstallProgressEnter,
    step: InstallProgressStep
  ): (progress: DownloadProgress) => void {
    const throttle = createProgressThrottle()
    return (progress) => {
      const update = selectProgressUpdate(throttle, progress)
      if (!update) return
      enter(step, {
        detail: update.detail,
        ...(update.fraction !== undefined ? { fraction: update.fraction } : {})
      })
    }
  }

  /**
   * 下载器的进度回调组（字节比例 + 阶段切换）。成一个方法是为了让"下载 → 解压"这条链在
   * 三个工具、两种运行时上完全同形：比例按 `step` 上报，阶段切换（解压）由下载器触发。
   */
  private progressCallbacks(
    plan: ToolPlan,
    pipeline: readonly InstallProgressStep[],
    step: InstallProgressStep
  ): {
    onProgress: (progress: DownloadProgress) => void
    onStep: (next: InstallProgressStep) => void
  } {
    const enter = this.stepper(plan, pipeline)
    return {
      onProgress: this.downloadProgressReporter(enter, step),
      onStep: (next) => enter(next)
    }
  }

  /**
   * 本次安装的阶段进入器：把"第几步 / 共几步"附在每次广播上。
   *
   * 阶段序列由各安装函数**在运行时**组出来（条件阶段如 paper-agent 的 venv 只有需要时才进
   * 序列），所以 total 恒等于这次真会走的步数——不是猜的。步骤不在序列里时记一行日志并降级为
   * "只报步骤名"（进度条落回不确定态），绝不编一个位置。
   *
   * 位置**单调不回退**（与下载比例的单调约定同源：走过的段不会没走过）。回退请求确实会出现
   * ——同一个序列里可能有两次同类下载（paper-agent 的 CPython 与 node 各自"下载 + 解压"一轮），
   * 第二次的步骤名指向前面已走过的段。此时让条停在已到达的最远段并记一行日志：步骤名照实
   * 说"正在下载运行时…"（那是真的），条不倒着走（那也是真的），段内仍按字节填。
   */
  private stepper(plan: ToolPlan, pipeline: readonly InstallProgressStep[]): InstallProgressEnter {
    const tracker = createStageTracker(pipeline)
    let holdLogged = false
    return (step, extra) => {
      const { stage, held } = tracker(step)
      if (!stage) {
        logger.warn(`Install progress step "${step}" is not in the ${plan.kind} pipeline for ${plan.name}`)
      } else if (held && !holdLogged) {
        holdLogged = true
        logger.info(`Install progress held at stage ${stage.index} while re-entering "${step}" for ${plan.name}`)
      }
      this.broadcastInstallProgress(plan.name, step, { ...extra, ...(stage ? { stage } : {}) })
    }
  }

  /**
   * pip 阶段的上报器：从 pip 输出里数"已处理 N 个包 / 已下载 X MB"——真实且单调的计数，
   * **不编百分比**（分母要等 pip 自己解析完才知道）。按 ~700ms 节流。
   */
  private pipProgressReporter(enter: InstallProgressEnter, step: InstallProgressStep): (line: string) => void {
    const progress = createPipProgress()
    let lastReportedAt = 0
    return (line) => {
      feedPipProgress(progress, line)
      const now = Date.now()
      if (now - lastReportedAt < 700) return
      const detail = formatPipProgress(progress)
      if (!detail) return
      lastReportedAt = now
      enter(step, { detail })
    }
  }

  /** 命令执行原语抽到 runCommand.ts（市场通道共用），此处保留同一入口名。 */
  private runCommand(
    executable: string,
    args: string[],
    options: {
      env: NodeJS.ProcessEnv
      label: string
      timeoutMs?: number
      cwd?: string
      onOutputLine?: (line: string) => void
    }
  ): Promise<string> {
    return runBoundedCommand(executable, args, {
      ...options,
      timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    })
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}

export const binaryManager = new BinaryManager()

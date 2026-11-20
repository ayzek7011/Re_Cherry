import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import * as fsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import GoalService from '@deepseek-ai/dsh-goal'
import * as goalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as piAiPlugin from '@deepseek-ai/dsh-llm-pi-ai'
import SandboxPwshExecutor from '@deepseek-ai/dsh-pwsh-sandbox'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import * as shellEnv from '@deepseek-ai/dsh-shell-env'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { loggerService } from '@logger'
import { setCodeMateProviders } from '@main/services/codeCli/providerSnapshot'
import { getFilesDir } from '@main/utils/file'
import type { KernelWebSearchConfig } from '@shared/config/types'
import { isWorkModeApprovalTier, type WorkModeApprovalTier } from '@shared/config/workMode'
import type { KernelApprovalDecisionPayload, KernelQuestionAnswerPayload } from '@shared/interaction/types'
import { IpcChannel } from '@shared/IpcChannel'
import type { LightLlmCall } from '@shared/lightLlm/types'
import type { FileMetadata, MCPServer } from '@types'
import { FILE_TYPE } from '@types'
import { app, BrowserWindow, ipcMain } from 'electron'

import type { KnowledgeTurnBase, TurnDocument } from '../services/knowledge/KnowledgeService'
import { knowledgeService } from '../services/knowledge/KnowledgeService'
import { preprocessChannel } from '../services/preprocess/preprocessChannel'
import type { SkillTurnEntry } from '../services/skills/SkillService'
import { abortTopicWork } from '../services/topicWorkAbort'
import {
  attachmentFileExtension,
  CherryAttachmentStore,
  IMAGE_MEDIA_TYPES,
  parseImageAttachmentRef
} from './attachments'
import { CherryCredentialProvider } from './credentials'
import { DocumentKernelService } from './documentKernelService'
import { registerDsmlRepair } from './dsmlRepair'
import { setTurnGenerateImageConfig } from './generateImageTool'
import { ImageDescriberService } from './imageDescriber'
import { installRequestImageHandleAnchor } from './imageHandleText'
import type { KernelInteractionHub } from './interaction'
import { registerInteractionHost } from './interaction'
import { KnowledgeKernelService } from './knowledgeKernelService'
// fork 缝：流式补全真取消（Dsh_StreamAbort → abortLightStream）。
import { abortLightStream, lightOneShot, lightStream } from './lightLlm'
import { abortLightImage, lightEditImage, lightGenerateImage, setLightLlmProviderRoutes } from './lightLlmModalities'
import { MemoryKernelService } from './memoryKernelService'
import { registerModelStreamAbort } from './modelStreamAbort'
import { type KernelProviderInput, syncCherryProviders } from './providers'
import { registerAppServiceSeams, type TopicTreeService } from './services'
import { uiSessionEvent } from './sessionEventView'
import { SkillKernelService } from './skillKernelService'
import { installThinkingReplayTrim } from './thinkingReplay'
import { isTopicNotFoundError } from './topicNotFoundError'
import type { TopicSendOptions } from './topics'
import { clearLiveHandles, getTopic, initTopics, listTopicBranches, listTopics, searchSessions } from './topics'
import { WebSearchKernelService } from './webSearchService'

const logger = loggerService.withContext('Kernel')

/** ctx.topicTree 服务访问器（IPC 薄转发的唯一路径；服务在 boot 时由 registerAppServiceSeams 挂接）。 */
function topicTree(ctx: Context): TopicTreeService {
  const service = (ctx as unknown as { topicTree: TopicTreeService }).topicTree
  if (service === undefined) throw new Error('kernel: ctx.topicTree not registered')
  return service
}

let kernelContext: Context | undefined
let interactionHub: KernelInteractionHub | undefined
/** 内核 IPC 的注销函数（`registerKernelIpc` 返回值；停机时逐 channel 撤销）。 */
let kernelIpcDispose: (() => void) | undefined
/** `ctx.userQuestions.registerProvider` 的注销函数（停机时配对调用）。 */
let interactionUnregister: (() => void) | undefined

/** 已启动的内核上下文；未启动或已销毁时为 undefined。 */
export function getKernel(): Context | undefined {
  return kernelContext
}

/**
 * 停止内核：逆序 dispose 注册表中所有插件 fiber，
 * SQLite 持久化连接、事件监听等副作用随各自 disposer 清理。
 * 应用退出（will-quit）时必须调用，否则主进程事件循环被拖住、进程退不干净。
 */
export async function stopKernel(): Promise<void> {
  const ctx = kernelContext
  if (ctx === undefined) return
  kernelContext = undefined
  // 先撤销 IPC handler 与问答 provider，再拆 fiber。内核 IPC 注册以前不撤销任何
  // channel，于是二次 `bootKernel()`（模块重载 / 测试宿主）会撞 Electron 的
  // "Attempted to register a second handler"。撤销后 `requireKernel()` 仍以
  // `kernel not booted` 拒绝，不会留下指向已销毁 ctx 的脏 handler。
  try {
    kernelIpcDispose?.()
  } catch (error) {
    logger.warn('dsh kernel: ipc handler dispose failed', error instanceof Error ? error : new Error(String(error)))
  }
  kernelIpcDispose = undefined
  try {
    interactionUnregister?.()
  } catch (error) {
    logger.warn(
      'dsh kernel: user-questions provider unregister failed',
      error instanceof Error ? error : new Error(String(error))
    )
  }
  interactionUnregister = undefined
  interactionHub?.disposeAll()
  interactionHub = undefined
  clearLiveHandles()

  const runtimes = [...ctx.registry.values()]
  for (const runtime of runtimes.reverse()) {
    for (const fiber of [...runtime.fibers]) {
      try {
        await fiber.dispose()
      } catch (error) {
        logger.warn(
          'dsh kernel: fiber dispose failed during shutdown',
          error instanceof Error ? error : new Error(String(error))
        )
      }
    }
  }
  logger.info('dsh kernel stopped')
}

/**
 * 在主进程内以编程方式组装 Cordis 插件树（不走 YAML loader，避开打包路径问题）。
 * 插件树 = 内核：llm + 三协议适配器 + 会话存储/持久化 + 自动标题 + agent 回合循环。
 * 性能约束：无 HMR 文件监视、无定时器、无子进程、无 worker；写盘全部事件驱动。
 */
export async function bootKernel(): Promise<Context> {
  if (kernelContext !== undefined) return kernelContext

  const kernelDir = join(app.getPath('userData'), 'kernel')
  const ctx = new Context()

  try {
    // 配置与凭证层（provider 路由配置、apiKey 都由渲染进程推送）
    await ctx.plugin(FileSettingsProvider, {
      path: join(kernelDir, 'settings.json'),
      watch: false
    })
    await ctx.plugin(CherryCredentialProvider)

    // 附件仓库（识图通道）：ctx.attachments 服务缝的宿主实现。内容寻址 blob 落
    // kernelDir/attachments；会话日志只存 ref，读回与请求版本按 ref 即时核验。
    // 位置在 LLM 层之前——dsh-tool-fs 的 read_image 工具按"attachments 已挂载"注册。
    await ctx.plugin(CherryAttachmentStore, { root: join(kernelDir, 'attachments') })
    // 转述模型服务（识图通道补全）：ctx.imageDescriber 服务缝（cordis Service
    // 子类，super(ctx, 'imageDescriber')——直接给 ctx 赋属性会被声明制拒绝）。
    // 只持转述路由一份状态（Dsh_SyncImageDescriber 推送）；会话状态一概走日志真相源。
    await ctx.plugin(ImageDescriberService)
    // 网络搜索服务缝：ctx.webSearch——渲染层 websearch 切片同步投影
    //（providers/blacklist/searchWithTime，Dsh_SyncWebSearch 推送）+ 每轮提供商登记。
    // apiKey 只进主进程内存（引擎单例 services/WebSearchService），不落内核 settings.json。
    await ctx.plugin(WebSearchKernelService)
    // 知识检索每轮登记缝：ctx.knowledge（webSearch 同构，状态本体在主进程
    // KnowledgeService，嵌入路由随 Dsh_SyncProviders 快照刷新）。
    await ctx.plugin(KnowledgeKernelService)
    // 技能每轮登记缝：ctx.skills（同构，状态本体在主进程 SkillService，
    // SKILL.md 磁盘真相源新鲜读取）。
    await ctx.plugin(SkillKernelService)
    // 文档阅读每轮登记缝：ctx.documents（同构，状态本体在主进程
    // knowledgeService—— 起文档处理系统同时服务知识库摄取与聊天读文件，
    // 附件路径主进程直读）。
    await ctx.plugin(DocumentKernelService)
    // 持久记忆每轮登记缝：ctx.memory（同构，状态本体在 memoryKernelService
    // 模块单例；根目录由 topics.sendMessage 按助手 id 主进程派生并确保存在）。
    await ctx.plugin(MemoryKernelService)

    // LLM 层
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(piAiPlugin, { providers: {} })
    // 请求端思考回放剥离（见 thinkingReplay.ts）：动作点在包内"dsh 消息 → pi 消息"
    // 转换，无公开缝可投（`llm/stream` 瀑布只能观察、不能替换请求），因此在内核包上
    // 补一层中性门（globalThis 钩子，门缺失 = 零行为差异），判定与剥离逻辑全在本仓
    // thinkingReplay.ts。必须在 piAiPlugin 装载后、首个请求前安装。
    installThinkingReplayTrim()
    // 图片句柄短锚（上下文净化 A'，见 imageHandleText.ts）：pi-ai 在 wire 上给每个
    // image part 伴一条上游长句柄（hash+尺寸），经由同一补丁文件的第二个中性门
    // （globalThis.__recRequestImageHandleText）改写为中文短锚 `图片N (WxHpx)`；
    // 钩子缺失/形状不认识 = 上游原样（零行为差异）。
    installRequestImageHandleAnchor()
    // 响应端工具调用修复：挂在 dsh 文档化的 `llm/stream` waterfall 上，
    // agent-loop 的 ctx.llm.stream / prepareCall().stream 两条路径都经此，恒开不受开关约束。
    // DSML 修复自身不走补丁（移除了当时的 dsh-llm-pi-ai 行为补丁）；内核包上现存的
    // 唯一补丁文件持有两个请求端中性门（思考剥离 + 图片句柄短锚，见 thinkingReplay.ts 头注
    // 与 imageHandleText.ts 头注），与 DSML 修复（响应端 waterfall）机制不同、互不替代。
    registerDsmlRepair(ctx)
    // 在途模型流切断（v1：暂停一律直接打断，见 modelStreamAbort.ts）：同一 waterfall 上
    // 按话题登记我方中断信号，`Dsh_TopicStop` → `abortTopicWork` 即在途 HTTP 请求当场被 abort，
    // 运行时规范成 `finish { kind: 'aborted' }`。无人暂停时零行为差异。
    registerModelStreamAbort(ctx)

    // 提示词与工具层（tools 空注册：MCP 已砍，占位满足 agent-loop 的 inject）。
    // includeRuntimeContext 必须开：RuntimeContextProjection 靠它把动态上下文（工具面
    // 快照 cherry:tool-face-state、沙箱/审批档位）在渲染值变化时投影成会话内消息——
    // 关着会把所有 context 压空（root suppressor 全局生效），模型就只剩历史锚定。
    await ctx.plugin(SystemPrompt, {
      includeHarnessIdentity: false,
      includeRuntimeContext: true,
      persona: ''
    })
    await ctx.plugin(ToolRuntime, { mode: 'native' })

    // 审批与问答（Step 2）：审批服务（ask 档 → answerer 链）+ 问答服务缝。
    // ask_user_question 工具改为 agent 作用域挂载（topics.ts，按助手"内置工具"开关，
    // 见 @shared/config/agentTools）——根部常驻会让纯对话请求永远携带工具 schema。
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    await ctx.plugin(UserQuestionService)

    // 沙箱与文件系统（Step 3）：策略服务（部署默认 read-only；工作区回退根 = 数据文件夹下的 .agent 围栏
    // ——助手未设工作目录的会话以此为本，围栏外读写一律拒绝或走审批升级，不再放宽到用户主目录）
    // + 沙箱化 fs 后端 + 观察策略（edit 前必须先读）+ 子进程运行时（glob/grep 的 rg 通道）。
    // 工具本体在 agent setup 时按话题工作模式作用域挂载（topics.ts ensureAgent），关闭 = 纯对话。
    const agentWorkspaceRoot = join(app.getPath('userData'), '.agent')
    await mkdir(agentWorkspaceRoot, { recursive: true })
    await ctx.plugin(SandboxPolicyService, {
      mode: 'read-only',
      workspaceRoot: agentWorkspaceRoot
    })
    await ctx.plugin(SandboxedFileSystem, {})
    await ctx.plugin(fsObservationPolicy)
    await ctx.plugin(LocalSubprocessRuntime)

    // 命令行与后台作业（Step 4）：shell-env 环境注册表（DSH_* 托管变量）+ 沙箱 runner
    // + 沙箱化 pwsh 执行器（ctx.shell，按会话 sandbox/mode 收敛）+ 进程内作业注册表（ctx.jobs）。
    await ctx.plugin(shellEnv, { dshHome: join(kernelDir) })

    // 修复（改机制）：Windows 沙箱 runner 的启动语义。
    //
    // `dsh-sandbox-local.windowsAclRunnerInvocation()` 以 **`[process.execPath, runner.js]`** 前缀
    // 启动受限 runner，其注释假设"前缀是 `[node, runner, …]`"。但本内核跑在 Electron 里，
    // `process.execPath` 是 `Re_Cherry.exe` —— 不给 `ELECTRON_RUN_AS_NODE` 时该子进程会按
    // **Electron 应用**启动：Chromium 起来加载资源（向被采集的 stderr 刷 `libpng warning: iCCP`）、
    // 消息循环不退出 → 采集器等不到子进程结束 → **每次 pwsh 都在超时到点被判定
    // `[timed out after Nms]` + `[exit code: 1]`**（正文其实已经产出）。
    //
    // 曾把该变量设到 ambient `process.env`（dsh childEnv 的父基底）——真机实锤
    // Chromium 自身子进程同受其害：GPU 进程惰性重生时继承变量、以 node 模式
    // 启动、全部 Chromium 开关报 `bad option` 后退出（exit_code=9）。故改为
    // `patches/@deepseek-ai__dsh-subprocess-local@0.1.1-rc.2.patch`：spawnSubprocess 内按
    // `program === process.execPath` 逐子进程注入——runner 获得 node 语义，pwsh/ripgrep
    // 等与 Chromium 子进程的环境保持干净。ambient 变量不再在此设置。
    // 实测（tools/branch-jump-artifacts/probe-sandbox-runner.mjs，仅此一个变量）：
    //   A 现状（无该变量）→ 20023ms 未退出、15 条 libpng；B 加该变量 → 87ms 干净退出、0 条 libpng。
    // ipc.ts / BackupManager 的 relaunch 清理保留（防用户系统环境同名变量外泄）。

    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(SandboxPwshExecutor, {})
    await ctx.plugin(LocalJobRegistry, {})

    // 会话层：内存 store + SQLite 持久化。
    // 话题标题服务（dsh-session-title）已移除：自动命名回归 V1 原理——
    // 快速模型 + 用户设置项，经 renderer services/topicNaming.ts 调度（turn/end 触发），
    // 名称经 Dsh_TopicRename 落注册表；注册表 .name 只服务重启恢复（物化缺行）。
    await ctx.plugin(SessionStore)
    await ctx.plugin(SqliteSessionPersistence, {
      path: join(kernelDir, 'sessions.db')
    })

    // Agent 层：注册表 + 回合循环（工厂由 loop 注入注册表）
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    // 目标域（dsh 原生词表轻挂）：同会话目标状态服务（事件溯源）+ 自动续轮驱动；
    // 模型面 goal 三件套（create/get/update）按助手开关在 topics.ts BUILTIN_MOUNTS 挂载。
    await ctx.plugin(GoalService)
    await ctx.plugin(goalRoundDriver)

    // App 服务 seam（P5）：话题树/会话回收/思考档位查询挂到 ctx，供未来插件接管
    registerAppServiceSeams(ctx)

    await initTopics(ctx)
    registerEventForwarding(ctx)

    // 审批/问答往返：请求帧推给所有窗口，回执经 IPC 回来（未决请求随内核停机作废）
    const interaction = registerInteractionHost(ctx, (message) => {
      const { kind, payload } = message as { kind: 'approval' | 'question'; payload: unknown }
      if (kind === 'approval') broadcast(IpcChannel.Dsh_ApprovalRequest, payload)
      else if (kind === 'question') broadcast(IpcChannel.Dsh_QuestionRequest, payload)
    })
    interactionHub = interaction.hub
    // 把撤销函数一起存下来，`stopKernel()` 才能配对拆掉 handler 与问答 provider。
    interactionUnregister = interaction.unregister
    kernelIpcDispose = registerKernelIpc()

    kernelContext = ctx
    logger.info('dsh kernel booted')
    return ctx
  } catch (error) {
    logger.error('dsh kernel failed to boot', error instanceof Error ? error : new Error(String(error)))
    throw error
  }
}

/** 内核事件 → 所有窗口（UI 是内核的显示器）。注入的插件源消息不是用户发言：就地不发。 */
function registerEventForwarding(ctx: Context): void {
  ctx.on('session/event', (session, event) => {
    // UI 视界判据的唯一落点之一（另两处：ctx.topicTree.uiEvents 与 searchSessions）：
    // 注入快照只服务模型上下文，渲染层不该看见，也无需自己再判（结构化）。
    const view = uiSessionEvent(event)
    if (view === undefined) return
    broadcast(IpcChannel.Dsh_SessionEvent, { topicId: session.id, event: view })
  })
  ctx.on('session/created', (session) => {
    broadcast(IpcChannel.Dsh_SessionEvent, { topicId: session.id, event: { type: 'session/created', data: {} } })
  })
  ctx.on('session/disposed', (session) => {
    broadcast(IpcChannel.Dsh_SessionEvent, { topicId: session.id, event: { type: 'session/disposed', data: {} } })
  })
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload)
    }
  }
}

/** 内核 IPC：provider 同步、冒烟、话题 CRUD 与聊天。返回值是逐 channel 撤销的注销函数。 */
function registerKernelIpc(): () => void {
  const requireKernel = (): Context => {
    const ctx = getKernel()
    if (ctx === undefined) throw new Error('kernel not booted')
    return ctx
  }

  // 注册即记账。handler 的注册面全在本函数内（29 处），统一经这个包装登记，
  // 避免"加了新通道却忘了加进撤销清单"这种漏项。
  const registeredChannels: string[] = []
  const handle = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    registeredChannels.push(channel)
    ipcMain.handle(channel, listener)
  }

  handle(IpcChannel.Dsh_SyncProviders, async (_event, providers: KernelProviderInput[]) => {
    await syncCherryProviders(requireKernel(), providers)
    // 知识库：嵌入客户端复用同一路由快照（apiHost/apiKey 只进主进程内存）。
    knowledgeService.setProviders(providers)
    // 轻量 AI 服务面非 chat 模态（embed/rerank/image）共用同一路由快照。
    setLightLlmProviderRoutes(providers)
    // 编码助手：dsh/hermes 配置投影与网关五函数共用同一路由快照。
    setCodeMateProviders(providers)
    return { ok: true }
  })

  // 转述模型配置同步（识图通道补全）：payload = { provider, model, prompt } 或 null（未配置）。
  // prompt 为空字符串 = 内置默认提示词（@shared/config/imageDescriber）。
  // 内核不做路由存在性校验——provider 同步（Dsh_SyncProviders）才是路由的真相源，
  // 这里只落 ctx.imageDescriber；describe_images 执行时路由缺失自然明错。
  handle(
    IpcChannel.Dsh_SyncImageDescriber,
    async (_event, config: { provider: unknown; model: unknown; prompt: unknown } | null) => {
      const ctx = requireKernel()
      const describer = (
        ctx as unknown as {
          imageDescriber?: {
            setConfig: (r: { provider: string; model: string } | undefined, prompt: string) => void
          }
        }
      ).imageDescriber
      if (describer === undefined) throw new Error('kernel: image describer service not mounted')
      if (config === null) {
        describer.setConfig(undefined, '')
        return { ok: true }
      }
      if (
        typeof config?.provider !== 'string' ||
        config.provider.length === 0 ||
        typeof config?.model !== 'string' ||
        config.model.length === 0 ||
        typeof config?.prompt !== 'string'
      ) {
        throw new Error('kernel: invalid image describer config payload')
      }
      describer.setConfig({ provider: config.provider, model: config.model }, config.prompt)
      return { ok: true }
    }
  )

  // 网络搜索配置同步：渲染层 websearch 切片整体投影（providers 含 apiKey /
  // blacklist / searchWithTime）。只落 ctx.webSearch（引擎 setConfig），不做字段级校验
  // ——引擎执行时对缺失提供商自然明错；apiKey 仅存主进程内存。
  handle(IpcChannel.Dsh_SyncWebSearch, async (_event, config: KernelWebSearchConfig) => {
    const ctx = requireKernel()
    const webSearch = (ctx as unknown as { webSearch?: { setConfig: (config: KernelWebSearchConfig) => void } })
      .webSearch
    if (webSearch === undefined) throw new Error('kernel: web search service not mounted')
    webSearch.setConfig(config)
    return { ok: true }
  })

  // 网络搜索连通性检查：'test query' 真跑一次引擎（同一条真实执行路径，
  // 比上游渲染层侧测更诚实）。引擎未同步该提供商时按其就绪判定自然失败。
  handle(IpcChannel.WebSearch_Check, async (_event, providerId: string) => {
    const { webSearchService } = await import('../services/WebSearchService')
    return { ok: await webSearchService.check(providerId) }
  })

  // MCP 服务器配置同步：渲染层 mcp 切片整体投影进主进程 MCPService 内存
  //（命令/args/env 可能含密钥，与 webSearch 同先例只进主进程内存，不落盘不进会话）。
  // 内核 MCP 桥（mcpBridge.ts）挂载时按 serverId 从这里反查配置。
  handle(IpcChannel.Dsh_SyncMcpServers, async (_event, servers: unknown) => {
    const { mcpService } = await import('../services/mcp/MCPService')
    if (!Array.isArray(servers)) throw new Error('kernel: invalid mcp servers sync payload')
    mcpService.setServers(servers as MCPServer[])
    return { ok: true }
  })

  // 文档处理通道配置同步（三轮）：preprocess 切片 providers 整体投影
  //（apiKey 只进主进程内存，webSearch/MCP 同先例）。ocr_document 工具与知识库
  // 摄取的 PDF 路由按此配置表反查服务商（V2 对齐：配置即路由）。
  // 投影按字段白名单收敛（渲染层输入一律校验）——vision-model 条目的
  // 视觉模型引用取 { provider, model } 两个非空字符串，畸形即视为未配置。
  handle(IpcChannel.Dsh_SyncPreprocess, async (_event, providers: unknown) => {
    if (!Array.isArray(providers)) throw new Error('kernel: invalid preprocess sync payload')
    const configs = providers.map((provider) => {
      if (typeof provider !== 'object' || provider === null || typeof (provider as { id?: unknown }).id !== 'string') {
        throw new Error('kernel: invalid preprocess provider entry')
      }
      const entry = provider as {
        id: string
        apiKey?: unknown
        apiHost?: unknown
        model?: unknown
        visionModel?: unknown
        visionConcurrency?: unknown
        localConcurrency?: unknown
        gpuAcceleration?: unknown
      }
      const rawVision = entry.visionModel as { provider?: unknown; model?: unknown } | undefined
      const visionModel =
        typeof rawVision?.provider === 'string' &&
        rawVision.provider.length > 0 &&
        typeof rawVision.model === 'string' &&
        rawVision.model.length > 0
          ? { provider: rawVision.provider, model: rawVision.model }
          : undefined
      // 页级并发数收敛：vision 整数 1..40、local 整数 1..20，越界（含缺省）不投影，走主进程缺省。
      const clampConcurrency = (value: unknown, max: number): number | undefined =>
        typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max ? value : undefined
      const visionConcurrency = clampConcurrency(entry.visionConcurrency, 40)
      const localConcurrency = clampConcurrency(entry.localConcurrency, 20)
      const gpuAcceleration = entry.gpuAcceleration === false ? false : true
      return {
        id: entry.id,
        ...(typeof entry.apiKey === 'string' ? { apiKey: entry.apiKey } : {}),
        ...(typeof entry.apiHost === 'string' ? { apiHost: entry.apiHost } : {}),
        ...(typeof entry.model === 'string' ? { model: entry.model } : {}),
        ...(visionModel === undefined ? {} : { visionModel }),
        ...(visionConcurrency === undefined ? {} : { visionConcurrency }),
        ...(localConcurrency === undefined ? {} : { localConcurrency }),
        gpuAcceleration
      }
    })
    preprocessChannel.setConfig(configs)
    return { ok: true }
  })

  handle(
    IpcChannel.Dsh_StreamSmoke,
    async (
      _event,
      payload: { providers: KernelProviderInput[]; providerId: string; modelId: string; prompt: string }
    ) => {
      const ctx = requireKernel()
      const { providers, providerId, modelId, prompt } = payload

      await syncCherryProviders(ctx, providers)

      const { text, finishKind } = await lightOneShot(ctx, {
        provider: providerId,
        model: modelId,
        messages: [{ role: 'user', text: prompt }],
        source: 'cherry-smoke'
      })
      return { text, finish: finishKind }
    }
  )

  // ---- 轻量 LLM 服务（一次性/流式补全；实现见 lightLlm.ts，handler 只做薄转发） ----

  handle(IpcChannel.Dsh_Complete, async (_event, payload: LightLlmCall) => {
    return await lightOneShot(requireKernel(), payload)
  })

  handle(IpcChannel.Dsh_StreamComplete, async (event, payload: { requestId: string } & LightLlmCall) => {
    const ctx = requireKernel()
    const { requestId } = payload
    const send = (data: object): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IpcChannel.Dsh_CompletionEvent, { requestId, ...data })
      }
    }
    let lastEventWasTerminal = false
    // fork 缝：requestId 一并交给 lightStream，登记为该流的取消键（Dsh_StreamAbort）。
    await lightStream(
      ctx,
      payload,
      (streamEvent) => {
        if (streamEvent.type === 'error' || streamEvent.type === 'done') {
          // 终态只发一次：lightStream 的异常路径已在事件面收口，这里不重复补发
          if (lastEventWasTerminal) return
          lastEventWasTerminal = true
        }
        send(streamEvent)
      },
      requestId
    )
    return { ok: true }
  })

  // fork 缝：流式补全取消（渲染层「停止/暂停」的真取消缝；未命中 requestId 为无害空操作）。
  handle(IpcChannel.Dsh_StreamAbort, (_event, requestId: unknown) => {
    if (typeof requestId === 'string' && requestId.length > 0) {
      abortLightStream(requestId)
    }
    return { ok: true }
  })

  // ---- 轻量图像模态（绘画页/生图工具的执行缝；实现见 lightLlmModalities.ts） ----

  handle(
    IpcChannel.Dsh_LightImage,
    async (
      _event,
      payload: { mode: 'generate' | 'edit' } & Record<string, unknown>
    ): Promise<{ type: 'url' | 'base64'; images: string[] }> => {
      if (payload?.mode === 'edit') {
        return await lightEditImage(payload as unknown as Parameters<typeof lightEditImage>[0])
      }
      return await lightGenerateImage(payload as unknown as Parameters<typeof lightGenerateImage>[0])
    }
  )

  handle(IpcChannel.Dsh_LightImageAbort, (_event, requestId: unknown) => {
    if (typeof requestId === 'string' && requestId.length > 0) {
      abortLightImage(requestId)
    }
    return { ok: true }
  })

  // ---- 话题 ----

  handle(IpcChannel.Dsh_TopicList, () => {
    return { topics: listTopics() }
  })

  handle(
    IpcChannel.Dsh_TopicCreate,
    async (
      _event,
      input: {
        id: string
        name?: string
        provider: string
        model: string
        maxTokens?: number
        systemPrompt?: string
        reasoningEffort?: string
        workingDir?: string
      }
    ) => {
      return { topic: await topicTree(requireKernel()).create(input) }
    }
  )

  handle(IpcChannel.Dsh_TopicRename, async (_event, id: string, name: string) => {
    return { topic: await topicTree(requireKernel()).rename(id, name) }
  })

  handle(IpcChannel.Dsh_TopicDelete, async (_event, id: string) => {
    // `ok` = 注册表行已删（话题从 UI 消失）；`purged` = 磁盘上的会话数据也清掉了。
    // 旧写法无条件回 `{ ok: true }`，把"物理清盘失败"伪装成完全成功。
    const purged = await topicTree(requireKernel()).delete(id)
    if (!purged) {
      logger.error(
        `kernel: topic "${id}" delete reported a physical purge failure — the persisted session is still on disk`
      )
    }
    return { ok: true, purged }
  })

  handle(IpcChannel.Dsh_TopicDestroyTurns, async (_event, id: string, anchorUserSeqs: number[]) => {
    return await topicTree(requireKernel()).destroyTurns(id, anchorUserSeqs)
  })

  handle(IpcChannel.Dsh_TopicOpen, async (_event, id: string) => {
    await topicTree(requireKernel()).open(id)
    return { ok: true }
  })

  handle(IpcChannel.Dsh_TopicFork, async (_event, sourceTopicId: string, anchorUserMessageSeq: number) => {
    return { topic: await topicTree(requireKernel()).fork(sourceTopicId, anchorUserMessageSeq) }
  })

  handle(IpcChannel.Dsh_TopicBranches, (_event, rootTopicId: string) => {
    return { topics: listTopicBranches(rootTopicId) }
  })

  handle(
    IpcChannel.Dsh_TopicSend,
    async (
      _event,
      id: string,
      text: string,
      options?: {
        reasoningEffort?: string
        builtinTools?: string[]
        externalTools?: string[]
        tier?: WorkModeApprovalTier
        images?: Array<{ mediaType?: unknown; data?: unknown; name?: unknown }>
        webSearch?: { providerId?: unknown }
        knowledgeBases?: unknown
        skills?: unknown
        documents?: unknown
        preprocess?: { providerId?: unknown }
        generateImage?: { providerId?: unknown; modelId?: unknown }
        memory?: { assistantId?: unknown }
      }
    ) => {
      // 白名单重建（形态）+ 能力载荷（webSearch/knowledgeBases/
      // skills/documents）。事故教训：白名单漏字段 = 静默剥离——工具挂载了
      // （builtinTools 在列）但每轮登记永远落空，真机表现为
      // "no web search provider is configured for this conversation turn"。
      // 新增字段必须三层同步：preload 声明 → 本 handler → topics.TopicSendOptions。
      const cleanOptions: TopicSendOptions = {}
      if (options?.reasoningEffort !== undefined) {
        if (typeof options.reasoningEffort !== 'string') {
          throw new Error('kernel: invalid reasoningEffort in topic send options')
        }
        cleanOptions.reasoningEffort = options.reasoningEffort
      }
      if (options?.tier !== undefined) {
        if (!isWorkModeApprovalTier(options.tier)) {
          throw new Error('kernel: invalid tier in topic send options')
        }
        cleanOptions.tier = options.tier
      }
      if (options?.builtinTools !== undefined) {
        if (!Array.isArray(options.builtinTools) || options.builtinTools.some((toolId) => typeof toolId !== 'string')) {
          throw new Error('kernel: invalid builtinTools in topic send options')
        }
        cleanOptions.builtinTools = options.builtinTools
      }
      if (options?.externalTools !== undefined) {
        if (
          !Array.isArray(options.externalTools) ||
          options.externalTools.some((toolId) => typeof toolId !== 'string')
        ) {
          throw new Error('kernel: invalid externalTools in topic send options')
        }
        cleanOptions.externalTools = options.externalTools
      }
      if (options?.images !== undefined) {
        if (!Array.isArray(options.images)) {
          throw new Error('kernel: invalid images in topic send options')
        }
        cleanOptions.images = options.images.map((image) => {
          if (
            typeof image !== 'object' ||
            image === null ||
            typeof image.mediaType !== 'string' ||
            !IMAGE_MEDIA_TYPES.includes(image.mediaType as ImageMediaType) ||
            typeof image.data !== 'string' ||
            image.data.length === 0 ||
            (image.name !== undefined && typeof image.name !== 'string')
          ) {
            throw new Error('kernel: invalid image entry in topic send options')
          }
          return {
            mediaType: image.mediaType as ImageMediaType,
            data: image.data,
            ...(typeof image.name === 'string' && image.name.length > 0 ? { name: image.name } : {})
          }
        })
      }
      if (options?.webSearch !== undefined) {
        const webSearch = options.webSearch
        if (
          typeof webSearch !== 'object' ||
          webSearch === null ||
          typeof webSearch.providerId !== 'string' ||
          webSearch.providerId.length === 0
        ) {
          throw new Error('kernel: invalid webSearch in topic send options')
        }
        cleanOptions.webSearch = { providerId: webSearch.providerId }
      }
      if (options?.knowledgeBases !== undefined) {
        if (!Array.isArray(options.knowledgeBases)) {
          throw new Error('kernel: invalid knowledgeBases in topic send options')
        }
        cleanOptions.knowledgeBases = options.knowledgeBases.map((base) => {
          // 只校验结构必需（id + 嵌入模型引用），其余字段（chunkSize/threshold/
          // dimensions 等）按原样透传—— 事故：dimensions 在
          // KnowledgeEmbeddingRef 里本就可选（旧 base 无此值），过严校验把整条
          // topic-send 炸掉，用户的知识库助手完全无法发消息。
          if (
            typeof base !== 'object' ||
            base === null ||
            typeof (base as { id?: unknown }).id !== 'string' ||
            typeof (base as { embedding?: unknown }).embedding !== 'object' ||
            (base as { embedding?: { providerId?: unknown; modelId?: unknown } }).embedding === null ||
            typeof (base as { embedding: { providerId?: unknown } }).embedding.providerId !== 'string' ||
            typeof (base as { embedding: { modelId?: unknown } }).embedding.modelId !== 'string'
          ) {
            throw new Error('kernel: invalid knowledge base entry in topic send options')
          }
          return base as KnowledgeTurnBase
        })
      }
      if (options?.skills !== undefined) {
        if (!Array.isArray(options.skills)) {
          throw new Error('kernel: invalid skills in topic send options')
        }
        cleanOptions.skills = options.skills.map((skill) => {
          if (
            typeof skill !== 'object' ||
            skill === null ||
            typeof (skill as { id?: unknown }).id !== 'string' ||
            typeof (skill as { folderName?: unknown }).folderName !== 'string' ||
            typeof (skill as { name?: unknown }).name !== 'string' ||
            typeof (skill as { description?: unknown }).description !== 'string'
          ) {
            throw new Error('kernel: invalid skill entry in topic send options')
          }
          return skill as SkillTurnEntry
        })
      }
      if (options?.documents !== undefined) {
        if (!Array.isArray(options.documents)) {
          throw new Error('kernel: invalid documents in topic send options')
        }
        cleanOptions.documents = options.documents.map((document) => {
          if (
            typeof document !== 'object' ||
            document === null ||
            typeof (document as { name?: unknown }).name !== 'string' ||
            typeof (document as { path?: unknown }).path !== 'string'
          ) {
            throw new Error('kernel: invalid document entry in topic send options')
          }
          return document as TurnDocument
        })
      }
      if (options?.preprocess !== undefined) {
        const providerId = (options.preprocess as { providerId?: unknown } | null)?.providerId
        if (typeof providerId !== 'string' || providerId.length === 0) {
          throw new Error('kernel: invalid preprocess in topic send options')
        }
        cleanOptions.preprocess = { providerId }
      }
      if (options?.generateImage !== undefined) {
        const generateImage = options.generateImage
        if (
          typeof generateImage !== 'object' ||
          generateImage === null ||
          typeof generateImage.providerId !== 'string' ||
          generateImage.providerId.length === 0 ||
          typeof generateImage.modelId !== 'string' ||
          generateImage.modelId.length === 0
        ) {
          throw new Error('kernel: invalid generateImage in topic send options')
        }
        cleanOptions.generateImage = { providerId: generateImage.providerId, modelId: generateImage.modelId }
      }
      if (options?.memory !== undefined) {
        const memory = options.memory
        if (
          typeof memory !== 'object' ||
          memory === null ||
          typeof memory.assistantId !== 'string' ||
          memory.assistantId.length === 0
        ) {
          throw new Error('kernel: invalid memory in topic send options')
        }
        // 只上行助手 id：memory 根目录由主进程派生（路径权威在主进程）。
        cleanOptions.memory = { assistantId: memory.assistantId }
      }
      // 聊天生图：本轮绘画模型登记（generate_image 工具执行时按 topicId 反查）。
      setTurnGenerateImageConfig(id, cleanOptions.generateImage)
      await topicTree(requireKernel()).send(id, text, cleanOptions)
      return { ok: true }
    }
  )

  // 内核图片附件回放同步（识图通道）：按 ref 从附件仓读回并核验字节，
  // 确定性落进渲染层文件仓（<attachmentId>.<ext>，同 id 同字节幂等），返回 FileMetadata。
  // 渲染层把它 upsert 进 Dexie 后即可按普通图片块渲染（file:// 直读）。
  handle(IpcChannel.Dsh_AttachmentSync, async (_event, ref: unknown) => {
    const parsed = parseImageAttachmentRef(ref)
    const ctx = requireKernel()
    const stored = await ctx.attachments.readImage(parsed)
    const ext = attachmentFileExtension(parsed.mediaType)
    const filesDir = getFilesDir()
    await mkdir(filesDir, { recursive: true })
    const fileName = `${parsed.attachmentId}${ext}`
    const filePath = join(filesDir, fileName)
    await writeFile(filePath, stored.data)
    const file: FileMetadata = {
      id: parsed.attachmentId,
      name: fileName,
      origin_name: parsed.name ?? fileName,
      path: filePath,
      size: stored.data.byteLength,
      // FileMetadata.ext 带点（与上传路径一致）：getFilePath / base64File(id+ext)
      // / delete(id+ext) 全按 "<id>.<ext>" 拼文件名，剥点会让回放图片 404 变占位符。
      ext,
      type: FILE_TYPE.IMAGE,
      created_at: new Date().toISOString(),
      count: 1
    }
    return { file }
  })

  handle(IpcChannel.Dsh_TopicStop, (_event, id: string) => {
    // [pause-probe] 停止指令到达主进程的落盘痕迹：排查"暂停打不断"时用它区分
    // 「渲染层没发」与「内核没中断在途工具」。
    const tree = topicTree(requireKernel())
    logger.warn(`[pause-probe] kernel stop requested for "${id}" (running before stop = ${tree.isRunning(id)})`)
    // 2026-10-01（真机取证）：内核的 stop **不中断在途工具**（stop 返回后 isRunning 仍为 true，
    // 那次 OCR 随后照常跑完）。所以这里同时中止我们自己的长活（文档处理按话题登记，见
    // services/topicWorkAbort.ts）——暂停要真的打断，就不能只依赖内核。
    const abortedWork = abortTopicWork(id, new Error('paused by user'))
    logger.warn(`[pause-probe] aborted ${abortedWork} in-flight topic work item(s) for "${id}"`)
    tree.stop(id)
    logger.warn(`[pause-probe] kernel stop returned (running after stop = ${tree.isRunning(id)})`)
    return { ok: true }
  })

  handle(IpcChannel.Dsh_TopicRunning, (_event, id: string) => {
    return { running: topicTree(requireKernel()).isRunning(id) }
  })

  handle(IpcChannel.Dsh_TopicEvents, async (_event, id: string) => {
    const ctx = requireKernel()
    const tree = topicTree(ctx)
    // 必须 await：重启后 agent 需从持久化异步 resume，
    // 不同步等待则下方 events 取不到 agent 而抛 "session is not loaded"
    try {
      await tree.open(id)
    } catch (error) {
      // 确定性"注册表无此行"（从未建册/已删）= 真实状态：按空会话回答——渲染层本就把
      // 这一答案降级为空（kernelEventStream.isDefinitiveTopicUnknown），在源头回答可免
      // ipcMain.handle 的 reject 被 Electron 无条件打印成 "Error occurred in handler"。
      // 瞬时失败（"session is not loaded" 等）照原样抛——渲染层对它们有重试窗口。
      if (isTopicNotFoundError(error)) return { events: [] }
      throw error
    }
    // UI 视界：注入的插件源消息已由 seam 剔除（渲染层因此不需要可见性判据）
    return { events: tree.uiEvents(id) }
  })

  handle(IpcChannel.Dsh_TopicGet, (_event, id: string) => {
    return { topic: getTopic(id) }
  })

  handle(IpcChannel.Dsh_SearchMessages, async (_event, terms: string[]) => {
    return { hits: await searchSessions(requireKernel(), terms) }
  })

  // ---- 审批/问答回执（Step 2）----

  handle(IpcChannel.Dsh_ApprovalDecide, (_event, decision: KernelApprovalDecisionPayload) => {
    if (
      decision === null ||
      typeof decision !== 'object' ||
      typeof decision.requestId !== 'string' ||
      (decision.behavior !== 'allow' && decision.behavior !== 'deny')
    ) {
      throw new Error('kernel: invalid approval decision payload')
    }
    return { ok: interactionHub?.decideApproval(decision) ?? false }
  })

  handle(IpcChannel.Dsh_QuestionAnswer, (_event, answer: KernelQuestionAnswerPayload) => {
    if (
      answer === null ||
      typeof answer !== 'object' ||
      typeof answer.requestId !== 'string' ||
      !Array.isArray(answer.answers)
    ) {
      throw new Error('kernel: invalid question answer payload')
    }
    return { ok: interactionHub?.answerQuestion(answer) ?? false }
  })

  // 停机时逐 channel 撤销。`removeHandler` 对未注册通道是安全的空操作。
  return () => {
    for (const channel of registeredChannels) {
      ipcMain.removeHandler(channel)
    }
  }
}

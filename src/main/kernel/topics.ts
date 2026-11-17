import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { EncodedImageAttachment, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import { effectiveSandboxMode, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { type SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import * as toolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as toolGoal from '@deepseek-ai/dsh-tool-goal'
import * as toolJobs from '@deepseek-ai/dsh-tool-jobs'
import * as toolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import * as toolStrReplaceEditor from '@deepseek-ai/dsh-tool-str-replace-editor'
import * as toolTodo from '@deepseek-ai/dsh-tool-todo'
import { effectiveApprovalPolicy, setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { loggerService } from '@logger'
import { EXTERNAL_TOOL_IDS, type ExternalToolId } from '@shared/config/agentTools'
import { KERNEL_REASONING_LEVELS, type KernelReasoningLevel } from '@shared/config/reasoning'
import { WORK_MODE_APPROVAL_TIERS, type WorkModeApprovalTier } from '@shared/config/workMode'
import type { MCPTool } from '@types'
import { app } from 'electron'

import type { KnowledgeTurnBase, TurnDocument } from '../services/knowledge/KnowledgeService'
import { knowledgeService } from '../services/knowledge/KnowledgeService'
import { mcpService } from '../services/mcp/MCPService'
import { preprocessChannel } from '../services/preprocess/preprocessChannel'
import type { SkillTurnEntry } from '../services/skills/SkillService'
import { skillService } from '../services/skills/SkillService'
import * as askUserTool from './askUserTool'
import * as describeImagesTool from './describeImageTool'
import * as documentExtractTool from './documentExtractTool'
import * as documentTool from './documentTool'
import * as generateImageTool from './generateImageTool'
import * as knowledgeReadTool from './knowledgeReadTool'
import * as knowledgeSearchTool from './knowledgeSearchTool'
import { type LegacyIgnorableMigrationOutcome, migrateLegacyIgnorableEvents } from './legacySessionMigration'
import { createMcpBridgeModule } from './mcpBridge'
import { getTurnMemoryRoot } from './memoryKernelService'
import * as memoryTool from './memoryTool'
import * as moveToTrashTool from './moveToTrashTool'
import * as ocrDocumentTool from './ocrDocumentTool'
import * as saveAttachmentTool from './saveAttachmentTool'
import { isInjectedUserEvent } from './sessionEventView'
import { resumeOrCreateSession } from './sessionResumeFallback'
import * as skillTool from './skillTool'
import { hardenUntrustedText } from './untrustedContent'
import * as webFetchTool from './webFetchTool'
import * as webSearchTool from './webSearchTool'

const logger = loggerService.withContext('KernelTopics')

const REASONING_RANK = new Map<string, number>(KERNEL_REASONING_LEVELS.map((level, index) => [level, index]))

/** 话题元数据注册表（对话本体在 dsh session 里，这里只存 Cherry UI 需要的元数据）。 */
export interface KernelTopic {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  provider: string
  model: string
  maxTokens?: number
  systemPrompt?: string
  /** 当前请求使用的思考档位（pi-ai 词汇）；缺省/空串 = 不显式请求（交给 provider 默认）。 */
  reasoningEffort?: string
  /**
   * 上下文预算（请求里允许的消息条数上限）。渲染层随建册上行助手的 contextCount
   * 设置、随发送刷新；请求端经 dsh-llm-pi-ai 补丁的第三个中性门
   * （globalThis.__recApplyContextBudget，见 contextBudget.ts）按它裁掉最旧历史，
   * 防大对话每 step 全量 deriveMessages 触发 provider 上限拒绝（问题 1 R1）。
   * 缺省/undefined = 不裁剪（UNLIMITED_CONTEXT_COUNT 语义）。
   */
  contextCount?: number
  /** 分支血缘：有值 = forkTopic 切出的子分支会话（父会话 id）；未定义 = 普通话题/窗口根。侧栏列表只显示根。 */
  parentTopicId?: string
  /** 截断删除后被取代：值为替代它的新会话 id；可见层与清扫只认新会话。 */
  supersededByTopicId?: string
  /** 工作目录（会话创建时写入 session header.cwd，绝对路径；仅新建话题生效）。 */
  workingDir?: string
}

interface KernelTopicInput {
  id: string
  name?: string
  provider: string
  model: string
  maxTokens?: number
  systemPrompt?: string
  reasoningEffort?: string
  /** 上下文预算（消息条数上限）；缺省 = 不裁剪。 */
  contextCount?: number
  /** 新话题的工作目录（= dsh 会话 header.cwd；仅新建话题生效）。 */
  workingDir?: string
}

interface TopicRegistryFile {
  topics: KernelTopic[]
}

let topics = new Map<string, KernelTopic>()
const liveHandles = new Map<string, AgentHandle>()
/**
 * 活体 agent 的工具面挂载状态（内置/外置工具 id 集）；随活体生命周期同步增删。
 * 铁律：任何机制都不得按“面 id 比对工具注册名”运作——一个插件注册几个工具、
 * 叫什么名是插件的内部事务。开关 = 挂载单元（插件级）：开 = 挂（schema 出现），
 * 关 = 撤（schema 消失）；关闭期间模型仍试图调用的，由 DSML 修复补丁转成真调用
 * 后落到 dsh 原生 unknown tool 结构化回执（带内反馈，不会静默成功）。
 */
interface MountedToolsState {
  builtins: string[]
  externals: string[]
  /**
   * MCP 挂载单元的漂移签名：`mcp:<serverId>` 挂载单元的 id 不含工具集信息，
   * 服务器配置/工具清单变化（listTools 缓存内容）不会改 id——签名把每台服务器的
   * 工具集哈希折叠进比对，变化即触发 dispose 重挂（工具面跟轮走的 MCP 补充维度）。
   * 无 mcp 挂载单元时为 ''（与 idListEquals 同语义：无该维度则恒等）。
   */
  mcpSignature: string
  /**
   * 每轮登记漂移签名：skill/read_document 的可用清单（cherry:skills /
   * cherry:documents 快照节）是 setup 时静态计算的——挂载单元 id 不随清单内容变化，
   * 启用集/附件集跨轮变更必须靠本签名触发重挂才对模型可见（真机实锤：
   * 注释曾声称"无需漂移签名"，实际首测即索引缺失）。无登记时为 ''。
   */
  turnRegSignature: string
  /** setup 时的 topic.systemPrompt 快照（闭包持行对象，行被 createTopic 换新后旧值不变）。 */
  systemPrompt: string
}
const mountedTools = new Map<string, MountedToolsState>()

/**
 * 活体 agent 建载（create/resume）时实际使用的路由（provider/model）。
 * dsh 只在 create/resume 时消费 agentOptions——live agent 不会随后续 createTopic upsert
 * 自动换路由（真机实锤：fork 后连切 Qwen/V4，六轮请求仍全发给首建时的 Kimi）。
 * 本表让 ensureAgent 能识别"注册表路由已变、活体还持旧路由"的漂移并重挂。
 */
const liveAgentRoute = new Map<string, { provider: string; model: string }>()

/**
 * 工具面挂载注册表（数据驱动，新增工具零逻辑改动）：id（@shared/config/agentTools 的
 * BUILTIN_TOOL_IDS / EXTERNAL_TOOL_IDS）→ 挂载单元。一个挂载单元可以在插件里展开成
 * 任意数量的工具（如 fs 展开 read/write/edit/read_image），挂载逻辑只认 id 不认工具名。
 */
const BUILTIN_MOUNTS: ReadonlyArray<{ id: string; mount: (agentCtx: Context) => PromiseLike<unknown> }> = [
  { id: 'ask_user_question', mount: (agentCtx) => agentCtx.plugin(askUserTool) },
  // 识图通道补全：主模型无视觉 + 已配置转述模型时由渲染层注入 builtinTools；
  // 工具体 = describe_images（本仓模块）。图片 ref 的真相源是会话日志，
  // 工具执行时在日志内反查（不建并行登记表）。
  { id: 'describe_images', mount: (agentCtx) => agentCtx.plugin(describeImagesTool) },
  // 网络搜索接线：渲染层 messageThunk 在助手网络搜索开启（webSearchProviderId
  // 就绪）的轮把 'web_search' 并入 builtinTools；执行走主进程引擎（services/WebSearchService），
  // 每轮提供商经 sendMessage options.webSearch 登记（见 sendMessage 内 setTurnProvider）。
  { id: 'web_search', mount: (agentCtx) => agentCtx.plugin(webSearchTool) },
  // 知识库接线：助手挂知识库（knowledge_bases 非空）的轮把 'knowledge_search'
  // 并入 builtinTools；执行直调主进程 KnowledgeService（嵌入+余弦检索），每轮库清单经
  // sendMessage options.knowledgeBases 登记（webSearch 同构）。
  { id: 'knowledge_search', mount: (agentCtx) => agentCtx.plugin(knowledgeSearchTool) },
  // skills 接线：助手启用技能（enabledSkills 非空）的轮把 'skill' 并入
  // builtinTools；可用技能的 name/description 索引由 setup 写入 RuntimeContextProjection
  // 快照节（setup 静态计算——启用集跨轮变更靠 turnRegSignature 漂移重挂刷新），工具按
  // name 反查磁盘 SKILL.md。
  { id: 'skill', mount: (agentCtx) => agentCtx.plugin(skillTool) },
  // 文档阅读（"聊天中文档阅读处理"）：触发消息带文件附件的
  // 轮把 'read_document' 并入 builtinTools；文档名清单由 setup 写入快照节，工具按名
  // 反查登记读全文（直读：PDF 文本层，无扫描件检测；空文本如实报错）。
  { id: 'read_document', mount: (agentCtx) => agentCtx.plugin(documentTool) },
  // 验收轮（2026-09-22 用户裁决）：OCR 分体独立内置工具——模型自行判断何时
  // 调用（read_document 文本层空/乱、或用户明确要 OCR）。挂载条件 = 本轮有
  // 文档附件（渲染层与 read_document 同轮并入）。执行按本轮登记的文档处理服务商
  // 路由（用户第三轮裁决：挂进文档处理通道，LocalPaddle 只是通道里的本地条目）；
  // 未登记/未配置时执行侧如实报可行动错误，不做静默降级。
  { id: 'ocr_document', mount: (agentCtx) => agentCtx.plugin(ocrDocumentTool) },
  // 聊天生图（V2 PaintingTool 同构）：助手 enableGenerateImage 开且
  // 绘画模型已配置的轮把 'generate_image' 并入 builtinTools；每轮绘画模型经
  // sendMessage options.generateImage 登记（webSearch 同构）。执行 = 轻量 AI 服务面
  // lightGenerateImage（主进程直调，无 IPC 旁路）。
  { id: 'generate_image', mount: (agentCtx) => agentCtx.plugin(generateImageTool) },
  // web_fetch（V2 WebFetchTool 同构）：随 web_search 挂载（webSearchActive 门由
  // 渲染层决定，fetch 本身不依赖搜索提供商）；执行走三级抓取链 + Readability，
  // 结果并入 web_search 同一条 [n] 编号链与引用卡。
  { id: 'web_fetch', mount: (agentCtx) => agentCtx.plugin(webFetchTool) },
  // knowledge_read（V2 kb_read 同构）：随 knowledge_search 挂载（turnBases 门）；
  // 命中文档整读/文档内 grep，baseId 执行侧防线复用每轮登记。
  { id: 'knowledge_read', mount: (agentCtx) => agentCtx.plugin(knowledgeReadTool) }
]

const EXTERNAL_MOUNTS: ReadonlyArray<{ id: string; mount: (agentCtx: Context) => PromiseLike<unknown> }> = [
  // tool-fs-search 的 sampleOverCapGlobResults 是必填无默认配置（schema fail-loud），
  // 不传会在 resume 重建时 ValidationError；true = glob 超限时采样截断并提示（而非报错）。
  { id: 'fs', mount: (agentCtx) => agentCtx.plugin(toolFs) },
  { id: 'fsSearch', mount: (agentCtx) => agentCtx.plugin(toolFsSearch, { sampleOverCapGlobResults: true }) },
  { id: 'editor', mount: (agentCtx) => agentCtx.plugin(toolStrReplaceEditor) },
  { id: 'pwsh', mount: (agentCtx) => agentCtx.plugin(toolPwsh) },
  { id: 'jobs', mount: (agentCtx) => agentCtx.plugin(toolJobs) },
  // （V2 同名工具移植）：工作区安全删除（OS 回收站）+ 附件物化。
  // 两者共用档位升级流（read-only 档拒绝 + sandbox_permissions 问询放行）。
  { id: 'trash', mount: (agentCtx) => agentCtx.plugin(moveToTrashTool) },
  { id: 'saveAttachment', mount: (agentCtx) => agentCtx.plugin(saveAttachmentTool) },
  // （2026-10-21 用户裁决）：磁盘文档线——按绝对路径抽取文档文字，两臂同权
  // （markitdown 文本层缺省 / 文档处理通道扫描件，模型显式选 engine）。附件线
  // （read_document/ocr_document，按每轮登记名读）不动，两条线互不替代。
  { id: 'documentsExtract', mount: (agentCtx) => agentCtx.plugin(documentExtractTool) },
  // 用户裁决：memory / todo / goal 归外置（工作模式作用域）——它们都在会话之外
  // 留持久状态（memory 写磁盘助手级 FACT/JOURNAL；todo/goal 写会话日志并驱动 UI 面板/
  // 自动续轮）。memory 每轮根目录经 sendMessage options.memory（assistantId）登记，
  // FACT.md 内容进 cherry:memory 快照节（recall side），JOURNAL 仅工具可达。
  // dsh 原生词表（V2 dsh 驱动组合差集）：todo_write（allowParallelInProgress: false =
  // 单活纪律）+ goal 三件套（create/get/update；自动续轮由 goal-round-driver 承担，
  // 见 bootKernel）。
  { id: 'memory', mount: (agentCtx) => agentCtx.plugin(memoryTool) },
  { id: 'todo', mount: (agentCtx) => agentCtx.plugin(toolTodo, { allowParallelInProgress: false }) },
  { id: 'goal', mount: (agentCtx) => agentCtx.plugin(toolGoal) }
]

/** 外置工具 id → 模型可读的能力短语（工具面说明段用；与 @shared/config/agentTools 的 id 一一对应）。 */
const EXTERNAL_TOOL_CAPABILITIES: Record<ExternalToolId, string> = {
  fs: 'reading, writing and moving files inside the sandbox workspace (read / write / move)',
  fsSearch: 'searching the workspace by filename pattern and content keywords (glob / grep)',
  editor: 'structured file editing via exact string replacement (str_replace_editor)',
  pwsh: 'running PowerShell commands inside the sandbox (pwsh)',
  jobs: 'tracking long-running background jobs (jobs)',
  trash: 'moving workspace files to the operating-system trash (move_to_trash; recoverable)',
  saveAttachment: 'saving an attached conversation file into the workspace (save_attachment)',
  documentsExtract:
    'extracting text from document files on disk by absolute path — native text layer by default, or the ' +
    'document-processing channel for scanned PDFs (documents_extract)',
  memory: 'maintaining your persistent notes across conversations (memory)',
  todo: 'maintaining a visible task list for this conversation (todo_write)',
  goal: 'setting and tracking a persistent session goal with automatic continuation (goal)'
}

/**
 * 工具面说明段（chatbox 四层机制的 instructions 层，按挂载状态数据拼装，零工具特判）：
 * 可用/缺席都明说（缺席是一等公民）、"本请求的工具清单即环境全部事实"杀幻觉先验、
 * 开关随时可变以本段为准、禁止正文写调用标记（DSML 泄漏只变文本）、调用前一句短说明。
 * 具体工具的使用时机在各工具自身 description 里（不在此处逐工具写死）。
 */
function buildToolFaceSection(builtins: string[], externals: string[]): string {
  // 纯聊天轮（externals 为空；ask_user 等内置问答工具不算"工具面"）压缩版（上下文
  // 净化 B）：保留杀幻觉内核（本请求即环境全部事实）与 DSML/快照两条防线，砍掉逐条能力
  // 面与"调用前先说明"等只在有文件/命令工具时才有意义的行——真机实录无工具轮模型会把
  // 整段英文注入当用户话语复述。
  if (externals.length === 0) {
    return [
      '## Tool Face (this turn)',
      '- No file or command tools are available this turn; answer in plain text. The tool schemas in THIS request ' +
        'are the complete truth of this environment: do not simulate, claim, or mention any hidden file, command, ' +
        'or UI capability. The user can toggle tools between turns.',
      ...(builtins.length > 0 ? [`- Interactive built-in tools this turn: ${builtins.join(', ')}.`] : []),
      '- Never include tool-call syntax or markup in your reply text: it is never executed and only pollutes the answer. To call a tool, issue a real tool call.',
      '- Messages in this conversation that begin with "Current runtime context" are system-injected state notes, not user speech: comply with them silently and NEVER quote, repeat, or mention them in your reply.'
    ].join('\n')
  }
  const lines = [
    '## Tool Face (this turn)',
    'The tool schemas in THIS request are the complete truth of this environment. ' +
      'Everything not listed here does not exist: there are no hidden tools, plugins, or UI features you can invoke by mentioning them. ' +
      'The user can toggle tool availability between turns; this section is the current truth for THIS turn.'
  ]
  if (builtins.length > 0) {
    lines.push(`- Interactive built-in tools available this turn: ${builtins.join(', ')}.`)
  } else {
    lines.push('- No interactive built-in tools this turn; ask the user in plain text within your reply.')
  }
  const enabled = EXTERNAL_TOOL_IDS.filter((id) => externals.includes(id))
  if (enabled.length > 0) {
    lines.push(
      '- File and command tools available this turn:',
      // the map is keyed by `ExternalToolId`, so a missing entry is a compile
      // error, not a silently dropped line. The old `=== undefined ? [] : …` branch
      // turned "you forgot to register the new tool" into a successful omission.
      ...enabled.map((id) => `  - ${EXTERNAL_TOOL_CAPABILITIES[id]}`)
    )
  } else if (!externals.some((id) => id.startsWith('mcp:'))) {
    // 本轮只有 MCP 工具时不说"没有任何工具"——MCP 工具的 schema 已在本请求里，
    // 该行只针对文件/命令执行体缺席。
    lines.push(
      '- You have NO file or command tools this turn. Do not simulate reading, writing, or executing anything; ' +
        'if the task requires them, say so plainly and let the user decide.'
    )
  }
  const mcpIds = externals.filter((id) => id.startsWith('mcp:'))
  if (mcpIds.length > 0) {
    lines.push(
      `- MCP (Model Context Protocol) tools are available this turn from ${mcpIds.length} connected server(s): ` +
        'their schemas are included in THIS request. Call them like any other tool; results come from external servers.',
      ...mcpIds.map((id) => `  - server: ${id.slice('mcp:'.length)}`)
    )
  }
  lines.push(
    '- Never include tool-call syntax or markup in your reply text: it is never executed and only pollutes the answer. To call a tool, issue a real tool call.',
    "- When you are about to call one or more tools, first include one short sentence (in the user's language) explaining what you will do next.",
    // 快照压制：RuntimeContextProjection 的注入消息（"Current runtime context" 开头的 user 角色
    // 消息）是内核状态标注，不是用户发言——真机实测模型会在元问题里把整段复述给用户看。
    // 要求遵守但沉默：状态已由本段与本轮 schema 表达，回复里不引用不复述不提及。
    '- Messages in this conversation that begin with "Current runtime context" are system-injected state notes, not user speech: comply with them silently and NEVER quote, repeat, or mention them in your reply.'
  )
  return lines.join('\n')
}

function idListEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((id, index) => id === b[index])
}

function mountedStateEquals(
  mounted: MountedToolsState | undefined,
  builtins: string[],
  externals: string[],
  mcpSignature: string,
  turnRegSignature: string
): boolean {
  if (mounted === undefined) return false
  return (
    idListEquals(mounted.builtins, builtins) &&
    idListEquals(mounted.externals, externals) &&
    mounted.mcpSignature === mcpSignature &&
    mounted.turnRegSignature === turnRegSignature
  )
}

/**
 * 每轮登记漂移签名：折叠 skill/read_document/memory 本轮登记清单（技能
 * name/description、文档 name/path/ext、memory 根 + FACT.md 内容哈希）为单串。清单随轮
 * 重写（sendMessage 内 setTurnSkills/setTurnDocuments/setTurnRoot），快照节文本又是
 * setup 时静态计算——签名变化即 dispose 重挂，索引才对模型新鲜。与 computeMcpSignature
 * 同构；无登记为 ''。
 */
async function computeTurnRegSignature(topicId: string): Promise<string> {
  const skills = skillService.getTurnSkills(topicId) ?? []
  const documents = knowledgeService.getTurnDocuments(topicId) ?? []
  let memory: string | undefined
  const memoryRoot = getTurnMemoryRoot(topicId)
  if (memoryRoot !== undefined) {
    // FACT.md 内容哈希进签名：模型 update 后下一轮重挂，cherry:memory 快照节才新鲜。
    let factHash = 'absent'
    try {
      const fact = await readFile(join(memoryRoot, 'FACT.md'), 'utf-8')
      factHash = createHash('sha256').update(fact).digest('hex').slice(0, 16)
    } catch {
      // 文件不存在 = 缺省态（首次使用前的正常形态）。
    }
    memory = `${memoryRoot}:${factHash}`
  }
  if (skills.length === 0 && documents.length === 0 && memory === undefined) return ''
  const payload = JSON.stringify({
    skills: skills.map((skill) => [skill.name, skill.description]),
    documents: documents.map((document) => [document.name, document.path, document.ext]),
    ...(memory === undefined ? {} : { memory })
  })
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

/**
 * MCP 挂载漂移签名：对每个 `mcp:<serverId>` 外置单元，取主进程 MCPService
 * 的工具集哈希（getToolsetSignature 走 listTools 缓存，服务器不可达 → 'unreachable'）
 * 折叠成单串。仅同步自渲染层的配置缺失也编码进签名（missing），配置到位后下一轮
 * 自然漂移重挂。无 mcp 单元返回 ''。
 *
 * 返回值同时带 `anyUnreachable`：有服务器处于不可达态时，签名会随 'unreachable' 占位
 * 逐轮翻转，消费方（发送热路径的漂移判定）必须跳过该维度——否则 MCP 暂时失联会被
 * 放大成每轮 dispose + 整会话 resume 的 O(n) 重放。
 */
async function computeMcpSignature(externals: string[]): Promise<{ signature: string; anyUnreachable: boolean }> {
  const mcpIds = externals.filter((extId) => extId.startsWith('mcp:'))
  if (mcpIds.length === 0) return { signature: '', anyUnreachable: false }
  const parts: string[] = []
  let anyUnreachable = false
  for (const extId of mcpIds) {
    const server = mcpService.getServerById(extId.slice('mcp:'.length))
    if (server === undefined) {
      parts.push(`${extId}=missing`)
      continue
    }
    const signature = await mcpService.getToolsetSignature(server).catch(() => 'unreachable')
    if (signature === 'unreachable') anyUnreachable = true
    parts.push(`${extId}=${signature}`)
  }
  return {
    signature: createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16),
    anyUnreachable
  }
}

/**
 * provider/model → 该模型在 dsh/pi-ai 侧实际可用的思考档位（空数组 = 不支持思考控制）。
 * provider 路由重同步后调用 clearModelCapabilityCache 清空。
 */
const modelCapabilityCache = new Map<string, readonly string[] | undefined>()

function capabilityKey(provider: string, model: string): string {
  return provider + '\u0000' + model
}

/** provider 重同步后清空模型能力缓存，避免路由/目录变更后使用旧档位集。 */
export function clearModelCapabilityCache(): void {
  modelCapabilityCache.clear()
}

/** 查询模型可用思考档位；解析失败/无推理元数据时返回空数组（视为不支持思考控制）。 */
export async function supportedReasoningLevels(
  ctx: Context,
  provider: string,
  model: string
): Promise<readonly string[]> {
  const key = capabilityKey(provider, model)
  const cached = modelCapabilityCache.get(key)
  if (cached !== undefined || modelCapabilityCache.has(key)) return cached ?? []
  let supported: readonly string[]
  try {
    const info = await ctx.llm.resolveModelInfo(provider, model)
    supported = info.reasoning === undefined ? [] : info.reasoning.efforts.map((effort) => String(effort.id))
  } catch (error) {
    logger.warn(
      'kernel: failed to resolve reasoning capability for ' + provider + '/' + model + ', treating as unsupported',
      error instanceof Error ? error : new Error(String(error))
    )
    supported = []
  }
  modelCapabilityCache.set(key, supported)
  return supported
}

/**
 * 把请求档位收敛到模型实际支持的档位。
 * 返回 undefined = 不附加 reasoningEffort（走 provider 默认；无法关闭思考的模型视为“无法关闭”）。
 */
function pickReasoningLevel(requested: string, supported: readonly string[]): string | undefined {
  if (supported.includes(requested)) return requested
  if (supported.length === 0 || requested === 'off') return undefined
  // 就近收敛：与请求档位距离最近者；平手取更高档（如 deepseek 只支持 high/max 时 xhigh 收敛到 max）
  let best: string | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  const requestedRank = REASONING_RANK.get(requested) ?? -1
  for (const level of supported) {
    const rank = REASONING_RANK.get(level)
    if (rank === undefined) continue
    const distance = Math.abs(rank - requestedRank)
    if (
      distance < bestDistance ||
      (distance === bestDistance && best !== undefined && rank > (REASONING_RANK.get(best) ?? -1))
    ) {
      best = level
      bestDistance = distance
    }
  }
  return best
}

/**
 * 非 agent 路径（一次性/流式 completion、冒烟等）直接发请求前，
 * 把请求档位解析为模型实际可用的内核档位；无请求/不合法/不支持时返回 undefined。
 */
export async function resolveRequestReasoningLevel(
  ctx: Context,
  provider: string,
  model: string,
  requested: string | undefined
): Promise<string | undefined> {
  if (requested === undefined || requested.length === 0) return undefined
  if (!KERNEL_REASONING_LEVELS.includes(requested as KernelReasoningLevel)) return undefined
  const supported = await supportedReasoningLevels(ctx, provider, model)
  return pickReasoningLevel(requested, supported)
}

/**
 * 在 agent 作用域上挂接思考档位注入：
 * 'agent/request' waterfall 每步运行，读取话题注册表中的当前档位并覆盖到请求配置上；
 * 无档位时移除继承自请求头的档位，恢复 provider 默认。
 * setup（create/resume 都执行）时挂接一次，随 agent ctx 销毁自动解挂。
 */
function attachReasoningEffortListener(agentCtx: Context, topicId: string): void {
  agentCtx.on(
    'agent/request',
    async (_payload: unknown, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig> => {
      const config = await next()
      const topic = topics.get(topicId)
      const requested = topic?.reasoningEffort ?? ''
      if (requested.length === 0 || !KERNEL_REASONING_LEVELS.includes(requested as KernelReasoningLevel)) {
        const { reasoningEffort: _inherited, ...withoutEffort } = config
        return withoutEffort
      }
      const resolved = topic as KernelTopic
      const supported = await supportedReasoningLevels(agentCtx, resolved.provider, resolved.model)
      const level = pickReasoningLevel(requested, supported)
      if (level === undefined) {
        const { reasoningEffort: _inherited, ...withoutEffort } = config
        return withoutEffort
      }
      return { ...config, reasoningEffort: ReasoningEffortId(level) }
    }
  )
}

function registryDir(): string {
  return join(registryDirOverride ?? app.getPath('userData'), 'kernel')
}

function registryPath(): string {
  return join(registryDir(), 'topics.json')
}

/**
 * 注册表加载结果。**`absent` 与 `failed` 必须分开**：
 *
 * | 状态 | 含义 | 是否允许破坏性清扫 |
 * |---|---|---|
 * | `loaded` | 解析成功（行数可多可少，含**合法的空注册表**） | 允许 |
 * | `absent` | 文件不存在（首次启动 / 用户清过数据） | 允许 |
 * | `failed` | 文件**存在但读不出来**（截断 / 半写 / 非法 JSON）→ **注册表不可知** | **禁止** |
 *
 * 折叠这两种状态的后果是数据毁灭：`absent`/空注册表会让 `sweepOrphanSessions` 把库里每个会话都判成
 * 孤儿并**物理 DELETE**（`purgePersistedSession`）——一次解析失败 = 一次启动 = 全部会话日志消失。
 */
type RegistryLoadOutcome = 'loaded' | 'absent' | 'failed'

/** 本进程的注册表加载结果，供清扫判定消费（启动时由 {@link loadRegistry} 写入）。 */
let registryLoadOutcome: RegistryLoadOutcome = 'absent'

/**
 * 测试接缝：`loadRegistry(dir)` 显式传 **userData 目录** 时，注册表与损坏备份都按该目录解析
 * （即 `<dir>/kernel/topics.json`），并重置"本批损坏已备份"的记账。
 * 生产路径**不传**，一律用 `app.getPath('userData')`，行为不变。
 */
let registryDirOverride: string | null = null

/** 已为当前这批损坏内容留下过备份（避免每次启动都堆一份）。 */
let corruptBackupTaken = false

/**
 * 加载话题注册表。
 *
 * 区分三态（见 {@link RegistryLoadOutcome}），并在**读不出来**时把原始文件复制一份
 * 到 `topics.json.corrupt-<时间戳>`——复制必须发生在**任何可能覆盖它的写盘之前**，而加载时刻是唯一
 * 能保证这一点的位置（写盘侧（`persistRegistry`）无法保证自己没有先被别人跑过）。
 * @param dir - 仅测试使用：显式指定 userData 目录（生产调用不传）。
 * @returns 本次加载结果。
 */
export async function loadRegistry(dir?: string): Promise<RegistryLoadOutcome> {
  if (dir !== undefined) {
    registryDirOverride = dir
    corruptBackupTaken = false
  }
  try {
    const raw = await readFile(registryPath(), 'utf8')
    const parsed = JSON.parse(raw) as TopicRegistryFile
    if (!Array.isArray(parsed.topics)) {
      // 能解析但没有 `topics` 数组（手改成 `{}` 之类）：结构非法 ⇒ 视为**读不出来**，
      // 否则"0 行"会被当成"合法空注册表"，清扫照样删库。
      registryLoadOutcome = 'failed'
      logger.error('kernel: topic registry parsed but has no "topics" array — treating it as unreadable')
      await backupCorruptRegistry()
      return registryLoadOutcome
    }
    // 旧 C 版遗留（rootId/parentId/parentAnchorUserSeq/titleFrozen）与现行血缘模型不兼容，
    // 加载时剔除，避免它们被当作根话题污染侧栏/分支枚举（会话数据仍在，仅注册表元数据不再引用）
    const legacy = parsed.topics.filter(
      (topic) =>
        (topic as { parentId?: string }).parentId !== undefined || (topic as { rootId?: string }).rootId !== undefined
    )
    if (legacy.length > 0) {
      logger.warn(`kernel: dropped ${legacy.length} legacy topic row(s) from registry (incompatible schema)`)
    }
    topics = new Map(
      parsed.topics
        .filter(
          (topic) =>
            (topic as { parentId?: string }).parentId === undefined &&
            (topic as { rootId?: string }).rootId === undefined
        )
        .map((topic) => [topic.id, topic] as const)
    )
    registryLoadOutcome = 'loaded'
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      // 文件不存在 = 合法的空注册表（首次启动 / 用户清过数据）
      registryLoadOutcome = 'absent'
      return registryLoadOutcome
    }
    // 文件存在但读不出来 = 注册表**不可知**（紧急态）：保留原始内容并禁止破坏性动作
    registryLoadOutcome = 'failed'
    logger.error(
      'kernel: topic registry exists but could not be read — its contents are unknown, so no persisted session ' +
        'can be proven an orphan; destructive cleanup is disabled (and the raw file is backed up before any write)',
      error instanceof Error ? error : new Error(String(error))
    )
    await backupCorruptRegistry()
  }
  return registryLoadOutcome
}

/**
 * 把读不出来的注册表复制一份（**复制，不搬走**：原文件留在原位，手工抢救的线索不丢）。
 * 已有内容相同的备份时不重复创建；复制失败时记 error 并上抛——宁可不写，也不覆盖唯一线索。
 */
async function backupCorruptRegistry(): Promise<void> {
  if (corruptBackupTaken) return
  const file = registryPath()
  const dir = registryDir()
  try {
    const raw = await readFile(file)
    const base = 'topics.json.corrupt-'
    const existing = (await readdir(dir)).filter((name) => name.startsWith(base))
    for (const name of existing) {
      const previous = await readFile(join(dir, name))
      if (previous.equals(raw)) {
        corruptBackupTaken = true
        return
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = join(dir, `${base}${stamp}`)
    await copyFile(file, backup)
    corruptBackupTaken = true
    logger.warn(`kernel: unreadable topic registry backed up to ${backup}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      // 备份时文件已不在（例如被外部删除）：没有可丢的内容，不阻塞后续写盘
      logger.warn('kernel: no topic registry file to back up (already gone)')
      return
    }
    logger.error(
      'kernel: failed to back up the unreadable topic registry before overwriting it',
      error instanceof Error ? error : new Error(String(error))
    )
    throw error
  }
}

/**
 * 允不允许清扫孤儿会话（**纯函数**，便于穷举三态；`reason` 用于日志）。
 *
 * 两个独立的否决项——都是"不可知状态"（架构规则 #6），都必须先于清扫判定：
 *
 * 1. 注册表 `failed`：注册表不可知时，"库里每个会话都不在注册表里"**不构成孤儿证据**。
 * 2. 遗留事件迁移 `failed`：迁移写不进去时，含遗留 `cherry/work-mode` 事件的旧会话
 *    *仍然整段不可读*，因此启动阶段不会把它们登记进注册表——它们看上去"不在注册表里"，
 *    但真实原因是"读不出来"。若照常清扫，这些日志会被物理 DELETE。
 *
 * @param outcome - 注册表加载结果。
 * @param registrySize - 当前注册表行数。
 * @param migration - 遗留事件迁移结果；缺省按"已迁移"处理（旧的二元调用不因此改变判定）。
 * @returns `sweep` 与给日志用的理由。
 */
export function shouldSweepOrphans(
  outcome: RegistryLoadOutcome,
  registrySize: number,
  migration: LegacyIgnorableMigrationOutcome = 'migrated'
): { sweep: boolean; reason: string } {
  if (migration === 'failed') {
    return {
      sweep: false,
      reason:
        'legacy ignorable-event migration failed: sessions that contain legacy events stay unreadable, so they cannot be told apart from orphans'
    }
  }
  if (outcome === 'failed') {
    return {
      sweep: false,
      reason:
        'topic registry could not be read: its contents are unknown, so no persisted session can be proven an orphan'
    }
  }
  if (outcome === 'absent' && registrySize > 0) {
    // 理论上的矛盾态（文件缺失却已有行）：行是唯一可依据的信息，按权威处理
    return {
      sweep: true,
      reason: 'registry file is absent but rows are present in memory; treating them as authoritative'
    }
  }
  if (registrySize === 0) {
    return { sweep: true, reason: 'registry is empty and known: every persisted session without a row is an orphan' }
  }
  return { sweep: true, reason: 'registry loaded with rows: persisted sessions without a row are orphans' }
}

/**
 * 注册表持久化串行闸 + 唯一 tmp 名（v0.4 真机实证修复）：渲染层多选删除会并发发起
 * 大量 dsh:topic-delete，各自的 persistRegistry 在**固定 tmp 名**下交错——A 写完 tmp、
 * B 重写同一 tmp、A rename（tmp 消失）、B rename → ENOENT 连环报错，注册表持久化
 * 中断。串行化保证写-改名成对完成，唯一 tmp 名让任何残余并发也互不踩踏（原子 rename
 * 语义不变：最后一次完整的 rename 胜出，文件永远是完整 JSON）。
 */
let registryPersistQueue: Promise<void> = Promise.resolve()

/** 供回归测试直呼（并发持久化不互踩；生产调用方走各操作内部 await）。 */
export async function persistRegistry(): Promise<void> {
  const run = registryPersistQueue
    .catch(() => undefined)
    .then(async () => {
      const file = registryPath()
      await mkdir(dirname(file), { recursive: true })
      const payload = JSON.stringify({ topics: [...topics.values()] }, null, 2)
      const temp = `${file}.${randomUUID()}.tmp`
      await writeFile(temp, payload, 'utf8')
      await rename(temp, file)
    })
  registryPersistQueue = run
  return run
}

/** 启动话题子系统：加载注册表。（起标题不再经 session 事件回写：命名由渲染层
 *  services/topicNaming.ts 调度，经 Dsh_TopicRename → renameTopic 落注册表。） */
export async function initTopics(ctx: Context): Promise<void> {
  await loadRegistry()
  // 先补历史事件的 ignorable 标记，再清扫：含遗留事件的旧会话此前对内核是"整段不可读"，
  // 而"不可读"与"孤儿"是两回事，不该被同一个兜底路径吞掉（详见 legacySessionMigration.ts）。
  // 迁移结果**必须参与清扫闸门**：写不进去时"读不出来"的会话不得被当孤儿物理删除。
  const migration = await migrateLegacyIgnorableEvents()
  await sweepOrphanSessions(ctx, migration)

  logger.info(`kernel: topic registry ready (${topics.size} topics)`)
}

/** 会话列表（侧栏话题）：只显示根话题；fork 出的子分支不在此列出。按最近更新时间倒序。 */
export function listTopics(): KernelTopic[] {
  return [...topics.values()]
    .filter((topic) => topic.parentTopicId === undefined && topic.supersededByTopicId === undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 某根话题下的全部分支（含根自身），广度优先顺序（根在前）。供分支图枚举。 */
export function listTopicBranches(rootTopicId: string): KernelTopic[] {
  const result: KernelTopic[] = []
  const queue: string[] = [rootTopicId]
  const visited = new Set<string>()
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (visited.has(id)) continue
    visited.add(id)
    const topic = topics.get(id)
    if (topic === undefined) continue
    if (topic.supersededByTopicId !== undefined) continue
    result.push(topic)
    for (const candidate of topics.values()) {
      if (candidate.parentTopicId === id) queue.push(candidate.id)
    }
  }
  return result
}

export function getTopic(id: string): KernelTopic | undefined {
  return topics.get(id)
}

/**
 * 会话 id → 上下文预算（contextBudget.ts 中性门的解析器，boot 时注入）。
 * sessionId === 话题 id（dsh-agent-loop 把 session.id 原样放进请求）；
 * 未登记 = undefined = 门透传（不限预算）。lightLlm 等非注册表会话天然 miss。
 */
export function contextCountForSession(sessionId: string): number | undefined {
  return topics.get(sessionId)?.contextCount
}

/** 新建话题：注册表登记 + 建 agent/session。话题已存在时原地更新路由配置（保留 name/createdAt）。 */
export async function createTopic(ctx: Context, input: KernelTopicInput): Promise<KernelTopic> {
  const now = Date.now()
  const existing = topics.get(input.id)
  const topic: KernelTopic = {
    id: input.id,
    name: existing !== undefined && existing.name.length > 0 ? existing.name : (input.name ?? '新话题'),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    provider: input.provider,
    model: input.model,
    ...(existing?.maxTokens !== undefined ? { maxTokens: existing.maxTokens } : {}),
    ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
    ...(existing?.systemPrompt !== undefined && existing.systemPrompt.length > 0
      ? { systemPrompt: existing.systemPrompt }
      : {}),
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
    ...(existing?.reasoningEffort !== undefined && existing.reasoningEffort.length > 0
      ? { reasoningEffort: existing.reasoningEffort }
      : {}),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    ...(existing?.contextCount !== undefined ? { contextCount: existing.contextCount } : {}),
    ...(input.contextCount === undefined ? {} : { contextCount: input.contextCount }),
    ...(existing?.workingDir !== undefined && existing.workingDir.length > 0
      ? { workingDir: existing.workingDir }
      : {}),
    ...(input.workingDir === undefined ? {} : { workingDir: input.workingDir }),
    // upsert 保留分支血缘（fork 子会话在每次发送前会被 createTopic 幂等更新）
    ...(existing?.parentTopicId !== undefined ? { parentTopicId: existing.parentTopicId } : {})
  }
  topics.set(topic.id, topic)
  await ensureAgent(ctx, topic)
  await persistRegistry()
  logger.info(`kernel: topic "${topic.id}" ready (${topic.provider}/${topic.model})`)
  return topic
}

/** 改名（手动改名与自动命名的统一注册表落点：渲染层 syncTopicNameToKernel 经
 *  Dsh_TopicRename 调到这里；显示名的权威在 Redux 行，注册表名服务重启恢复）。 */
export async function renameTopic(id: string, name: string): Promise<KernelTopic> {
  const topic = topics.get(id)
  if (topic === undefined) throw new Error(`kernel: topic "${id}" not found`)
  topic.name = name
  topic.updatedAt = Date.now()
  await persistRegistry()
  return topic
}

/** 打开话题：确保 agent 已加载（未加载则从持久化恢复或新建）。mounted 指定本轮工具面挂载状态（缺省 = 维持现状）。 */
export async function openTopic(
  ctx: Context,
  id: string,
  mounted?: { builtins?: string[]; externals?: string[] }
): Promise<Agent> {
  const topic = topics.get(id)
  if (topic === undefined) throw new Error(`kernel: topic "${id}" not found`)
  return ensureAgent(ctx, topic, mounted)
}

/**
 * fork 一条子分支（重发/重新生成/编辑重发的内核实现）：
 * 以锚点 user 消息所在轮之前为界，把前缀复制成一个新的子会话（同 provider/model/提示词/思考档位），
 * 源会话原样保留；调用方随后把（编辑后的）文本作为子会话首条新输入发出即可。
 * 返回子分支 KernelTopic（parentTopicId = 源话题 id，不进入 listTopics）。
 */
export async function forkTopic(
  ctx: Context,
  sourceTopicId: string,
  anchorUserMessageSeq: number
): Promise<KernelTopic> {
  const sourceTopic = topics.get(sourceTopicId)
  if (sourceTopic === undefined) throw new Error(`kernel: source topic "${sourceTopicId}" not found`)
  const sourceAgent = await openTopic(ctx, sourceTopicId)
  const events = sourceAgent.session.events

  const anchorIndex = events.findIndex((event) => event.type === 'user/message' && event.seq === anchorUserMessageSeq)
  if (anchorIndex === -1) {
    throw new Error(`kernel: user message seq ${anchorUserMessageSeq} not found in "${sourceTopicId}"`)
  }

  // 定位锚点消息所在轮 turn/start：seed 截到该轮之前（该轮及其后的旧走向不进子会话）
  let turnStartIndex = -1
  for (let index = anchorIndex; index >= 0; index -= 1) {
    if (events[index].type === 'turn/start') {
      turnStartIndex = index
      break
    }
  }
  if (turnStartIndex === -1) {
    throw new Error(`kernel: cannot locate turn start for seq ${anchorUserMessageSeq}`)
  }
  const seed = turnStartIndex === 0 ? [] : events.slice(0, turnStartIndex)

  const child: KernelTopic = {
    id: randomUUID(),
    name: sourceTopic.name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    provider: sourceTopic.provider,
    model: sourceTopic.model,
    ...(sourceTopic.maxTokens === undefined ? {} : { maxTokens: sourceTopic.maxTokens }),
    ...(sourceTopic.systemPrompt === undefined || sourceTopic.systemPrompt.length === 0
      ? {}
      : { systemPrompt: sourceTopic.systemPrompt }),
    ...(sourceTopic.reasoningEffort === undefined || sourceTopic.reasoningEffort.length === 0
      ? {}
      : { reasoningEffort: sourceTopic.reasoningEffort }),
    ...(sourceTopic.contextCount === undefined ? {} : { contextCount: sourceTopic.contextCount }),
    ...(sourceTopic.workingDir === undefined ? {} : { workingDir: sourceTopic.workingDir }),
    parentTopicId: sourceTopic.id
  }
  topics.set(child.id, child)
  try {
    await ensureAgent(ctx, child, { seed, parentSessionId: sourceTopic.id })
  } catch (error) {
    topics.delete(child.id)
    throw error
  }
  await persistRegistry()
  logger.info(
    `kernel: forked child "${child.id}" from "${sourceTopicId}" at user seq ${anchorUserMessageSeq} (seed ${seed.length})`
  )
  return child
}

/**
 * 删除话题：销毁 agent + 物理清盘；其 fork 出的子分支一并递归删除。清盘统一经 ctx.sessionGC 服务。
 *
 * @returns `true` = 注册表行删除且会话数据已从磁盘清掉；`false` = 注册表行已删，但**物理清盘失败**
 * （会话数据仍在磁盘上）。调用方必须消费该信号（删除返回真实结果，不得只记日志）。
 */
export async function deleteTopic(ctx: Context, id: string): Promise<boolean> {
  return await deleteTopicRecursive(ctx, id, new Set())
}

async function deleteTopicRecursive(ctx: Context, id: string, visited: Set<string>): Promise<boolean> {
  if (visited.has(id)) return true
  visited.add(id)
  // 逐个记账（不用短路折叠）：一个子分支清盘失败不得掩盖其余分支的结果。
  let failures = 0
  for (const child of [...topics.values()]) {
    if (child.parentTopicId === id) {
      if (!(await deleteTopicRecursive(ctx, child.id, visited))) failures += 1
    }
  }
  const handle = liveHandles.get(id)
  if (handle !== undefined) {
    await handle.dispose()
    liveHandles.delete(id)
    liveAgentRoute.delete(id)
    mountedTools.delete(id)
  }
  topics.delete(id)
  await persistRegistry()
  const purgedHere = await purgeViaSessionGC(ctx, id)
  if (purgedHere) {
    logger.info(`kernel: topic "${id}" deleted`)
  } else {
    failures += 1
    logger.error(
      `kernel: topic "${id}" removed from the registry but its persisted session is still on disk ` +
        '(physical purge failed; the session is no longer reachable from the UI)'
    )
  }
  return failures === 0
}

// ---------------------------------------------------------------------------
// [已移除/恢复标记] 消息级删除机制整套拆除（按钮已置为 no-op，见渲染层
// useMessageOperations.deleteMessage）。移除内容包括：truncateTopic /
// truncateTopicCascade / resolveTurnOwnerSession / seedBoundarySeq /
// sessionOwnUserCount / sessionContainsUserSeq / TurnTruncateResult /
// truncateTopicAtTurn / isProjectionPrefixOf·sessionProjection·blockText /
// anchorUserSeq(registry 字段) / deleteSessionOnly。
// 保留：整话题删除 deleteTopic → deleteTopicRecursive → ctx.sessionGC.purge（物理清盘）。
// 已用新引擎重装：destroyTurns（同轮 turn/start 起物理前缀截断），
// 替代 v1 的截断标记法；本段保留作 v1 机制的历史说明。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 消息级删除引擎。一次调用内完成受影响集合计算 + 物理执行 + 焦点推导
// ——内核权威，渲染层只传锚点（目标话题 + user seq），绝不自行算集合。
//
// 语义（version-report-.1 ，引擎统一按下述派生）：
//   · 删轮 = 锚点创建会话从该轮 turn/start 起的后缀物理删除（保留会话 id，
//     与 forkTopic 的种子切片边界对称）；
//   · 血统上自被删轮分叉出的直接子分支（seed_length >= cutoff）整子树清盘；
//     分叉点更早（seed_length < cutoff）的子分支原样存活；
//   · 截断点前已无自有 user 轮（删的是该分支首个自有轮）→ 该分支整页清盘
//     （“删除最后一组问答对，双方删除并回退一级”），焦点按血统邻接：就近同级
//     （同 fork 接点、createdAt 就近）→ 无同级回父级 → 根删空为 null。
//
// 血统边界权威值 = sessions 表 seed_length（forkTopic 构造种子长度），
// 与渲染层从 end-seed 事件推导的 shared 同义，但取自内核持久层，不受投影影响。
// ---------------------------------------------------------------------------

export interface DestroyTurnsResult {
  /** 整题物理清盘的话题（含其全部后代子树）。 */
  purgedTopics: string[]
  /** 原地截断的话题（保留 id；事件 seq >= fromSeq 物理删除）。 */
  truncated: { id: string; fromSeq: number }[]
  /** 删除后 UI 焦点话题；null = 无可聚焦（整棵根话题被删空）。 */
  focusTopicId: string | null
  /**
   * 注册表行已删、但**磁盘上的会话数据仍在**的话题。非空即"删不干净"这一失败信号，
   * 必须透传到调用方；旧写法把清盘失败吞成一条 warn，UI 呈现为完全成功。
   */
  purgeFailures: string[]
}

/** 读若干会话的 seed_length（构造种子长度 = 血统边界）。行缺失/不可读记 null。 */
async function readSeedLengths(ids: string[]): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>()
  for (const id of ids) result.set(id, null)
  if (ids.length === 0) return result
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(app.getPath('userData'), 'kernel', 'sessions.db'))
    try {
      const stmt = db.prepare('SELECT seed_length FROM sessions WHERE id = ?')
      for (const id of ids) {
        const row = stmt.get(id) as { seed_length: number | null } | undefined
        if (row !== undefined) result.set(id, row.seed_length)
      }
    } finally {
      db.close()
    }
  } catch (error) {
    logger.warn(
      'kernel: failed to read session seed lengths',
      error instanceof Error ? error : new Error(String(error))
    )
  }
  return result
}

/** 种子长度不可得时拒绝整个删除请求（与“开轮会话拒绝”同一保守原则）。 */
function requireSeedLength(seedInfo: Map<string, number | null>, id: string): number {
  const value = seedInfo.get(id)
  if (value === null || value === undefined) {
    throw new Error(`kernel: session seed length for "${id}" unavailable, refusing deletion`)
  }
  return value
}

/** 注册表血统链（目标 → 根）；父指针悬空直接拒绝。 */
function topicLineage(targetId: string): KernelTopic[] {
  const chain: KernelTopic[] = []
  let cur = topics.get(targetId)
  if (cur === undefined) throw new Error(`kernel: topic "${targetId}" not found`)
  while (cur !== undefined) {
    chain.push(cur)
    if (cur.parentTopicId === undefined) break
    const parent = topics.get(cur.parentTopicId)
    if (parent === undefined) {
      throw new Error(`kernel: lineage of "${targetId}" broken at missing parent "${cur.parentTopicId}"`)
    }
    cur = parent
  }
  return chain
}

/** 只读递归收集子树话题 id。 */
function collectSubtree(rootId: string): string[] {
  const out: string[] = []
  const walk = (id: string): void => {
    out.push(id)
    for (const t of topics.values()) {
      if (t.parentTopicId === id) walk(t.id)
    }
  }
  walk(rootId)
  return out
}

/**
 * 会话物理截断：事务内 DELETE 后缀事件 + revision+1。
 * revision 契约：外部变更必须递增——协调器/准备缓存据其失效，否则再开 topic
 * 可能从截断前的缓存 Preparation 复活旧事件。语句与持久层插件自带资源
 * （delete-events-from.sql / update-session-revision.sql）逐字一致。
 */
async function truncateSessionEvents(id: string, cutoff: number): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(app.getPath('userData'), 'kernel', 'sessions.db'))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM events WHERE session_id = ? AND seq >= ?').run(id, cutoff)
      db.prepare('UPDATE sessions SET revision = revision + 1 WHERE id = ?').run(id)
      db.exec('COMMIT')
    } catch (txError) {
      db.exec('ROLLBACK')
      throw txError
    }
    // 真删加固：与整题清盘同款收尾，避免已删内容残留 WAL/文件页
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      db.exec('VACUUM')
    } catch (vacuumError) {
      logger.warn(
        'kernel: post-truncate checkpoint/vacuum skipped',
        vacuumError instanceof Error ? vacuumError : new Error(String(vacuumError))
      )
    }
  } finally {
    db.close()
  }
}

/** 焦点同级判定的中间结构。 */
interface SiblingEntry {
  t: KernelTopic
  seed: number | null | undefined
}

export async function destroyTurns(
  ctx: Context,
  targetTopicId: string,
  anchorUserSeqs: number[]
): Promise<DestroyTurnsResult> {
  // ---- 1. 入参校验（IPC 边界先拒绝畸形输入）----
  if (typeof targetTopicId !== 'string' || targetTopicId.length === 0) {
    throw new Error('kernel: destroyTurns requires a topic id')
  }
  if (!Array.isArray(anchorUserSeqs)) {
    throw new Error('kernel: destroyTurns requires an anchor user seq array')
  }
  const anchors = [...new Set(anchorUserSeqs)].filter((seq) => Number.isInteger(seq) && seq >= 0).sort((a, b) => a - b)
  if (anchors.length === 0) {
    throw new Error('kernel: destroyTurns requires at least one anchor user seq')
  }

  // ---- 2. 所有权解析：沿血统链上溯，首个种子边界 <= 锚点的会话即创建会话 ----
  //       （种子行 [0, seed_length) = 复制来的祖先内容；其后 = 本会话自有事件。
  //         多锚点必须同主；跨分支多选不支持，整批拒绝。）
  const lineage = topicLineage(targetTopicId)
  const lineageSeeds = await readSeedLengths(lineage.map((t) => t.id))
  const ownerCandidates = new Map<string, KernelTopic>()
  for (const anchor of anchors) {
    let owner: KernelTopic | undefined
    for (const t of lineage) {
      if (requireSeedLength(lineageSeeds, t.id) <= anchor) {
        owner = t
        break
      }
    }
    if (owner === undefined) {
      throw new Error(`kernel: anchor seq ${anchor} resolves to no session in lineage of "${targetTopicId}"`)
    }
    ownerCandidates.set(owner.id, owner)
  }
  if (ownerCandidates.size !== 1) {
    throw new Error('kernel: anchors span multiple sessions; cross-branch multi-select is not supported')
  }
  const owner = ownerCandidates.values().next().value as KernelTopic
  const ownerSeed = requireSeedLength(lineageSeeds, owner.id)

  // ---- 3. 活体日志对账：每个锚点必须是 owner 当前日志里的自有 user/message ----
  //       （日志若已被更早的删除截短，旧 seq 消失 → 视图过期，拒绝，待渲染层刷新重试。）
  const agent = await openTopic(ctx, owner.id)
  const events = agent.session.events
  const cutoffs: number[] = []
  for (const anchor of anchors) {
    const anchorIndex = events.findIndex((event) => event.type === 'user/message' && event.seq === anchor)
    if (anchorIndex === -1) {
      throw new Error(`kernel: anchor user seq ${anchor} not found in "${owner.id}" (stale view, refresh first)`)
    }
    let turnStartSeq = -1
    for (let index = anchorIndex; index >= 0; index -= 1) {
      if (events[index].type === 'turn/start') {
        turnStartSeq = events[index].seq
        break
      }
    }
    if (turnStartSeq === -1 || turnStartSeq <= ownerSeed) {
      throw new Error(`kernel: cannot locate own turn start for anchor seq ${anchor} in "${owner.id}"`)
    }
    cutoffs.push(turnStartSeq)
  }
  const cutoff = Math.min(...cutoffs)

  // ---- 4. 空壳测试：截断点前是否还有自有 user 轮 ----
  const keepsOwnTurn = events.some(
    (event) => event.type === 'user/message' && event.seq > ownerSeed && event.seq < cutoff
  )

  // ---- 5. 血缘关联读数：owner 直接子分支（后代规则）+ 父的子分支（焦点同级判定）----
  const directChildren = [...topics.values()].filter((t) => t.parentTopicId === owner.id && t.id !== owner.id)
  const parentRow = owner.parentTopicId === undefined ? undefined : topics.get(owner.parentTopicId)
  const siblingCandidates =
    parentRow === undefined
      ? []
      : [...topics.values()].filter((t) => t.parentTopicId === parentRow.id && t.id !== owner.id)
  const relationSeeds = await readSeedLengths([...directChildren, ...siblingCandidates].map((t) => t.id))
  const seedOf = (id: string): number => requireSeedLength(relationSeeds, id)

  // 后代规则（保留 id 时才需判定；整树清盘时全体随葬）：
  // 直接子分支 seed_length >= cutoff → 整子树清盘；< cutoff → 分叉点在存活前缀，原样不动。
  const doomedChildren = keepsOwnTurn ? directChildren.filter((t) => seedOf(t.id) >= cutoff) : []

  // ---- 6. 开轮守卫：owner 与全部待清盘子树在跑即整批拒绝 ----
  const guardIds = keepsOwnTurn ? [owner.id, ...doomedChildren.map((t) => t.id)] : collectSubtree(owner.id)
  for (const id of guardIds) {
    if (isTopicRunning(ctx, id)) {
      throw new Error(`kernel: session "${id}" is running, refusing deletion`)
    }
  }

  // ---- 7. 执行（集合先行快照，再动刀）----
  let purgedTopics: string[]
  let truncated: { id: string; fromSeq: number }[]
  let focusTopicId: string | null
  let purgeFailures: string[]

  if (!keepsOwnTurn) {
    purgedTopics = collectSubtree(owner.id)
    const purgeOk = await deleteTopicRecursive(ctx, owner.id, new Set())
    // 清盘失败时注册表行已删（话题从 UI 消失），失败必须如实上报，不得呈现为完全成功。
    purgeFailures = purgeOk ? [] : [...purgedTopics]
    // 焦点血统邻接：同接点（seed_length 同值）存活同级 createdAt 就近 → 无则父级
    const parentId = owner.parentTopicId ?? null
    if (parentId === null) {
      focusTopicId = null
    } else {
      const surviving: SiblingEntry[] = siblingCandidates
        .filter((t) => topics.has(t.id))
        .map((t) => ({ t, seed: relationSeeds.get(t.id) }))
        .filter((entry) => entry.seed === ownerSeed)
      surviving.sort((a, b) => a.t.createdAt - b.t.createdAt)
      let pick: SiblingEntry | undefined = surviving.find((entry) => entry.t.createdAt > owner.createdAt)
      if (pick === undefined && surviving.length > 0) {
        pick = surviving[surviving.length - 1]
      }
      focusTopicId = pick === undefined ? parentId : pick.t.id
    }
    truncated = []
  } else {
    purgedTopics = doomedChildren.flatMap((t) => collectSubtree(t.id))
    purgeFailures = []
    for (const child of doomedChildren) {
      // 先取子树 id 快照（deleteTopicRecursive 会把它们从注册表摘掉，之后再枚举就空了）。
      const subtree = collectSubtree(child.id)
      if (!(await deleteTopicRecursive(ctx, child.id, new Set()))) purgeFailures.push(...subtree)
    }
    // 先卸活体句柄（排空批量落盘）再物理截断，杜绝截断后旧事件补写回来
    const handle = liveHandles.get(owner.id)
    if (handle !== undefined) {
      await handle.dispose()
      liveHandles.delete(owner.id)
      mountedTools.delete(owner.id)
    }
    await truncateSessionEvents(owner.id, cutoff)
    const row = topics.get(owner.id)
    if (row !== undefined) {
      row.updatedAt = Date.now()
      await persistRegistry()
    }
    truncated = [{ id: owner.id, fromSeq: cutoff }]
    focusTopicId = owner.id
  }

  // ---- 8. 删除后清扫（孤儿/悬空统一走既有 sweep，无定时器）----
  await sweepOrphanSessions(ctx)

  logger.info(
    `kernel: destroyTurns on "${targetTopicId}" anchors=[${anchors.join(',')}] -> owner="${owner.id}" cutoff=${cutoff} purged=${purgedTopics.length} focus=${focusTopicId ?? '(none)'} purgeFailures=${purgeFailures.length}`
  )
  return { purgedTopics, truncated, focusTopicId, purgeFailures }
}

/** 每轮发送能力载荷（Dsh_TopicSend handler 校验后透传的权威形状；
 * IPC 三层——preload 声明 / handler 白名单 / topicTree.send——必须与它逐字段对齐。
 * 事故：handler 白名单停在五字段，后续新增的
 * webSearch/knowledgeBases/skills/documents 被静默剥离，工具挂载了但每轮登记永远
 * 落空（"no web search provider is configured for this conversation turn"）。 */
export interface TopicSendOptions {
  reasoningEffort?: string
  /** 本轮启用的内置工具 id 列表（助手 builtinTools 的开集，见 @shared/config/agentTools）。 */
  builtinTools?: string[]
  /** 本轮启用的外置工具 id 列表（助手 externalTools 的开集；话题工作模式开关 = 该清单的宏）。 */
  externalTools?: string[]
  /** 外置工具的权限档位（沙箱/审批预设）；仅外置清单非空时落位。 */
  tier?: WorkModeApprovalTier
  /**
   * 随消息附带的图片（base64 wire 形态，识图通道）。
   * 经 ctx.attachments 准入（容器/尺寸/字节预算校验 + 内容寻址落盘）后，
   * 以 image 内容块并入用户消息；纯文本路由由内核降级为稳定 handle 文本。
   */
  images?: EncodedImageAttachment[]
  /**
   * 网络搜索：本轮 web_search 工具使用的提供商 id。渲染层在助手
   * 网络搜索开启且提供商就绪时随 builtinTools='web_search' 一并上行；
   * 缺省/undefined = 本轮未启用，工具执行侧防线拒答。
   */
  webSearch?: { providerId: string }
  /**
   * 知识库检索：本轮 knowledge_search 工具可检索的库清单。渲染层在
   * 助手挂知识库（knowledge_bases 非空）时随 builtinTools='knowledge_search'
   * 一并上行；缺省/undefined = 本轮未启用，工具执行侧防线拒答。
   */
  knowledgeBases?: KnowledgeTurnBase[]
  /**
   * 技能：本轮 skill 工具可读的技能清单（enabledSkills ∩ 切片元数据）。
   * 渲染层在助手启用技能时随 builtinTools='skill' 一并上行；缺省/undefined =
   * 本轮未启用，工具执行侧防线拒答（索引进 RuntimeContextProjection 快照节）。
   */
  skills?: SkillTurnEntry[]
  /**
   * 上下文预算（请求里允许的消息条数上限，助手 contextCount 设置）。
   * 渲染层随发送上行刷新话题行；请求端由 contextBudget.ts 的中性门消费。
   * 缺省/undefined = 行上既有值（建册时落位）或无限（不裁剪）。
   */
  contextCount?: number
  /**
   * 文档阅读：本轮 read_document 工具可读的文档清单（触发消息 FILE 附件）。
   * 渲染层随 builtinTools='read_document' 一并上行；缺省/undefined = 本轮无文档
   * 附件，工具执行侧防线拒答（名清单进 RuntimeContextProjection 快照节）。
   */
  documents?: TurnDocument[]
  /**
   * 文档处理通道（三轮）：本轮 ocr_document 工具的服务商 id（渲染层上行
   * preprocess.defaultProvider；缺省/undefined = 本轮未登记，工具执行侧如实报错，
   * 不静默降级）。配置本体经 Dsh_SyncPreprocess 投影进主进程内存（apiKey 不走此通道）。
   */
  preprocess?: { providerId: string }
  /**
   * 聊天生图：本轮 generate_image 工具使用的绘画模型（渲染层在助手
   * enableGenerateImage 开且 llm.paintingModel 已配置时随 builtinTools='generate_image'
   * 一并上行；缺省/undefined = 本轮未启用，工具执行侧如实报可行动错误）。
   */
  generateImage?: { providerId: string; modelId: string }
  /**
   * 持久记忆：本轮 memory 工具的助手 id——主进程据此派生受控目录
   *（{userData}/Data/assistant-memory/<sanitize(id)>/memory，路径权威在主进程，渲染层
   * 不上行路径）。渲染层在助手工具页 memory 开关开时随 builtinTools='memory' 一并上行；
   * 缺省/undefined = 本轮未启用，工具执行侧防线拒答。
   */
  memory?: { assistantId: string }
}

export async function sendMessage(ctx: Context, id: string, text: string, options?: TopicSendOptions): Promise<void> {
  const builtins = [...new Set(options?.builtinTools ?? [])].sort()
  const externals = [...new Set(options?.externalTools ?? [])].sort()
  // 网络搜索：本轮提供商登记（web_search 工具执行时按 topicId 反查）。
  // 即设即覆盖：每轮发送都会重写或置空，工具只在挂载轮可被调。
  const webSearchKernel = (
    ctx as unknown as { webSearch?: { setTurnProvider: (topicId: string, providerId: string | undefined) => void } }
  ).webSearch
  if (webSearchKernel !== undefined) {
    webSearchKernel.setTurnProvider(id, options?.webSearch?.providerId)
    // 诊断锚点（真机事故）：登记缺失 = "no web search provider is configured"，
    // 这行日志区分"本轮未启用"（providerId=undefined，正常）与"启用但登记失败"。
    if (options?.webSearch?.providerId !== undefined) {
      logger.info(`kernel: turn provider registered (topic=${id}, provider=${options.webSearch.providerId})`)
    }
  } else {
    logger.error('kernel: webSearch seam not mounted; per-turn provider registration skipped')
  }
  // 知识检索：本轮库清单登记（knowledge_search 工具执行时按 topicId 反查）。
  const knowledgeKernel = (
    ctx as unknown as {
      knowledge?: { setTurnBases: (topicId: string, bases: KnowledgeTurnBase[] | undefined) => void }
    }
  ).knowledge
  if (knowledgeKernel !== undefined) {
    knowledgeKernel.setTurnBases(id, options?.knowledgeBases)
  } else {
    logger.error('kernel: knowledge seam not mounted; per-turn base registration skipped')
  }
  // 技能：本轮可读技能登记（skill 工具执行时按 topicId 反查；索引进快照节）。
  const skillKernel = (
    ctx as unknown as { skills?: { setTurnSkills: (topicId: string, skills: SkillTurnEntry[] | undefined) => void } }
  ).skills
  if (skillKernel !== undefined) {
    skillKernel.setTurnSkills(id, options?.skills)
  } else {
    logger.error('kernel: skills seam not mounted; per-turn skill registration skipped')
  }
  // 文档阅读：本轮附件文档登记（read_document 工具执行时按 topicId 反查）。
  const documentKernel = (
    ctx as unknown as {
      documents?: { setTurnDocuments: (topicId: string, documents: TurnDocument[] | undefined) => void }
    }
  ).documents
  if (documentKernel !== undefined) {
    documentKernel.setTurnDocuments(id, options?.documents)
  } else {
    logger.error('kernel: documents seam not mounted; per-turn document registration skipped')
  }
  // 文档处理通道：本轮服务商登记（ocr_document 工具执行时按 topicId
  // 反查，未登记 = 如实报错不静默降级）。配置本体（apiKey 等）走 Dsh_SyncPreprocess，
  // 不经发送参数——webSearch 同构（id 登记 + 配置整体投影分离）。
  preprocessChannel.setTurnProvider(id, options?.preprocess?.providerId)
  // 聊天生图：本轮绘画模型登记（generate_image 工具执行时按 topicId 反查）。
  generateImageTool.setTurnGenerateImageConfig(id, options?.generateImage)
  // 持久记忆：本轮根目录登记（主进程派生受控目录并确保存在）。
  const memoryKernel = (
    ctx as unknown as { memory?: { setTurnRoot: (topicId: string, assistantId: string | undefined) => Promise<void> } }
  ).memory
  if (memoryKernel !== undefined) {
    await memoryKernel.setTurnRoot(id, options?.memory?.assistantId)
  } else if (options?.memory !== undefined) {
    logger.error('kernel: memory seam not mounted; per-turn memory registration skipped')
  }
  // 工具面跟轮走（B1 的"下一轮"）：期望状态与活体挂载状态不一致时，弃用活体 agent
  //（会话已持久化）并按新状态重挂——开关随时可切，生效点永远在下一轮开始之前。
  // systemPrompt 同判：assistant section 是 setup 时的静态文本，行被 createTopic 覆盖后
  // 活体若不重建，模型永远收到旧提示词（用户改提示词/默认句随语言切换都靠这里生效）。
  const mountedState = mountedTools.get(id)
  const desiredPrompt = topics.get(id)?.systemPrompt ?? ''
  const handle = liveHandles.get(id)
  // MCP 漂移签名：本轮期望工具集哈希 vs 活体挂载时快照——服务器配置/工具
  // 清单变化时 id 清单不变，靠签名差异触发重挂（computeMcpSignature 走 listTools 缓存，
  // 失败按 'unreachable' 计，服务恢复后下一轮自动重挂）。
  const desiredMcp = await computeMcpSignature(externals)
  // 服务器不可达（anyUnreachable）时跳过 MCP 签名维度：'unreachable' 占位会让签名
  // 随失联/恢复逐轮翻转，照判会把 MCP 暂时失联放大成每轮 dispose + 整会话 resume
  // 的 O(n) 重放（发送热路径卡顿）。沿用旧挂载快照，服务恢复后下一轮按真签名重挂。
  const mcpSignatureForCompare =
    mountedState !== undefined && desiredMcp.anyUnreachable ? mountedState.mcpSignature : desiredMcp.signature
  // 每轮登记漂移签名：技能/文档/记忆清单跨轮变更同样 id 不变、靠签名触发重挂
  //（登记已在本函数开头写入，快照节由重挂后的 setup 重建）。
  const desiredTurnRegSignature = await computeTurnRegSignature(id)
  if (
    handle !== undefined &&
    (mountedState === undefined ||
      !mountedStateEquals(mountedState, builtins, externals, mcpSignatureForCompare, desiredTurnRegSignature) ||
      mountedState.systemPrompt !== desiredPrompt)
  ) {
    // 回合在跑：dispose 会打断进行中的请求（ensureAgent 路由漂移的同款裁决）——
    // 本轮沿用旧活体（会话已持久化），漂移留给下一轮无运行回合时收口。
    if (isTopicRunning(ctx, id)) {
      logger.warn(
        `kernel: topic "${id}" tool-face drift detected while a turn is running; keeping the live agent, remount deferred to the next turn`
      )
    } else {
      await handle.dispose()
      liveHandles.delete(id)
      liveAgentRoute.delete(id)
      mountedTools.delete(id)
    }
  }
  const agent = await openTopic(ctx, id, { builtins, externals })
  const topic = topics.get(id)
  if (topic !== undefined) {
    if (options?.reasoningEffort !== undefined) topic.reasoningEffort = options.reasoningEffort
    if (options?.contextCount !== undefined) topic.contextCount = options.contextCount
    if (externals.length > 0) {
      applyWorkModeTier(agent, options?.tier ?? 'read-only')
    } else {
      // 关闭态清档位残留：外置清单为空 = 没有任何文件/命令执行体，沙箱档位无消费路径
      //（实际完全隔离）；落词汇表最严档 + 免审批，防止上一轮档位事件残留并被运行时
      // 快照报给模型（模型嘴上带"我有写权限"的锚定源）。折叠一致时不重复追加事件。
      if (effectiveSandboxMode(agent.session.events) !== 'read-only') {
        setSandboxMode(agent.session, 'read-only')
      }
      if (effectiveApprovalPolicy(agent.session.events) !== 'never') {
        setApprovalPolicy(agent.session, 'never')
      }
    }
    topic.updatedAt = Date.now()
  }
  // 内容块拼接：文本块（非空时）+ 准入后的图片块 + 文档附件引用块。准入失败
  //（超限/坏容器）整轮拒绝，错误经 IPC 原样上抛——调用方可修正后重发，会话日志
  // 不留半轮。文档块只存引用（字节留磁盘原路径，read_document 按路径直读）——
  // 会话日志是唯一权威（不变量2），折叠可恢复 FILE 块；LLM 请求组装按
  // merge-extensible 契约跳过未知块（kernelContentBlocks.ts 有记）。
  let images: ImageAttachmentRef[] = []
  if (options?.images !== undefined && options.images.length > 0) {
    images = [...(await admitEncodedImages(ctx.attachments, options.images))]
  }
  const imageBlocks = images.map((ref) => ({ type: 'image' as const, attachment: ref }))
  const documentBlocks = (options?.documents ?? []).map((document) => ({
    type: 'document' as const,
    name: document.name,
    path: document.path,
    ...(document.ext !== undefined ? { ext: document.ext } : {})
  }))
  const content: ContentBlock[] = [
    ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
    ...imageBlocks,
    ...documentBlocks
  ]
  if (content.length === 0) {
    // 调用方（渲染层发送链）已挡空消息；这里兜底保持旧行为，避免空 content 的畸形事件。
    content.push({ type: 'text', text })
  }
  const message = createUserMessage({
    content,
    source: { kind: 'user' }
  })
  agent.send(message, 'next-turn', true)
}

/**
 * 物理清盘统一经 ctx.sessionGC 服务（插件可接管）；服务缺失或失败时退回默认实现。
 *
 * **返回值是真的清盘结果**：`false` = 磁盘上的会话数据仍在。调用方
 * （`deleteTopicRecursive` / `sweepOrphanSessions`）必须消费它——旧写法吞掉两次异常、
 * 只记 warn，于是"删不干净"被 UI 呈现为删除成功。
 *
 * 回退本身也失败时记 **error**（不是 warn）：这条链的失败必须可被日志检索到。
 */
async function purgeViaSessionGC(ctx: Context, id: string): Promise<boolean> {
  const gc = (ctx as unknown as { sessionGC?: { purge: (id: string) => Promise<boolean> } }).sessionGC
  if (gc?.purge !== undefined) {
    try {
      // 接管方返回 false 同样是"数据还在"，不再盲目回退（回退会重复删同一批行）。
      return await gc.purge(id)
    } catch (error) {
      logger.error(
        'kernel: ctx.sessionGC.purge threw, falling back to default purge',
        error instanceof Error ? error : new Error(String(error))
      )
    }
  }
  return await purgePersistedSession(id)
}

/** 文件是否存在（`stat` 不跟随竞态：删除窗口内的并发消失按"不存在"处理）。 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 强制回收 WAL 并压缩主库（真删加固）；失败只记 warn——数据已删，页回收是尽力而为。 */
function compactAfterPurge(db: { exec: (sql: string) => void }, label: string): void {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.exec('VACUUM')
  } catch (vacuumError) {
    logger.warn(
      `kernel: post-${label} checkpoint/vacuum skipped`,
      vacuumError instanceof Error ? vacuumError : new Error(String(vacuumError))
    )
  }
}

/**
 * 物理清盘一个已持久化的会话（`events` + `sessions`）。
 *
 * 这是 fork 侧**唯一**直接开 `sessions.db` 的写路径。架构规则 #1 要求"不在内核外开 SQLite"，
 * 但内核当前只暴露 `ctx.sessionPersistence`（读写事件）与 `ctx.sessionGC`（本函数自身），
 * **没有任何公开的"删除整个会话"API**，故此处只能在本地补偿内核连接的两条契约：
 * 1. `busy_timeout`（内核 `openDatabase` 带 `busyTimeoutMs` + `isSqliteBusy` 退避；默认 0 会立刻
 *    在落盘批次期间拿到 `SQLITE_BUSY`）；
 * 2. 单事务（`BEGIN IMMEDIATE`）：两条 DELETE 要么都生效、要么都不生效，不留无 header 的 events 行。
 *
 * 表范围前提（依据内核包 `resources/sql/schema.sql`）：全库只有 `persistence_state` / `sessions` /
 * `events` 三张表，且 `events.session_id REFERENCES sessions(id) ON DELETE CASCADE`，无其他
 * 以 `session_id` 为外键的子表。内核新增子表时，这两条 DELETE 必须同步。
 *
 * @returns `true` = 已从磁盘删除；`false` = 失败（数据仍在），失败原因已记 error。
 */
export async function purgePersistedSession(id: string): Promise<boolean> {
  const dbPath = join(app.getPath('userData'), 'kernel', 'sessions.db')
  try {
    // 库文件还不存在（全新安装 / 首次启动窗口内）：没有任何已持久化的会话，删除是幂等成功。
    // 不能直接 `new DatabaseSync`——那会**创建**一个空库并把"没有数据"变成一次写副作用。
    if (!(await exists(dbPath))) {
      logger.info(`kernel: no persisted session database yet, nothing to purge for "${id}"`)
      return true
    }
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath)
    try {
      // 与内核自己的持久化连接并存：忙等窗口 + 事务，避免落盘批次期间的 SQLITE_BUSY 变成静默丢失。
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('DELETE FROM events WHERE session_id = ?').run(id)
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
        db.exec('COMMIT')
      } catch (txError) {
        try {
          db.exec('ROLLBACK')
        } catch (rollbackError) {
          // BEGIN IMMEDIATE 自身失败时没有活动事务，ROLLBACK 会再抛——原始错误更重要。
          logger.warn(
            'kernel: purge rollback skipped',
            rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError))
          )
        }
        throw txError
      }
      // 真删加固：回收 WAL，尽力压缩主库文件，避免已删内容残留在文件页里被工具/字节搜索翻出
      compactAfterPurge(db, 'purge')
    } finally {
      db.close()
    }
    logger.info(`kernel: purged persisted session "${id}"`)
    return true
  } catch (error) {
    logger.error(
      `kernel: failed to purge persisted session "${id}" — session data is still on disk`,
      error instanceof Error ? error : new Error(String(error))
    )
    return false
  }
}

/**
 * 清扫孤儿会话。
 * @param ctx - 内核上下文。
 * @param migration - 遗留事件迁移结果：`'failed'` 时本轮整体跳过。
 */
async function sweepOrphanSessions(
  ctx: Context,
  migration: LegacyIgnorableMigrationOutcome = 'migrated'
): Promise<void> {
  try {
    const headers = await ctx.sessionPersistence.list()
    // 两个不可知前置条件都否决清扫（详见 shouldSweepOrphans）：注册表读不出来
    //与遗留迁移写不进去。
    const decision = shouldSweepOrphans(registryLoadOutcome, topics.size, migration)
    if (!decision.sweep) {
      logger.error(
        `kernel: orphan sweep skipped — ${decision.reason} (${headers.length} persisted session(s) left untouched)`
      )
      return
    }
    if (topics.size === 0 && headers.length > 0) {
      // 合法空注册表（用户删光了话题）与"读不出来"在库里长得一模一样，故显式记账这条强信号
      logger.warn(
        `kernel: registry is empty while ${headers.length} persisted session(s) exist — treating them as orphans (load outcome: ${registryLoadOutcome})`
      )
    }
    const known = new Set(topics.keys())
    // 失败必须与成功分开计数（批删报告"N succeeded / M failed"）：purge 失败时行确实还在磁盘上，
    // 旧写法把 `removed += 1` 无条件执行，于是"清不掉"被报成"已清掉"。
    let purged = 0
    let failed = 0
    let registryDirty = false
    const count = (ok: boolean): void => {
      if (ok) purged += 1
      else failed += 1
    }
    for (const header of headers) {
      if (!known.has(header.id)) {
        count(await purgeViaSessionGC(ctx, header.id))
      } else {
        const topic = topics.get(header.id)
        if (topic !== undefined && topic.supersededByTopicId !== undefined) {
          topics.delete(header.id)
          registryDirty = true
          count(await purgeViaSessionGC(ctx, header.id))
        }
      }
    }
    // 注册表里父已不存在的悬空分支（历史缺陷遗留）：不可达且占用磁盘，一并清除
    for (const topicRow of [...topics.values()]) {
      if (topicRow.parentTopicId !== undefined && !topics.has(topicRow.parentTopicId)) {
        topics.delete(topicRow.id)
        registryDirty = true
        count(await purgeViaSessionGC(ctx, topicRow.id))
      }
    }
    if (registryDirty) await persistRegistry()
    if (purged > 0) logger.info(`kernel: purged ${purged} orphan persisted session(s)`)
    if (failed > 0) {
      logger.error(
        `kernel: ${failed} orphan persisted session(s) could not be purged and are still on disk ` +
          `(${purged} purged) — their registry rows are gone, so they are no longer reachable from the UI`
      )
    }
  } catch (error) {
    logger.warn('kernel: orphan session sweep failed', error instanceof Error ? error : new Error(String(error)))
  }
}

export function clearLiveHandles(): void {
  liveHandles.clear()
  liveAgentRoute.clear()
  mountedTools.clear()
}

/** 中止当前回合。 */
export function stopTopic(ctx: Context, id: string): void {
  const agent = ctx.agents.get(SessionId(id))
  if (agent === undefined) return
  agent.cancel({ kind: 'user' })
}

/** 当前回合是否在跑（供 UI 显示生成中状态）。 */
export function isTopicRunning(ctx: Context, id: string): boolean {
  return ctx.agents.get(SessionId(id))?.status === 'running'
}

/** 取会话事件日志（打开话题后的初始渲染用）。 */
export function sessionEvents(ctx: Context, id: string): readonly SessionEvent[] {
  const agent = ctx.agents.get(SessionId(id))
  if (agent === undefined) throw new Error(`kernel: session "${id}" is not loaded`)
  return agent.session.events
}

/**
 * `inspect` returns the session's **complete** event list (its chunk-compressed body
 * included), and it is the only read seam the kernel exposes — `list()` has no paging.
 * A search therefore deserializes the whole library. The brake is a bounded pool
 * instead of one serial `await` chain, so the scans overlap without an unbounded
 * fan-out . The inspected set and the AND/case-insensitive semantics are
 * unchanged: no session is skipped and no match is dropped.
 */
const SEARCH_INSPECT_CONCURRENCY = 4

/** 一条可搜索的消息投影（形状经 `searchSessions` 的返回值消费，故类型本身不出文件）。 */
interface KernelSearchHit {
  topicId: string
  topicName: string
  seq: number
  role: 'user' | 'assistant'
  text: string
  createdAt: number
}

/**
 * 全库搜索：遍历内核持久化的所有会话，投影 user/assistant 消息文本，
 * 返回包含全部关键词（AND，大小写不敏感）的消息。
 * 数据源是内核 SQLite（权威）；旧 Dexie 数据按既定政策不参与。
 *
 * 结果顺序是 list() 的 header 顺序、header 内按 seq（每个会话的命中先收进自己的桶，
 * 最后按 header 下标的顺序拼起来）——与旧的串行版本逐条一致。
 */
export async function searchSessions(ctx: Context, terms: string[]): Promise<KernelSearchHit[]> {
  const normalized = terms.map((term) => term.trim().toLowerCase()).filter((term) => term.length > 0)
  if (normalized.length === 0) return []

  const headers = await ctx.sessionPersistence.list()
  const perSession: KernelSearchHit[][] = headers.map(() => [])
  let cursor = 0

  const scanOne = async (index: number): Promise<void> => {
    const header = headers[index]
    const topicName = getTopic(header.id)?.name ?? header.id
    let events: readonly SessionEvent[]
    try {
      const inspection = await ctx.sessionPersistence.inspect(header.id)
      events = inspection.events
    } catch (error) {
      logger.warn(
        `kernel: failed to inspect session "${header.id}" for search`,
        error instanceof Error ? error : new Error(String(error))
      )
      return
    }

    const found: KernelSearchHit[] = []
    for (const event of events) {
      if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
      // 注入的插件源消息是模型侧状态标注，不是对话内容：不得进检索结果（UI 视界同一判据，
      // 见 sessionEventView.ts）。此前漏封此处，注入快照会以 role:'user' 的形式出现在历史搜索里。
      if (isInjectedUserEvent(event)) continue
      // user/message 的文本在 event.data.content，assistant/message 在 event.data.message.content
      const content = event.type === 'user/message' ? event.data.content : event.data.message.content
      const text = content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (text.length === 0) continue
      const lower = text.toLowerCase()
      if (normalized.every((term) => lower.includes(term))) {
        found.push({
          topicId: header.id,
          topicName,
          seq: event.seq,
          role: event.type === 'user/message' ? 'user' : 'assistant',
          text,
          createdAt: header.createdAt
        })
      }
    }
    perSession[index] = found
  }

  const worker = async (): Promise<void> => {
    for (let index = cursor++; index < headers.length; index = cursor++) {
      await scanOne(index)
    }
  }

  await Promise.all(Array.from({ length: Math.min(SEARCH_INSPECT_CONCURRENCY, headers.length) }, () => worker()))

  return perSession.flat()
}

async function ensureAgent(
  ctx: Context,
  topic: KernelTopic,
  options?: { seed?: readonly SessionEvent[]; parentSessionId?: string; builtins?: string[]; externals?: string[] }
): Promise<Agent> {
  const existing = liveHandles.get(topic.id)
  if (existing !== undefined) {
    const loaded = liveAgentRoute.get(topic.id)
    if (loaded !== undefined && loaded.provider === topic.provider && loaded.model === topic.model) {
      return existing.agent
    }
    // 路由漂移：注册表 provider/model 已被 createTopic upsert 更新，活体还持旧路由。
    // 流式回合进行中不拆活体（会打断进行中的请求）；本次沿用旧路由，下轮 ensure 自然重挂。
    if (isTopicRunning(ctx, topic.id)) return existing.agent
    await existing.dispose()
    liveHandles.delete(topic.id)
    liveAgentRoute.delete(topic.id)
    // 刻意保留 mountedTools：期望工具面/提示词经下方 previous 语义复用，重挂不丢开关状态。
  }

  const sessionId = SessionId(topic.id)
  const live = ctx.agents.get(sessionId)
  if (live !== undefined) return live

  // 工具面跟轮走：显式指定（本轮发送的能力状态）优先，否则维持上一次挂载状态。
  const previous = mountedTools.get(topic.id)
  const builtinsMounted = options?.builtins ?? previous?.builtins ?? []
  const externalsMounted = options?.externals ?? previous?.externals ?? []

  const agentOptions = {
    provider: topic.provider,
    model: topic.model,
    ...(topic.maxTokens === undefined ? {} : { maxTokens: topic.maxTokens })
  }
  // 工具面（Step 3/工具页）：按挂载注册表在 agent 作用域挂载（ToolRegistry 按作用域分层，
  // agentCtx 注册只对本 agent 可见）。挂载单元数据驱动（BUILTIN_MOUNTS / EXTERNAL_MOUNTS），
  // 一个单元可在插件内展开任意数量的工具；开关只增删挂载单元，逻辑不认工具名。
  const setup = async (agentCtx: Context): Promise<void> => {
    if (topic.systemPrompt !== undefined && topic.systemPrompt.length > 0) {
      agentCtx.systemPrompt.section({
        name: 'cherry:assistant',
        order: 0,
        text: topic.systemPrompt
      })
    }
    agentCtx.systemPrompt.section({
      name: 'cherry:tool-face',
      order: 1,
      text: buildToolFaceSection(builtinsMounted, externalsMounted)
    })
    // 工具面运行时快照（dsh RuntimeContextProjection 原生机制）：system 说明段管规则（远因），
    // 这里的动态上下文管每轮状态——渲染值变化时 dsh 自动把快照投影成会话内消息（排在当轮
    // 用户消息之后，最近因位置），状态变化即被模型以最高新鲜度看到，压掉它对自己历史回答
    // 的锚定（真机实锤：挂载/schema 全对，模型仍连续复读旧状态）。面没变不注入（dsh 去重）。
    // 文本刻意压到最短（无感注入：一词一句都是 token）。
    // /6 修正（真机实锤）：cherry:skills / cherry:documents 每轮索引走同一运行时
    // 快照投影——挂了这两个内置工具的轮不得抑制（曾按"仅外置"判定，索引被吞，模型看不到
    // Attached skills、按用户原话瞎猜技能名被执行侧防线拒答）。web_search/knowledge_search
    // 的登记在工具执行时才反查、无快照节，保持原抑制（上下文净化的收益不回吐）。
    const snapshotDependentBuiltin = builtinsMounted.includes('skill') || builtinsMounted.includes('read_document')
    if (externalsMounted.length > 0 || snapshotDependentBuiltin) {
      agentCtx.systemPrompt.context({
        name: 'cherry:tool-face-state',
        order: 0,
        text: `Tools: ${[...builtinsMounted, ...externalsMounted].join(', ')}.`
      })
    } else {
      // 纯聊天/仅内置问答轮抑制整个运行时快照（上下文净化 C）：快照的另两行
      // （文件策略/审批档位）只对带文件/命令工具的轮有意义，零工具时无可越权、无可幻读，
      // 注入只剩 token 与复述噪音（真机实录模型把快照与图片句柄当用户话语复述）。
      // 作用域级抑制器随 agent dispose 自动撤销；工具话题与后续 remount（externals>0）不受影响。
      agentCtx.systemPrompt.suppressRuntimeContext()
    }
    attachReasoningEffortListener(agentCtx, topic.id)
    for (const entry of BUILTIN_MOUNTS) {
      if (builtinsMounted.includes(entry.id)) await entry.mount(agentCtx)
    }
    for (const entry of EXTERNAL_MOUNTS) {
      if (externalsMounted.includes(entry.id)) await entry.mount(agentCtx)
    }
    // MCP 挂载单元：id 形如 `mcp:<serverId>`，由渲染层 messageThunk 按助手
    // mcpMode/mcpServers 派生（manual=勾选集，auto=全部活跃——fork 无 hub，auto 语义
    // 就地降级为全量，交付注记有记）。服务器配置经 Dsh_SyncMcpServers 同步进主进程
    // 内存（同 webSearch 的 apiKey 只进主进程先例）；工具清单 mcpService.listTools（缓存）。
    // 配置缺失/不可达时挂零工具桥或跳过并告警——不静默假装有工具。
    for (const extId of externalsMounted.filter((item) => item.startsWith('mcp:'))) {
      const server = mcpService.getServerById(extId.slice('mcp:'.length))
      if (server === undefined) {
        logger.warn(`kernel: mcp mount "${extId}" skipped — server config not synced to main process`)
        continue
      }
      let tools: MCPTool[] = []
      try {
        tools = await mcpService.listTools(server)
      } catch (error) {
        logger.warn(
          `kernel: mcp mount "${extId}" listTools failed — mounting empty bridge`,
          error instanceof Error ? error : new Error(String(error))
        )
      }
      await agentCtx.plugin(createMcpBridgeModule(server, tools))
    }
    logger.info(
      `kernel: tools mounted for topic "${topic.id}" builtins=[${builtinsMounted.join(',') || '(none)'}] externals=[${externalsMounted.join(',') || '(none)'}]`
    )
    // 技能索引：skill 工具挂载的轮，把可用技能（本轮登记的
    // enabledSkills ∩ 切片元数据）的 name/description 索引进 RuntimeContextProjection
    // 快照节——文本为 setup 时静态计算，启用集跨轮变更靠 turnRegSignature 漂移重挂
    // 刷新；模型按需用 skill 工具读 SKILL.md 全文（progressive disclosure）。
    if (builtinsMounted.includes('skill')) {
      const turnSkills = skillService.getTurnSkills(topic.id) ?? []
      const index =
        turnSkills.length > 0
          ? turnSkills
              .map(
                (skill) =>
                  `- ${hardenUntrustedText(skill.name)}${skill.description ? `: ${hardenUntrustedText(skill.description)}` : ''}`
              )
              .join('\n')
          : '(no skills are attached to this turn)'
      agentCtx.systemPrompt.context({
        name: 'cherry:skills',
        order: 1,
        text: `Attached skills (${turnSkills.length}); read one with the skill tool by its exact name:\n${index}`
      })
    }
    // 文档清单：read_document 挂载的轮，附件文档名索引进快照节（同上，逐轮新鲜）。
    // （ASD-STE100 + 拼名修复）：文档名加引号定边界（名字含空格/混合文字，
    // 裸名 + 冗余扩展标记导致模型首轮拼错文件名）；OCR 提示压成一句（与
    // ocr_document 描述不重复）。工具挂载态决定动词短语（ocr_document 未挂载不提及）。
    // 文档名经 hardenUntrustedText（归一 + 拆解真标签；进受信边界的用户可写文本）。
    if (builtinsMounted.includes('read_document')) {
      const turnDocuments = knowledgeService.getTurnDocuments(topic.id) ?? []
      const index =
        turnDocuments.length > 0
          ? turnDocuments.map((document) => `- "${hardenUntrustedText(document.name)}"`).join('\n')
          : '(no documents are attached to this turn)'
      const verbs = builtinsMounted.includes('ocr_document') ? 'read_document or ocr_document' : 'read_document'
      const ocrHint = builtinsMounted.includes('ocr_document')
        ? ' PDFs without a text layer need the ocr_document tool.'
        : ''
      const saveHint = externalsMounted.includes('saveAttachment')
        ? ' The save_attachment tool can copy one into the workspace.'
        : ''
      agentCtx.systemPrompt.context({
        name: 'cherry:documents',
        order: 1,
        text: `Attached documents (${turnDocuments.length}); pass one to the ${verbs} tool, quoted exactly as listed below.${ocrHint}${saveHint}\n${index}`
      })
    }
    // 持久记忆（外置——工作模式作用域）：memory 工具挂载且有登记根的轮，FACT.md
    // 内容（存在且非空时）注入快照节——V2 的 recall side 同构（工具是唯一写入口，注入只
    // 读回放）。内容是模型自己写的持久文本，进受信边界前清洗（hardenUntrustedText：归一 + 拆解真标签）。
    if (externalsMounted.includes('memory')) {
      const memoryRoot = getTurnMemoryRoot(topic.id)
      if (memoryRoot !== undefined) {
        let factContent: string | undefined
        try {
          const fact = await readFile(join(memoryRoot, 'FACT.md'), 'utf-8')
          if (fact.trim().length > 0) factContent = fact
        } catch {
          // 无 FACT.md = 该助手还没有持久记忆（首次使用前的正常形态，不注入）。
        }
        if (factContent !== undefined) {
          agentCtx.systemPrompt.context({
            name: 'cherry:memory',
            order: 1,
            text:
              "These are your durable notes accumulated across this assistant's past conversations. Trust them " +
              'as ground truth unless you have direct evidence otherwise; update them via the memory tool ' +
              '(action: update) so the next conversation also benefits.\n' +
              hardenUntrustedText(factContent)
          })
        }
      }
    }
  }

  // 工作目录：仅会话创建时可写入 header.cwd（持久化、不可变）；resume 路径沿用已存值。
  const meta = {
    ...(options?.seed !== undefined ? { seedLength: options.seed.length } : {}),
    ...(options?.parentSessionId !== undefined ? { parentSessionId: SessionId(options.parentSessionId) } : {}),
    ...(topic.workingDir !== undefined && topic.workingDir.length > 0 ? { cwd: topic.workingDir } : {})
  }

  let handle: AgentHandle
  if (options?.seed !== undefined) {
    // fork 出的新子会话：直接用前缀事件建会话（不尝试 resume）
    handle = await ctx.agents.create({
      sessionId,
      seed: options.seed as SessionEvent[],
      meta,
      agentOptions,
      setup
    })
  } else {
    // 先尝试从持久化恢复（重启后的话题）；"会话确实不存在"时新建空会话（既有健壮性设计）。
    // 拒绝还是兜底由 sessionResumeFallback 决定，判据是"持久化里有没有这个会话"（本地事实），
    // 不是 resume 抛了哪种错误（那依赖上游抛错行为，而 dsh 对格式无兼容承诺）——见该模块文档。
    handle = await resumeOrCreateSession({
      sessionId,
      topicId: topic.id,
      listPersisted: () => ctx.sessionPersistence.list(),
      resume: () => ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup }),
      createFresh: () => ctx.agents.create({ sessionId, meta, agentOptions, setup })
    })
  }
  liveHandles.set(topic.id, handle)
  liveAgentRoute.set(topic.id, { provider: topic.provider, model: topic.model })
  mountedTools.set(topic.id, {
    builtins: builtinsMounted,
    externals: externalsMounted,
    mcpSignature: (await computeMcpSignature(externalsMounted)).signature,
    // 与上方快照节同源（登记已在 sendMessage 开头写入；话题直开轮为既有登记/空）
    turnRegSignature: await computeTurnRegSignature(topic.id),
    systemPrompt: topic.systemPrompt ?? ''
  })
  return handle.agent
}

/**
 * 发送前把本轮权限档位落到会话（三档生效；随外置工具挂载触发）：
 * 档位 = dsh 沙箱模式名（read-only / workspace-write / danger-full-access），
 * 审批档位 = read-only 问、其余 never。折叠值与目标一致时不重复追加事件。
 */
function applyWorkModeTier(agent: Agent, tier: WorkModeApprovalTier): void {
  if (!WORK_MODE_APPROVAL_TIERS.includes(tier)) return
  const session = agent.session
  if (effectiveSandboxMode(session.events) !== tier) {
    setSandboxMode(session, tier)
  }
  const desiredApproval = tier === 'read-only' ? 'ask' : 'never'
  if (effectiveApprovalPolicy(session.events) !== desiredApproval) {
    setApprovalPolicy(session, desiredApproval)
  }
}

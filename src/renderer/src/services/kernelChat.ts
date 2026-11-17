import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { loggerService } from '@logger'
import { DEFAULT_CONTEXTCOUNT, MAX_CONTEXT_COUNT, UNLIMITED_CONTEXT_COUNT } from '@renderer/config/constant'
import { isVisionModel } from '@renderer/config/models'
import { providerReasoningCompat, type ReasoningCompatProviderInput } from '@renderer/config/reasoningCompat'
import i18n from '@renderer/i18n'
import { pumpFollowupQueue } from '@renderer/services/followupQueue'
import { fetchTopicEventsWithRetry, subscribeKernelSessionEvents } from '@renderer/services/kernelEventStream'
import {
  encodeImageFileForKernel,
  type KernelImageInput,
  registerGeneratedImageFiles,
  syncKernelImageAttachment
} from '@renderer/services/kernelImages'
import { autoNameKernelTopic } from '@renderer/services/topicNaming'
import { beginTurn, cancelTurn, endTurn, isTurnCancelled } from '@renderer/services/topicTurnRuntime'
import { recordUsage } from '@renderer/services/usageStore'
import store from '@renderer/store'
import { updateTopicUpdatedAt } from '@renderer/store/assistants'
import { appendBlockContent, updateOneBlock, upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import { toolPermissionsActions } from '@renderer/store/toolPermissions'
import { type UserQuestionEntry, userQuestionsActions } from '@renderer/store/userQuestions'
import type {
  Assistant,
  FileMetadata,
  KnowledgeReference,
  Model,
  WebSearchProviderResponse,
  WebSearchSource
} from '@renderer/types'
import { FILE_TYPE, WEB_SEARCH_SOURCE } from '@renderer/types'
import type { SerializedError } from '@renderer/types/error'
import {
  AssistantMessageStatus,
  type CitationMessageBlock,
  type ErrorMessageBlock,
  type Message,
  type MessageBlock,
  MessageBlockStatus,
  MessageBlockType,
  type ToolMessageBlock
} from '@renderer/types/newMessage'
import {
  createCitationBlock,
  createErrorBlock,
  createFileBlock,
  createImageBlock,
  createMainTextBlock,
  createThinkingBlock,
  createToolBlock
} from '@renderer/utils/messageUtils/create'
import { replacePromptVariables } from '@renderer/utils/prompt'
import { kernelReasoningEffortsForModel, kernelReasoningLevelFor } from '@renderer/utils/reasoningKernel'
import {
  invalidateKernelRootTopics,
  isRestoredTopicRow,
  kernelKnowsTopic,
  rootTopicIdOf
} from '@renderer/utils/topicBranch'
import type { WorkModeApprovalTier } from '@shared/config/workMode'

const logger = loggerService.withContext('KernelChat')

// ---------------------------------------------------------------------------
// 渲染进程 ↔ dsh 内核的聊天桥。
// 职责：
//   1. 把现有聊天发送路径里的"网络调用"换成内核（topic-send）
//   2. 订阅内核 session 事件流，投影成 Cherry 的 Message/MessageBlock 进 Redux
//      —— UI 是内核的显示器，内核会话日志是权威数据源
// 约束：内核路径任何一步失败都记录日志并向上抛，由调用方走原有回退。
// ---------------------------------------------------------------------------

/** topicId → 等待内核回复的助手消息 stub id（sendMessage thunk 创建）。 */
const pendingStubs = new Map<string, string>()

/** 单个回合（turn）的投影状态：一轮 = 一条回答（B8），轮内多 step 的说话/工具块都归并进同一条消息。 */
interface TurnState {
  assistantMessageId: string
  turn: number
  /** 当前 step（事件自带 step；换 step 即新开一段说话块）。 */
  currentStep?: number
  /** 当前 step 的流式说话块（text / reasoning）。 */
  mainBlockId?: string
  mainText: string
  thinkingBlockId?: string
  thinkingText: string
  /**
   * 尚在 rAF 队列里、未派发进 store 的正文字符：块 content 由 store 侧
   * **增量**追加（`appendBlockContentAction`），故这里只记"已 flush 的长度"这一游标
   * （`mainText` 仍是逐 delta 累积的全文，供计长与最终一致性核对）。
   */
  mainFlushedLen: number
  /** 同上，思考块。 */
  thinkingFlushedLen: number
  /**
   * 推理计时段（修复"完成态归 0.1"）：startedAt = 首条 reasoning-delta；
   * thinkingMillsec = 冻结值（推理结束瞬间——首条 text-delta / tool 块 / step 收尾/
   * 回合收尾最早者——一次性落块，值 = 冻结时刻 − startedAt，与用户看到的跳动器同值；
   * 正文流式时间不计入）。assistant/message 收尾后复位。
   */
  thinkingStartedAt?: number
  thinkingMillsec?: number
  /** 本轮块序（消息 blocks 列表的权威；按事件顺序追加，assistant/message 时替换回当前 step 的流式块）。 */
  blockIds: string[]
  /** 取证钩子（v1 改进）：上一条**任意**内核对本话题事件（含思考/工具/收尾）的
   *  performance.now()。旧实现只量"正文 delta 间隔"，把模型的思考期与工具期误报成
   *  流式停顿——真机日志实证 `text delta gap 73217ms (accumulated 2 chars)` 前后有
   *  thinking-trim 与 interaction 事件，属"没有正文"而非"通路断流"。真正的停顿
   *  = 任意事件都断流（见 noteStreamActivity）。 */
  lastStreamActivityAt?: number
  /** callId → 工具块（tool/result 按 callId 回填同一块）。 */
  toolBlocks: Map<string, ToolMessageBlock>
  /** 跨 step 累计的 token 用量（每条 assistant/message 携带其 step 的用量）。 */
  usage: { inputTokens: number; outputTokens: number }
  /** 是否已把 stub uuid 改写为 kernel id（在本轮第一条 assistant/message 时发生，与其后历史还原一致）。 */
  sawAssistantMessage: boolean
  /** 当前生效的引用数据载体块（搜索工具出结果即设置，多搜索取最新——V1
   * getCitationBlockId 同语义）：其后创建/收尾的正文块据此携带 citationReferences，
   * 正文 [n] 经 withCitationTags → Link/CitationSup 变成可点药丸（统一引用机制）。 */
  citationBlockId?: string
  citationBlockSource?: WebSearchSource
}

const streams = new Map<string, TurnState>()

// --- 分支锚点簿记（最小版，无 UI） ---
// 本地上送的 user 消息（uuid）在回执 user/message 事件到达前拿不到内核 seq；这里按会话 FIFO
// 记录"尚未回执的发送"，回执到达时把本地消息 id 改写成 kernel-<topic>-<seq>（`remapMessageToKernelId`）。
//
// 旧实现另有一张 `liveUserSeq`（topicId\0messageId → seq）登记表，但它在写入的
// **同一行**（回执到达）就被删除，随后消息 id 被改写成 kernel- 前缀——该表对用户消息永远查不到，
// 是"回执前 fork"这条腿的**死登记**（回执前 seq 恰恰不可知，登记不可能存在）。故删除此表：
// 锚点只从 `kernel-` 前缀 id 解析，`kernelAnchorOf` 对非 kernel- id 明确返回 undefined
//（= "回执前 fork 不支持"，由调用方按已有的 anchor 缺失路径处理）。
const pendingUserIds = new Map<string, string[]>()

/** 发送前登记：该 user 消息即将以内核新事件落库（会话内 FIFO）。 */
function rememberPendingUser(topicId: string, userMessageId: string): void {
  const queue = pendingUserIds.get(topicId) ?? []
  queue.push(userMessageId)
  pendingUserIds.set(topicId, queue)
}

/** user/message 事件回执：弹出最早一条未回执的本地消息 id（无则 undefined），供 id 改写用。 */
function takePendingUser(topicId: string): string | undefined {
  const queue = pendingUserIds.get(topicId)
  if (queue === undefined || queue.length === 0) return undefined
  const userMessageId = queue.shift() as string
  if (queue.length === 0) pendingUserIds.delete(topicId) // 空队列不留键（无界增长的半个来源）
  return userMessageId
}

export interface KernelAnchor {
  sessionId: string
  seq: number
}

/**
 * 消息 → 内核锚点 (sessionId, seq)。
 * 只认 `kernel-<session>-<seq>` 形态：本地 uuid（回执未到、seq 未知）没有锚点——
 * **"回执前 fork"不支持**（自 起为显式语义，旧实现的死登记表已删除）。
 *
 * `_topicId` 保留在签名里是为了调用点语义稳定（调用方按话题查询），自 起不再参与解析
 * —— 锚点完全由消息 id 决定，所以不可能出现"按错话题查到别的锚点"。
 */
export function kernelAnchorOf(_topicId: string, message: Message): KernelAnchor | undefined {
  const id = message.id
  if (id.startsWith('kernel-')) {
    const body = id.slice('kernel-'.length)
    const dash = body.lastIndexOf('-')
    if (dash <= 0) return undefined
    const seqText = body.slice(dash + 1)
    if (!/^[0-9]+$/.test(seqText)) return undefined
    return { sessionId: body.slice(0, dash), seq: Number(seqText) }
  }
  return undefined
}

/** 在内核把 source 会话按锚点 fork 成子分支（源会话原样保留）。返回子分支信息；锚点不可解析/失败返回 null。 */
export async function forkBranchToKernel(
  sourceTopicId: string,
  anchorMessage: Message
): Promise<{ id: string; name?: string; createdAt?: number; updatedAt?: number; parentTopicId?: string } | null> {
  const anchor = kernelAnchorOf(sourceTopicId, anchorMessage)
  if (anchor === undefined) {
    logger.warn('kernelChat: no kernel anchor for message ' + anchorMessage.id)
    return null
  }
  if (anchor.sessionId !== sourceTopicId) {
    logger.warn('kernelChat: anchor belongs to a different session, abort fork')
    return null
  }
  try {
    const { topic } = (await window.api.dshTopicFork(anchor.sessionId, anchor.seq)) as {
      topic: { id: string; name?: string; createdAt?: number; updatedAt?: number; parentTopicId?: string }
    }
    return topic
  } catch (error) {
    logger.error(
      'kernelChat: failed to fork topic ' + sourceTopicId,
      error instanceof Error ? error : new Error(String(error))
    )
    return null
  }
}

/** destroyTurns 结果的渲染侧类型（与内核 topics.ts DestroyTurnsResult 同构）。 */
export interface DestroyTurnsResponse {
  purgedTopics: string[]
  truncated: { id: string; fromSeq: number }[]
  focusTopicId: string | null
  /** 内核侧删了注册表但物理清库失败的会话 id（半成功必须可被看见）。 */
  purgeFailures: string[]
}

/** 消息级删除：受影响集合/物理/焦点全部由内核一次事务算完（kernel/topics.ts destroyTurns）。 */
export async function destroyTurnsInKernel(topicId: string, anchorUserSeqs: number[]): Promise<DestroyTurnsResponse> {
  return (await window.api.dshTopicDestroyTurns(topicId, anchorUserSeqs)) as DestroyTurnsResponse
}

let bridgeInitialized = false

/** 应用启动时调用一次：订阅内核事件流与审批/问答请求帧。 */
export function initKernelBridge(): void {
  if (bridgeInitialized) return
  bridgeInitialized = true
  subscribeKernelSessionEvents((payload) => {
    try {
      handleSessionEvent(payload)
    } catch (error) {
      logger.error(
        'kernelChat: failed to handle session event',
        error instanceof Error ? error : new Error(String(error))
      )
    }
  })
  // 审批请求帧 → toolPermissions 状态机（工具卡按 callId 挂上 允许/拒绝 按钮）
  window.api.dshOnApprovalRequest((payload) => {
    try {
      const request = payload as {
        requestId: string
        topicId: string
        toolName: string
        callId?: string
        reason?: string
      }
      store.dispatch(
        toolPermissionsActions.requestReceived({
          requestId: request.requestId,
          toolName: request.toolName,
          toolId: request.callId ?? request.requestId,
          toolCallId: request.callId ?? request.requestId,
          topicId: request.topicId,
          description: request.reason,
          requiresPermissions: true,
          input: {},
          inputPreview: request.reason ?? '',
          createdAt: Date.now(),
          suggestions: []
        })
      )
    } catch (error) {
      logger.error(
        'kernelChat: failed to handle approval request',
        error instanceof Error ? error : new Error(String(error))
      )
    }
  })
  // 问答请求帧 → userQuestions 状态机（ask_user_question 卡片内作答）
  window.api.dshOnQuestionRequest((payload) => {
    try {
      store.dispatch(userQuestionsActions.requestReceived(payload as UserQuestionEntry))
    } catch (error) {
      logger.error(
        'kernelChat: failed to handle question request',
        error instanceof Error ? error : new Error(String(error))
      )
    }
  })
  logger.info('kernelChat: bridge initialized')
}

/**
 * 网络搜索配置同步：websearch 切片 → 主进程引擎（providers 含 apiKey、
 * 黑名单、searchWithTime）。启动与切片变更时调用；apiKey 经此通道进主进程内存，
 * 不落内核 settings.json。载荷形状 KernelWebSearchConfig（@shared/config/types）。
 */
export async function syncWebSearchToKernel(config: {
  providers: Array<{
    id: string
    name: string
    apiKey?: string
    apiHost?: string
    url?: string
    engines?: string[]
    basicAuthUsername?: string
    basicAuthPassword?: string
    usingBrowser?: boolean
  }>
  blacklist: string[]
  excludeDomains: string[]
  searchWithTime: boolean
  maxResults: number
  /** 应用语言（BCP-47，补齐——local-google/bing 的 lang: 过滤消费端此前是死路）。 */
  language?: string
  /** 结果压缩（websearch 切片 compressionConfig 的收窄投影；rag 的 embeddingModel/rerankModel 收窄为引用）。 */
  compression?: {
    method: 'none' | 'cutoff' | 'rag'
    cutoffLimit?: number
    cutoffUnit?: 'char' | 'token'
    documentCount?: number
    embedding?: { providerId: string; modelId: string; dimensions?: number }
    rerank?: { providerId: string; modelId: string }
  }
}): Promise<void> {
  try {
    await window.api.dshSyncWebSearch(config)
  } catch (error) {
    logger.error(
      'kernelChat: failed to sync web search config to kernel',
      error instanceof Error ? error : new Error(String(error))
    )
  }
}

/**
 * 文档处理通道配置同步（三轮）：preprocess 切片 providers（含 apiKey，只进
 * 主进程内存，webSearch/MCP 同先例）→ 主进程内存配置表。ocr_document 工具与知识库
 * 摄取的 PDF 路由按此配置表反查服务商（V2 对齐：配置即路由）。
 * 启动与切片变更时调用。
 */
export async function syncPreprocessToKernel(
  providers: Array<{
    id: string
    apiKey?: string
    apiHost?: string
    model?: string
    /** vision-model 条目的视觉模型引用：provider + model 两个 id。 */
    visionModel?: { provider: string; model: string }
    /** vision-model 条目的页级并发数（1..40；缺省走主进程默认 8）。 */
    visionConcurrency?: number
    /** local-paddle 条目的页级并发数（1..20；缺省走主进程默认 5）。 */
    localConcurrency?: number
    /** local-paddle 条目的 GPU 加速开关（缺省开）。 */
    gpuAcceleration?: boolean
  }>
): Promise<void> {
  try {
    await window.api.dshSyncPreprocess(providers)
  } catch (error) {
    logger.error(
      'kernelChat: failed to sync preprocess providers to kernel',
      error instanceof Error ? error : new Error(String(error))
    )
  }
}

/** 把渲染进程的 provider 配置同步进内核（应用启动与 provider 变更时调用）。 */
export async function syncProvidersToKernel(providers: unknown[]): Promise<void> {
  try {
    const enriched = (providers as Array<Record<string, unknown>>).map((provider) => {
      const models = (provider.models as Array<Record<string, unknown>> | undefined) ?? []
      return {
        ...provider,
        models: models.map((model) => {
          const reasoningEfforts = kernelReasoningEffortsForModel(model as Model)
          // 三层思考协议修正：登记网关事实 + 泛用家族推断 + 用户 apiOptions 声明（见 config/reasoningCompat.ts）
          const compat = providerReasoningCompat(provider as ReasoningCompatProviderInput, model as Model)
          // 识图通道：视觉模型声明输入模态（pi-ai models[].input）——目录外自定义
          // 视觉模型缺了这条，图片会被内核按纯文本路由降级成 handle 文本，永远不上 wire。
          const input = isVisionModel(model as Model) ? (['text', 'image'] as const) : undefined
          if (reasoningEfforts === undefined && compat === undefined && input === undefined) return model
          return {
            ...model,
            ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
            ...(compat === undefined ? {} : { compat }),
            ...(input === undefined ? {} : { input: [...input] })
          }
        })
      }
    })
    await window.api.dshSyncProviders(enriched)
  } catch (error) {
    logger.error(
      'kernelChat: failed to sync providers to kernel',
      error instanceof Error ? error : new Error(String(error))
    )
  }
}

/**
 * 转述模型配置同步（识图通道补全）。变更即推；启动窗内内核未就绪时
 * 只记日志（下一处 provider 变更或重启会重推；describe_images 挂载由发送链
 * 的 builtinTools 决定，路由缺失仅使工具调用明错，不会静默劣化）。
 * prompt 为 '' = 内置默认提示词。
 */
export async function syncImageDescriberToKernel(
  model: { provider: string; id: string } | undefined,
  prompt: string
): Promise<void> {
  try {
    await window.api.dshSyncImageDescriber(
      model === undefined ? null : { provider: model.provider, model: model.id, prompt }
    )
  } catch (error) {
    logger.error(
      'kernelChat: failed to sync image describer config to kernel',
      error instanceof Error ? error : new Error(String(error))
    )
  }
}

/** 助手当前生效的思考档位（映射为内核档位；非推理模型/auto/default 返回 undefined）。 */
export function assistantReasoningLevel(assistant: Assistant): string | undefined {
  return kernelReasoningLevelFor(assistant.model, assistant.settings?.reasoning_effort)
}

/**
 * 助手的上下文预算（请求消息条数上限）。MAX_CONTEXT_COUNT（"不限"档）折算成
 * UNLIMITED_CONTEXT_COUNT（MessagesService 同一约定）——内核侧把 >= 该值视作不裁剪。
 * 随建册/发送上行（问题 1 R1：渲染层预算此前从不进内核请求端）。
 */
export function assistantContextCount(assistant: Assistant): number {
  const setting = assistant.settings?.contextCount
  if (setting === undefined) return DEFAULT_CONTEXTCOUNT
  return setting === MAX_CONTEXT_COUNT ? UNLIMITED_CONTEXT_COUNT : setting
}

/**
 * 确保内核侧存在该话题的 agent/session（幂等）。工作模式不进建册输入——它是渲染层话题开关，随发送参数生效。
 *
 * `dshTopicCreate` 是 **upsert**，对"内核已遗忘的 id"调用
 * 会让该 id **复活**（违反内核兼容契约第 4 节的墓碑纪律）。因此只服务**真正新建**的话题：
 * 来自上次会话的行（`isRestoredTopicRow`）必须由内核**确认存在**（`kernelKnowsTopic` 返回 `true`）
 * 才允许建册；`false`（明确否定）与 `null`（重试窗口内没问到）都拒绝。
 * 本进程内新建的话题不需要这次确认——内核不认识它是因为它还没首发过（这正是本函数要做的建册）。
 */
export async function ensureKernelTopic(topicId: string, assistant: Assistant): Promise<void> {
  const model = assistant.model
  if (model === undefined || model.provider === undefined) {
    throw new Error(`kernelChat: assistant "${assistant.id}" has no model/provider`)
  }
  if (isRestoredTopicRow(topicId)) {
    const known = await kernelKnowsTopic(topicId)
    // `dshTopicCreate` 是 upsert，对"内核已遗忘的 id"调用会让它复活（墓碑纪律）。
    // 三值契约里只有 `true` 是"已确认存在"；`false`（内核确定没有）与 `null`（全部尝试都没问到）
    // 都属于**未确认存在**，而不变式 4 要求 `ensureAgent` 绝不在既有日志之上创建会话——
    // 所以两种情形都拒绝，只在诊断文案上区分：
    //   `false` = 内核明确回答"没有此行"（确定性否定）
    //   `null`  = 内核未能在重试窗口内回答（未知；「不知道」不是「不存在」的许可证）
    if (known === false) {
      throw new Error(
        `kernelChat: topic "${topicId}" is unknown to the kernel registry; refusing to recreate it (kernel answered: no such topic)`
      )
    }
    if (known === null) {
      throw new Error(
        `kernelChat: topic "${topicId}" could not be verified against the kernel registry; refusing to recreate it (kernel did not answer within the retry window)`
      )
    }
  }
  // 占位符必须先就地展开再送内核：助手提示词里的 {{date}} / {{model_name}} 等是 Cherry 自己的
  // 语法，而内核的 systemPrompt.section 走 dsh 的**严格**插值——遇到未注册的 {{name}} 直接抛
  // `unknown prompt variable`，且内核只注册了 provider / model / cwd（见 dsh-agent-loop 的
  // ctx.systemPrompt.variable 三处注册），Cherry 这套一个都不在其中。
  // 渲染侧原先只在设置页预览（usePromptProcessor）与旧的 ApiService 直连路径里做替换，
  // 走到内核的这条注入路径漏了，于是预览能正常显示、一发送就崩。此处补上，两条路径归位。
  const systemPrompt = await replacePromptVariables(assistant.prompt, model.name)
  await window.api.dshTopicCreate({
    id: topicId,
    provider: model.provider,
    model: model.id,
    maxTokens: assistant.settings?.maxTokens,
    systemPrompt,
    reasoningEffort: assistantReasoningLevel(assistant),
    contextCount: assistantContextCount(assistant),
    ...(assistant.workMode?.workingDir !== undefined && assistant.workMode.workingDir.length > 0
      ? { workingDir: assistant.workMode.workingDir }
      : {})
  })
  // 建册成功 → 成员集合变了（新建的行现在在内核里）
  invalidateKernelRootTopics()
}

/** 发送一条消息到内核；流式回复经由事件流投影回 Redux。工具面（内置/外置）与权限档位随发送参数生效（拨动下一轮生效）。 */
export async function sendToKernel(
  topicId: string,
  text: string,
  assistantMessageId: string,
  userMessageId?: string,
  options?: {
    reasoningEffort?: string
    /** 上下文预算（请求消息条数上限；UNLIMITED_CONTEXT_COUNT = 不裁剪）。 */
    contextCount?: number
    builtinTools?: string[]
    externalTools?: string[]
    tier?: WorkModeApprovalTier
    /** 随消息附带的图片（已规范化进预算，识图通道）。 */
    images?: KernelImageInput[]
    /** 网络搜索：本轮 web_search 工具的提供商（助手搜索开启且提供商就绪时上行）。 */
    webSearch?: { providerId: string }
    /** 聊天生图：本轮 generate_image 工具的绘画模型（双门开时上行）。 */
    generateImage?: { providerId: string; modelId: string }
  }
): Promise<void> {
  pendingStubs.set(topicId, assistantMessageId)
  if (userMessageId !== undefined) rememberPendingUser(topicId, userMessageId)
  try {
    await window.api.dshTopicSend(topicId, text, options)
  } catch (error) {
    pendingStubs.delete(topicId)
    throw error
  }
}

/**
 * 提取用户消息携带的图片并规范化为内核附件载荷新形态（识图通道）。
 * 图片块 → FileMetadata → canvas 解码/EXIF 摆正/压预算 → base64 wire 载荷。
 * 单个图片失败即抛错（发送链可见失败），由附件仓库做最后防线校验。
 */
export async function extractImagesFromUserMessage(message: Message): Promise<KernelImageInput[]> {
  const entities = store.getState().messageBlocks.entities
  const files: FileMetadata[] = []
  for (const blockId of message.blocks ?? []) {
    const block = entities[blockId]
    if (block !== undefined && block.type === MessageBlockType.IMAGE && block.file !== undefined) {
      files.push(block.file)
    }
  }
  if (files.length === 0) return []
  return Promise.all(files.map((file) => encodeImageFileForKernel(file)))
}

/**
 * 从内核会话日志还原一个话题的 Message/MessageBlock（打开话题的初始渲染用）。
 * 按"轮"归并（B8：一轮 = 一条回答）：turn 内所有 assistant/message（多 step）的说话块
 * 顺序追加进同一条回答消息；tool/call + tool/result 按 callId 配对产出统一工具块；
 * 用户消息的 image 内容块经 Dsh_AttachmentSync 幂等同步回本地文件仓后产出 IMAGE 块。
 * @returns 投影结果（空历史 = 空数组，是真实状态）；`null` = 内核在重试窗口内始终不可达
 *   （真失败——调用方不得把它当"没有消息"渲染，须允许后续重进重拉）。
 *   启动窗口的瞬时失败（handler 未注册 / agent 异步 resume）由 fetchTopicEventsWithRetry
 * 覆盖（此前一次瞬时失败即返回 null → 话题空白且被"已加载"短路卡住）。
 */
export async function loadKernelTopicMessages(
  topicId: string
): Promise<{ messages: Message[]; blocks: MessageBlock[] } | null> {
  // UI 视界取数：注入的插件源消息已在内核侧剔除（渲染层不再需要可见性判据）
  const events = await fetchTopicEventsWithRetry(topicId)
  if (events === null) {
    logger.warn(`kernelChat: kernel unreachable for topic "${topicId}" after retry window`)
    return null
  }
  return await projectEventsToMessages(topicId, events)
}

// ---------------------------------------------------------------------------
// 事件投影
// ---------------------------------------------------------------------------

/** 停顿告警阈值（毫秒）：任意内核事件都断流超过它才记 warn。 */
const STREAM_STALL_WARN_MS = 5000

/**
 * 记录一次流活动，并在**任意事件**断流超阈值时记 warn（renderer warn 落主进程盘）。
 *
 * 与旧的"正文 delta 间隔"钩子的区别：本函数在 `handleSessionEvent` 的入口调用，因此
 * 思考 delta、工具调用/结果、step 收尾、turn 收尾都算活动。模型长时间推理或跑工具时
 * 不告警——那不是停顿。只有事件流真的中断（内核/IPC 断流）才告警。
 * 阈值取 5s：真机观察到的思考/工具间隙通常 <5s，而用户可感知的停顿远大于此。
 */
function noteStreamActivity(topicId: string, kind: string): void {
  const state = streams.get(topicId)
  if (state === undefined) return
  const now = performance.now()
  const previous = state.lastStreamActivityAt
  state.lastStreamActivityAt = now
  if (previous === undefined) return
  const gap = now - previous
  if (gap > STREAM_STALL_WARN_MS) {
    logger.warn(`kernelChat: no stream activity for ${Math.round(gap)}ms (resumed at ${kind}, topic=${topicId})`)
  }
}

function handleSessionEvent(payload: { topicId: string; event: SessionEvent }): void {
  const { topicId, event } = payload
  // 取证钩子（v1）：任意内核事件都算流活动；只有"什么都没来"才算停顿。
  noteStreamActivity(topicId, event.type)
  switch (event.type) {
    case 'user/message': {
      // 注入的插件源消息（RuntimeContextProjection 的工具面快照、档位标注等）已由内核在
      // 广播口剔除（kernel/sessionEventView.ts），这里收到的一定是真实发送——回执 FIFO
      // 不再有被注入事件抢占名额、把本地消息的回执 seq 记到注入事件上的风险（
      // 结构化：可见性由单一判据保证，本层无需再判）。
      // 回执登记：弹出本地上送的 user 消息（FIFO），其 seq 由事件的 seq 给出
      const localUserId = takePendingUser(topicId)
      // P3 消息 id 统一：回执到达即把本地 uuid 改写为 kernel-<topic>-<seq>（含块与 askId 引用）；
      // 改写后该消息的锚点直接由 id 解析，故不再需要单独的 seq 登记表。
      if (localUserId) {
        remapMessageToKernelId(topicId, localUserId, event.seq)
      }
      break
    }
    case 'turn/start': {
      startTurn(topicId, event.data.turn)
      break
    }
    case 'assistant/chunk': {
      projectChunk(topicId, event.data.step, event.data.chunk)
      break
    }
    case 'assistant/message': {
      // 每 step 一条 assistant/message：只收尾该 step 的块，回合状态保留到 turn/end（多 step 归并不丢内容）
      finalizeStep(topicId, event)
      break
    }
    case 'tool/call': {
      projectToolCall(topicId, event)
      break
    }
    case 'tool/result': {
      projectToolResult(topicId, event)
      break
    }
    case 'turn/end': {
      finishTurn(topicId, event.data.reason)
      // 回合成功 → 话题自动命名（V1 原理：轻量调用 + 设置面可控，见 services/topicNaming.ts）。
      // 错误/中断回合不命名：失败回合的名字没有语义，留给下一次成功的轮次。
      if (event.data.reason.kind !== 'error' && event.data.reason.kind !== 'aborted') {
        void autoNameKernelTopic(topicId)
        // 追问队列泵：回合成功结束后把队首追问按正常路径发出（见
        // services/followupQueue.ts；error/aborted 不泵——失败轮不该自动续问）。
        void pumpFollowupQueue(topicId)
      }
      break
    }
    default:
      break
  }
}

function startTurn(topicId: string, turn: number): void {
  const stubId = pendingStubs.get(topicId)
  if (stubId === undefined) {
    // 内核已开始一个回合，但渲染层没有可投影的 stub（发送登记被上一次失败发送清掉、
    // 或并发发送互踩）。此前静默 return——内核在跑、界面毫无投影，用户看到消息石沉大海。
    // 记 warn 取证；本回合的终态收口由 finishTurn 的无状态分支完成（清 loading/孤儿 stub）。
    logger.warn(`kernelChat: turn/start for topic "${topicId}" (turn ${turn}) has no pending stub to project`)
    return
  }

  // 暂停机制的唯一真相源：回合开始即建立记录（回合结束清掉，见 finishTurn 的 endTurn）。
  beginTurn(topicId, turn, stubId)
  const mainBlock = createMainTextBlock(stubId, '', { status: MessageBlockStatus.STREAMING })
  streams.set(topicId, {
    assistantMessageId: stubId,
    turn,
    mainBlockId: mainBlock.id,
    mainText: '',
    mainFlushedLen: 0,
    thinkingText: '',
    thinkingFlushedLen: 0,
    blockIds: [mainBlock.id],
    toolBlocks: new Map(),
    usage: { inputTokens: 0, outputTokens: 0 },
    sawAssistantMessage: false
  })
  store.dispatch(upsertManyBlocks([mainBlock]))
  store.dispatch(
    newMessagesActions.updateMessage({
      topicId,
      messageId: stubId,
      updates: { blocks: [mainBlock.id], status: AssistantMessageStatus.PROCESSING }
    })
  )
}

/** 把本轮的块序列同步回消息（消息 blocks 列表的唯一写入口，保证「说话 → 工具 → 说话」的事件顺序）。 */
function syncMessageBlocks(topicId: string, state: TurnState): void {
  store.dispatch(
    newMessagesActions.updateMessage({
      topicId,
      messageId: state.assistantMessageId,
      updates: { blocks: [...state.blockIds] }
    })
  )
}

/**
 * 推理结束瞬间冻结思考块（修复"完成态归 0.1"）：status 置 SUCCESS +
 * thinking_millsec 落块，跳动器当场停在推理结束那格——正文/工具阶段不计入思考时长。
 * 冻结值 = 冻结时刻 − 推理起点（与跳动器同基同时钟）。幂等。
 */
function freezePendingThinking(state: TurnState): void {
  if (state.thinkingBlockId === undefined || state.thinkingMillsec !== undefined) return
  const startedAt = state.thinkingStartedAt
  if (startedAt === undefined) return
  const millsec = Math.max(0, Math.round(performance.now() - startedAt))
  state.thinkingMillsec = millsec
  flushBlockUpdate(state.thinkingBlockId, { status: MessageBlockStatus.SUCCESS, thinking_millsec: millsec })
}

function projectChunk(topicId: string, step: number, chunk: StreamChunk): void {
  const state = streams.get(topicId)
  if (state === undefined) return
  // 用户已按暂停：本回合后续增量一律丢弃（界面当帧停住，不再等内核边界收尾）。
  // 阶段名`text-delta`/`reasoning-delta`/`tool-call-delta` 都从这里进，一处拦下即可。
  if (isTurnCancelled(topicId)) return
  // 换 step：上一段说话已由 assistant/message 收尾，本段新开流式块。
  // currentStep 未定 = 首个 step，沿用 startTurn 建好的初始块。
  if (state.currentStep !== undefined && state.currentStep !== step) {
    state.mainBlockId = undefined
    state.mainText = ''
    state.mainFlushedLen = 0
    state.thinkingBlockId = undefined
    state.thinkingText = ''
    state.thinkingFlushedLen = 0
    state.thinkingStartedAt = undefined
    state.thinkingMillsec = undefined
  }
  state.currentStep = step
  switch (chunk.type) {
    case 'text-delta': {
      // 首条正文 delta = 推理已结束：先冻结思考块（跳动器停在同值）。
      // 必须无条件调用——startTurn 已建初始正文块，首 step 的正文 delta 不走下方建块分支
      //（上一版把冻结藏在建块分支里，首 step 冻结从未执行，计数器一路走到回合收尾）。
      freezePendingThinking(state)
      if (state.mainBlockId === undefined) {
        const mainBlock = createMainTextBlock(state.assistantMessageId, '', {
          status: MessageBlockStatus.STREAMING,
          ...(state.citationBlockId !== undefined
            ? {
                citationReferences: [
                  { citationBlockId: state.citationBlockId, citationBlockSource: state.citationBlockSource }
                ]
              }
            : {})
        })
        state.mainBlockId = mainBlock.id
        state.blockIds.push(mainBlock.id)
        store.dispatch(upsertManyBlocks([mainBlock]))
        syncMessageBlocks(topicId, state)
      }
      state.mainText += chunk.text
      state.mainFlushedLen = flushStreamChunk(state.mainBlockId, chunk.text, state.mainText, state.mainFlushedLen)
      break
    }
    case 'reasoning-delta': {
      state.thinkingText += chunk.text
      if (state.thinkingBlockId === undefined) {
        state.thinkingStartedAt = performance.now()
        const thinkingBlock = createThinkingBlock(state.assistantMessageId, '', {
          status: MessageBlockStatus.STREAMING
        })
        state.thinkingBlockId = thinkingBlock.id
        state.thinkingFlushedLen = 0
        // 思考块置于本段文本块之前（沿用现有展示顺序）
        const mainIndex = state.mainBlockId !== undefined ? state.blockIds.indexOf(state.mainBlockId) : -1
        if (mainIndex >= 0) {
          state.blockIds.splice(mainIndex, 0, thinkingBlock.id)
        } else {
          state.blockIds.push(thinkingBlock.id)
        }
        store.dispatch(upsertManyBlocks([thinkingBlock]))
        syncMessageBlocks(topicId, state)
      }
      state.thinkingFlushedLen = flushStreamChunk(
        state.thinkingBlockId,
        chunk.text,
        state.thinkingText,
        state.thinkingFlushedLen
      )
      break
    }
    case 'tool-call-delta':
      // 工具调用块在 tool/call 事件落盘时创建（参数以最终 JSON 为准），流式 delta 不投影
      logger.debug(`kernelChat: tool-call chunk ignored (${chunk.name ?? chunk.id})`)
      break
    default:
      break
  }
}

/** 块内容更新走 rAF 合并，避免高频 delta 刷爆渲染。
 * 派发异常必须放行队列（dispatch 抛错时旧实现不 delete，条目变僵尸——
 * 该块后续所有 flush 永久合并进死条目，表现为"流几字停顿、收尾一次性全文"）。 */
/**
 * 流式正文/思考的**增量**派发。
 *
 * reducer 与 action 都在 `store/messageBlock.ts`（`appendBlockContent`，immer draft 上
 * `content += chunk`）。`getDefaultMiddleware().concat(...)` 会携带**全部** slice 的 matcher
 * 到每个 reducer，故该 action 能命中 `messageBlocks` slice 的 reducer（RTK 标准跨 slice 用法），
 * 无需在服务层另造写入口。
 */
export const CONTENT_CHUNKS_KEY = '__contentChunks' as const

/** rAF 合并队列条目：`changes` 里可携带 `__contentChunks`（本次新增的 delta 列表）。 */
const blockFlushQueue = new Map<string, { timer: number; changes: Record<string, unknown>; queuedAt: number }>()

function flushBlockUpdate(blockId: string, changes: Partial<MessageBlock>): void {
  const existing = blockFlushQueue.get(blockId)
  if (existing !== undefined) {
    // 增量载荷是**追加**语义，不能像普通字段那样被后者覆盖（否则同一帧内的
    // 第二、三个 delta 会顶掉前一个，正文丢字）
    const incomingChunks = (changes as Record<string, unknown>)[CONTENT_CHUNKS_KEY]
    let incoming: Partial<MessageBlock> = changes
    if (Array.isArray(incomingChunks) && incomingChunks.length > 0) {
      const merged = (existing.changes[CONTENT_CHUNKS_KEY] as readonly string[] | undefined) ?? []
      incoming = {
        ...changes,
        [CONTENT_CHUNKS_KEY]: [...merged, ...incomingChunks]
      } as unknown as Partial<MessageBlock>
    }
    existing.changes = { ...existing.changes, ...incoming }
    return
  }
  const entry = { timer: 0, changes: changes as Record<string, unknown>, queuedAt: performance.now() }
  blockFlushQueue.set(blockId, entry)
  entry.timer = window.requestAnimationFrame(() => {
    const current = blockFlushQueue.get(blockId)
    if (current === undefined) return
    blockFlushQueue.delete(blockId)
    // 取证钩子：rAF 派发延迟 >500ms = 渲染饥饿（rAF 未按帧派发）。
    const delay = performance.now() - current.queuedAt
    if (delay > 500) {
      logger.warn(`kernelChat: block flush rAF delayed ${Math.round(delay)}ms (blockId=${blockId})`)
    }
    try {
      const { [CONTENT_CHUNKS_KEY]: rawChunks, ...rest } = current.changes as {
        [CONTENT_CHUNKS_KEY]?: readonly string[]
      } & Record<string, unknown>
      const chunks = rawChunks ?? []
      if (chunks.length > 0) {
        // 增量先落地（与 rest 同一 tick 内先后派发，订阅者一次重算即可）
        store.dispatch(appendBlockContent({ id: blockId, chunks }))
      }
      if (Object.keys(rest).length > 0) {
        store.dispatch(updateOneBlock({ id: blockId, changes: rest as Partial<MessageBlock> }))
      }
    } catch (error) {
      // 取证钩子：渲染层 error 不落盘，升 warn（forensic——静默失败被禁）。
      logger.warn(
        `kernelChat: block flush dispatch failed (blockId=${blockId}, changes=${Object.keys(current.changes).join(',')})`,
        error instanceof Error ? error : new Error(String(error))
      )
    }
  })
}

/** 流式块的增量写入口。
 *
 * 把 `next` 相对 `flushedLen` 的新增后缀作为 delta 交给 rAF 合并队列（同一帧的多个 delta
 * 在队列里累积成一个 chunks 数组，一次派发）。返回新的"已提交长度"游标。
 *
 * 长度回退（理论上是同一 step 内文本被改写，未在事件形态中出现）走全量兜底：此时把
 * 游标复位为 0 并直接派发全文，保证 store 内容与 `next` 逐字一致——宁可慢一次，不可分叉。
 */
function flushStreamChunk(blockId: string, _delta: string, next: string, flushedLen: number): number {
  if (next.length < flushedLen) {
    flushBlockUpdate(blockId, { content: next })
    return next.length
  }
  const tail = next.slice(flushedLen)
  if (tail.length > 0) {
    flushBlockUpdate(blockId, { [CONTENT_CHUNKS_KEY]: [tail] } as unknown as Partial<MessageBlock>)
  }
  return next.length
}

/**
 * 收尾一个 step：以最终内容替换该 step 的流式说话块、累计 usage。
 * 回合状态保留（不删 streams / pendingStubs）——同一轮的后续 step 继续往同一条消息归并，
 * 直到 turn/end 才整体收尾。这是"修掉直播丢内容"的关键（B8：一轮 = 一条回答）。
 */
function finalizeStep(topicId: string, event: Extract<SessionEvent, { type: 'assistant/message' }>): void {
  const state = streams.get(topicId)
  if (state === undefined) return
  const data = event.data

  // 本轮第一条 assistant/message：把 stub uuid 改写为 kernel-<topic>-<seq>（块与引用同步改写）。
  // canonical seq = 本轮第一条 assistant/message（含无文本的纯工具 step），与历史还原和 replySeqs 对齐。
  if (!state.sawAssistantMessage) {
    state.sawAssistantMessage = true
    remapMessageToKernelId(topicId, state.assistantMessageId, event.seq)
    state.assistantMessageId = kernelMessageId(topicId, event.seq)
  }

  // 最终说话块（tool-call 块由 tool/call 事件负责，不在这里产出，避免双卡）
  const finalBlockIds: string[] = []
  const finalBlocks: MessageBlock[] = []
  // 纯推理 step（无正文/工具事件触发过冻结）在此补冻；已冻结则沿用冻结值。
  freezePendingThinking(state)
  const thinkingMillsec = state.thinkingMillsec
  for (const block of data.message.content) {
    if (block.type === 'text' && block.text !== undefined && block.text.length > 0) {
      const main = createMainTextBlock(state.assistantMessageId, block.text, {
        status: MessageBlockStatus.SUCCESS,
        ...(state.citationBlockId !== undefined
          ? {
              citationReferences: [
                { citationBlockId: state.citationBlockId, citationBlockSource: state.citationBlockSource }
              ]
            }
          : {})
      })
      finalBlocks.push(main)
      finalBlockIds.push(main.id)
    } else if (block.type === 'reasoning' && block.text !== undefined && block.text.length > 0) {
      const thinking = createThinkingBlock(state.assistantMessageId, block.text, {
        status: MessageBlockStatus.SUCCESS,
        ...(thinkingMillsec !== undefined ? { thinking_millsec: thinkingMillsec } : {})
      })
      finalBlocks.push(thinking)
      finalBlockIds.push(thinking.id)
    }
  }

  // 从块序中摘掉当前 step 的流式块，把最终块插回原位
  const streamedIds = [state.thinkingBlockId, state.mainBlockId].filter((id): id is string => id !== undefined)
  if (streamedIds.length > 0) {
    const firstIndex = state.blockIds.findIndex((id) => streamedIds.includes(id))
    state.blockIds = state.blockIds.filter((id) => !streamedIds.includes(id))
    const insertAt = firstIndex >= 0 ? Math.min(firstIndex, state.blockIds.length) : state.blockIds.length
    state.blockIds.splice(insertAt, 0, ...finalBlockIds)
  } else if (finalBlockIds.length > 0) {
    state.blockIds.push(...finalBlockIds)
  }
  if (finalBlocks.length > 0) {
    store.dispatch(upsertManyBlocks(finalBlocks))
  }
  // 被替换的流式块标记终态（消息 blocks 已不含它们）；思考块保留冻结值
  //此前只置 SUCCESS 不写 thinking_millsec，完成态计时归 0.1—— 修复。
  for (const id of streamedIds) {
    const isThinkingBlock = id === state.thinkingBlockId
    store.dispatch(
      updateOneBlock({
        id,
        changes: {
          status: MessageBlockStatus.SUCCESS,
          ...(isThinkingBlock && thinkingMillsec !== undefined ? { thinking_millsec: thinkingMillsec } : {})
        }
      })
    )
  }

  // 累计 token 用量（每条 assistant/message 携带其 step 的用量，turn/end 时写入消息）
  if (data.usage !== undefined) {
    state.usage.inputTokens += data.usage.inputTokens ?? 0
    state.usage.outputTokens += data.usage.outputTokens ?? 0
  }

  // 重置说话块游标：下一段说话（下一个 step）新开块
  state.mainBlockId = undefined
  state.mainText = ''
  state.thinkingBlockId = undefined
  state.thinkingText = ''
  state.thinkingStartedAt = undefined
  state.thinkingMillsec = undefined

  syncMessageBlocks(topicId, state)
}

/** 工具调用开始：建统一工具块（status=PROCESSING），按事件顺序追加进本轮块序。 */
function projectToolCall(topicId: string, event: Extract<SessionEvent, { type: 'tool/call' }>): void {
  const state = streams.get(topicId)
  if (state === undefined) return
  // 推理结束转入工具调用：先冻结思考块（同正文分支语义）。
  freezePendingThinking(state)
  let parsedArguments: Record<string, unknown> | undefined
  try {
    const parsed = JSON.parse(event.data.arguments) as unknown
    if (parsed !== null && typeof parsed === 'object') parsedArguments = parsed as Record<string, unknown>
  } catch {
    parsedArguments = undefined
  }
  const block = createToolBlock(state.assistantMessageId, event.data.callId, {
    toolName: event.data.name,
    ...(parsedArguments !== undefined ? { arguments: parsedArguments } : {}),
    metadata: { rawArguments: event.data.arguments }
  })
  state.toolBlocks.set(event.data.callId, block)
  state.blockIds.push(block.id)
  store.dispatch(upsertManyBlocks([block]))
  syncMessageBlocks(topicId, state)
}

/**
 * generate_image 工具结果 → IMAGE 块（直播/回放共用）。结构化图片列表经
 * presentationMeta 随 tool/result 事件 meta 上行（webSearch 引用机制同构，
 * 会话日志持久化、回放复现）；images 非全字符串或为空 = 非本工具的成功形状，
 * 返回 undefined 不投影。type 取 'url'（ImageBlock 渲染层按字符串直用，
 * data URL 与 http URL 同路）。
 *
 * （用户点名）：这批图**同时登记进文件仓**——按源串 sha256 内容寻址落一份 +
 * `db.files` 一行，文件页才看得到聊天页的出图。内容寻址使回放/重开话题重投影时命中同一 id
 * 直接跳过，既有的"不落盘以免堆积"顾虑（旧注释的说法）由这一条解决；登记失败不影响本块渲染。
 */
function buildGenerateImageBlock(messageId: string, meta: unknown): ReturnType<typeof createImageBlock> | undefined {
  if (meta === null || typeof meta !== 'object') return undefined
  const kind = (meta as { kind?: unknown }).kind
  const images = (meta as { images?: unknown }).images
  if (kind !== 'generate-image') return undefined
  if (!Array.isArray(images) || images.length === 0 || !images.every((image) => typeof image === 'string')) {
    return undefined
  }
  void registerGeneratedImageFiles(images)
  return createImageBlock(messageId, {
    status: MessageBlockStatus.SUCCESS,
    metadata: { generateImageResponse: { type: 'url', images: images } }
  })
}

/** 工具调用结束：按 callId 回填同一块（结果文本 + 成功/失败）。 */
function projectToolResult(topicId: string, event: Extract<SessionEvent, { type: 'tool/result' }>): void {
  const state = streams.get(topicId)
  if (state === undefined) return
  const resultBlock = event.data.message?.content?.[0]
  if (resultBlock === undefined) return
  const toolBlock = state.toolBlocks.get(resultBlock.toolCallId)
  if (toolBlock === undefined) {
    logger.warn(`kernelChat: tool result without a tracked call (${resultBlock.toolCallId}) in topic "${topicId}"`)
    return
  }
  const text = (resultBlock.content ?? [])
    .flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    .join('\n')
  const failed = resultBlock.isError === true || event.data.error !== undefined
  store.dispatch(
    updateOneBlock({
      id: toolBlock.id,
      changes: {
        content: text,
        status: failed ? MessageBlockStatus.ERROR : MessageBlockStatus.SUCCESS
      }
    })
  )
  // 工具出结果即该调用的审批生命周期结束（'invoking' 条目随之摘除）
  store.dispatch(toolPermissionsActions.removeByToolCallId({ toolCallId: resultBlock.toolCallId }))
  // 聊天生图：generate_image 成功结果 → IMAGE 块。结构化载荷在事件 meta
  // （presentationMeta 正规通道，webSearch 同构）；直播与回放两路共用
  // buildGenerateImageBlock。base64 data URL 原样进元数据不落盘——
  // saveBase64Image 每次生成新 uuid，回放重落盘会堆积重复文件；数据已在会话
  // 日志，块元数据仅内存投影。
  if (!failed && toolBlock.toolName === 'generate_image') {
    const imageBlock = buildGenerateImageBlock(state.assistantMessageId, event.data.meta)
    if (imageBlock !== undefined) {
      state.blockIds.push(imageBlock.id)
      store.dispatch(upsertManyBlocks([imageBlock]))
      syncMessageBlocks(topicId, state)
    }
  }
  // 统一引用机制：搜索类工具的结构化 meta → 隐形 CitationBlock 数据载体
  //（不渲染成卡——UI 即正文药丸 + 悬浮胶囊；载体仅持有数据供正文引用）。
  // 同轮多次 web_search 合并进既有载体（v0.4 验收轮：配合内核全局编号，单一引用卡）。
  const existingCarrier =
    state.citationBlockId !== undefined
      ? (store.getState().messageBlocks.entities[state.citationBlockId] as CitationMessageBlock | undefined)
      : undefined
  const citationResult = buildSearchCitationBlock(state.assistantMessageId, event.data.meta, failed, existingCarrier)
  if (citationResult !== undefined) {
    const citationBlock = citationResult.block
    if (citationResult.merged) {
      // 合并后的载荷字段随来源不同（web 搜索在 `response.results`，知识库在 `knowledge`）：
      // 这里必须按实际存在的字段落 store——此前只写 `response`，知识库的合并结果会直接丢掉
      //（算对了却进不了 store，界面仍显示两个载体）。
      store.dispatch(
        updateOneBlock({
          id: citationBlock.id,
          changes: {
            ...(citationBlock.response !== undefined ? { response: citationBlock.response } : {}),
            ...(citationBlock.knowledge !== undefined ? { knowledge: citationBlock.knowledge } : {})
          }
        })
      )
    } else {
      state.citationBlockId = citationBlock.id
      state.citationBlockSource = citationBlock.response?.source
      state.blockIds.push(citationBlock.id)
      store.dispatch(upsertManyBlocks([citationBlock]))
      // 本 step 当前流式正文块立即补挂引用（先文后搜索、[n] 出现在同块的场景）
      if (state.mainBlockId !== undefined) {
        store.dispatch(
          updateOneBlock({
            id: state.mainBlockId,
            changes: {
              citationReferences: [
                { citationBlockId: citationBlock.id, citationBlockSource: citationBlock.response?.source }
              ]
            }
          })
        )
      }
    }
    syncMessageBlocks(topicId, state)
  }
}

/**
 * 搜索类工具 meta → 隐形 CitationBlock 数据载体（web-search / knowledge 两形态；
 * 统一引用机制：无 meta 或失败返回 undefined；UI 层不渲染为卡，仅作 Citation[] 源）。
 * 各放弃分支留 info/warn 日志——引用药丸缺失时按日志定位到具体环节。
 *
 * v0.4 验收轮：同轮多次 web_search 合并进既有载体（`existing` 传入本轮已建的
 * websearch 载体块时条目追加、返回原块），配合内核的全局编号偏移——模型正文
 * [n] 与合并后的单一引用卡同序同号，不再出现两张 1-6 卡。merged 返回值语义：
 * 块已就地更新，调用方仅需触发 store 更新，不再 push/attach。
 */
/** 导出仅供测试（冻结块合并回归）；生产消费方为上方两处调用点。 */
export function buildSearchCitationBlock(
  messageId: string,
  meta: unknown,
  failed: boolean,
  existing?: CitationMessageBlock
): { block: CitationMessageBlock; merged: boolean } | undefined {
  if (failed || meta === null || typeof meta !== 'object') return undefined
  const payload = meta as { kind?: string; results?: unknown }
  if (payload.kind === 'web-search') {
    // WebSearchProviderResponse 包装形状 {results:[…]}：formatCitationsFromBlock 的
    // WEBSEARCH 分支按 block.response.results.results 取条目（双层，V1 语义）。
    if (!Array.isArray(payload.results) || payload.results.length === 0) {
      logger.warn('kernelChat: web-search meta carried no results; skip citation block')
      return undefined
    }
    const entries = payload.results as unknown[]
    if (
      existing !== undefined &&
      existing.response?.source === WEB_SEARCH_SOURCE.WEBSEARCH &&
      existing.response.results !== null &&
      typeof existing.response.results === 'object'
    ) {
      // 不可变合并（v0.4 验收轮第二轮修正）：RTK 会冻结已入 store 的块对象，
      // 原地赋值 `wrapper.results = …` 抛 "Cannot assign to read only property" →
      // 事件处理中断 → 第二次搜索的引用整体丢失（真机 15:40 实证）。必须新建
      // 响应对象；调用方用新引用触发 store 更新。
      const wrapper = existing.response.results as { results: unknown[] }
      const mergedBlock: CitationMessageBlock = {
        ...existing,
        response: {
          ...existing.response,
          results: { results: [...wrapper.results, ...entries] } as WebSearchProviderResponse
        }
      }
      logger.info(
        `kernelChat: citation carrier (web-search) merged, ${wrapper.results.length + entries.length} entries total`
      )
      return { block: mergedBlock, merged: true }
    }
    const wrapper = { results: payload.results } as unknown as WebSearchProviderResponse
    const block = createCitationBlock(messageId, {
      response: {
        results: wrapper,
        source: WEB_SEARCH_SOURCE.WEBSEARCH
      }
    })
    logger.info(`kernelChat: citation carrier (web-search) created with ${payload.results.length} entries`)
    return { block, merged: false }
  }
  if (payload.kind === 'knowledge') {
    if (!Array.isArray(payload.results) || payload.results.length === 0) {
      logger.warn('kernelChat: knowledge meta carried no results; skip citation block')
      return undefined
    }
    const entries = payload.results as unknown as KnowledgeReference[]
    if (existing !== undefined && Array.isArray(existing.knowledge)) {
      // 与 web 搜索同构的不可变合并（W4-1）：同一轮第二次检索并入**同一个载体**。
      // 为什么必须合并而不是新建载体：渲染层只取 `citationReferences[0]`，两个载体各自
      // 从 1 编号 ⇒ 第二段正文的 [n] 会对到第一个载体里的错误条目（正确性问题，不只是观感）。
      // 为什么必须新建对象：块进 store 后被冻结，原地 push 抛 "Cannot assign to read only
      // property"（web 搜索分支 15:40 真机实证，故两分支同款写法）。
      const mergedBlock: CitationMessageBlock = {
        ...existing,
        knowledge: [...existing.knowledge, ...entries]
      }
      logger.info(
        `kernelChat: citation carrier (knowledge) merged, ${existing.knowledge.length + entries.length} entries total`
      )
      return { block: mergedBlock, merged: true }
    }
    const block = createCitationBlock(messageId, {
      knowledge: entries
    })
    logger.info(`kernelChat: citation carrier (knowledge) created with ${entries.length} entries`)
    return { block, merged: false }
  }
  logger.warn(`kernelChat: unrecognized search meta kind "${String(payload.kind)}"; skip citation block`)
  return undefined
}

/** turn/end kind=error → ErrorMessageBlock 载荷。
 * UNKNOWN_MODEL（话题绑定的模型不在内核路由集——渲染层模型选择与路由集脱同步）换双语
 * 友好文案；其余错误保留引擎原文，由 ErrorBlock 的分类体系渲染。 */
function serializedTurnError(reason: { error?: { message: string; code: string } }): SerializedError {
  const raw = reason.error
  const code = raw?.code ?? 'TURN_FAILED'
  let message: string = raw?.message ?? 'turn ended with error'
  if (code === 'UNKNOWN_MODEL') {
    const model = /has no configured model "([^"]+)"/.exec(message)?.[1]
    if (model !== undefined) {
      message = i18n.t('kernelChat.unknownModelError', { model })
    }
  }
  return { name: 'KernelTurnError', message, stack: null, code }
}

/** 空响应块载荷（回合正常收尾但零可见输出）。 */
function serializedEmptyTurn(): SerializedError {
  return {
    name: 'KernelTurnError',
    message: i18n.t('kernelChat.emptyResponse'),
    stack: null,
    code: 'EMPTY_RESPONSE'
  }
}

/** 本轮是否产出过可见内容（非空正文/思考；工具卡本身即可见——
 * 纯工具轮是合法形态，不得按空响应误报）。 */
function turnHasVisibleOutput(state: TurnState, entities: Record<string, MessageBlock | undefined>): boolean {
  return state.blockIds.some((blockId) => {
    const block = entities[blockId]
    if (block === undefined) return false
    switch (block.type) {
      case MessageBlockType.MAIN_TEXT:
      case MessageBlockType.THINKING:
        return typeof block.content === 'string' && block.content.trim().length > 0
      case MessageBlockType.TOOL:
        return true
      default:
        return false
    }
  })
}

function finishTurn(topicId: string, reason: { kind: string; error?: { message: string; code: string } }): void {
  const state = streams.get(topicId)
  if (state === undefined) {
    // 本回合没有投影状态（turn/end 先于 turn/start 到达、或 startTurn 未认领 stub）：回合仍然结束了，
    // 本回合的簿记必须收口——否则未回执的 FIFO 条目会污染下一回合的回执配对。
    // 暂停记录也在这一处清掉（endTurn 是唯一的清理点，不存在残留闭包）。
    pendingUserIds.delete(topicId)
    // 未认领的 stub（发送已登记、turn/start 从未认领）：turn 已结束，stub 却永远停在
    // PENDING 零块、话题 loading 永远挂着（失败伪装成空结果）。就地落 ERROR 终态，
    // 语义与下方 state-present 分支一致：error 回合用引擎错误，否则按空响应。
    const orphanStubId = pendingStubs.get(topicId)
    if (orphanStubId !== undefined) {
      const failedTurn = reason.kind === 'error'
      const orphanErrorBlock = createErrorBlock(
        orphanStubId,
        failedTurn ? serializedTurnError(reason) : serializedEmptyTurn()
      )
      store.dispatch(upsertManyBlocks([orphanErrorBlock]))
      store.dispatch(
        newMessagesActions.upsertBlockReference({
          messageId: orphanStubId,
          blockId: orphanErrorBlock.id,
          status: orphanErrorBlock.status,
          blockType: orphanErrorBlock.type
        })
      )
      store.dispatch(
        newMessagesActions.updateMessage({
          topicId,
          messageId: orphanStubId,
          updates: { blocks: [orphanErrorBlock.id], status: AssistantMessageStatus.ERROR }
        })
      )
    }
    // 话题 loading 与回合级登记照常收口（此前漏掉：turn/end 在无投影状态下到达时
    // 话题永远转圈）。
    store.dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
    store.dispatch(toolPermissionsActions.clearByTopic({ topicId }))
    store.dispatch(userQuestionsActions.clearByTopic({ topicId }))
    pendingStubs.delete(topicId)
    endTurn(topicId)
    return
  }
  const failed = reason.kind === 'error'
  const aborted = reason.kind === 'aborted'
  if (failed) {
    logger.error(`kernelChat: turn failed for topic "${topicId}": ${reason.error?.message ?? 'unknown'}`)
  }
  // 失败/空响应以 ERROR 块投影进消息本体（直播路径）。此前只落日志并把
  // 消息状态置 error，气泡里没有任何可见内容（"空回复"案的呈现层缺陷）。历史还原路径
  // （projectEventsToMessages 的 turn/end case）与此同构。
  const turnErrorBlock: ErrorMessageBlock | undefined = failed
    ? createErrorBlock(state.assistantMessageId, serializedTurnError(reason))
    : !aborted && !turnHasVisibleOutput(state, store.getState().messageBlocks.entities)
      ? createErrorBlock(state.assistantMessageId, serializedEmptyTurn())
      : undefined
  if (turnErrorBlock !== undefined) {
    state.blockIds.push(turnErrorBlock.id)
    store.dispatch(upsertManyBlocks([turnErrorBlock]))
    syncMessageBlocks(topicId, state)
  }
  // 只收尾仍处于流式/进行中的块（已终态的块保持其成功/失败原样）。
  // 思考块内联盖上冻结时长（纯推理 step 被打断也不归 0.1）；状态仍按 settle 收尾。
  const settleStatus = failed
    ? MessageBlockStatus.ERROR
    : aborted
      ? MessageBlockStatus.PAUSED
      : MessageBlockStatus.SUCCESS
  const entities = store.getState().messageBlocks.entities
  for (const blockId of state.blockIds) {
    const block = entities[blockId]
    if (
      block !== undefined &&
      (block.status === MessageBlockStatus.STREAMING || block.status === MessageBlockStatus.PROCESSING)
    ) {
      const thinkingElapsed =
        blockId === state.thinkingBlockId && state.thinkingStartedAt !== undefined
          ? (state.thinkingMillsec ?? Math.max(0, Math.round(performance.now() - state.thinkingStartedAt)))
          : undefined
      store.dispatch(
        updateOneBlock({
          id: blockId,
          changes: {
            status: settleStatus,
            ...(thinkingElapsed !== undefined ? { thinking_millsec: thinkingElapsed } : {})
          }
        })
      )
    }
  }
  const updates: Partial<Message> = {
    status: failed
      ? AssistantMessageStatus.ERROR
      : aborted
        ? AssistantMessageStatus.PAUSED
        : AssistantMessageStatus.SUCCESS
  }
  if (state.usage.inputTokens > 0 || state.usage.outputTokens > 0) {
    updates.usage = {
      prompt_tokens: state.usage.inputTokens,
      completion_tokens: state.usage.outputTokens,
      total_tokens: state.usage.inputTokens + state.usage.outputTokens
    }
  }
  store.dispatch(newMessagesActions.updateMessage({ topicId, messageId: state.assistantMessageId, updates }))
  // 用量统计面板：回合级 usage 落库（派生分析数据，见 services/usageStore.ts；
  // 失败/中断回合的 token 也已消耗，照记）。
  if (state.usage.inputTokens > 0 || state.usage.outputTokens > 0) {
    const assistantMessage = store.getState().messages.entities[state.assistantMessageId]
    if (assistantMessage !== undefined && assistantMessage.model !== undefined) {
      void recordUsage({
        timestamp: Date.now(),
        topicId,
        assistantId: assistantMessage.assistantId,
        modelId: assistantMessage.model.id,
        providerId: assistantMessage.model.provider,
        inputTokens: state.usage.inputTokens,
        outputTokens: state.usage.outputTokens
      })
    }
  }
  store.dispatch(updateTopicUpdatedAt({ topicId }))
  store.dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
  // 第三轮：fulfilled 的**真来源**。旧位置在发送任务队列排空时设 true——queue 排
  // 空≠回合结束（内核流还在打），绿点提前亮然后被"看没了"，也从不按回合亮。规则：回合
  // **成功**结束且用户没盯着它（盯着 = 看完了，不算未读）；错误/中断回合不置。
  if (!failed && !aborted) {
    // 写入端直接写**根 id 投影**（第三轮补丁）：重发/旁答的回合发生在 fork 出的
    // 子会话上，侧栏只渲染根行——不折叠的话子会话的"完成"永远照不到根行（重发流绿点
    // 全灭）。判定"用户正盯着"也按家族：currentTopicId 与本回合同根 = 同一串对话在眼前。
    const rows = store.getState().assistants.assistants.flatMap((assistant) => assistant.topics ?? [])
    const rootId = rootTopicIdOf(topicId, rows)
    const current = store.getState().messages.currentTopicId
    const watchingFamily = current !== null && rootTopicIdOf(current, rows) === rootId
    if (!watchingFamily) {
      store.dispatch(newMessagesActions.setTopicFulfilled({ topicId: rootId, fulfilled: true }))
    }
  }
  // 兜底清理：回合结束（含错误/中断）时该话题不应再有未决审批/问答
  store.dispatch(toolPermissionsActions.clearByTopic({ topicId }))
  store.dispatch(userQuestionsActions.clearByTopic({ topicId }))
  streams.delete(topicId)
  pendingStubs.delete(topicId)
  // 本回合未回执的本地 user 消息 FIFO 到此作废——回执没来（内核侧失败/中断/删除轮次）时
  // 留着它只会让下一回合的 user/message 回执把 seq 记到错误的本地 id 上（FIFO 错配 → 锚点错位）。
  pendingUserIds.delete(topicId)
  // 暂停记录在这里唯一收口：回合结束即清，不存在残留（旧的 abortMap + 话题索引 + 键迁移三件套
  // 已随 utils/abortController.ts 一起删除）。
  endTurn(topicId)
}

/**
 * 用户按下暂停：**当帧**把界面状态落定，不等内核到边界收尾。
 *
 * 1. 标记本回合已取消 ⇒ 之后到达的一切增量由 `projectChunk` 丢弃（界面立刻停住）；
 * 2. 把仍在流式/进行中的块与本回合助手消息落成 PAUSED（口径与 `finishTurn` 的 aborted 分支一致，
 *    包含思考块时长内联冻结）；
 * 3. 返回是否真有在跑的回合：`false` = 没有可停的东西。
 *
 * 内核那边仍会收到一次停止（调用方负责），它何时收尾都不再影响观感：`turn/end` 到达时
 * `finishTurn` 走 aborted 分支做终态对账并清记录，此时重复落态是幂等的。
 */
export function cancelActiveTurn(topicId: string): boolean {
  const state = streams.get(topicId)
  if (state === undefined) return false
  cancelTurn(topicId)
  const entities = store.getState().messageBlocks.entities
  for (const blockId of state.blockIds) {
    const block = entities[blockId]
    if (
      block !== undefined &&
      (block.status === MessageBlockStatus.STREAMING || block.status === MessageBlockStatus.PROCESSING)
    ) {
      const thinkingElapsed =
        blockId === state.thinkingBlockId && state.thinkingStartedAt !== undefined
          ? (state.thinkingMillsec ?? Math.max(0, Math.round(performance.now() - state.thinkingStartedAt)))
          : undefined
      store.dispatch(
        updateOneBlock({
          id: blockId,
          changes: {
            status: MessageBlockStatus.PAUSED,
            ...(thinkingElapsed !== undefined ? { thinking_millsec: thinkingElapsed } : {})
          }
        })
      )
    }
  }
  store.dispatch(
    newMessagesActions.updateMessage({
      topicId,
      messageId: state.assistantMessageId,
      updates: { status: AssistantMessageStatus.PAUSED }
    })
  )
  return true
}

// ---------------------------------------------------------------------------
// 历史还原：session 事件 → Cherry Message/MessageBlock
// ---------------------------------------------------------------------------

async function projectEventsToMessages(
  topicId: string,
  events: SessionEvent[]
): Promise<{ messages: Message[]; blocks: MessageBlock[] }> {
  const messages: Message[] = []
  const blocks: MessageBlock[] = []
  // 块索引（id → 块 / id → 下标）。旧实现在 tool/result 回路里用 `blocks.find` 线性查引用
  // 载体块，复杂度是"事件数 × 本轮块数"（直播路径用 store 的实体索引，O(1)）。这里同口径建索引，
  // 顺带让不可变替换（换数组元素）也是 O(1)。数组只追加、只按 id 替换，下标稳定。
  const blockById = new Map<string, MessageBlock>()
  const blockIndexById = new Map<string, number>()
  const pushBlock = (block: MessageBlock): void => {
    blockIndexById.set(block.id, blocks.length)
    blockById.set(block.id, block)
    blocks.push(block)
  }
  const assistantId = findAssistantIdForTopic(topicId)

  let lastUserMessageId: string | undefined
  // 当前轮的合并回答：turn 内所有 assistant/message（多 step）都归并进这一条消息
  let reply: {
    messageId: string
    message: Message
    /** 该回答消息在 `messages` 里的下标（不可变替换用）。 */
    messageIndex: number
    blockIds: string[]
    usage: { inputTokens: number; outputTokens: number }
    toolBlocks: Map<string, ToolMessageBlock>
    /** 本轮是否产出过可见内容（正文/思考/工具卡）——turn/end 空轮守门。 */
    sawVisibleOutput: boolean
    /** 当前生效的引用数据载体块（与直播 TurnState 同语义，正文 [n] 药丸联动）。 */
    citationBlockId?: string
    citationBlockSource?: WebSearchSource
  } | null = null

  /** 历史投影与直播路径同口径——收尾时用**新对象**替换数组元素，不就地改已入数组的对象。 */
  const replaceReplyMessage = (next: Message): void => {
    if (reply === null) return
    reply.message = next
    messages[reply.messageIndex] = next
  }

  const closeReply = (): void => {
    if (reply === null) return
    replaceReplyMessage({
      ...reply.message,
      blocks: reply.blockIds,
      ...(reply.usage.inputTokens > 0 || reply.usage.outputTokens > 0
        ? {
            usage: {
              prompt_tokens: reply.usage.inputTokens,
              completion_tokens: reply.usage.outputTokens,
              total_tokens: reply.usage.inputTokens + reply.usage.outputTokens
            }
          }
        : {})
    })
    reply = null
  }

  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        // 注入消息已在内核侧从 UI 视界剔除（kernel/sessionEventView.ts）：此处不再有
        // "插件源消息"分支——到达这里的 user/message 一定是真实用户轮，直接开新气泡。
        closeReply()
        const messageId = kernelMessageId(topicId, event.seq)
        lastUserMessageId = messageId
        const blockIds: string[] = []
        for (const content of event.data.content) {
          if (content.type === 'text' && content.text.length > 0) {
            const block = createMainTextBlock(messageId, content.text, { status: MessageBlockStatus.SUCCESS })
            pushBlock(block)
            blockIds.push(block.id)
          } else if (content.type === 'document') {
            // 附件修复：文档引用块 → FILE 块。引用随会话日志持久
            //（kernelContentBlocks.ts 的 merge-extensible 扩展点），字节留磁盘原路径。
            const file: FileMetadata = {
              id: `doc-${messageId}-${blocks.length}`,
              name: content.name,
              origin_name: content.name,
              path: content.path,
              size: 0,
              ext: content.ext ?? '',
              type: FILE_TYPE.DOCUMENT,
              created_at: new Date().toISOString(),
              count: 1
            }
            const block = createFileBlock(messageId, file, { status: MessageBlockStatus.SUCCESS })
            pushBlock(block)
            blockIds.push(block.id)
          } else if (content.type === 'image') {
            // 内核只存图片 ref——按 ref 同步字节回本地文件仓（幂等）再产出 IMAGE 块。
            // 同步失败不吞：投影占位文本，重启后重进话题可再同步。
            const file = await syncKernelImageAttachment(content.attachment)
            if (file !== null) {
              const block = createImageBlock(messageId, { file, status: MessageBlockStatus.SUCCESS })
              pushBlock(block)
              blockIds.push(block.id)
            } else {
              // 失败占位与"真的有一段这样的文字"必须在结构上可分——旧实现用
              // `status: SUCCESS` 承载它，导出/复制/用量这类按 status 统计的消费方会把它
              // 当成正常内容。可见文本保持不变（消费方 MainTextBlock/Markdown 不看 status 渲染正文，
              // 见 pages/home/Messages/Blocks/MainTextBlock.tsx；Markdown 只把 status==='streaming'
              // 当流式，ERROR 走"已完成"渲染路径，故呈现不变）。
              const failed = createMainTextBlock(messageId, i18n.t('kernelChat.imageLoadFailed'), {
                status: MessageBlockStatus.ERROR,
                metadata: {
                  error: { kind: 'image-attachment-sync-failed', attachmentId: content.attachment.attachmentId }
                }
              })
              pushBlock(failed)
              blockIds.push(failed.id)
            }
          }
        }
        messages.push(
          createKernelMessage(messageId, topicId, assistantId, 'user', blockIds, {
            askId: messageId,
            status: 'success' as AssistantMessageStatus
          })
        )
        break
      }
      case 'assistant/message': {
        // 回填生成该消息的模型身份（头像/显示名/重新生成都依赖 modelId/model）。
        // source 类型上必填，但 SQLite 旧行或坏行可能缺失：缺了只退化为无头像，不让整个话题投影失败
        const source = event.data.message.source
        const modelFields: Partial<Message> =
          source !== undefined && source.model !== undefined
            ? { modelId: source.model, model: { id: source.model, provider: source.provider } as Model }
            : {}
        if (reply === null) {
          // 本轮第一条 assistant/message：建立合并后的回答消息。
          // canonical id = 本事件 seq（与直播路径的 remap 时机和 replySeqs 一致）
          const messageId = kernelMessageId(topicId, event.seq)
          const message = createKernelMessage(messageId, topicId, assistantId, 'assistant', [], {
            askId: lastUserMessageId,
            ...modelFields,
            status: 'success' as AssistantMessageStatus
          })
          messages.push(message)
          reply = {
            messageId,
            message,
            messageIndex: messages.length - 1,
            blockIds: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            toolBlocks: new Map(),
            sawVisibleOutput: false
          }
        }
        // 说话块顺序追加；tool-call 块由 tool/call + tool/result 事件负责（避免双卡）
        for (const block of event.data.message.content) {
          if (block.type === 'text' && block.text !== undefined && block.text.length > 0) {
            const main = createMainTextBlock(reply.messageId, block.text, {
              status: MessageBlockStatus.SUCCESS,
              ...(reply.citationBlockId !== undefined
                ? {
                    citationReferences: [
                      { citationBlockId: reply.citationBlockId, citationBlockSource: reply.citationBlockSource }
                    ]
                  }
                : {})
            })
            pushBlock(main)
            reply.blockIds.push(main.id)
            reply.sawVisibleOutput = true
          } else if (block.type === 'reasoning' && block.text !== undefined && block.text.length > 0) {
            const thinking = createThinkingBlock(reply.messageId, block.text, { status: MessageBlockStatus.SUCCESS })
            pushBlock(thinking)
            reply.blockIds.push(thinking.id)
            reply.sawVisibleOutput = true
          }
        }
        if (event.data.usage !== undefined) {
          reply.usage.inputTokens += event.data.usage.inputTokens ?? 0
          reply.usage.outputTokens += event.data.usage.outputTokens ?? 0
        }
        break
      }
      case 'tool/call': {
        if (reply === null) {
          logger.warn(`kernelChat: tool/call before any assistant message in topic "${topicId}" (seq ${event.seq})`)
          break
        }
        // 工具卡本身即可见输出（纯工具轮合法，空轮守门不误报）
        reply.sawVisibleOutput = true
        let parsedArguments: Record<string, unknown> | undefined
        try {
          const parsed = JSON.parse(event.data.arguments) as unknown
          if (parsed !== null && typeof parsed === 'object') parsedArguments = parsed as Record<string, unknown>
        } catch {
          parsedArguments = undefined
        }
        const toolBlock = createToolBlock(reply.messageId, event.data.callId, {
          toolName: event.data.name,
          ...(parsedArguments !== undefined ? { arguments: parsedArguments } : {}),
          metadata: { rawArguments: event.data.arguments }
        })
        pushBlock(toolBlock)
        reply.blockIds.push(toolBlock.id)
        reply.toolBlocks.set(event.data.callId, toolBlock)
        break
      }
      case 'tool/result': {
        if (reply === null) break
        const resultBlock = event.data.message?.content?.[0]
        if (resultBlock === undefined) break
        const toolBlock = reply.toolBlocks.get(resultBlock.toolCallId)
        if (toolBlock === undefined) {
          logger.warn(
            `kernelChat: tool result without a tracked call (${resultBlock.toolCallId}) in topic "${topicId}"`
          )
          break
        }
        const text = (resultBlock.content ?? [])
          .flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
          .join('\n')
        const failed = resultBlock.isError === true || event.data.error !== undefined
        // 回填结果用**新块对象**替换（不就地改已进 blocks 数组的块）——与直播路径的
        // `updateOneBlock` 同口径；toolBlocks/数组/索引表同步指向新对象。
        const filledToolBlock: ToolMessageBlock = {
          ...toolBlock,
          content: text,
          status: failed ? MessageBlockStatus.ERROR : MessageBlockStatus.SUCCESS
        }
        reply.toolBlocks.set(resultBlock.toolCallId, filledToolBlock)
        const toolBlockIndex = blockIndexById.get(toolBlock.id)
        if (toolBlockIndex !== undefined) {
          blocks[toolBlockIndex] = filledToolBlock
          blockById.set(filledToolBlock.id, filledToolBlock)
        }
        // 聊天生图回放投影：与直播路径同构（buildGenerateImageBlock 共用，
        // 载荷在事件 meta——presentationMeta 通道，回放复现）。
        if (!failed && filledToolBlock.toolName === 'generate_image') {
          const imageBlock = buildGenerateImageBlock(reply.messageId, event.data.meta)
          if (imageBlock !== undefined) {
            pushBlock(imageBlock)
            reply.blockIds.push(imageBlock.id)
          }
        }
        // 统一引用机制：与直播路径同构（隐形载体 + 正文引用联动；meta 持久化在
        // 会话日志，重开话题即复现药丸与胶囊）。同轮多次 web_search 合并进既有
        // 载体（v0.4 验收轮，与直播路径同构）。
        const currentReply = reply
        // 只要本轮记着载体 id 就把载体交给构建函数——来源是否匹配由构建函数内部分支各自
        // 把守（跨来源本就不合并）。旧条件写成「来源必须是 web 搜索」，导致知识库载体在还原
        // 路径上永远拿不到 existing ⇒ 重开话题后引用又裂成两个载体（直播与还原不同构，W4-1）。
        const existingCarrier =
          currentReply.citationBlockId !== undefined
            ? (blockById.get(currentReply.citationBlockId) as CitationMessageBlock | undefined)
            : undefined
        const citationResult = buildSearchCitationBlock(
          currentReply.messageId,
          event.data.meta,
          failed,
          existingCarrier
        )
        if (citationResult !== undefined) {
          const citationBlock = citationResult.block
          if (citationResult.merged) {
            // 不可变合并的新块对象替换 blocks 里的旧元素（同 id；store 快照稍后统一 upsert）
            const index = blockIndexById.get(citationBlock.id)
            if (index !== undefined) {
              blocks[index] = citationBlock
              blockById.set(citationBlock.id, citationBlock)
            }
          } else {
            currentReply.citationBlockId = citationBlock.id
            currentReply.citationBlockSource = citationBlock.response?.source
            pushBlock(citationBlock)
            currentReply.blockIds.push(citationBlock.id)
          }
        }
        break
      }
      case 'turn/end': {
        // 错误/空轮的历史投影与直播路径（finishTurn）同构。此前投影循环
        // 没有 turn/end case，失败轮重新打开话题后只剩空气泡。轮内没有任何
        // assistant/message 时（如 UNKNOWN_MODEL 在引擎之前失败），先补一条承载
        // 消息（id 用本事件 seq），否则错误块无处可挂。
        const reason = event.data.reason as { kind: string; error?: { message: string; code: string } }
        const wantsErrorBlock = reason.kind === 'error'
        // 空轮守门：正常收尾但零可见输出；aborted 不投（PAUSED 语义）。
        const wantsEmptyBlock =
          reason.kind !== 'error' && reason.kind !== 'aborted' && !(reply?.sawVisibleOutput ?? false)
        if (!wantsErrorBlock && !wantsEmptyBlock) break
        if (reply === null) {
          if (lastUserMessageId === undefined) break
          const messageId = kernelMessageId(topicId, event.seq)
          const message = createKernelMessage(messageId, topicId, assistantId, 'assistant', [], {
            askId: lastUserMessageId,
            status: 'error' as AssistantMessageStatus
          })
          messages.push(message)
          reply = {
            messageId,
            message,
            messageIndex: messages.length - 1,
            blockIds: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            toolBlocks: new Map(),
            sawVisibleOutput: false
          }
        }
        const turnBlock = wantsErrorBlock
          ? createErrorBlock(reply.messageId, serializedTurnError(reason))
          : createErrorBlock(reply.messageId, serializedEmptyTurn())
        // 消息级 status 与直播路径（finishTurn）对齐：error 轮置 error；
        // 空轮保持 success（直播路径成功收尾语义，错误承载在块内）
        // 用新消息对象替换数组元素（不就地改）。
        if (wantsErrorBlock) {
          replaceReplyMessage({ ...reply.message, status: 'error' as AssistantMessageStatus })
        }
        pushBlock(turnBlock)
        reply.blockIds.push(turnBlock.id)
        break
      }
      default:
        break
    }
  }
  closeReply()

  return { messages, blocks }
}

function kernelMessageId(topicId: string, seq: number): string {
  return `kernel-${topicId}-${seq}`
}

/** P3 消息 id 统一：把本地 uuid 消息（user 回执/assistant 收尾）改写为 kernel-<topic>-<seq>，
 * 同步修正其块的 messageId 与 reducer 内 askId 引用；之后删除/重发锚点可直接从 id 解析。 */
function remapMessageToKernelId(topicId: string, localId: string, seq: number): void {
  if (!localId || localId.startsWith('kernel-')) return
  const newId = kernelMessageId(topicId, seq)
  const existing = store.getState().messages.entities[localId]
  const blockIds = existing?.blocks ?? []
  // 暂停不再按键记账（按话题记账，见 services/topicTurnRuntime.ts），故此处无需迁移任何中止键。
  store.dispatch(newMessagesActions.replaceMessageId({ topicId, oldId: localId, newId }))
  for (const blockId of blockIds) {
    store.dispatch(updateOneBlock({ id: blockId, changes: { messageId: newId } }))
  }
}

function createKernelMessage(
  id: string,
  topicId: string,
  assistantId: string,
  role: 'user' | 'assistant',
  blocks: string[],
  overrides: Partial<Message>
): Message {
  return {
    id,
    role,
    assistantId,
    topicId,
    createdAt: new Date().toISOString(),
    // 旧写法 `role === 'user' ? 'success' : 'success'` 两支同值（读者会以为角色有默认差异）。
    // 三个调用点都显式传 `status`（user→success、assistant→success/error），故缺省值不可达、
    // 无法从调用方证明"按角色分默认"的意图；这里退回单一表达式，行为与旧实现逐字一致。
    status: 'success' as AssistantMessageStatus,
    blocks,
    ...overrides
  }
}

function findAssistantIdForTopic(topicId: string): string {
  const state = store.getState()
  for (const assistant of state.assistants.assistants) {
    if (assistant.topics.some((t) => t.id === topicId)) {
      return assistant.id
    }
  }
  return 'kernel'
}

/** 从用户消息块中提取纯文本（发送到内核用）。 */
export function extractTextFromUserMessage(message: Message): string {
  const state = store.getState()
  const blockIds = message.blocks ?? []
  const texts: string[] = []
  for (const blockId of blockIds) {
    const block = state.messageBlocks.entities[blockId]
    if (block !== undefined && block.type === MessageBlockType.MAIN_TEXT) {
      texts.push(block.content)
    }
  }
  return texts.join('\n')
}

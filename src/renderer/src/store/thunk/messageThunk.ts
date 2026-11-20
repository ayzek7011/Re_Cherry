/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
import { loggerService } from '@logger'
import { isVisionModel } from '@renderer/config/models'
import i18n from '@renderer/i18n'
import FileManager from '@renderer/services/FileManager'
import { endSpan } from '@renderer/services/SpanManagerService'
import { isWebSearchEnabled } from '@renderer/services/WebSearchService'
import store from '@renderer/store'
import { moveTopicToHead, updateTopicUpdatedAt } from '@renderer/store/assistants'
import { getEffectiveMcpMode } from '@renderer/types'
import { type Assistant, type FileMetadata, type Model, type Topic } from '@renderer/types'
import type { FileMessageBlock, ImageMessageBlock, Message, MessageBlock } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockType } from '@renderer/types/newMessage'
import { serializeError } from '@renderer/utils/error'
import { createAssistantMessage, createErrorBlock, resetAssistantMessage } from '@renderer/utils/messageUtils/create'
import { getTopicQueue, waitForTopicQueue } from '@renderer/utils/queue'
import { isRestoredTopicRow } from '@renderer/utils/topicBranch'
import { BUILTIN_TOOL_IDS, EXTERNAL_TOOL_IDS } from '@shared/config/agentTools'
import { t } from 'i18next'
import { isEmpty, throttle } from 'lodash-es'
import { LRUCache } from 'lru-cache'

import type { AppDispatch, RootState } from '../index'
import { removeManyBlocks, updateOneBlock, upsertManyBlocks } from '../messageBlock'
import { newMessagesActions, selectMessagesForTopic } from '../newMessage'

const logger = loggerService.withContext('MessageThunk')

const finishTopicLoading = async (topicId: string) => {
  await waitForTopicQueue(topicId)
  // 第三轮：fulfilled 的 true 不在这里设——queue 排空≠回合结束（内核流还在打），
  // 旧位置会让侧栏绿点提前亮然后被"看没了"。真源在 kernelChat.finishTurn（回合成功 + 用户
  // 未在观看时才置 true）。loading:false 本身保留：它服务"加载等待"语义（加载中禁点）。
  store.dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
}

type AgentSessionContext = {
  agentId: string
  sessionId: string
  agentSessionId?: string
}

const findExistingAgentSessionContext = (
  state: RootState,
  topicId: string,
  assistantId: string
): AgentSessionContext | undefined => {
  void state
  void topicId
  void assistantId
  return undefined
}

/**
 * 消息块节流器。
 * 每个消息块有独立节流器，并发更新时不会互相影响
 */
const blockUpdateThrottlers = new LRUCache<string, ReturnType<typeof throttle>>({
  max: 100,
  ttl: 1000 * 60 * 5,
  updateAgeOnGet: true,
  dispose: (throttler, id) => {
    throttler.cancel()
    const rafId = blockUpdateRafs.get(id)
    if (rafId) {
      cancelAnimationFrame(rafId)
      blockUpdateRafs.delete(id)
    }
  }
})

/**
 * 消息块 RAF 缓存。
 * 用于管理 RAF 请求创建和取消。
 */
const blockUpdateRafs = new LRUCache<string, number>({
  max: 100,
  ttl: 1000 * 60 * 5,
  updateAgeOnGet: true,
  dispose: (rafId) => {
    cancelAnimationFrame(rafId)
  }
})

/**
 * 获取或创建消息块专用的节流函数。
 */
const getBlockThrottler = (id: string) => {
  if (!blockUpdateThrottlers.has(id)) {
    const throttler = throttle(async (blockUpdate: any) => {
      const existingRAF = blockUpdateRafs.get(id)
      if (existingRAF) {
        cancelAnimationFrame(existingRAF)
      }

      const rafId = requestAnimationFrame(() => {
        store.dispatch(updateOneBlock({ id, changes: blockUpdate }))
        blockUpdateRafs.delete(id)
      })

      blockUpdateRafs.set(id, rafId)
    }, 150)

    blockUpdateThrottlers.set(id, throttler)
  }

  return blockUpdateThrottlers.get(id)!
}

/**
 * 更新单个消息块。
 */
export const throttledBlockUpdate = (id: string, blockUpdate: any) => {
  const throttler = getBlockThrottler(id)
  // store.dispatch(updateOneBlock({ id, changes: blockUpdate }))
  throttler(blockUpdate)
}

/**
 * 取消单个块的节流更新，移除节流器和 RAF。
 */
export const cancelThrottledBlockUpdate = (id: string) => {
  const rafId = blockUpdateRafs.get(id)
  if (rafId) {
    cancelAnimationFrame(rafId)
    blockUpdateRafs.delete(id)
  }

  const throttler = blockUpdateThrottlers.get(id)
  if (throttler) {
    throttler.cancel()
    blockUpdateThrottlers.delete(id)
  }
}

/**
 * 批量清理多个消息块。
 */
export const cleanupMultipleBlocks = (dispatch: AppDispatch, blockIds: string[]) => {
  blockIds.forEach((id) => {
    cancelThrottledBlockUpdate(id)
  })

  const getBlocksFiles = async (blockIds: string[]) => {
    // 从 Redux 读块拿关联文件（Dexie 已废弃，块数据由内核事件驱动）
    const state = store.getState()
    const files = blockIds
      .map((id) => state.messageBlocks.entities[id])
      .filter(
        (block) =>
          block &&
          (block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE) &&
          block.file !== undefined
      )
      .map((block) => (block as FileMessageBlock | ImageMessageBlock).file)
      .filter((file): file is FileMetadata => file !== undefined)
    return isEmpty(files) ? [] : files
  }

  const cleanupFiles = async (files: FileMetadata[]) => {
    await Promise.all(files.map((file) => FileManager.deleteFile(file.id, false)))
  }

  void getBlocksFiles(blockIds).then(cleanupFiles)

  if (blockIds.length > 0) {
    dispatch(removeManyBlocks(blockIds))
  }
}

// --- Helper Function for Multi-Model Dispatch ---
// 多模型创建和发送请求的逻辑，用于用户消息多模型发送和重发
const dispatchMultiModelResponses = async (
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  triggeringMessage: Message, // userMessage or messageToResend
  assistant: Assistant,
  mentionedModels: Model[]
) => {
  const tasksToQueue: { assistantConfig: Assistant; messageStub: Message }[] = []

  for (const mentionedModel of mentionedModels) {
    const assistantForThisMention = { ...assistant, model: mentionedModel }
    const assistantMessage = createAssistantMessage(assistant.id, topicId, {
      askId: triggeringMessage.id,
      model: mentionedModel,
      modelId: mentionedModel.id,
      traceId: triggeringMessage.traceId
    })
    dispatch(newMessagesActions.addMessage({ topicId, message: assistantMessage }))
    tasksToQueue.push({
      assistantConfig: assistantForThisMention,
      messageStub: assistantMessage
    })
  }

  const queue = getTopicQueue(topicId)
  for (const task of tasksToQueue) {
    void queue.add(async () => {
      await fetchAndProcessAssistantResponseImpl(dispatch, getState, topicId, task.assistantConfig, task.messageStub)
    })
  }
}

// --- End Helper Function ---

// 发送和处理助手响应的实现函数，话题提示词在此拼接
const fetchAndProcessAssistantResponseImpl = async (
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  origAssistant: Assistant,
  assistantMessage: Message // Pass the prepared assistant message (new or reset)
) => {
  // 话题行从 store 现取：调用方（分支重发/多模型队列）持有的 assistant 引用可能早于
  // addTopic/updateTopic——用闭包旧引用查找会拿不到新分支话题，workMode/prompt 全部
  // 丢失（外置工具清单与档位随之恒空）。origAssistant 保留给 prompt 基底（多模型场景
  // 的 model 覆盖在调用方变体上，不能被 store 值覆盖回去）。
  const storedAssistant = getState().assistants.assistants.find((a) => a.id === origAssistant.id)
  const topic = (storedAssistant ?? origAssistant).topics.find((t) => t.id === topicId)
  // 助手系统提示词留空 = 加载随界面语言走的默认句（i18n 实时取值，切语言下一轮生效）；
  // 用户填了就只用用户的。话题提示词仍按既有规则叠加在基底之后。
  const basePrompt =
    origAssistant.prompt.trim().length > 0 ? origAssistant.prompt : i18n.t('chat.assistant.defaultSystemPrompt')
  const assistant = topic?.prompt
    ? { ...origAssistant, prompt: `${basePrompt}\n${topic.prompt}` }
    : { ...origAssistant, prompt: basePrompt }
  const assistantMsgId = assistantMessage.id
  try {
    dispatch(newMessagesActions.setTopicLoading({ topicId, loading: true }))

    const allMessagesForTopic = selectMessagesForTopic(getState(), topicId)

    const userMessageId = assistantMessage.askId

    // 2026-10-01：这里原来登记一张「用户消息 id → 回调」的中止表（还要在消息 id 被改写时迁移键、
    // 键失配时再兜底发一次停止）。那三件套已整体删除：暂停改由 `services/topicTurnRuntime.ts`
    // 按**话题**记账（`useMessageOperations.pauseMessages` → `kernelChat.cancelActiveTurn`），
    // 不再需要在这里留任何登记。

    // dsh 内核替换：网络调用改为内核会话（provider/model/prompt 同步进内核，
    // 流式回复由内核 session 事件投影回 Redux）。
    const kernelChat = await import('@renderer/services/kernelChat')
    const triggeringUserMessage = userMessageId
      ? (getState().messages.entities[userMessageId] ?? allMessagesForTopic.find((m) => m.id === userMessageId))
      : undefined
    if (triggeringUserMessage) {
      await kernelChat.ensureKernelTopic(topicId, assistant)
      const text = kernelChat.extractTextFromUserMessage(triggeringUserMessage)
      // 识图通道：图片块规范化为附件载荷（canvas 解码/EXIF/压预算），随发送参数上行。
      // 准入（数量/字节/容器校验）在内核附件仓库，失败整轮拒绝并上抛。
      const images = await kernelChat.extractImagesFromUserMessage(triggeringUserMessage)
      if (text.length === 0 && images.length === 0) {
        logger.warn('kernelChat: user message has no text or image content, nothing to send')
      }
      // 能力状态随发送参数现算（类 buildToolsForSession，拨动下一轮生效）：
      // 内置工具 = 助手开关；外置工具 = 话题工作模式开关（宏）× 助手外置开关；档位 = 助手权限配置
      // 识图通道补全：主模型（本 assistant.model，@提及轮经 assistantForThisMention
      // 已是实际发送模型）无视觉且已配置转述模型 → 追加 describe_images。不进工具设置页
      //（用户裁决：开关由"是否是视觉模型"自动决定）；视觉路由永不挂载，模型直读，
      // 执行侧防线保留拒Call。
      const describerModel = getState().llm.imageDescriberModel
      const wantsDescriber =
        assistant.model !== undefined && !isVisionModel(assistant.model) && describerModel !== undefined
      // 网络搜索：助手开启（webSearchProviderId 或 enableWebSearch）且提供商就绪
      // → 追加 web_search 工具并上行提供商；就绪判定与设置页/面板共用同一判据
      //（services/WebSearchService.isWebSearchEnabled）。提供商缺省用全局默认提供商。
      const webSearchProviderId = assistant.webSearchProviderId ?? getState().websearch.defaultProvider
      const webSearchActive =
        (assistant.webSearchProviderId !== undefined || assistant.enableWebSearch === true) &&
        webSearchProviderId !== undefined &&
        isWebSearchEnabled(webSearchProviderId)
      // 技能：助手启用技能（enabledSkills ∩ 切片元数据）→ 追加 skill 工具并
      // 上行本轮可读技能清单（索引进内核快照节，SKILL.md 由工具按需读）。
      const enabledSkills = assistant.enabledSkills ?? []
      const skillsActive = enabledSkills.length > 0
      // 文档阅读：触发消息 FILE 附件块（非图片）→ read_document 登记载荷
      //（展示名 + 绝对路径，主进程直读做文本层抽取；扫描件诚实诊断见主进程服务）。
      const documentFiles = (triggeringUserMessage.blocks ?? [])
        .map((blockId) => getState().messageBlocks.entities[blockId])
        .filter(
          (block): block is FileMessageBlock =>
            block !== undefined && block.type === MessageBlockType.FILE && block.file !== undefined
        )
        .map((block) => block.file)
      const documentsActive = documentFiles.length > 0
      // ocr_document 进了助手工具页注册表（稀疏缺省 = 开）：附件门 + 开关双门控。
      const ocrEnabled = assistant.builtinTools?.ocr_document !== false
      const documentToolIds = documentsActive ? ['read_document', ...(ocrEnabled ? ['ocr_document'] : [])] : []
      // 聊天生图（V2 PaintingTool.applies 双门语义）：助手开关开 + 绘画模型已配置。
      const paintingModel = getState().llm.paintingModel
      const generateImageActive = assistant.enableGenerateImage === true && paintingModel !== undefined
      const builtinTools = [
        // 附件门：read_document/ocr_document 只在触发消息带文件附件的轮挂载
        //（无附件时 schema 是纯噪音）；ask_user_question 受助手工具页开关。用户裁决：
        // memory/todo/goal 归外置（工作模式作用域），不再进本清单。
        ...BUILTIN_TOOL_IDS.filter((toolId) => toolId !== 'ocr_document' && assistant.builtinTools?.[toolId] !== false),
        ...(wantsDescriber ? ['describe_images'] : []),
        ...(webSearchActive ? ['web_search', 'web_fetch'] : []),
        // 知识检索：助手挂知识库即追加（每轮登记见 options.knowledgeBases）。
        // knowledge_read 同门挂载（kb_search 命中文档的整读/grep 取回键）。
        ...((assistant.knowledge_bases?.length ?? 0) > 0 ? ['knowledge_search', 'knowledge_read'] : []),
        ...(skillsActive ? ['skill'] : []),
        ...(generateImageActive ? ['generate_image'] : []),
        ...documentToolIds
      ]
      // MCP：助手 mcpMode 派生挂载单元清单（`mcp:<serverId>`）。manual = 勾选集
      //（assistant.mcpServers ∩ 活跃）；auto = 全部活跃服务器（fork 无上游 hub 服务器，
      // auto 语义就地降级为全量，交付注记有记）；disabled/空 = 无。服务器配置本身经
      // useAppInit 的 Dsh_SyncMcpServers 同步进主进程，内核桥挂载时按 id 反查。
      const mcpMode = getEffectiveMcpMode(assistant)
      const selectedMcpIds = new Set((assistant.mcpServers ?? []).map((server) => server.id))
      const mcpExternalIds =
        mcpMode === 'disabled'
          ? []
          : getState()
              .mcp.servers.filter(
                (server) => server.isActive && (mcpMode === 'manual' ? selectedMcpIds.has(server.id) : true)
              )
              .map((server) => `mcp:${server.id}`)
      await kernelChat.sendToKernel(topicId, text, assistantMsgId, triggeringUserMessage.id, {
        reasoningEffort: kernelChat.assistantReasoningLevel(assistant),
        builtinTools,
        externalTools: [
          ...(topic?.workMode === true
            ? EXTERNAL_TOOL_IDS.filter((toolId) => assistant.externalTools?.[toolId] !== false)
            : []),
          ...mcpExternalIds
        ],
        tier: assistant.workMode?.approval,
        images,
        ...(webSearchActive ? { webSearch: { providerId: webSearchProviderId } } : {}),
        // 知识检索：本轮可检索库清单（嵌入引用只含 id，主进程自解析密钥）。
        ...((assistant.knowledge_bases?.length ?? 0) > 0
          ? {
              knowledgeBases: (assistant.knowledge_bases ?? []).map((base) => ({
                id: base.id,
                chunkSize: base.chunkSize,
                chunkOverlap: base.chunkOverlap,
                documentCount: base.documentCount,
                threshold: base.threshold,
                embedding: {
                  providerId: base.model.provider,
                  modelId: base.model.id,
                  dimensions: base.dimensions
                },
                // rerank 实装：库配置了重排模型则随登记上行（主进程 lightRerank 精排）。
                ...(base.rerankModel
                  ? { rerank: { providerId: base.rerankModel.provider, modelId: base.rerankModel.id } }
                  : {})
              }))
            }
          : {}),
        // 技能：本轮可读技能清单（enabledSkills ∩ 切片元数据，id = folderName）。
        ...(skillsActive
          ? {
              skills: enabledSkills
                .map((skillId) =>
                  getState().skills.installedSkills.find(
                    (skill) => skill.id === skillId || skill.folderName === skillId
                  )
                )
                .filter((skill): skill is NonNullable<typeof skill> => skill !== undefined)
                .map((skill) => ({
                  id: skill.id,
                  folderName: skill.folderName,
                  name: skill.name,
                  description: skill.description ?? ''
                }))
            }
          : {}),
        // 文档阅读：本轮附件文档清单（展示名 + 绝对路径）。仅在附件轮上行——
        // read_document/ocr_document 的每轮登记（附件线）。
        ...(documentsActive
          ? {
              documents: documentFiles.map((file) => ({
                name: file.origin_name || file.name,
                path: file.path,
                ext: file.ext
              }))
            }
          : {}),
        // 文档处理通道：本轮 OCR 服务商 = 设置 → 文档处理的默认服务商（配置本体经
        // Dsh_SyncPreprocess 整体投影，这里只上行 id）。载荷门与 OCR 能力合并挂载门
        // **严格同形**（payload 门 = 挂载门不变量）：附件轮的 ocr_document，或工作模式轮
        // 的 documents_extract 文档处理臂。多登 = 死登记，少登 = 挂了工具执行必拒。
        ...((documentsActive && ocrEnabled) ||
        (topic?.workMode === true && assistant.externalTools?.documentsExtract !== false)
          ? { preprocess: { providerId: getState().preprocess.defaultProvider } }
          : {}),
        // 聊天生图：本轮绘画模型登记（generate_image 工具执行时按 topicId 反查）。
        ...(generateImageActive && paintingModel
          ? { generateImage: { providerId: paintingModel.provider, modelId: paintingModel.id } }
          : {}),
        // 持久记忆（外置）：工作模式开 + 助手外置开关开时上行助手 id（内核主进程
        // 派生受控目录，渲染层不上行路径）；payload 门与外置挂载门严格同条件。
        ...(topic?.workMode === true && assistant.externalTools?.memory !== false
          ? { memory: { assistantId: assistant.id } }
          : {})
      })
    } else {
      // 触发消息不存在（消息被删/重发竞态等）：此前只记一行日志就返回——loading 已在
      // 上方置 true、stub 消息已入册，话题永远转圈、stub 永远 PENDING 零块（失败伪装成
      // 空结果）。上抛交给既有 catch 做等价终态（错误块 + ERROR 状态 + loading 复位）；
      // endSpan 对尚不存在的 span 是 no-op，安全。
      throw new Error('Triggering user message not found, cannot send assistant response')
    }
  } catch (error: any) {
    logger.error('Error in fetchAndProcessAssistantResponseImpl:', error)
    endSpan({
      topicId,
      error: error,
      modelName: assistant.model?.name
    })
    // V1 回调编排（callbacks/* + BlockManager）已整树删除——它除 `onError` 外没有任何
    // 调用者。发送路径（会话建册 / 附件规范化 / dshTopicSend）抛错时内核不会发 turn/end，
    // 所以 kernelChat.finishTurn 的终态收尾（错误块 + 消息状态 + loading）不会发生。
    // 这里就地补齐**等价且可见**的终态，绝不静默：消息会一直停在 PENDING 且
    // 零块，渲染出来就是一条「空回复」——失败伪装成空结果。
    try {
      const errorBlock = createErrorBlock(assistantMsgId, serializeError(error))
      dispatch(upsertManyBlocks([errorBlock]))
      dispatch(
        newMessagesActions.upsertBlockReference({
          messageId: assistantMsgId,
          blockId: errorBlock.id,
          status: errorBlock.status,
          blockType: errorBlock.type
        })
      )
      dispatch(
        newMessagesActions.updateMessage({
          topicId,
          messageId: assistantMsgId,
          updates: { status: AssistantMessageStatus.ERROR }
        })
      )
    } catch (finalizeError) {
      logger.error('Error finalizing failed send:', finalizeError as Error)
    } finally {
      // 确保无论如何都设置 loading 为 false（失败回合不得把加载动画挂在话题上）
      dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
    }
  }
}

/**
 * 发送消息并处理助手回复
 * @param userMessage 已创建的用户消息
 * @param userMessageBlocks 用户消息关联的消息块
 * @param assistant 助手对象
 * @param topicId 主题ID
 */
export const sendMessage =
  (
    userMessage: Message,
    userMessageBlocks: MessageBlock[],
    assistant: Assistant,
    topicId: Topic['id'],
    agentSession?: AgentSessionContext
  ) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    try {
      if (userMessage.blocks.length === 0) {
        logger.warn('sendMessage: No blocks in the provided message.')
        return
      }

      const stateBeforeSend = getState()
      let activeAgentSession = agentSession ?? findExistingAgentSessionContext(stateBeforeSend, topicId, assistant.id)
      if (activeAgentSession) {
        const derivedSession = findExistingAgentSessionContext(stateBeforeSend, topicId, assistant.id)
        if (derivedSession?.agentSessionId && derivedSession.agentSessionId !== activeAgentSession.agentSessionId) {
          activeAgentSession = {
            ...activeAgentSession,
            agentSessionId: derivedSession.agentSessionId
          }
        }
      }
      if (activeAgentSession?.agentSessionId && !userMessage.agentSessionId) {
        userMessage.agentSessionId = activeAgentSession.agentSessionId
      }

      dispatch(newMessagesActions.addMessage({ topicId, message: userMessage }))
      if (userMessageBlocks.length > 0) {
        dispatch(upsertManyBlocks(userMessageBlocks))
      }
      dispatch(updateTopicUpdatedAt({ topicId }))
      // 活动浮顶（验收轮）：发送即写数组序，侧栏立刻反映；只动位置，updatedAt 已由上行负责
      dispatch(moveTopicToHead({ topicId }))

      const queue = getTopicQueue(topicId)

      {
        const mentionedModels = userMessage.mentions

        if (mentionedModels && mentionedModels.length > 0) {
          await dispatchMultiModelResponses(dispatch, getState, topicId, userMessage, assistant, mentionedModels)
        } else {
          const assistantMessage = createAssistantMessage(assistant.id, topicId, {
            askId: userMessage.id,
            model: assistant.model,
            traceId: userMessage.traceId
          })
          dispatch(
            newMessagesActions.addMessage({
              topicId,
              message: assistantMessage
            })
          )

          void queue.add(async () => {
            await fetchAndProcessAssistantResponseImpl(dispatch, getState, topicId, assistant, assistantMessage)
          })
        }
      }
    } catch (error) {
      logger.error('Error in sendMessage thunk:', error as Error)
    } finally {
      void finishTopicLoading(topicId)
    }
  }

/**
 * Thunk to resend a user message by regenerating its associated assistant responses.
 * Finds all assistant messages responding to the given user message, resets them,
 * and queues them for regeneration without deleting other messages.
 */
export const resendMessageThunk =
  (topicId: Topic['id'], userMessageToResend: Message, assistant: Assistant) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    try {
      const state = getState()
      // Use selector to get all messages for the topic
      const allMessagesForTopic = selectMessagesForTopic(state, topicId)

      // Filter to find the assistant messages to reset
      const assistantMessagesToReset = allMessagesForTopic.filter(
        (m) => m.askId === userMessageToResend.id && m.role === 'assistant'
      )

      // Clear cached search results for the user message being resent
      // This ensures that the regenerated responses will not use stale search results
      try {
        window.keyv.remove(`web-search-${userMessageToResend.id}`)
        window.keyv.remove(`knowledge-search-${userMessageToResend.id}`)
      } catch (error) {
        logger.warn(`Failed to clear keyv cache for message ${userMessageToResend.id}:`, error as Error)
      }

      const resetDataList: Message[] = []

      if (assistantMessagesToReset.length === 0 && !userMessageToResend?.mentions?.length) {
        // 没有相关的助手消息且没有提及模型时，使用助手模型创建一条消息

        const assistantMessage = createAssistantMessage(assistant.id, topicId, {
          askId: userMessageToResend.id,
          model: assistant.model
        })
        assistantMessage.traceId = userMessageToResend.traceId
        resetDataList.push(assistantMessage)

        resetDataList.forEach((message) => {
          dispatch(newMessagesActions.addMessage({ topicId, message }))
        })
      }

      // 处理存在相关的助手消息的情况
      const allBlockIdsToDelete: string[] = []
      const messagesToUpdateInRedux: {
        topicId: string
        messageId: string
        updates: Partial<Message>
      }[] = []

      // 先处理已有的重传
      for (const originalMsg of assistantMessagesToReset) {
        const modelToSet =
          assistantMessagesToReset.length === 1 && !userMessageToResend?.mentions?.length
            ? assistant.model
            : originalMsg.model
        const blockIdsToDelete = [...(originalMsg.blocks || [])]
        const resetMsg = resetAssistantMessage(originalMsg, {
          status: AssistantMessageStatus.PENDING,
          updatedAt: new Date().toISOString(),
          model: modelToSet
        })

        resetDataList.push(resetMsg)
        allBlockIdsToDelete.push(...blockIdsToDelete)
        messagesToUpdateInRedux.push({
          topicId,
          messageId: resetMsg.id,
          updates: resetMsg
        })
      }

      // 再处理新的重传（用户消息提及，但是现有助手消息中不存在提及的模型）
      const originModelSet = new Set(assistantMessagesToReset.map((m) => m.model).filter((m) => m !== undefined))
      const mentionedModelSet = new Set(userMessageToResend.mentions ?? [])
      const newModelSet = new Set([...mentionedModelSet].filter((m) => !originModelSet.has(m)))
      for (const model of newModelSet) {
        const assistantMessage = createAssistantMessage(assistant.id, topicId, {
          askId: userMessageToResend.id,
          model: model,
          modelId: model.id
        })
        resetDataList.push(assistantMessage)
        dispatch(newMessagesActions.addMessage({ topicId, message: assistantMessage }))
      }

      messagesToUpdateInRedux.forEach((update) => dispatch(newMessagesActions.updateMessage(update)))
      cleanupMultipleBlocks(dispatch, allBlockIdsToDelete)

      const queue = getTopicQueue(topicId)
      for (const resetMsg of resetDataList) {
        const assistantConfigForThisRegen = {
          ...assistant,
          ...(resetMsg.model ? { model: resetMsg.model } : {})
        }
        void queue.add(async () => {
          await fetchAndProcessAssistantResponseImpl(dispatch, getState, topicId, assistantConfigForThisRegen, resetMsg)
        })
      }
    } catch (error) {
      logger.error(`[resendMessageThunk] Error resending user message ${userMessageToResend.id}:`, error as Error)
    } finally {
      void finishTopicLoading(topicId)
    }
  }

/**
 * Thunk to resend a user message after its content has been edited.
 * Updates the user message's text block and then triggers the regeneration
 * of its associated assistant responses using resendMessageThunk.
 */
export const resendUserMessageWithEditThunk =
  (topicId: Topic['id'], originalMessage: Message, assistant: Assistant) => async (dispatch: AppDispatch) => {
    // Trigger the regeneration logic for associated assistant messages
    void dispatch(resendMessageThunk(topicId, originalMessage, assistant))
  }

/**
 * Thunk to regenerate a specific assistant response.
 */
export const regenerateAssistantResponseThunk =
  (topicId: Topic['id'], assistantMessageToRegenerate: Message, assistant: Assistant) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    try {
      const state = getState()

      // 1. Use selector to get all messages for the topic
      const allMessagesForTopic = selectMessagesForTopic(state, topicId)

      const askId = assistantMessageToRegenerate.askId

      if (!askId) {
        logger.error(
          `[appendAssistantResponseThunk] Existing assistant message ${assistantMessageToRegenerate.id} does not have an askId.`
        )
        return // Stop if askId is missing
      }

      if (!state.messages.entities[askId]) {
        logger.error(
          `[appendAssistantResponseThunk] Original user query (askId: ${askId}) not found in entities. Cannot create assistant response without corresponding user message.`
        )

        // Show error popup instead of creating error message block
        window.toast.error(t('error.missing_user_message'))

        return
      }

      // 2. Find the original user query (Restored Logic)
      const originalUserQuery = allMessagesForTopic.find((m) => m.id === assistantMessageToRegenerate.askId)
      if (!originalUserQuery) {
        logger.error(
          `[regenerateAssistantResponseThunk] Original user query (askId: ${assistantMessageToRegenerate.askId}) not found for assistant message ${assistantMessageToRegenerate.id}. Cannot regenerate.`
        )
        return
      }

      // 3. Verify the assistant message itself exists in entities
      const messageToResetEntity = state.messages.entities[assistantMessageToRegenerate.id]
      if (!messageToResetEntity) {
        // No need to check topicId again as selector implicitly handles it
        logger.error(
          `[regenerateAssistantResponseThunk] Assistant message ${assistantMessageToRegenerate.id} not found in entities despite being in the topic list. State might be inconsistent.`
        )
        return
      }

      // 4. Get Block IDs to delete
      const blockIdsToDelete = [...(messageToResetEntity.blocks || [])]

      // 5. Reset the message entity in Redux
      const resetAssistantMsg = resetAssistantMessage(
        messageToResetEntity,
        // Grouped message (mentioned model message) should not reset model and modelId, always use the original model
        assistantMessageToRegenerate.modelId
          ? {
              status: AssistantMessageStatus.PENDING,
              updatedAt: new Date().toISOString()
            }
          : {
              status: AssistantMessageStatus.PENDING,
              updatedAt: new Date().toISOString(),
              model: assistant.model
            }
      )

      dispatch(
        newMessagesActions.updateMessage({
          topicId,
          messageId: resetAssistantMsg.id,
          updates: resetAssistantMsg
        })
      )

      // 6. Remove old blocks from Redux
      cleanupMultipleBlocks(dispatch, blockIdsToDelete)

      // 7. Add fetch/process call to the queue
      const queue = getTopicQueue(topicId)
      const assistantConfigForRegen = {
        ...assistant,
        ...(resetAssistantMsg.model ? { model: resetAssistantMsg.model } : {})
      }
      void queue.add(async () => {
        await fetchAndProcessAssistantResponseImpl(
          dispatch,
          getState,
          topicId,
          assistantConfigForRegen,
          resetAssistantMsg
        )
      })
    } catch (error) {
      logger.error(
        `[regenerateAssistantResponseThunk] Error regenerating response for assistant message ${assistantMessageToRegenerate.id}:`,
        error as Error
      )
      // dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
    } finally {
      void finishTopicLoading(topicId)
    }
  }

/**
 * Thunk to append a new assistant response (using a potentially different model)
 * in reply to the same user query as an existing assistant message.
 */
export const appendAssistantResponseThunk =
  (
    topicId: Topic['id'],
    existingAssistantMessageId: string, // ID of the assistant message the user interacted with
    newModel: Model, // The new model selected by the user
    assistant: Assistant, // Base assistant configuration
    traceId?: string
  ) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    try {
      const state = getState()

      // 1. Find the existing assistant message to get the original askId
      const existingAssistantMsg = state.messages.entities[existingAssistantMessageId]
      if (!existingAssistantMsg) {
        logger.error(
          `[appendAssistantResponseThunk] Existing assistant message ${existingAssistantMessageId} not found.`
        )
        return // Stop if the reference message doesn't exist
      }
      if (existingAssistantMsg.role !== 'assistant') {
        logger.error(
          `[appendAssistantResponseThunk] Message ${existingAssistantMessageId} is not an assistant message.`
        )
        return // Ensure it's an assistant message
      }
      const askId = existingAssistantMsg.askId
      if (!askId) {
        logger.error(
          `[appendAssistantResponseThunk] Existing assistant message ${existingAssistantMessageId} does not have an askId.`
        )
        return // Stop if askId is missing
      }

      // (Optional but recommended) Verify the original user query exists
      if (!state.messages.entities[askId]) {
        logger.error(
          `[appendAssistantResponseThunk] Original user query (askId: ${askId}) not found in entities. Cannot create assistant response without corresponding user message.`
        )

        // Show error popup instead of creating error message block
        window.toast.error(t('error.missing_user_message'))

        return
      }

      // 2. Create the new assistant message stub
      const newAssistantMessageStub = createAssistantMessage(assistant.id, topicId, {
        askId: askId, // Crucial: Use the original askId
        model: newModel,
        modelId: newModel.id,
        traceId: traceId
      })

      // 3. Update Redux Store
      const currentTopicMessageIds = getState().messages.messageIdsByTopic[topicId] || []
      const existingMessageIndex = currentTopicMessageIds.findIndex((id) => id === existingAssistantMessageId)
      const insertAtIndex = existingMessageIndex !== -1 ? existingMessageIndex + 1 : currentTopicMessageIds.length

      dispatch(
        newMessagesActions.insertMessageAtIndex({
          topicId,
          message: newAssistantMessageStub,
          index: insertAtIndex
        })
      )

      void dispatch(updateMessageAndBlocksThunk(topicId, { id: existingAssistantMessageId, foldSelected: false }, []))
      void dispatch(updateMessageAndBlocksThunk(topicId, { id: newAssistantMessageStub.id, foldSelected: true }, []))

      // 5. Prepare and queue the processing task
      const assistantConfigForThisCall = {
        ...assistant,
        model: newModel
      }
      const queue = getTopicQueue(topicId)
      void queue.add(async () => {
        await fetchAndProcessAssistantResponseImpl(
          dispatch,
          getState,
          topicId,
          assistantConfigForThisCall,
          newAssistantMessageStub // Pass the newly created stub
        )
      })
    } catch (error) {
      logger.error(`[appendAssistantResponseThunk] Error appending assistant response:`, error as Error)
      // Optionally dispatch an error action or notification
      // Resetting loading state should be handled by the underlying fetchAndProcessAssistantResponseImpl
    } finally {
      void finishTopicLoading(topicId)
    }
  }

export const updateMessageAndBlocksThunk =
  (
    topicId: string,
    // Allow messageUpdates to be optional or just contain the ID if only blocks are updated
    messageUpdates: (Partial<Message> & Pick<Message, 'id'>) | null, // ID is always required for context
    blockUpdatesList: MessageBlock[] // Block updates remain required for this thunk's purpose
  ) =>
  async (dispatch: AppDispatch): Promise<void> => {
    const messageId = messageUpdates?.id

    if (messageUpdates && !messageId) {
      logger.error('[updateMessageAndUpdateBlocksThunk] Message ID is required.')
      return
    }

    try {
      // 1. 更新 Redux Store
      if (messageUpdates && messageId) {
        // oxlint-disable-next-line @typescript-eslint/no-unused-vars
        const { id: msgId, ...actualMessageChanges } = messageUpdates // Separate ID from actual changes

        // Only dispatch message update if there are actual changes beyond the ID
        if (Object.keys(actualMessageChanges).length > 0) {
          dispatch(
            newMessagesActions.updateMessage({
              topicId,
              messageId,
              updates: actualMessageChanges
            })
          )
        }
      }

      if (blockUpdatesList.length > 0) {
        dispatch(upsertManyBlocks(blockUpdatesList))
      }

      dispatch(updateTopicUpdatedAt({ topicId }))
    } catch (error) {
      logger.error(`[updateMessageAndBlocksThunk] Failed to process updates for message ${messageId}:`, error as Error)
    }
  }

export const removeBlocksThunk =
  (topicId: string, messageId: string, blockIdsToRemove: string[]) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    if (!blockIdsToRemove.length) {
      logger.warn('[removeBlocksThunk] No block IDs provided to remove.')
      return
    }

    try {
      const state = getState()
      const message = state.messages.entities[messageId]

      if (!message) {
        logger.error(`[removeBlocksThunk] Message ${messageId} not found in state.`)
        return
      }
      const blockIdsToRemoveSet = new Set(blockIdsToRemove)

      const updatedBlockIds = (message.blocks || []).filter((id) => !blockIdsToRemoveSet.has(id))

      // 1. Update Redux state
      dispatch(
        newMessagesActions.updateMessage({
          topicId,
          messageId,
          updates: { blocks: updatedBlockIds }
        })
      )
      cleanupMultipleBlocks(dispatch, blockIdsToRemove)

      dispatch(updateTopicUpdatedAt({ topicId }))
    } catch (error) {
      logger.error(`[removeBlocksThunk] Failed to remove blocks from message ${messageId}:`, error as Error)
      throw error
    }
  }

//以下内容从原 messageThunk.v2.ts 迁移过来，原文件已经删除
//原因：v2.ts并不是v2数据重构的一部分，而相关命名对v2重构造成重大误解，故两文件合并，以消除误解

/**
 * Load messages for a topic using unified DbService
 */
export const loadTopicMessagesThunk =
  (topicId: string, forceReload: boolean = false) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    const state = getState()

    dispatch(newMessagesActions.setCurrentTopicId(topicId))

    // Skip if already cached and not forcing reload
    // X14：显式 `return Promise.resolve()`（不是裸 `return`）——本 thunk 在任一分支上都必须返回
    // 可 `.catch()` 的 Promise：消费方（`hooks/useTopic.ts`）用「挂载即对账加载 + 防未处理拒绝」
    // 的形态直接 `.catch()` 调用结果，裸 `return` 会得到 `undefined` → 渲染期 TypeError。
    if (!forceReload && state.messages.messageIdsByTopic[topicId]) {
      return Promise.resolve()
    }

    try {
      dispatch(newMessagesActions.setTopicLoading({ topicId, loading: true }))

      // dsh 内核替换：话题历史只从内核会话日志还原（Dexie 已废弃）
      const { loadKernelTopicMessages } = await import('@renderer/services/kernelChat')
      const kernelData = await loadKernelTopicMessages(topicId)
      if (kernelData !== null) {
        if (kernelData.blocks.length > 0) {
          dispatch(upsertManyBlocks(kernelData.blocks))
        }
        dispatch(newMessagesActions.messagesReceived({ topicId, messages: kernelData.messages }))
        logger.silly('Loaded messages via dsh kernel', {
          topicId,
          messageCount: kernelData.messages.length,
          blockCount: kernelData.blocks.length
        })
      } else if (isRestoredTopicRow(topicId)) {
        // 恢复行却读不出来 = 失败，不是"空历史"——如实抛出，由消费方渲染错误态与重试。
        throw new Error(`kernel has no readable session for restored topic ${topicId}`)
      } else {
        // 本进程内新建、尚未首发建册：内核本来就没有它的会话，"没有历史"是正常状态而不是失败
        // （旧写法在这里一律 warn，真机日志里把"新建话题点一下"污染成了一条 not found 报错）。
        logger.debug(`topic "${topicId}" has no kernel session yet (created this session, never sent)`)
      }
    } catch (error) {
      logger.error(`Failed to load messages for topic ${topicId}:`, error as Error)
      // 失败必须能被消费方看见（失败不得伪装成"确实没有消息"）。调用方按 rejection 决定错误态。
      throw error
    } finally {
      dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
    }
  }

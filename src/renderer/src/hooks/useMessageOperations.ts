import { loggerService } from '@logger'
import { createSelector } from '@reduxjs/toolkit'
import { TopicManager } from '@renderer/hooks/useTopic'
import {
  cancelActiveTurn,
  destroyTurnsInKernel,
  type DestroyTurnsResponse,
  forkBranchToKernel,
  type KernelAnchor,
  kernelAnchorOf,
  loadKernelTopicMessages
} from '@renderer/services/kernelChat'
import { getUserMessage } from '@renderer/services/MessagesService'
import { appendMessageTrace, pauseTrace, restartTrace } from '@renderer/services/SpanManagerService'
import { estimateUserPromptUsage } from '@renderer/services/TokenService'
import store, { type RootState, useAppDispatch, useAppSelector } from '@renderer/store'
import { addTopic, removeTopic, selectTopicsMap, updateTopicUpdatedAt } from '@renderer/store/assistants'
import { removeManyBlocks, upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions, selectMessagesForTopic } from '@renderer/store/newMessage'
import {
  appendAssistantResponseThunk,
  loadTopicMessagesThunk,
  regenerateAssistantResponseThunk,
  removeBlocksThunk,
  resendMessageThunk,
  resendUserMessageWithEditThunk,
  sendMessage as sendMessageThunk,
  updateMessageAndBlocksThunk
} from '@renderer/store/thunk/messageThunk'
import { type Assistant, type FileMetadata, type Model, type Topic, TopicType } from '@renderer/types'
import { objectKeys } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockType } from '@renderer/types/newMessage'
import { getMainTextContent } from '@renderer/utils/messageUtils/find'
import { materializeKernelTopicRow, requestTopicSwitch } from '@renderer/utils/topicBranch'
import { t as translate } from 'i18next'
import { difference } from 'lodash-es'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('UseMessageOperations')

const selectMessagesState = (state: RootState) => state.messages

export const selectNewTopicLoading = createSelector(
  [selectMessagesState, (_, topicId: string) => topicId],
  (messagesState, topicId) => messagesState.loadingByTopic[topicId] || false
)

export const selectNewDisplayCount = createSelector(
  [selectMessagesState],
  (messagesState) => messagesState.displayCount
)

/**
 * Hook 提供针对特定主题的消息操作方法。 / Hook providing various operations for messages within a specific topic.
 * @param topic 当前主题对象。 / The current topic object.
 * @returns 包含消息操作函数的对象。 / An object containing message operation functions.
 */
/**
 * 单条消息 → 其“轮问题”锚点（删除接线）：user 取自身 seq；
 * assistant 归一到其 askId 问题（store 查问后解析）—— 页内组落本页轮，
 * 并行卡组（copyQuestionId）天然落旁答子会话，引擎再按血统上溯定真正创建会话。
 */
function anchorOfMessage(state: RootState, message: Message, fallbackTopicId: string): KernelAnchor | undefined {
  const anchor = kernelAnchorOf(message.topicId ?? fallbackTopicId, message)
  if (anchor === undefined) return undefined
  if (message.role === 'user') return anchor
  if (message.role === 'assistant' && message.askId !== undefined) {
    const question = state.messages.entities[message.askId] as Message | undefined
    if (question === undefined) return undefined
    return kernelAnchorOf(question.topicId ?? anchor.sessionId, question)
  }
  return undefined
}

/**
 * 消息携带的附件（图片/文档）的 file 记录，供分支重发继承。
 * fork 的 seed 截到锚点轮之前——重发消息若不带这些 file，图片/附件会在分支里
 * 静默消失（分支看不到图，模型也无图可读：识图通道真机验收发现的回归）。
 */
function collectMessageFiles(state: RootState, message: Message): FileMetadata[] {
  const files: FileMetadata[] = []
  for (const blockId of message.blocks ?? []) {
    const block = state.messageBlocks.entities[blockId]
    if (block === undefined) continue
    if ((block.type === MessageBlockType.IMAGE || block.type === MessageBlockType.FILE) && block.file !== undefined) {
      files.push(block.file)
    }
  }
  return files
}

export function useMessageOperations(topic: Topic) {
  const dispatch = useAppDispatch()
  const { t } = useTranslation()

  /**
   * 分支重发核心：把（编辑后）的文本作为一次重发，在内核把当前会话按锚点 fork 成子分支
   * （源会话原样保留），随后把文本发进子分支并切换视图到子分支。
   * 返回是否成功；失败（锚点不可解析/内核错误）时调用方回退旧逻辑。
   */
  const startBranchResend = useCallback(
    async (
      anchorMessage: Message,
      assistant: Assistant,
      text: string,
      kind: 'resend' | 'regenerate' = 'resend'
    ): Promise<boolean> => {
      const trimmed = (text ?? '').trim()
      // 锚点单点重读：调用方（编辑重发）传入的 message 是渲染期闭包快照，编辑器新增的
      // 附件块只存在于 store 实体里（editMessageBlocks 已 await 提交）。按旧 blocks 收
      // 附件会静默丢掉新附件，这里从 store 重读一次作为唯一真相源；不把编辑后的 files
      // 另传进来，避免制造第二个真相源。
      const anchor: Message = store.getState().messages.entities[anchorMessage.id] ?? anchorMessage
      // 分支重发继承锚点消息的附件（图片/文档）：fork 的 seed 截到锚点轮之前，
      // 重发消息不带 file 的话图片会在子分支里静默消失（用户卡片无图、模型也无图可读）。
      const files = collectMessageFiles(store.getState(), anchor)
      if (trimmed.length === 0 && files.length === 0) {
        logger.warn('[branchResend] nothing to send')
        return false
      }
      const forked = await forkBranchToKernel(topic.id, anchor)
      if (forked === null) return false

      const preview = trimmed.replace(/\s+/g, ' ').slice(0, 30)
      const childTopic: Topic = {
        id: forked.id,
        type: TopicType.Chat,
        assistantId: assistant.id,
        name: preview.length > 0 ? preview : topic.name || translate('chat.branches.new_branch'),
        createdAt: new Date(forked.createdAt ?? Date.now()).toISOString(),
        updatedAt: new Date(forked.updatedAt ?? Date.now()).toISOString(),
        messages: [],
        parentTopicId: topic.id,
        branchKind: kind,
        // 分支继承源话题的工作模式开关状态（B6：跟话题走，随 redux-persist 持久化）
        ...(topic.workMode === true ? { workMode: true } : {})
      }
      dispatch(addTopic({ assistantId: assistant.id, topic: childTopic }))

      const { message: userMessage, blocks } = getUserMessage({
        content: trimmed,
        files,
        assistant,
        topic: childTopic
      })

      // 关键顺序：先把子分支的完整日志（含与父分支共享的上文）从内核加载进 store，
      // 再发新文本 —— 否则 store 里先有 stub 会让 loadTopicMessagesThunk 短路，
      // 子分支视图将看不到该轮之上的历史。
      try {
        await dispatch(loadTopicMessagesThunk(childTopic.id, true))
      } catch (error) {
        // 子会话首次加载失败不应打断分叉流程（新话题尚无消息时内核侧也确实是空的）。
        logger.warn(`useMessageOperations: failed to load fork child ${childTopic.id}`, error as Error)
      }

      void dispatch(sendMessageThunk(userMessage, blocks ?? [], assistant, childTopic.id))
      requestTopicSwitch(childTopic)
      return true
    },
    [dispatch, topic]
  )

  // ---------------------------------------------------------------------------
  // 消息级删除（destroyTurns 引擎接线）：内核权威。
  // 渲染层只负责把消息归一成“轮问题锚点”后交给内核；受影响集合、物理
  // 截断/清盘、焦点推导全在内核一次算完，落地见 applyDestroyTurnsResult。
  // ---------------------------------------------------------------------------

  /** 落地内核删除结果：purged 收拾本地行/块；truncated 重开+重投影+updatedAt 提升（驱动家族签名刷新）；当前页被整支清盘时按焦点导航。 */
  const applyDestroyTurnsResult = useCallback(
    async (result: DestroyTurnsResponse): Promise<void> => {
      // 1) 清盘话题：内核已物理删除，本地只收拾 —— 清消息/块/文件引用 + 去 topic 行
      for (const purgedId of result.purgedTopics) {
        try {
          await TopicManager.clearTopicMessages(purgedId)
        } catch (error) {
          logger.warn(
            '[applyDestroyTurns] failed to clear local messages for ' + purgedId,
            error instanceof Error ? error : new Error(String(error))
          )
        }
        // Redux 投影一并清掉（文件 + 投影是两回事；TopicManager.clearTopicMessages 只清文件——
        // 与 newMessagesActions.clearTopicMessages 同名不同物，历史上靠同名遮蔽漏掉了投影清理，
        // 后果：purged 话题的 entities/messageIdsByTopic 残留到重启，useParallelAnswers 的
        // "Redux 有就不重拉"会把陈旧投影当新鲜数据跳过重取）。
        const statePre = store.getState()
        const blockIds = (statePre.messages.messageIdsByTopic[purgedId] ?? []).flatMap(
          (messageId) => statePre.messages.entities[messageId]?.blocks ?? []
        )
        if (blockIds.length > 0) {
          dispatch(removeManyBlocks(blockIds))
        }
        dispatch(newMessagesActions.clearTopicMessages(purgedId))
        const stateNow = store.getState()
        const row = selectTopicsMap(stateNow).get(purgedId)
        if (row === undefined) continue
        const owner = stateNow.assistants.assistants.find((assistant) =>
          (assistant.topics ?? []).some((candidate) => candidate.id === purgedId)
        )
        if (owner !== undefined) dispatch(removeTopic({ assistantId: owner.id, topic: row }))
      }

      // 2) 截断存活话题：重开内核会话（从截断日志 resume）+ 整表重投影 + 行 updatedAt 提升
      for (const item of result.truncated) {
        try {
          await window.api.dshTopicOpen(item.id)
        } catch (error) {
          logger.warn(
            '[applyDestroyTurns] failed to reopen ' + item.id,
            error instanceof Error ? error : new Error(String(error))
          )
        }
        const kernelData = await loadKernelTopicMessages(item.id)
        if (kernelData !== null) {
          if (kernelData.blocks.length > 0) dispatch(upsertManyBlocks(kernelData.blocks))
          dispatch(newMessagesActions.messagesReceived({ topicId: item.id, messages: kernelData.messages }))
        }
        dispatch(updateTopicUpdatedAt({ topicId: item.id }))
      }

      // 3) 焦点：当前页被整支清盘时按内核给的落点导航
      if (result.focusTopicId !== null && result.purgedTopics.includes(topic.id)) {
        const focusId = result.focusTopicId
        const stateNow = store.getState()
        const mapNow = selectTopicsMap(stateNow)
        let row = mapNow.get(focusId)
        if (row === undefined) {
          const materialized = await materializeKernelTopicRow({
            sessionId: focusId,
            assistantId: topic.assistantId,
            allTopics: [...mapNow.values()]
          })
          if (materialized !== null) {
            row = materialized.row
            if (materialized.created) dispatch(addTopic({ assistantId: topic.assistantId, topic: row }))
          }
        }
        if (row !== undefined && row.branchKind === 'parallel') {
          // 旁答隐藏会话：不整页导航 —— 焦点回其父页（卡组仍在父页，删卡由签名刷新自然完成）
          try {
            const { topic: kernelTopic } = (await window.api.dshTopicGet(focusId)) as {
              topic?: { parentTopicId?: string }
            }
            const parentId = kernelTopic?.parentTopicId
            if (parentId !== undefined && parentId.length > 0) {
              let target = mapNow.get(parentId)
              if (target === undefined) {
                const materializedParent = await materializeKernelTopicRow({
                  sessionId: parentId,
                  assistantId: topic.assistantId,
                  allTopics: [...mapNow.values()]
                })
                if (materializedParent !== null) {
                  target = materializedParent.row
                  if (materializedParent.created) {
                    dispatch(addTopic({ assistantId: topic.assistantId, topic: target }))
                  }
                }
              }
              if (target !== undefined) requestTopicSwitch(target)
            }
          } catch {
            // 取父失败：留在当前页（空态兜底）
          }
        } else if (row !== undefined) {
          requestTopicSwitch(row)
        }
      }

      // 4) 半成功必须可见：内核已把会话从注册表删掉，但物理清库失败。
      // 静默会让用户以为"已经彻底删除"，而数据其实还留在盘上——这是 「失败不能伪装成成功」的正面案例。
      if (result.purgeFailures.length > 0) {
        logger.warn(
          '[applyDestroyTurns] kernel removed the registry rows but failed to erase: ' + result.purgeFailures.join(', ')
        )
        window.toast?.warning(translate('kernel.topicDestroyTurns.purgeFailed'))
      }
    },
    [dispatch, topic.id, topic.assistantId]
  )

  /** 按消息 id 批量删除（多选入口）：归一锚点后一次交给内核；跨会话多选不支持。 */
  const deleteMessagesByIds = useCallback(
    async (messageIds: string[]): Promise<boolean> => {
      const state = store.getState()
      const bySession = new Map<string, Set<number>>()
      for (const messageId of messageIds) {
        const message = state.messages.entities[messageId] as Message | undefined
        if (message === undefined) continue
        const anchor = anchorOfMessage(state, message, topic.id)
        if (anchor === undefined) {
          logger.warn('[deleteMessages] no kernel anchor for ' + messageId)
          continue
        }
        const seqs = bySession.get(anchor.sessionId)
        if (seqs !== undefined) seqs.add(anchor.seq)
        else bySession.set(anchor.sessionId, new Set([anchor.seq]))
      }
      if (bySession.size === 0) {
        logger.warn('[deleteMessages] no resolvable anchors')
        return false
      }
      if (bySession.size > 1) {
        logger.warn('[deleteMessages] multi-select across sessions is not supported')
        return false
      }
      const entry = [...bySession.entries()][0]
      try {
        const result = await destroyTurnsInKernel(entry[0], [...entry[1]])
        await applyDestroyTurnsResult(result)
        return true
      } catch (error) {
        logger.error('[deleteMessages] destroyTurns failed', error instanceof Error ? error : new Error(String(error)))
        return false
      }
    },
    [applyDestroyTurnsResult, topic.id]
  )

  /** 删除一条消息所在轮：该轮起后缀物理删除，血统上分叉子树整支清盘（焦点见内核结果）。 */
  const deleteMessage = useCallback(
    async (id: string, _traceId?: string, _modelName?: string): Promise<boolean> => deleteMessagesByIds([id]),
    [deleteMessagesByIds]
  )

  /** 删除一组问答（组键即问题消息 id；语义同 deleteMessage —— 该轮起后缀删除）。 */
  const deleteGroupMessages = useCallback(
    async (askId: string): Promise<boolean> => deleteMessagesByIds([askId]),
    [deleteMessagesByIds]
  )

  const editMessage = useCallback(
    async (messageId: string, updates: Partial<Omit<Message, 'id' | 'topicId' | 'blocks'>>) => {
      if (!topic?.id) {
        logger.error('[editMessage] Topic prop is not valid.')
        return
      }
      const uiStates = ['multiModelMessageStyle', 'foldSelected'] as const satisfies (keyof Message)[]
      const extraUpdate = difference(objectKeys(updates), uiStates)
      const isUiUpdateOnly = extraUpdate.length === 0
      const messageUpdates: Partial<Message> & Pick<Message, 'id'> = {
        id: messageId,
        updatedAt: isUiUpdateOnly ? undefined : new Date().toISOString(),
        ...updates
      }

      // Call the thunk with topic.id and only message updates
      await dispatch(updateMessageAndBlocksThunk(topic.id, messageUpdates, []))
    },
    [dispatch, topic.id]
  )

  /**
   * 重新发送用户消息，触发其所有助手回复的重新生成。 / Resends a user message, triggering regeneration of all its assistant responses.
   * Dispatches resendMessageThunk.
   */
  const resendMessage = useCallback(
    async (message: Message, assistant: Assistant) => {
      await restartTrace(message)
      const entity = store.getState().messages.entities[message.id] ?? message
      const text = getMainTextContent(entity)
      if (text.trim().length === 0) {
        logger.warn('[resendMessage] message has no text content, skip')
        return
      }
      const ok = await startBranchResend(entity, assistant, text)
      if (!ok) {
        // 锚点不可解析（例如刚发送、回执未到）时回退旧逻辑
        await dispatch(resendMessageThunk(topic.id, entity, assistant))
      }
    },
    [dispatch, startBranchResend, topic.id]
  )

  /**
   * 清空话题 = 物理删除该页全部可见轮（语义归一）：锚点取页内第一个可解析
   * 用户轮；跨血统的牵连（祖先截断/子树清盘/焦点）全部由 destroyTurns 单次事务给出。
   * 本地Thunk 版只清 Redux、内核不落盘，换页即复活，已废弃。
   */
  const clearTopicMessages = useCallback(
    async (_topicId?: string): Promise<boolean> => {
      const topicIdToClear = _topicId || topic.id
      const state = store.getState()
      const orderedIds = state.messages.messageIdsByTopic[topicIdToClear] ?? []
      for (const messageId of orderedIds) {
        const message = state.messages.entities[messageId] as Message | undefined
        if (message === undefined) continue
        const anchor = anchorOfMessage(state, message, topicIdToClear)
        if (anchor === undefined) continue
        try {
          const result = await destroyTurnsInKernel(anchor.sessionId, [anchor.seq])
          await applyDestroyTurnsResult(result)
          return true
        } catch (error) {
          logger.error(
            '[clearTopicMessages] destroyTurns failed for ' + topicIdToClear,
            error instanceof Error ? error : new Error(String(error))
          )
          return false
        }
      }
      logger.warn('[clearTopicMessages] no resolvable anchor in ' + topicIdToClear + ' (empty or pre-receipt)')
      return false
    },
    [applyDestroyTurnsResult, topic.id]
  )

  const displayCount = useAppSelector(selectNewDisplayCount)

  /**
   * 暂停当前主题正在进行的消息生成。
   *
   * 2026-10-01 重做为**单一路径**（旧的「登记表 + 键迁移 + 键失配兜底」三件套已删）：
   *
   * 1. **当帧落态**：`cancelActiveTurn` 标记本回合已取消，并把仍在流式的块与助手消息落成 PAUSED。
   *    此后到达的内核增量由投影层丢弃 —— 所以界面"按下去就停"，不再等内核到边界收尾。
   * 2. **通知内核一次**（fire-and-forget）：内核的 `agent.cancel` 是边界级的，它何时收尾只影响它自己；
   *    同一个 IPC 在主进程里还会中止我们自己的在途长活（文档处理/OCR 等，按话题登记）。
   *    失败只记日志 + 提示，**不改界面状态**——因为界面已经按用户意图停了。
   */
  const pauseMessages = useCallback(async () => {
    const stopped = cancelActiveTurn(topic.id)
    logger.warn(`[pause] topic=${topic.id} local-cancel=${stopped ? 'applied' : 'no-active-turn'}`)
    void window.api.dshTopicStop(topic.id).catch((error) => {
      logger.error('pauseMessages: failed to stop the kernel turn', error as Error)
      window.toast.error(t('chat.pause.failed'))
    })
    void pauseTrace(topic.id)
    dispatch(newMessagesActions.setTopicLoading({ topicId: topic.id, loading: false }))
  }, [topic.id, dispatch, t])

  /**
   * 恢复/重发用户消息（目前复用 resendMessage 逻辑）。 / Resumes/Resends a user message (currently reuses resendMessage logic).
   */
  const resumeMessage = useCallback(
    async (message: Message, assistant: Assistant) => {
      return resendMessage(message, assistant)
    },
    [resendMessage]
  )

  /**
   * 重新生成指定的助手消息回复。 / Regenerates a specific assistant message response.
   * Dispatches regenerateAssistantResponseThunk.
   */
  const regenerateAssistantMessage = useCallback(
    async (message: Message, assistant: Assistant) => {
      await restartTrace(message)
      if (message.role !== 'assistant') {
        logger.warn('regenerateAssistantMessage should only be called for assistant messages.')
        return
      }
      const state = store.getState()
      const anchor =
        (message.askId && state.messages.entities[message.askId]) ||
        (message.askId ? selectMessagesForTopic(state, topic.id).find((m) => m.id === message.askId) : undefined)
      if (anchor === undefined || anchor.role !== 'user') {
        await dispatch(regenerateAssistantResponseThunk(topic.id, message, assistant))
        return
      }
      const text = getMainTextContent(anchor)
      if (text.trim().length === 0) {
        logger.warn('[regenerateAssistantMessage] anchor has no text content, skip')
        return
      }
      const ok = await startBranchResend(anchor, assistant, text, 'regenerate')
      if (!ok) {
        await dispatch(regenerateAssistantResponseThunk(topic.id, message, assistant))
      }
    },
    [dispatch, startBranchResend, topic.id]
  )

  /**
   * 使用指定模型追加一个新的助手回复，回复与现有助手消息相同的用户查询。 / Appends a new assistant response using a specified model, replying to the same user query as an existing assistant message.
   * Dispatches appendAssistantResponseThunk.
   */
  const appendAssistantResponse = useCallback(
    async (existingAssistantMessage: Message, newModel: Model, assistant: Assistant) => {
      await appendMessageTrace(existingAssistantMessage, newModel)
      if (existingAssistantMessage.role !== 'assistant') {
        logger.error('appendAssistantResponse should only be called for an existing assistant message.')
        return
      }
      if (!existingAssistantMessage.askId) {
        logger.error('Cannot append response: The existing assistant message is missing its askId.')
        return
      }
      await dispatch(
        appendAssistantResponseThunk(
          topic.id,
          existingAssistantMessage.id,
          newModel,
          assistant,
          existingAssistantMessage.traceId
        )
      )
    },
    [dispatch, topic.id]
  )

  /**
   * 并行回答核心（v1 遗产"切换模型回答"的新形态）：
   * 把当前会话按锚点问题 fork 成一个隐藏 parallel 子话题（branchKind='parallel'，
   * 内核 seed 截至锚点轮之前），用所选模型在子会话里重新回答同一问题。
   * 主会话日志分毫不动；子会话回答经家族投影并进主视图卡片组（useParallelAnswers）；
   * 不切换视图、不进侧栏/分叉图/页码体系。同锚多模型 = 各自独立子会话（互不污染）。
   * 返回 false = 锚点不可解析/内核 fork 失败（轮未结束等），调用方保守放弃。
   */
  const startParallelAnswer = useCallback(
    async (anchorAssistantMessage: Message, newModel: Model, assistant: Assistant): Promise<boolean> => {
      if (anchorAssistantMessage.role !== 'assistant' || !anchorAssistantMessage.askId) {
        logger.warn('[startParallelAnswer] expects an anchored assistant message')
        return false
      }
      const state = store.getState()
      const anchor =
        state.messages.entities[anchorAssistantMessage.askId] ??
        selectMessagesForTopic(state, topic.id).find((m) => m.id === anchorAssistantMessage.askId)
      if (!anchor || anchor.role !== 'user' || anchor.topicId !== topic.id) {
        logger.warn('[startParallelAnswer] anchor question not in current topic, skip')
        return false
      }
      const text = getMainTextContent(anchor)
      // 旁答分支同修：重发消息继承锚点问题的图片/文档附件（识图通道真机回归）。
      const files = collectMessageFiles(store.getState(), anchor)
      if (text.trim().length === 0 && files.length === 0) {
        logger.warn('[startParallelAnswer] anchor question has no text or image content, skip')
        return false
      }
      // 工作模式激活（话题级开关，B6）时禁用旁答：旁答子会话共享前缀但拿不到本话题的工作模式状态，
      // 且工具回合的卡片组语义与多模型旁答冲突（计划书 Step 5）。
      if (topic.workMode === true) {
        logger.warn('[startParallelAnswer] work mode is active on this topic, parallel answer is disabled')
        return false
      }
      const forked = await forkBranchToKernel(topic.id, anchor)
      if (forked === null) return false

      const childTopic: Topic = {
        id: forked.id,
        type: TopicType.Chat,
        assistantId: assistant.id,
        name: forked.name ?? topic.name,
        createdAt: new Date(forked.createdAt ?? Date.now()).toISOString(),
        updatedAt: new Date(forked.updatedAt ?? Date.now()).toISOString(),
        messages: [],
        parentTopicId: topic.id,
        branchKind: 'parallel'
      }
      dispatch(addTopic({ assistantId: assistant.id, topic: childTopic }))

      const { message: userMessage, blocks } = getUserMessage({ content: text, files, assistant, topic: childTopic })

      // 直接发进子会话（不经 loadTopicMessagesThunk：避免把 currentTopicId 指到隐藏会话；
      // 种子历史无需入 store——卡片组只消费子会话自有轮的回答）。
      void dispatch(sendMessageThunk(userMessage, blocks ?? [], { ...assistant, model: newModel }, childTopic.id))
      return true
    },
    [dispatch, topic]
  )

  /**
   * "切换模型回答"按钮（MessageMenubar）的唯一入口：
   * 走隐藏 parallel 子会话；锚点不可解析/内核 fork 失败时保守放弃（不回退旧的
   * 同话题补答路径——那正是"并行回答污染上下文"的病灶）。@model 提及路径本轮不迁移。
   */
  const switchModelAnswer = useCallback(
    async (message: Message, newModel: Model, assistant: Assistant) => {
      if (message.role !== 'assistant') return
      if (message.topicId !== topic.id) {
        // 并行回答卡（属于隐藏 parallel 子会话）不允许再并行
        logger.warn('[switchModelAnswer] foreign-topic card, skip')
        return
      }
      await appendMessageTrace(message, newModel)
      const ok = await startParallelAnswer(message, newModel, assistant)
      if (!ok) {
        logger.warn('[switchModelAnswer] parallel fork unavailable (open turn or unresolved anchor), give up')
      }
    },
    [startParallelAnswer, topic.id]
  )

  /**
   * Updates message blocks by comparing original and edited blocks.
   * Handles adding, updating, and removing blocks in a single operation.
   * @param messageId The ID of the message to update
   * @param editedBlocks The complete set of blocks after editing
   */
  const editMessageBlocks = useCallback(
    async (messageId: string, editedBlocks: MessageBlock[]) => {
      if (!topic?.id) {
        logger.error('[editMessageBlocks] Topic prop is not valid.')
        return
      }

      try {
        // 1. Get the current state of the message and its blocks
        const state = store.getState()
        const message = state.messages.entities[messageId]
        if (!message) {
          logger.error(`[editMessageBlocks] Message not found: ${messageId}`)
          return
        }

        // 2. Get all original blocks
        const originalBlocks = message.blocks
          ? message.blocks
              .map((blockId) => state.messageBlocks.entities[blockId])
              .filter((block) => block !== undefined)
          : []

        // 3. Create sets for efficient comparison
        const originalBlockIds = new Set(originalBlocks.map((block) => block.id))
        const editedBlockIds = new Set(editedBlocks.map((block) => block.id))

        // 4. Identify blocks to remove, update, and add
        const blockIdsToRemove = originalBlocks
          .filter((block) => !editedBlockIds.has(block.id))
          .map((block) => block.id)

        const blocksToUpdate = editedBlocks
          .filter((block) => originalBlockIds.has(block.id))
          .map((block) => ({
            ...block,
            updatedAt: new Date().toISOString()
          }))

        const blocksToAdd = editedBlocks
          .filter((block) => !originalBlockIds.has(block.id))
          .map((block) => ({
            ...block,
            updatedAt: new Date().toISOString()
          }))

        // 5. Prepare message update with new block IDs
        const updatedBlockIds = editedBlocks.map((block) => block.id)
        const messageUpdates: Partial<Message> & Pick<Message, 'id'> = {
          id: messageId,
          updatedAt: new Date().toISOString(),
          blocks: updatedBlockIds
        }

        // 6. Update Redux state and database
        // First update message and add/update blocks
        if (blocksToAdd.length > 0) {
          await dispatch(updateMessageAndBlocksThunk(topic.id, messageUpdates, blocksToAdd))
        }

        if (blocksToUpdate.length > 0) {
          await dispatch(updateMessageAndBlocksThunk(topic.id, messageUpdates, blocksToUpdate))
        }

        // Then remove blocks if needed
        if (blockIdsToRemove.length > 0) {
          await dispatch(removeBlocksThunk(topic.id, messageId, blockIdsToRemove))
        }
      } catch (error) {
        logger.error('[editMessageBlocks] Failed to update message blocks:', error as Error)
      }
    },
    [dispatch, topic?.id]
  )

  /**
   * 在用户消息的主文本块被编辑后重新发送该消息。 / Resends a user message after its main text block has been edited.
   * Dispatches resendUserMessageWithEditThunk.
   */
  const resendUserMessageWithEdit = useCallback(
    async (message: Message, editedBlocks: MessageBlock[], assistant: Assistant) => {
      await editMessageBlocks(message.id, editedBlocks)

      const mainTextBlock = editedBlocks.find((block) => block.type === MessageBlockType.MAIN_TEXT)
      if (!mainTextBlock || mainTextBlock.content.trim().length === 0) {
        logger.warn('[resendUserMessageWithEdit] no main text content, skip')
        return
      }

      await restartTrace(message, mainTextBlock.content)

      const fileBlocks = editedBlocks.filter(
        (block) => block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE
      )

      const files = fileBlocks.map((block) => block.file).filter((file) => file !== undefined)

      const usage = await estimateUserPromptUsage({ content: mainTextBlock.content, files })
      const messageUpdates: Partial<Message> & Pick<Message, 'id'> = {
        id: message.id,
        updatedAt: new Date().toISOString(),
        usage
      }

      dispatch(newMessagesActions.updateMessage({ topicId: topic.id, messageId: message.id, updates: messageUpdates }))
      const ok = await startBranchResend(message, assistant, mainTextBlock.content)
      if (!ok) {
        // 锚点不可解析时回退旧逻辑（原地重置并重发）。回退是用户可见的降级：
        // 原地重发会丢弃分支切换，必须给出信号而不是静默吞掉。
        logger.warn('[resendUserMessageWithEdit] branch resend failed, falling back to in-place resend')
        window.toast.warning(t('message.edit.branch_fallback'))
        await dispatch(resendUserMessageWithEditThunk(topic.id, message, assistant))
      }
    },
    [dispatch, editMessageBlocks, startBranchResend, t, topic.id]
  )

  /**
   * Removes a specific block from a message.
   */
  const removeMessageBlock = useCallback(
    async (messageId: string, blockIdToRemove: string) => {
      if (!topic?.id) {
        logger.error('[removeMessageBlock] Topic prop is not valid.')
        return
      }

      const state = store.getState()
      const message = state.messages.entities[messageId]
      if (!message || !message.blocks) {
        logger.error(`[removeMessageBlock] Message not found or has no blocks: ${messageId}`)
        return
      }

      const updatedBlocks = message.blocks.filter((blockId) => blockId !== blockIdToRemove)

      const messageUpdates: Partial<Message> & Pick<Message, 'id'> = {
        id: messageId,
        updatedAt: new Date().toISOString(),
        blocks: updatedBlocks
      }

      await dispatch(updateMessageAndBlocksThunk(topic.id, messageUpdates, []))
    },
    [dispatch, topic?.id]
  )

  return {
    displayCount,
    deleteMessage,
    deleteGroupMessages,
    deleteMessagesByIds,
    editMessage,
    resendMessage,
    regenerateAssistantMessage,
    resendUserMessageWithEdit,
    appendAssistantResponse,
    switchModelAnswer,
    clearTopicMessages,
    pauseMessages,
    resumeMessage,
    editMessageBlocks,
    removeMessageBlock
  }
}

export const useTopicMessages = (topicId: string) => {
  return useAppSelector((state) => selectMessagesForTopic(state, topicId))
}

export const useTopicLoading = (topic: Topic) => {
  return useAppSelector((state) => selectNewTopicLoading(state, topic.id))
}

/**
 * 当前话题是否"正在生成"（存在 PENDING/PROCESSING 的助手消息）。
 * 内核聊天的事件驱动流在 queue 排空后仍持续很久，loadingByTopic 会在 send 后很快被清掉，
 * 不能作为"生成中"的唯一信号 —— 暂停/停止按钮的可见性应以此信号为准。
 */
export const useTopicGenerating = (topic: Topic) => {
  return useAppSelector((state) => {
    const messageIds = state.messages.messageIdsByTopic[topic.id]
    if (messageIds === undefined || messageIds.length === 0) return false
    return messageIds.some((id) => {
      const message = state.messages.entities[id]
      return (
        message !== undefined &&
        message.role === 'assistant' &&
        (message.status === AssistantMessageStatus.PENDING || message.status === AssistantMessageStatus.PROCESSING)
      )
    })
  })
}

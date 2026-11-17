import { loggerService } from '@logger'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { safeDeleteFiles } from '@renderer/services/MessagesService'
import store from '@renderer/store'
import { setNewlyRenamedTopics, setRenamingTopics } from '@renderer/store/runtime'
import { loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
import type { Assistant, FileMetadata, Topic } from '@renderer/types'
import type { FileMessageBlock, ImageMessageBlock, Message } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import {
  invalidateKernelRootTopics,
  isRestoredTopicRow,
  isRootTopic,
  kernelRootTopics,
  type KernelTopicRow,
  listRootTopics,
  recallLastViewedBranch
} from '@renderer/utils/topicBranch'
import { t as translate } from 'i18next'
import { find } from 'lodash-es'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAssistant } from './useAssistant'

let _activeTopic: Topic

const logger = loggerService.withContext('useTopic')

export function useActiveTopic(assistantId: string, topic?: Topic) {
  const { assistant } = useAssistant(assistantId)
  const { t } = useTranslation()
  const rootTopics = assistant ? listRootTopics(assistant.topics ?? []) : []
  // 初始落点也走家族浏览记忆：重载/重启后首次挂载时恢复上次浏览的分支（fallback effect
  // 只兜"activeTopic 不在本助手"的场景，初始落点命中 topics 时不触发，必须在这里 recall）。
  const [activeTopic, setActiveTopic] = useState(
    topic ||
      _activeTopic ||
      (rootTopics[0] !== undefined
        ? recallLastViewedBranch(rootTopics[0], assistant?.topics ?? [])
        : assistant?.topics?.[0])
  )

  _activeTopic = activeTopic

  useEffect(() => {
    if (activeTopic) {
      void store.dispatch(loadTopicMessagesThunk(activeTopic.id)).catch((error) => {
        // 加载失败已在 thunk 内记 error；此处只防未处理拒绝（消费方有各自错误态）。
        logger.warn(`useTopic: failed to load messages for topic ${activeTopic.id}`, error as Error)
      })
      void EventEmitter.emit(EVENT_NAMES.CHANGE_TOPIC, activeTopic)
    }
  }, [activeTopic])

  useEffect(() => {
    // activeTopic not in assistant.topics
    // 确保 assistant 和 assistant.topics 存在，避免在数据未完全加载时访问属性
    if (
      assistant &&
      assistant.topics &&
      Array.isArray(assistant.topics) &&
      assistant.topics.length > 0 &&
      !find(assistant.topics, { id: activeTopic?.id })
    ) {
      const roots = listRootTopics(assistant.topics)
      const fallback = roots[0] ?? assistant.topics[0]
      // 家族浏览记忆：兜底落点也恢复上次浏览的分支（无记忆/分支已删 → 落回根）
      setActiveTopic(fallback !== undefined ? recallLastViewedBranch(fallback, assistant.topics) : fallback)
    }
  }, [activeTopic?.id, assistant])

  // **对账不能只挂在侧栏上**。
  //
  // 真机实测（2026-09-15 02:28 那次运行）：侧栏没展开时 `Topics.tsx` 的对账 effect 不执行，于是
  // "剪除内核不认识的历史行 / 补齐内核有的行"两件事一件都没发生——日志里一条 `pruned`/`materialized`
  // 都没有，而"启动落点判定"照旧触发（它在聊天 hook 里），结果只能是"检测到了却无处可落"。
  // 因此在这里（只要开了聊天就一定会跑的地方）也做一次对账。
  useEffect(() => {
    if (assistantId === undefined || assistantId.length === 0) return
    // 动态 import：`kernelTopics` → `store/assistants` → `hooks/useTopic`，静态导入会成环
    void import('@renderer/services/kernelTopics').then(({ reconcileAssistantTopicRows }) =>
      reconcileAssistantTopicRows(assistantId)
    )
  }, [assistantId])

  // 启动落点必须经过一致性判定。
  //
  // "隐藏"曾被绕过的那条通道就在这里——初始落点直接取 `assistant.topics`，没有任何"内核认不认识"的
  // 判定，于是打开一个内核已遗忘的历史话题会走 `loadTopicMessagesThunk` → `topic not found` → 空历史。
  //
  // 判定只针对**根话题**且**来自上次会话的行**（`isRestoredTopicRow`）：本进程内新建的话题在首发前
  // 内核本来就不认识（不是失效）；fork 子行不在 `dshTopicList` 里（要查得用 `kernelKnowsTopic`，
  // 而分支落点由分支图负责，不在这里）。
  //
  // 依赖从整个 `assistant` 对象收窄到 `assistant?.topics`（本 effect 实际读到的唯一字段）。
  // `assistant` 是被 `updateAssistant`/`updateTopics` 等 action 重建的新对象引用，任何助手字段更新
  // （含流式期 `updateTopicUpdatedAt` 的 `updatedAt` bump）都会让这个 effect 重跑并进入上面的
  // `kernelRootTopics()`（重试窗口内的 IPC）对账。`topics` 引用只在话题行真的变化时才换新，
  // 所以收窄不改变判定与回落结果（`alive` 守卫 + 后续从 store 现读保持新鲜）。
  useEffect(() => {
    const currentId = activeTopic?.id
    const rows = assistant?.topics
    if (currentId === undefined || rows === undefined || rows.length === 0) return
    const row = rows.find((item) => item.id === currentId)
    if (row === undefined || !isRootTopic(row) || !isRestoredTopicRow(row.id)) return

    let alive = true
    const pickFallback = (candidates: Topic[], kernelRoots: ReadonlyMap<string, KernelTopicRow>): Topic | undefined =>
      listRootTopics(candidates).find((candidate) => kernelRoots.has(candidate.id))
    void (async () => {
      const kernelRoots = await kernelRootTopics()
      if (!alive || kernelRoots === null || kernelRoots.has(currentId)) return
      // 内核已不认识这一行：绝不显示空历史——回落到内核确认存在的行，并在**回落处**显式告知
      logger.warn(`useTopic: active topic "${currentId}" is gone from the kernel registry; falling back`)
      window.toast?.warning(t('chat.topics.gone'))
      let target = pickFallback(rows, kernelRoots)
      if (target === undefined) {
        // 渲染层里一行内核确认存在的都没有（真机实测过这个状态：旧行全被删、内核的行还没补齐）。
        // 先让对账把内核的行补进来，再从 store 现读一次——否则"检测到了却无处可落"。
        const { reconcileAssistantTopicRows } = await import('@renderer/services/kernelTopics')
        await reconcileAssistantTopicRows(assistantId)
        if (!alive) return
        const freshRows = store.getState().assistants.assistants.find((row) => row.id === assistantId)?.topics ?? []
        target = pickFallback(freshRows, kernelRoots)
        if (target !== undefined) {
          setActiveTopic(recallLastViewedBranch(target, freshRows))
          return
        }
        logger.error(`useTopic: no kernel-confirmed topic row is available to fall back to for "${currentId}"`)
        return
      }
      setActiveTopic(recallLastViewedBranch(target, rows))
    })()
    return () => {
      alive = false
    }
  }, [activeTopic?.id, assistant?.topics, assistantId, t, setActiveTopic])

  useEffect(() => {
    if (!assistant?.topics?.length || !activeTopic) {
      return
    }

    const latestTopic = assistant.topics.find((item) => item.id === activeTopic.id)
    if (latestTopic && latestTopic !== activeTopic) {
      setActiveTopic(latestTopic)
    }
  }, [assistant?.topics, activeTopic])

  return { activeTopic, setActiveTopic }
}

export function useTopic(assistant: Assistant, topicId?: string) {
  return assistant?.topics.find((topic) => topic.id === topicId)
}

export function getTopic(assistant: Assistant, topicId: string) {
  return assistant?.topics.find((topic) => topic.id === topicId)
}

export async function getTopicById(topicId: string) {
  const assistants = store.getState().assistants.assistants
  const topics = assistants.map((assistant) => assistant.topics).flat()
  const topic = topics.find((topic) => topic.id === topicId)
  const messages = await TopicManager.getTopicMessages(topicId)
  return { ...topic, messages } as Topic
}

/**
 * 开始重命名指定话题
 */
export const startTopicRenaming = (topicId: string) => {
  const currentIds = store.getState().runtime.chat.renamingTopics
  if (!currentIds.includes(topicId)) {
    store.dispatch(setRenamingTopics([...currentIds, topicId]))
  }
}

/**
 * 完成重命名指定话题
 */
export const finishTopicRenaming = (topicId: string) => {
  const state = store.getState()

  // 1. 立即从 renamingTopics 移除
  const currentRenaming = state.runtime.chat.renamingTopics
  store.dispatch(setRenamingTopics(currentRenaming.filter((id) => id !== topicId)))

  // 2. 立即添加到 newlyRenamedTopics
  const currentNewlyRenamed = state.runtime.chat.newlyRenamedTopics
  store.dispatch(setNewlyRenamedTopics([...currentNewlyRenamed, topicId]))

  // 3. 延迟从 newlyRenamedTopics 移除
  setTimeout(() => {
    const current = store.getState().runtime.chat.newlyRenamedTopics
    store.dispatch(setNewlyRenamedTopics(current.filter((id) => id !== topicId)))
  }, 700)
}

// Convert class to object with functions since class only has static methods
// 只有静态方法,没必要用class，可以export {}
export const TopicManager = {
  async getTopic(id: string) {
    const state = store.getState()
    for (const assistant of state.assistants.assistants) {
      const topic = assistant.topics.find((topic) => topic.id === id)
      if (topic) return topic
    }
    return undefined
  },

  async getAllTopics() {
    const state = store.getState()
    return state.assistants.assistants.flatMap((assistant) => assistant.topics)
  },

  /**
   * 加载并返回指定话题的消息（dsh 内核替换：从内核会话加载进 Redux 后读取）
   */
  async getTopicMessages(id: string) {
    try {
      await store.dispatch(loadTopicMessagesThunk(id))
    } catch (error) {
      logger.warn(`useTopic: failed to load messages for topic ${id}`, error as Error)
    }
    const state = store.getState()
    return (state.messages.messageIdsByTopic[id] ?? [])
      .map((messageId) => state.messages.entities[messageId])
      .filter((message): message is Message => message !== undefined)
  },

  /**
   * 删除话题：清本地关联文件 → 让内核删注册表行并物理清会话。
   *
   * **返回值是真的删除结果**：内核删除会在 IPC 边界失败（内核尚未就绪时
   * `requireKernel()` 抛 `kernel not booted`；boot 窗口内 handler 还没注册），旧写法用
   * `void … .catch(warn)` 把它吞掉——渲染层行照删、内核留着，于是沉淀出"删不掉又看得见"的幽灵话题
   * （真机 2026-09-15 实证）。调用方必须据此决定是否把行放回去。
   * @param id - 话题（= 会话）id。
   * @returns `true` = 内核已确认删除；`false` = 内核侧失败（调用方应保留/恢复该行）。
   */
  async removeTopic(id: string): Promise<boolean> {
    await TopicManager.clearTopicMessages(id)
    try {
      const result = (await window.api.dshTopicDelete(id)) as { ok?: boolean; purged?: boolean } | undefined
      // 成员集合变了：下一次查询重新问内核（否则对账会把刚删的行又当成"内核还在"）
      invalidateKernelRootTopics()
      // 注册表删了但磁盘会话没清掉 = 只成功一半。内核侧已把 purge 失败做成 `purged:false`
      // 显式信号（不可知状态不得静默），这里必须让用户看见。
      if (result?.purged === false) {
        // 该函数在 TopicManager 对象里（非组件），拿不到 hook 的 t → 用 i18next 全局 t。
        window.toast?.warning(translate('kernel.topicDelete.purgeFailed'))
      }
      return true
    } catch (error) {
      logger.error(`TopicManager: failed to delete kernel session for topic ${id}`, error as Error)
      return false
    }
  },

  async clearTopicMessages(id: string): Promise<void> {
    // 从 Redux 收集并删除关联文件（Dexie 已废弃，块数据由内核事件驱动）
    const state = store.getState()
    const blockIds = (state.messages.messageIdsByTopic[id] ?? []).flatMap(
      (messageId) => state.messages.entities[messageId]?.blocks ?? []
    )
    const filesToDelete = blockIds
      .map((blockId) => state.messageBlocks.entities[blockId])
      .filter(
        (block): block is FileMessageBlock | ImageMessageBlock =>
          block !== undefined &&
          (block.type === MessageBlockType.IMAGE || block.type === MessageBlockType.FILE) &&
          block.file !== undefined
      )
      .map((block) => block.file)
      .filter((file): file is FileMetadata => file !== undefined)

    if (filesToDelete.length > 0) {
      await safeDeleteFiles(filesToDelete)
    }
  }
}

import { loggerService } from '@logger'
import SearchPopup from '@renderer/components/Popups/SearchPopup'
import { getTopicById } from '@renderer/hooks/useTopic'
import i18n from '@renderer/i18n'
import { fetchMessagesSummary } from '@renderer/services/ApiService'
import store from '@renderer/store'
import { removeManyBlocks } from '@renderer/store/messageBlock'
import { selectMessagesForTopic } from '@renderer/store/newMessage'
import type { Assistant, FileMetadata, Model, Topic, Usage } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockStatus } from '@renderer/types/newMessage'
import { uuid } from '@renderer/utils'
import { getTitleFromString } from '@renderer/utils/export'
import {
  createAssistantMessage,
  createFileBlock,
  createImageBlock,
  createMainTextBlock,
  createMessage,
  resetMessage
} from '@renderer/utils/messageUtils/create'
import { getMainTextContent } from '@renderer/utils/messageUtils/find'
import dayjs from 'dayjs'
import { t } from 'i18next'
import type { NavigateFunction } from 'react-router'

import { getAssistantById, getAssistantProvider, getDefaultModel } from './AssistantService'
import { EVENT_NAMES, EventEmitter } from './EventService'
import FileManager from './FileManager'

const logger = loggerService.withContext('MessagesService')

export {
  filterAfterContextClearMessages,
  filterEmptyMessages,
  filterErrorOnlyMessagesWithRelated,
  filterMessages,
  filterUsefulMessages,
  filterUserRoleStartMessages,
  getGroupedMessages
} from '@renderer/utils/messageUtils/filters'

// 删除列表中的文件
export async function safeDeleteFiles(filesToDelete: FileMetadata[]): Promise<void> {
  if (!filesToDelete || filesToDelete.length === 0) return

  try {
    await FileManager.deleteFiles(filesToDelete)
  } catch (error) {
    logger.error('Failed to delete files, may produce orphan files:', error as Error)
  }
}

/**
 * "生成中"闸门。
 *
 * 旧实现在生成中 `reject(false)`——拒绝值不是 `Error`，两个调用点又都是 UI 事件直呼
 * 且不接错误，于是每次点击都产生一条 `Uncaught (in promise) false`，日志里也看不出这是
 * 有意的拦截。改为 `Promise<boolean>`：`true` = 可以继续，`false` = 正在生成（已弹提示）。
 * 调用方必须读返回值并据此提前返回；`await` 不再会抛出。
 */
export async function isGenerating(): Promise<boolean> {
  const generating = store.getState().runtime.generating
  if (generating) {
    window.toast.warning(i18n.t('message.switch.disabled'))
    return false
  }
  return true
}

export async function locateToMessage(navigate: NavigateFunction, message: Message) {
  if (!(await isGenerating())) return

  SearchPopup.hide()
  const assistant = getAssistantById(message.assistantId)
  const topic = await getTopicById(message.topicId)

  navigate('/', { state: { assistant, topic } })

  setTimeout(() => EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR), 0)
  setTimeout(() => EventEmitter.emit(EVENT_NAMES.LOCATE_MESSAGE + ':' + message.id), 300)
}

/**
 * Creates a user message object and associated blocks based on input.
 * This is a pure function and does not dispatch to the store.
 *
 * @param params - The parameters for creating the message.
 * @returns An object containing the created message and its blocks.
 */
export function getUserMessage({
  assistant,
  topic,
  type,
  content,
  files,
  // Keep other potential params if needed by createMessage
  mentions,
  usage
}: {
  assistant: Assistant
  topic: Topic
  type?: Message['type']
  content?: string
  files?: FileMetadata[]
  knowledgeBaseIds?: string[]
  mentions?: Model[]
  usage?: Usage
}): { message: Message; blocks: MessageBlock[] } {
  const defaultModel = getDefaultModel()
  const model = assistant.model || defaultModel
  const messageId = uuid() // Generate ID here
  const blocks: MessageBlock[] = []
  const blockIds: string[] = []

  // 内容为空也应该创建空文本块
  if (content !== undefined) {
    // Pass messageId when creating blocks
    const textBlock = createMainTextBlock(messageId, content, {
      status: MessageBlockStatus.SUCCESS
    })
    blocks.push(textBlock)
    blockIds.push(textBlock.id)
  }
  if (files?.length) {
    files.forEach((file) => {
      if (file.type === FILE_TYPE.IMAGE) {
        const imgBlock = createImageBlock(messageId, { file, status: MessageBlockStatus.SUCCESS })
        blocks.push(imgBlock)
        blockIds.push(imgBlock.id)
      } else {
        const fileBlock = createFileBlock(messageId, file, { status: MessageBlockStatus.SUCCESS })
        blocks.push(fileBlock)
        blockIds.push(fileBlock.id)
      }
    })
  }

  // 直接在createMessage中传入id
  const message = createMessage(
    'user',
    topic.id, // topic.id已经是string类型
    assistant.id,
    {
      id: messageId, // 直接传入ID，避免冲突
      modelId: model?.id,
      model: model,
      blocks: blockIds,
      // 移除knowledgeBaseIds
      mentions,
      // 移除mcp
      type,
      usage
    }
  )

  // 不再需要手动合并ID
  return { message, blocks }
}

export function getAssistantMessage({ assistant, topic }: { assistant: Assistant; topic: Topic }): Message {
  const defaultModel = getDefaultModel()
  const model = assistant.model || defaultModel

  return createAssistantMessage(assistant.id, topic.id, {
    modelId: model?.id,
    model: model
  })
}

export function getMessageModelId(message: Message) {
  return message?.model?.id || message.modelId
}

export function resetAssistantMessage(message: Message, model?: Model): Message {
  const blockIdsToRemove = message.blocks
  if (blockIdsToRemove.length > 0) {
    store.dispatch(removeManyBlocks(blockIdsToRemove))
  }

  return {
    ...message,
    model: model || message.model,
    modelId: model?.id || message.modelId,
    status: AssistantMessageStatus.PENDING,
    useful: undefined,
    askId: undefined,
    mentions: undefined,
    blocks: [],
    createdAt: new Date().toISOString()
  }
}

export async function getMessageTitle(message: Message, length = 30): Promise<string> {
  const content = getMainTextContent(message)

  if ((store.getState().settings as any).useTopicNamingForMessageTitle) {
    try {
      const tempMessage = resetMessage(message, {
        status: AssistantMessageStatus.SUCCESS,
        blocks: message.blocks
      })

      const titlePromise = fetchMessagesSummary({ messages: [tempMessage] })
      // oxlint 的 no-floating-promises 看不到「promise 被交给 antd toast.loading」这一消费方式；
      // 显式 `void` 表明是有意不 await（该 promise 由 toast 与下一行 await 共同消费）。
      void window.toast.loading({ title: t('chat.topics.export.wait_for_title_naming'), promise: titlePromise })
      const { text: title } = await titlePromise

      // store.dispatch(messageBlocksActions.upsertOneBlock(tempTextBlock))

      // store.dispatch(messageBlocksActions.removeOneBlock(tempTextBlock.id))
      if (title) {
        window.toast.success(t('chat.topics.export.title_naming_success'))
        return title
      }
    } catch (e) {
      window.toast.error(t('chat.topics.export.title_naming_failed'))
      logger.error('Failed to generate title using topic naming, downgraded to default logic', e as Error)
    }
  }

  let title = getTitleFromString(content, length)

  if (!title) {
    title = dayjs(message.createdAt).format('YYYYMMDDHHmm')
  }

  return title
}

export function checkRateLimit(assistant: Assistant, topicId: string): boolean {
  const provider = getAssistantProvider(assistant)

  // 助手模型与默认模型都指不到现存 provider 时，无法确定限流值。
  // 限流是**提示性**检查：拿不到 provider 就放行，不谎报限流，也不假装成功——
  // 真正的发送会因 provider 缺失以可见错误失败。
  if (!provider) {
    logger.warn('checkRateLimit: no provider resolved, rate limit cannot be enforced', { assistantId: assistant.id })
    return false
  }

  if (!provider.rateLimit) {
    return false
  }

  // 限流判据按**调用方所在话题**取末条消息时间。此前固定用 topics[0]——用户在第二个
  // 及以后的话题里发消息时，检查的是另一个话题的节奏，限流既漏报也误报。
  const messages = selectMessagesForTopic(store.getState(), topicId)

  if (!messages || messages.length <= 1) {
    return false
  }

  const now = Date.now()
  const lastMessage = messages[messages.length - 1]
  const lastMessageTime = new Date(lastMessage.createdAt).getTime()
  const timeDiff = now - lastMessageTime
  const rateLimitMs = provider.rateLimit * 1000

  if (timeDiff < rateLimitMs) {
    const waitTimeSeconds = Math.ceil((rateLimitMs - timeDiff) / 1000)

    window.toast.warning(t('message.warning.rate.limit', { seconds: waitTimeSeconds }))
    return true
  }

  return false
}

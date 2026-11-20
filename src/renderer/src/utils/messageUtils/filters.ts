import store from '@renderer/store'
import { messageBlocksSelectors } from '@renderer/store/messageBlock'
import type { Message } from '@renderer/types/newMessage' // Assuming correct Message type import
import { MessageBlockType } from '@renderer/types/newMessage'
// May need Block types if refactoring to use them
// import type { MessageBlock, MainTextMessageBlock } from '@renderer/types/newMessageTypes';
import { remove } from 'lodash-es'
import { isEmpty } from 'lodash-es'

import { findBlocksByType } from './find'

// Assuming getGroupedMessages is also moved here or imported
// import { getGroupedMessages } from './path/to/getGroupedMessages';

// const logger = loggerService.withContext('Utils.filter')

/**
 * Filters out messages of type '@' or 'clear' and messages without main text content.
 */
export const filterMessages = (messages: Message[]) => {
  return messages
    .filter((message) => !['@', 'clear'].includes(message.type!))
    .filter((message) => {
      // 复用 find.ts 的同一次分桶遍历，不再单独扫一遍块表。
      const mainTextBlocks = findBlocksByType(message).get(MessageBlockType.MAIN_TEXT)
      return !isEmpty((mainTextBlocks?.[0] as any)?.content?.trim()) // Type assertion needed
    })
}

/**
 * Filters messages to include only those after the last 'clear' type message.
 */
export function filterAfterContextClearMessages(messages: Message[]): Message[] {
  const clearIndex = messages.findLastIndex((message) => message.type === 'clear')

  if (clearIndex === -1) {
    return messages
  }

  return messages.slice(clearIndex + 1)
}

/**
 * Filters messages to start from the first message with role 'user'.
 */
export function filterUserRoleStartMessages(messages: Message[]): Message[] {
  const firstUserMessageIndex = messages.findIndex((message) => message.role === 'user')

  if (firstUserMessageIndex === -1) {
    // Return empty array if no user message found, or original? Original returned messages.
    return messages
  }

  return messages.slice(firstUserMessageIndex)
}

/**
 * 判定消息是否含「有内容」的块：主文本非空，或存在图片/文件/代码/工具/引用块。
 * 复用 find.ts 的单次分桶遍历，供 filterEmptyMessages 与其它调用方共用。
 */
export const messageHasContent = (message: Message): boolean => {
  const buckets = findBlocksByType(message)
  const mainText = buckets.get(MessageBlockType.MAIN_TEXT)?.[0]
  if (mainText && !isEmpty((mainText as any).content?.trim())) {
    return true
  }
  return [
    MessageBlockType.IMAGE,
    MessageBlockType.FILE,
    MessageBlockType.CODE,
    MessageBlockType.TOOL,
    MessageBlockType.CITATION
  ].some((type) => (buckets.get(type)?.length ?? 0) > 0)
}

/**
 * Filters out messages considered "empty" based on block content.
 */
export function filterEmptyMessages(messages: Message[]): Message[] {
  return messages.filter((message) => messageHasContent(message))
}

/**
 * Groups messages by user message ID or assistant askId.
 */
export function getGroupedMessages(messages: Message[]): { [key: string]: (Message & { index: number })[] } {
  const groups: { [key: string]: (Message & { index: number })[] } = {}
  messages.forEach((message, index) => {
    // Use askId if available (should be on assistant messages), otherwise group user messages individually
    const key = message.role === 'assistant' && message.askId ? 'assistant' + message.askId : message.role + message.id
    if (key && !groups[key]) {
      groups[key] = []
    }
    groups[key].push({ ...message, index }) // Add message with its original index
  })
  return groups
}

/**
 * Filters messages based on the 'useful' flag and message role sequences.
 * Only remain one message in a group. Either useful or fallback to the first message in the group.
 */
export function filterUsefulMessages(messages: Message[]): Message[] {
  const _messages = [...messages]
  const groupedMessages = getGroupedMessages(messages)

  Object.entries(groupedMessages).forEach(([key, groupedMsgs]) => {
    if (key.startsWith('assistant')) {
      const usefulMessage = groupedMsgs.find((m) => m.useful === true)
      if (usefulMessage) {
        // Remove all messages in the group except the useful one
        groupedMsgs.forEach((m) => {
          if (m.id !== usefulMessage.id) {
            remove(_messages, (o) => o.id === m.id)
          }
        })
      } else if (groupedMsgs.length > 0) {
        // Keep only the first message if none are marked useful
        const messagesToRemove = groupedMsgs.slice(1)
        messagesToRemove.forEach((m) => {
          remove(_messages, (o) => o.id === m.id)
        })
      }
    }
  })

  return _messages
}

export function filterLastAssistantMessage(messages: Message[]): Message[] {
  const _messages = [...messages]
  // Remove trailing assistant messages
  while (_messages.length > 0 && _messages[_messages.length - 1].role === 'assistant') {
    _messages.pop()
  }
  return _messages
}

export function filterAdjacentUserMessaegs(messages: Message[]): Message[] {
  // Filter adjacent user messages, keeping only the last one
  return messages.filter((message, index, origin) => {
    return !(message.role === 'user' && index + 1 < origin.length && origin[index + 1].role === 'user')
  })
}

/**
 * Filters out assistant messages that only contain ErrorBlocks and their associated user messages.
 * An assistant message is associated with a user message via the askId field.
 */
export function filterErrorOnlyMessagesWithRelated(messages: Message[]): Message[] {
  const state = store.getState()

  // Find all assistant messages that only contain ErrorBlocks
  const errorOnlyAskIds = new Set<string>()

  for (const message of messages) {
    if (message.role !== 'assistant' || !message.askId) {
      continue
    }

    // Check if this assistant message only contains ErrorBlocks
    let hasNonErrorBlock = false
    for (const blockId of message.blocks) {
      const block = messageBlocksSelectors.selectById(state, blockId)
      if (!block) continue

      if (block.type !== MessageBlockType.ERROR) {
        hasNonErrorBlock = true
        break
      }
    }

    // If only ErrorBlocks (or no blocks), mark this askId for removal
    if (!hasNonErrorBlock && message.blocks.length > 0) {
      errorOnlyAskIds.add(message.askId)
    }
  }

  // Filter out both the assistant messages and their associated user messages
  return messages.filter((message) => {
    // Remove assistant messages that only have ErrorBlocks
    if (message.role === 'assistant' && message.askId && errorOnlyAskIds.has(message.askId)) {
      return false
    }

    // Remove user messages that are associated with error-only assistant messages
    if (message.role === 'user' && errorOnlyAskIds.has(message.id)) {
      return false
    }

    return true
  })
}

// Note: getGroupedMessages might also need to be moved or imported.
// It depends on message.askId which should still exist on the Message type.
// export function getGroupedMessages(messages: Message[]): { [key: string]: (Message & { index: number })[] } {
//   const groups: { [key: string]: (Message & { index: number })[] } = {}
//   messages.forEach((message, index) => {
//     const key = message.askId ? 'assistant' + message.askId : 'user' + message.id
//     if (key && !groups[key]) {
//       groups[key] = []
//     }
//     groups[key].unshift({ ...message, index }) // Keep unshift if order matters for useful filter
//   })
//   return groups
// }

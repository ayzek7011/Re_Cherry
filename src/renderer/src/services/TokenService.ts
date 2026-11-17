import type { Assistant, FileMetadata, Usage } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { findFileBlocks, getMainTextContent, getThinkingContent } from '@renderer/utils/messageUtils/find'
import { takeRight } from 'lodash-es'
import { approximateTokenSize } from 'tokenx'

import { getAssistantSettings } from './AssistantService'
import { filterAfterContextClearMessages, filterMessages } from './MessagesService'

interface MessageItem {
  name?: string
  role: 'system' | 'user' | 'assistant'
  content: string
}

async function getFileContent(file: FileMetadata) {
  if (!file) {
    return ''
  }

  if (file.type === FILE_TYPE.TEXT) {
    return await window.api.file.read(file.id + file.ext, true)
  }

  return ''
}

async function getMessageParam(message: Message): Promise<MessageItem[]> {
  const param: MessageItem[] = []

  const content = getMainTextContent(message)
  const files = findFileBlocks(message)

  param.push({
    role: message.role,
    content
  })

  if (files.length > 0) {
    for (const file of files) {
      param.push({
        role: 'assistant',
        content: await getFileContent(file.file)
      })
    }
  }

  return param
}

/**
 * 估算文本内容的 token 数量
 *
 * @param text - 需要估算的文本内容
 * @returns 返回估算的 token 数量
 */
export function estimateTextTokens(text: string) {
  return approximateTokenSize(text)
}

/**
 * 估算图片文件的 token 数量
 *
 * 根据图片文件大小计算预估的 token 数量。
 * 当前使用简单的文件大小除以 100 的方式进行估算。
 *
 * @param file - 图片文件对象
 * @returns 返回估算的 token 数量
 */
export function estimateImageTokens(file: FileMetadata) {
  return Math.floor(file.size / 100)
}

/**
 * 汇总文件列表里所有图片的 token 估算（`estimateUserPromptUsage` 与
 * `estimateMessageUsage` 里逐字重复的两段循环合并到这里）。
 */
function sumImageTokens(files: FileMetadata[]): number {
  let imageTokens = 0
  for (const file of files) {
    if (file.type !== FILE_TYPE.IMAGE) continue
    imageTokens += estimateImageTokens(file)
  }
  return imageTokens
}

/**
 * 用量字段的唯一口径。
 *
 * 用户输入只有"输入"没有"输出"：`completion_tokens` 恒为 0。此前两处估算都把它设成
 * `prompt_tokens`，于是 `MessageTokens` 对 user 消息展示的 `total_tokens` 恰好是输入的
 * **两倍**；`imageTokens - 7` 在图片小于约 700 字节时还会让 total 小于 prompt、极端为负。
 * 这里统一 `total_tokens = prompt_tokens + 图片估算`，并用 `Math.max(0, …)` 兜底非负。
 */
function buildEstimatedUsage(tokens: number, imageTokens: number): Usage {
  return {
    prompt_tokens: tokens,
    completion_tokens: 0,
    total_tokens: Math.max(0, tokens + imageTokens)
  }
}

/**
 * 估算用户输入内容（文本和文件）的 token 用量。
 *
 * 该函数只根据传入的 content（文本内容）和 files（文件列表）估算，
 * 不依赖完整的 Message 结构，也不会处理消息块、上下文等信息。
 *
 * @param {Object} params - 输入参数对象
 * @param {string} [params.content] - 用户输入的文本内容
 * @param {FileMetadata[]} [params.files] - 用户上传的文件列表（支持图片和文本）
 * @returns {Promise<Usage>} 返回一个 Usage 对象，包含 prompt_tokens、completion_tokens、total_tokens
 */
export async function estimateUserPromptUsage({
  content,
  files
}: {
  content?: string
  files?: FileMetadata[]
}): Promise<Usage> {
  const imageTokens = sumImageTokens(files ?? [])
  const tokens = estimateTextTokens(content || '')

  return buildEstimatedUsage(tokens, imageTokens)
}

/**
 * 估算完整消息（Message）的 token 用量。
 *
 * 该函数会自动从 message 中提取主文本内容、推理内容（reasoningContent）和所有文件块，
 * 统计文本和图片的 token 数量，适用于对完整消息对象进行 usage 估算。
 *
 * @param {Partial<Message>} message - 消息对象，可以是完整或部分 Message
 * @returns {Promise<Usage>} 返回一个 Usage 对象，包含 prompt_tokens、completion_tokens、total_tokens
 */
export async function estimateMessageUsage(message: Partial<Message>): Promise<Usage> {
  const fileBlocks = findFileBlocks(message as Message)
  const files = fileBlocks.map((f) => f.file)

  const imageTokens = sumImageTokens(files)

  const content = getMainTextContent(message as Message)
  const reasoningContent = getThinkingContent(message as Message)
  const combinedContent = [content, reasoningContent].filter((s) => s !== undefined).join(' ')
  const tokens = estimateTextTokens(combinedContent)

  return buildEstimatedUsage(tokens, imageTokens)
}

export async function estimateMessagesUsage({
  assistant,
  messages
}: {
  assistant: Assistant
  messages: Message[]
}): Promise<Usage> {
  const outputMessage = messages.pop()!

  const prompt_tokens = await estimateHistoryTokens(assistant, messages)
  // `estimateMessageUsage` 的 `completion_tokens` 口径改为 0（估算值只表达输入），
  // 回复的输出量按同一套本地估算单独算出来，否则这条兜底 usage 会退化成 0 输出。
  const completion_tokens = estimateTextTokens(getMainTextContent(outputMessage))

  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens
  } as Usage
}

/**
 * 历史上下文占用估算（`Messages.tsx` → `ESTIMATED_TOKEN_COUNT`，输入框的上下文百分比）。
 *
 * 旧实现把窗口内**每条**带 usage 消息的 `total_tokens` 直接相加。那是"该条消息
 * 发出时那一刻的累积量"，本身已包含被 `takeRight(maxContextCount)` 截掉的早期消息——
 * 逐条累加等于把历史长度重复计入，上报值会显著高于真实占用。
 *
 * 现口径（确定性、不依赖窗口外的数据）：
 *   ① 基线 = 窗口内**第一条**带 usage 消息的 `prompt_tokens`（它是一次真实测量，覆盖到它为止的上下文）；
 *   ② 该条之后的每条消息，按本地 `estimateMessageParams` 估算增量后相加（含 usage 的也照算，
 * 因为 `completion_tokens` 已按 归零，它的 `prompt_tokens` 只代表走到它的那段，
 *      再计入就会重复）；
 *   ③ 窗口内没有一条带 usage 消息时退化为纯本地估算（与旧实现同构：prompt + 全部消息文本）。
 */
export async function estimateHistoryTokens(assistant: Assistant, msgs: Message[]) {
  const { contextCount } = getAssistantSettings(assistant)
  const maxContextCount = contextCount
  const messages = filterMessages(filterAfterContextClearMessages(takeRight(msgs, maxContextCount)))

  // 每条消息压成一段文本（`MessageItem[]` → 按 `\n` 连接），读不出来的记 `null` 表示"无从估算"。
  const bodies = await Promise.all(messages.map((message) => estimateMessageBody(message)))

  // 基线：窗口内第一条既带 usage 又有正文的消息。它的 `prompt_tokens` 是一次真实测量，
  // 且该测量**已经包含** assistant.prompt —— 所以基线路径不再把 prompt 单独计一次。
  const baselineIndex = messages.findIndex((message, index) => bodies[index] !== null && message.usage !== undefined)
  const baselineTokens = baselineIndex === -1 ? 0 : (messages[baselineIndex].usage?.prompt_tokens ?? 0)

  // 整窗无测量：退化为纯本地估算 = assistant.prompt + 全部消息文本（与旧实现同构）。
  if (baselineIndex === -1) {
    return estimateTextTokens(assistant.prompt + '\n' + joinBodies(bodies, 0))
  }

  // 基线之后的增量：测到的部分不再重复计入（的核心修复）。
  return baselineTokens + estimateTextTokens(joinBodies(bodies, baselineIndex + 1))
}

/** 把窗口中从 `start` 起的消息正文按 `\n` 拼接（空/不可读消息保留空段，与旧实现同构）。 */
function joinBodies(bodies: (string | null)[], start: number): string {
  return bodies
    .slice(start)
    .map((text) => text ?? '')
    .join('\n')
}

/** 消息 → 一段文本；读文件失败按"无从估算"返回 `null`。 */
async function estimateMessageBody(message: Message): Promise<string | null> {
  try {
    const items = await getMessageParam(message)
    return items.map((item) => item.content).join('\n')
  } catch {
    return null
  }
}

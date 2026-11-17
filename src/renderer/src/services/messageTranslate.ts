/**
 * 消息级原地翻译（V1 MessageTranslate/TranslationBlock 移植，fork 缝实装）。
 *
 * 渲染层旁路功能：译文作为附加块投影到消息下方，**不进内核会话日志**（不变量2——
 * 会话日志仍是唯一真相源，译文只是本地增强；同 V1 形态：上游存 Dexie message_blocks，
 * fork 的对应等价物是 Dexie message_translations（messageId 主键，v17））。纯渲染层
 * 重投影后块会丢，由 MessageContent 的水合钩子从该表复原（hooks/useMessageTranslate）。
 *
 * 通路：lightLlm 流式（与翻译页同一条轻通路，source 同 'cherry-translate'，禁自开旁路），
 * 模型复用翻译页已选的 state.llm.translateModel；提示词复用 utils/translate 的
 * TRANSLATE_PROMPT + buildTranslatePrompt（同翻译页，单一提示词来源）。
 *
 * 重复点击语义（上游 getTranslationUpdater）：已存在翻译块 → 原地重置（清空 + STREAMING
 * + 新目标语言）再译，不新建块；每条消息至多一个译文块。停止 = lightStreamAbort，
 * 已生成部分保留（上游 abort 语义）。
 */
import type { TranslateLangCode, TranslateLanguage } from '@renderer/config/translateLanguages'
import { langCodeToI18nKey } from '@renderer/config/translateLanguages'
import { db } from '@renderer/databases'
import i18n from '@renderer/i18n'
import { lightStream, lightStreamAbort } from '@renderer/services/lightLlm'
import { loggerService } from '@renderer/services/LoggerService'
import store, { type RootState } from '@renderer/store'
import { updateOneBlock, upsertOneBlock } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import { removeBlocksThunk } from '@renderer/store/thunk/messageThunk'
import type { Message } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import type { MessageTranslationRecord } from '@renderer/types/translate'
import { createTranslationBlock } from '@renderer/utils/messageUtils/create'
import { buildTranslatePrompt, TRANSLATE_PROMPT } from '@renderer/utils/translate'
// DebouncedFuncLeading 只有 @types/lodash 提供（@types/lodash-es 未转发该类型）；
// type-only import 编译期擦除，不产生运行时双实例。
import type { DebouncedFuncLeading } from 'lodash'
import { throttle } from 'lodash-es'

const logger = loggerService.withContext('MessageTranslate')

/** 流 requestId 前缀（主进程取消注册表按 requestId 配对；每条消息一条在途流）。 */
const TRANSLATE_REQUEST_PREFIX = 'message-translate:'

/** 上游 updater 的节流参数（200ms，leading+trailing）逐字对齐。 */
const UPDATE_THROTTLE_MS = 200

/** messageId → 在途流 requestId（isTranslating 与 abort 的配对面）。 */
const activeStreams = new Map<string, string>()

/** 用户主动停止过的 requestId：主进程 abort 后会回发 error('stream aborted')，据此与真失败区分。 */
const abortedByUser = new Set<string>()

export function getMessageTranslateRequestId(messageId: string): string {
  return TRANSLATE_REQUEST_PREFIX + messageId
}

/** 消息是否正在翻译（翻译块处于 STREAMING/PROCESSING，上游 isTranslating 同语义）。 */
export function isMessageTranslating(state: RootState, messageId: string): boolean {
  const message = state.messages.entities[messageId]
  if (!message) return false
  for (const blockId of message.blocks) {
    const block = state.messageBlocks.entities[blockId]
    if (block && block.type === MessageBlockType.TRANSLATION) {
      return block.status === MessageBlockStatus.STREAMING || block.status === MessageBlockStatus.PROCESSING
    }
  }
  return false
}

/** 目标语言的展示名（与翻译页 languageLabel 同源：i18n languages.* 键族，查不到回退语言码）。 */
export function resolveTranslateTargetLabel(langCode: TranslateLangCode): string {
  const key = langCodeToI18nKey.get(langCode)
  if (!key) return langCode
  return i18n.t(key) || langCode
}

/** 持久层镜像写（fire-and-forget；失败记日志不阻塞流——渲染层 Redux 仍是即时显示面）。 */
function mirrorTranslationRecord(messageId: string, content: string, targetLanguage: TranslateLangCode): void {
  const record: MessageTranslationRecord = {
    messageId,
    content,
    targetLanguage,
    updatedAt: new Date().toISOString()
  }
  void db.message_translations
    .put(record)
    .catch((error: unknown) => logger.warn('mirror translation record failed', error as Error))
}

/** 持久层镜像删除（关闭译文/失败清块时同步清行，避免重开后水合复活已关闭的译文）。 */
function deleteTranslationRecord(messageId: string): void {
  void db.message_translations
    .delete(messageId)
    .catch((error: unknown) => logger.warn('delete translation record failed', error as Error))
}

/** 清理空译文块（上游 handleTranslate 错误路径逐字同构：内容为空才移块，非空保留已生成部分）。 */
async function cleanupEmptyTranslationBlock(state: RootState, topicId: string, messageId: string): Promise<void> {
  const message = state.messages.entities[messageId]
  if (!message) return
  const blockId = message.blocks.find((id) => state.messageBlocks.entities[id]?.type === MessageBlockType.TRANSLATION)
  if (!blockId) return
  const block = state.messageBlocks.entities[blockId]
  if (block && block.type === MessageBlockType.TRANSLATION && block.content.trim().length > 0) return

  // removeBlocksThunk：消息 blocks 列表 + 块实体一并清理（上游同款 thunk 语义）
  await store.dispatch(removeBlocksThunk(topicId, messageId, [blockId]))
  deleteTranslationRecord(messageId)
}

/** 上游同形的内容更新器：节流函数（含 cancel/flush），终态直写前先 cancel。 */
type TranslationUpdater = DebouncedFuncLeading<(accumulatedText: string, isComplete?: boolean) => void>

/**
 * 确保译文块存在并返回内容更新器（上游 getTranslationUpdater 等价物）：
 * 已有翻译块 → 原地重置（清空内容 + STREAMING + 新目标语言）；没有 → 创建并挂到消息 blocks 尾部
 * （updateMessage 的 blockInstruction 追加，天然幂等防重复）。
 */
function ensureTranslationBlock(
  topicId: string,
  message: Message,
  targetLanguage: TranslateLangCode
): TranslationUpdater | null {
  const state = store.getState()
  const liveMessage = state.messages.entities[message.id] ?? message
  if (!liveMessage) {
    logger.error('[ensureTranslationBlock] cannot find message: ' + message.id)
    return null
  }

  const existingBlockId = (liveMessage.blocks ?? []).find(
    (blockId) => state.messageBlocks.entities[blockId]?.type === MessageBlockType.TRANSLATION
  )

  let blockId: string
  if (existingBlockId) {
    blockId = existingBlockId
    store.dispatch(
      updateOneBlock({
        id: blockId,
        // 上游只重置 content/status/metadata（顶层 targetLanguage 会残留旧值——fork 修正：
        // knowledge.ts 的导出分支读顶层字段，重译换语言后必须同步）
        changes: {
          content: '',
          status: MessageBlockStatus.STREAMING,
          targetLanguage,
          metadata: { targetLanguage }
        }
      })
    )
  } else {
    const newBlock = createTranslationBlock(message.id, '', targetLanguage, { status: MessageBlockStatus.STREAMING })
    blockId = newBlock.id
    store.dispatch(upsertOneBlock(newBlock))
    store.dispatch(
      newMessagesActions.updateMessage({
        topicId,
        messageId: message.id,
        updates: { blockInstruction: { id: newBlock.id }, updatedAt: new Date().toISOString() }
      })
    )
  }

  mirrorTranslationRecord(message.id, '', targetLanguage)

  const writeBlock = (accumulatedText: string, isComplete: boolean = false) => {
    store.dispatch(
      updateOneBlock({
        id: blockId,
        changes: {
          content: accumulatedText,
          status: isComplete ? MessageBlockStatus.SUCCESS : MessageBlockStatus.STREAMING
        }
      })
    )
    mirrorTranslationRecord(message.id, accumulatedText, targetLanguage)
  }
  // 上游同参数节流：leading + trailing，流式期间每 200ms 至多落一次 dispatch + Dexie
  return throttle(writeBlock, UPDATE_THROTTLE_MS, { leading: true, trailing: true })
}

export interface MessageTranslationParams {
  topicId: string
  message: Message
  /** 源文本（调用方已取好的主文本内容，上游 mainTextContent 同位）。 */
  sourceText: string
  language: TranslateLanguage
}

/**
 * 翻译一条消息（上游 MessageMenubar.handleTranslate + TranslateService.translateText 的 fork 合成）。
 * 返回是否成功；失败时用户可见信号（toast）+ 空块清理，绝无静默失败。
 */
export async function startMessageTranslation({
  topicId,
  message,
  sourceText,
  language
}: MessageTranslationParams): Promise<boolean> {
  if (isMessageTranslating(store.getState(), message.id)) {
    return false
  }

  const text = (sourceText ?? '').trim()
  if (text.length === 0) {
    // 上游会把空文本直接发给模型再以 error.empty 收场；fork 提前短路（同文案、少一次注定失败的请求）
    window.toast.error(i18n.t('translate.error.empty'))
    return false
  }

  const model = store.getState().llm.translateModel
  if (!model) {
    // 与翻译页同一道门、同一文案
    window.toast.error(i18n.t('translate.error.not_configured'))
    return false
  }

  const targetLanguage = language.langCode
  const updater = ensureTranslationBlock(topicId, message, targetLanguage)
  if (!updater) return false

  const requestId = getMessageTranslateRequestId(message.id)
  activeStreams.set(message.id, requestId)

  let accumulated = ''
  let errorMessage: string | undefined
  let userAborted = false

  try {
    await lightStream(
      requestId,
      {
        provider: model.provider,
        model: model.id,
        messages: [
          {
            role: 'user',
            text: buildTranslatePrompt(TRANSLATE_PROMPT, resolveTranslateTargetLabel(targetLanguage), text)
          }
        ],
        source: 'cherry-translate'
      },
      (event) => {
        if (event.type === 'delta') {
          accumulated += event.text
          updater(accumulated, false)
        } else if (event.type === 'error') {
          // 用户停止：主进程回发 error('stream aborted')，按上游 abort 语义静默收尾（保留已生成部分）
          if (abortedByUser.has(requestId)) return
          errorMessage = event.message
        }
      }
    )
  } catch (error) {
    logger.warn('message translation stream channel failed', error as Error)
    if (!abortedByUser.has(requestId)) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }
  } finally {
    // 先取中止标记再清注册表（通道关闭后仍可能补发 abort 错误事件，注册表在 abort 时刻置入）
    userAborted = abortedByUser.has(requestId)
    // 终态直写（不经节流）：保证最后一次写一定是终态，规避 trailing 节流与 done 事件的次序竞争
    updater.cancel()
    updater(accumulated, true)
    activeStreams.delete(message.id)
    abortedByUser.delete(requestId)
  }

  if (!userAborted && errorMessage !== undefined) {
    window.toast.error(`${i18n.t('translate.error.failed')}: ${errorMessage}`)
    // 上游错误路径：空块才清理，非空（部分结果）保留
    await cleanupEmptyTranslationBlock(store.getState(), topicId, message.id)
    return false
  }

  if (accumulated.trim().length === 0) {
    window.toast.error(i18n.t('translate.error.empty'))
    await cleanupEmptyTranslationBlock(store.getState(), topicId, message.id)
    return false
  }

  return true
}

/** 停止该消息的在途翻译流（lightStreamAbort 真取消 + 已生成部分保留，上游 abortTranslation 同语义）。 */
export function abortMessageTranslation(messageId: string): void {
  const requestId = activeStreams.get(messageId)
  if (!requestId) return
  abortedByUser.add(requestId)
  void lightStreamAbort(requestId)
}

/** 关闭译文：块从消息与块表移除 + 持久行删除（上游 removeMessageBlock + Dexie 行删除合流）。 */
export async function closeMessageTranslation(topicId: string, messageId: string): Promise<void> {
  const state = store.getState()
  const message = state.messages.entities[messageId]
  const blockIds = (message?.blocks ?? []).filter(
    (blockId) => state.messageBlocks.entities[blockId]?.type === MessageBlockType.TRANSLATION
  )
  if (blockIds.length === 0) return

  await store.dispatch(removeBlocksThunk(topicId, messageId, blockIds))
  deleteTranslationRecord(messageId)
}

/** 复制译文（拼接全部翻译块内容；上游 translate-copy 菜单项同语义）。 */
export async function copyMessageTranslation(message: Message): Promise<boolean> {
  const state = store.getState()
  const contents = (message.blocks ?? [])
    .map((blockId) => state.messageBlocks.entities[blockId])
    .filter((block) => block && block.type === MessageBlockType.TRANSLATION)
    .map((block) => (block.type === MessageBlockType.TRANSLATION ? block.content : ''))
    .filter((content) => content.length > 0)

  const translationContent = contents.join('\n\n').trim()
  if (!translationContent) {
    window.toast.warning(i18n.t('messageTranslate.empty'))
    return false
  }
  await navigator.clipboard.writeText(translationContent)
  window.toast.success(i18n.t('messageTranslate.copied'))
  return true
}

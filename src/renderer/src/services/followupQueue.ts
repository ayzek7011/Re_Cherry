/**
 * 追问队列泵。回合成功结束后把队首追问按正常发送路径发出；
 * 暂停态/空队列不泵。发送构建与 Inputbar.sendMessage 的纯文本路径同构
 * （getUserMessage + usage 估算 + sendMessageThunk），trace span 不另启
 * （队列发送是用户已提交消息的延迟重放，不是新的根交互）。
 *
 * 触发点：kernelChat turn/end（仅成功/自然结束；error/aborted 不泵——失败轮
 * 的语义是"当前回答有问题"，自动接着发追问只会火上浇油）。
 */
import { loggerService } from '@logger'
import i18n from '@renderer/i18n'
import { checkRateLimit, getUserMessage } from '@renderer/services/MessagesService'
import { estimateUserPromptUsage } from '@renderer/services/TokenService'
import store from '@renderer/store'
import { removeFollowup, requeueFollowupHead, selectFollowupQueue } from '@renderer/store/followupQueue'
import { sendMessage } from '@renderer/store/thunk/messageThunk'
import type { MessageInputBaseParams } from '@renderer/types/newMessage'

const logger = loggerService.withContext('FollowupQueue')

export async function pumpFollowupQueue(topicId: string): Promise<void> {
  const state = store.getState()
  const queue = selectFollowupQueue(state, topicId)
  if (queue.paused || queue.items.length === 0) return

  const next = queue.items[0]
  const { row, assistant } = findTopicOwner(topicId)
  if (row === undefined || assistant === undefined) {
    // 没有归属话题行 = 这条追问无处可发；留在队列里只会每回合重试一次，故明确丢弃并记日志。
    logger.warn(`followupQueue: topic ${topicId} has no owning row/assistant, dropping queued item`)
    store.dispatch(removeFollowup({ topicId, id: next.id }))
    return
  }

  // 限流命中 = 发不出去：退回**队首原位**等待（不发也不丢， 前是 remove+enqueue 会被推到队尾并换新 id）。
  if (checkRateLimit(assistant, topicId)) {
    store.dispatch(requeueFollowupHead({ topicId, item: next }))
    logger.warn('followupQueue: rate limited, kept head item in place')
    return
  }

  try {
    const baseUserMessage: MessageInputBaseParams = { assistant, topic: row, content: next.text }
    baseUserMessage.usage = await estimateUserPromptUsage(baseUserMessage)
    const { message, blocks } = getUserMessage(baseUserMessage)

    // 先构建后移除。构建期抛错时队首原样留在队列里（保 id、保顺序），
    // 用户的排队文本不会"逐字消失"——旧实现在这里先 remove，失败只剩一条日志。
    store.dispatch(removeFollowup({ topicId, id: next.id }))
    void store.dispatch(sendMessage(message, blocks, assistant, topicId))
    logger.info(`followupQueue: pumped queued follow-up for topic ${topicId} (${queue.items.length - 1} left)`)
  } catch (error) {
    logger.error('followupQueue: failed to send queued follow-up:', error as Error)
    store.dispatch(requeueFollowupHead({ topicId, item: next }))
    // 失败绝不能看起来像"已发送"：队列文本仍在，但用户必须知道这一轮没发出去。
    window.toast.error(
      i18n.t('followupQueue.pump_failed', {
        defaultValue: 'Queued follow-up was not sent. It stays in the queue.'
      })
    )
  }
}

/** 跨助手找话题行与持有助手（topicNaming 的 findTopicRow 同款，附 assistant 整对象）。 */
function findTopicOwner(topicId: string) {
  for (const assistant of store.getState().assistants.assistants) {
    const row = (assistant.topics ?? []).find((topic) => topic.id === topicId)
    if (row !== undefined) return { row, assistant }
  }
  return { row: undefined, assistant: undefined }
}

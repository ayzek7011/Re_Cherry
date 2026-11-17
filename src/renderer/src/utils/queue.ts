import { endTrace } from '@renderer/services/SpanManagerService'
import PQueue from 'p-queue'

// Queue configuration - managed by topic
const requestQueues: { [topicId: string]: PQueue } = {}

/**
 * 队列空闲后自动回收的延时。
 * 说明：`requestQueues` 原先只增不减，每个新 topicId 都会永久
 * 驻留一个 PQueue（含 idle 监听器与内部任务历史）。这里在 idle 后延时回收，
 * 既保证紧接着的 `onIdle()` 调用仍能拿到同一个实例，也避免长期会话无界增长。
 * 真正删除话题时仍应显式调用 `disposeTopicQueue(topicId)`（见「」）。
 */
const QUEUE_EVICTION_DELAY_MS = 5 * 60 * 1000

/** 每个 topic 队列只允许结束一次 trace；队列被回收重建后重新计数。 */
const traceEndedQueues = new WeakSet<PQueue>()

/** idle 回收定时器句柄，用于「重新有任务」时取消回收。 */
const evictionTimers: { [topicId: string]: ReturnType<typeof setTimeout> } = {}

const endTraceOnce = (queue: PQueue, topicId: string) => {
  if (traceEndedQueues.has(queue)) {
    // p-queue 的 idle 在每次队列变空时都会触发（不是一次性事件）；
    // trace 已由 finishTurn 收尾，重复 endTrace 是噪声。
    return
  }
  traceEndedQueues.add(queue)
  endTrace({ topicId })
}

const cancelEviction = (topicId: string) => {
  const timer = evictionTimers[topicId]
  if (timer !== undefined) {
    clearTimeout(timer)
    delete evictionTimers[topicId]
  }
}

const scheduleEviction = (topicId: string, queue: PQueue) => {
  cancelEviction(topicId)
  evictionTimers[topicId] = setTimeout(() => {
    delete evictionTimers[topicId]
    // 只有仍是同一个实例且确实空闲时才回收，避免删掉新入队的任务。
    if (requestQueues[topicId] === queue && queue.size === 0 && queue.pending === 0) {
      delete requestQueues[topicId]
    }
  }, QUEUE_EVICTION_DELAY_MS)
  // 定时器不应阻止窗口关闭（Electron 渲染进程下 unref 可能存在，也可能不存在）。
  if (typeof (evictionTimers[topicId] as unknown as { unref?: unknown }).unref === 'function') {
    ;(evictionTimers[topicId] as unknown as { unref: () => void }).unref()
  }
}

/**
 * Get or create a queue for a specific topic
 *
 * 默认 `concurrency: 1`：一个话题在内核侧是一个会话，同一时刻只能跑一个回合；
 * 渲染层的投影状态（streams/pendingStubs）也是每话题单槽。并发 >1 时两个发送互踩——
 * 后发的 pendingStubs.set 覆盖先发的，先发回合的 turn/start 认领到别人的 stub，
 * 事件流错配（并答显示串模型）。多模型并答因此按队列顺序逐个流式（原"并行"在
 * 单槽投影下本就错配，不是真并行）。显式传 options 可覆盖。
 *
 * @param topicId The ID of the topic
 * @param options
 * @returns A PQueue instance for the topic
 */
export const getTopicQueue = (topicId: string, options = {}): PQueue => {
  if (!requestQueues[topicId]) {
    const queue = new PQueue({ concurrency: 1, ...options })
    requestQueues[topicId] = queue
    queue.addListener('idle', () => {
      endTraceOnce(queue, topicId)
      scheduleEviction(topicId, queue)
    })
    queue.addListener('active', () => {
      cancelEviction(topicId)
    })
  }
  return requestQueues[topicId]
}

/**
 * Dispose (evict) the queue for a topic and drop its trace listener.
 * Call this when a topic is deleted or cleared so the queue and its
 * `idle` listener do not outlive the topic.
 * @param topicId The ID of the topic
 * @returns True when a queue existed and was disposed.
 */
export const disposeTopicQueue = (topicId: string): boolean => {
  const queue = requestQueues[topicId]
  if (!queue) {
    return false
  }
  cancelEviction(topicId)
  queue.removeAllListeners()
  delete requestQueues[topicId]
  return true
}

/**
 * Check if a topic has pending requests
 * @param topicId The ID of the topic
 * @returns True if the topic has pending requests
 */
export const hasTopicPendingRequests = (topicId: string): boolean => {
  return requestQueues[topicId]?.size > 0 || requestQueues[topicId]?.pending > 0
}

/**
 * Wait for all pending requests in a topic queue to complete
 * @param topicId The ID of the topic
 */
export const waitForTopicQueue = async (topicId: string): Promise<void> => {
  if (requestQueues[topicId]) {
    await requestQueues[topicId].onIdle()
  }
}

/**
 * 既往 turn 的思考块回放剥离（传输层；请求端）。
 *
 * 背景（2026-09-17 wire 实测）：pi-ai 的 OpenAI 兼容序列化把 dsh assistant 历史里的
 * `reasoning` 块按思考签名回放成 wire 上的 `reasoning_content`（硅基流动路由），此后
 * 每一轮请求都全额重发全部历史思考——复利、计费、且对续答无增益：正文才是资产，
 * 思考是一次性草稿（同轮内草稿有用，出了轮就是旧稿）。
 *
 * 规则（与用户定案，不设开关、不分工作模式）：
 *   - turn 内保留：边界之后（含工具多步链的中间步）的 assistant 思考原样回放——
 *     这是工作模式工具链连续性的全部依据（工具调用本身不带动机，跨步意图只在思考里）；
 *   - 既往 turn 剥离：边界之前的 assistant 思考不再上 wire；正文与工具调用块不动，
 *     会话库（真源）里思考块原样保留——剥离只发生在"发出去的请求"这一层。
 *
 * 边界 = 消息数组里最后一条"真实用户消息"，须同时满足（三项都是 dsh 编译产物里的
 * 稳定形状，2026-09-17 probe-toolloop-shape 在真机管道上取形）：
 *   1. `role === 'user'`；
 *   2. 不是工具结果——dsh 的工具结果是 user-role 消息（dsh-llm `createToolResultMessage`：
 *      `source.kind === 'tool'` + `tool-result` 块）。不排除它，边界会在工具回合中间被劫持，
 *      当步思考被误剥，工具链断续；
 *   3. 不是注入快照——前缀 `Current runtime context.`（dsh 系统提示词里自述的同一条约定，
 *      fork `sessionEventView.ts` 的注入谓词同源）。快照可能插在回合中间，不能当边界。
 * 任何不可识别（没有合格边界 / 消息形状异常 / 门内部异常）→ 原样透传（fail-safe，
 * 与 dsmlRepair 同一原则）。
 *
 * 挂载方式：本特性的动作点在"dsh 消息 → pi 消息"转换，位于 npm 包内、无公开缝可投
 * （`llm/stream` 瀑布只能观察：cordis `waterfall` 的 `next()` 重放原参数数组，终点闭包
 * 持冻结原请求；agent-loop 出口即深冻结）。因此在 `@deepseek-ai/dsh-llm-pi-ai` 上用
 * 一个 pnpm 补丁装**中性门**（`globalThis.__recTrimPriorTurnThinking?.(options) ?? options`，
 * 门缺失=零行为差异），全部判定与剥离逻辑在本模块——补丁面最小、内核包不含 fork 语义。
 * 会话库与渲染层零改动：DB 里的 reasoning 块不受影响，历史完整性由折叠真源保证。
 */
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { loggerService } from '@logger'

const logger = loggerService.withContext('KernelThinkingReplay')

/** dsh 注入快照的稳定前缀（dsh 系统提示词自述约定；fork sessionEventView 同源）。 */
const SNAPSHOT_PREFIX = 'Current runtime context.'

/** 中性门（补丁侧）约定的全局键。 */
export const GATE_KEY = '__recTrimPriorTurnThinking' as const

/** dsh 消息的最小形状（只读判别用，不做完整类型断言）。 */
interface AnyMessage {
  role?: unknown
  source?: { kind?: unknown } | undefined
  content?: unknown
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function messageBlocks(message: AnyMessage): unknown[] {
  return Array.isArray(message.content) ? message.content : []
}

function firstTextOf(message: AnyMessage): string {
  for (const block of messageBlocks(message)) {
    if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
      return block.text
    }
  }
  return ''
}

/** 工具结果消息（dsh 词表：user-role + source.kind==='tool'，块 type==='tool-result'）。 */
function isToolResultMessage(message: AnyMessage): boolean {
  const source = isObject(message.source) ? message.source : undefined
  if (source !== undefined && source.kind === 'tool') return true
  return messageBlocks(message).some((block) => isObject(block) && block.type === 'tool-result')
}

/** 注入式 runtime 快照（user-role，文本以约定前缀开头）。 */
function isSnapshotMessage(message: AnyMessage): boolean {
  return firstTextOf(message).startsWith(SNAPSHOT_PREFIX)
}

/** 合格边界：真实用户消息（排除工具结果与注入快照）。 */
function isTurnStartMessage(message: AnyMessage): boolean {
  if (message.role !== 'user') return false
  if (isToolResultMessage(message)) return false
  if (isSnapshotMessage(message)) return false
  return true
}

/** 最后一条合格用户消息的下标；无合格边界时 -1（fail-safe：全保留）。 */
function boundaryIndex(messages: AnyMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isTurnStartMessage(messages[i])) return i
  }
  return -1
}

/** 是否带任何思考块（dsh 词表：assistant 消息 content 里的 `reasoning` 块）。 */
function hasReasoningBlocks(message: AnyMessage): boolean {
  return messageBlocks(message).some(
    (block) => isObject(block) && block.type === 'reasoning' && typeof block.text === 'string'
  )
}

/**
 * 纯函数：对一条 dsh 请求做既往 turn 思考剥离。
 * 返回原对象（恒等）当且仅当无需/不可剥离；永不修改入参，永不抛错。
 */
export function trimPriorTurnThinking(options: GenerateOptions): GenerateOptions {
  const messages = options.messages
  if (!Array.isArray(messages) || messages.length === 0) return options
  const boundary = boundaryIndex(messages as AnyMessage[])
  if (boundary <= 0) {
    // 无边界（含首条即用户消息 = 全部 turn 内）或历史异常：透传。debug 级留痕。
    logger.debug(`kernel: wire thinking trim passthrough (boundary=${boundary}, total=${messages.length})`)
    return options
  }

  const stripped: unknown[] = []
  let changed = false
  let strippedReasoning = 0
  let droppedEmpty = 0
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i] as AnyMessage
    if (i < boundary && message.role === 'assistant' && hasReasoningBlocks(message)) {
      const keptBlocks = messageBlocks(message).filter((block) => !(isObject(block) && block.type === 'reasoning'))
      if (keptBlocks.length === 0) {
        // 原本只有思考块的 assistant（被打断的回合会出现）：剥空后 content 为空数组，
        // Anthropic 风味接口会硬拒。这类消息对模型零贡献（无正文、无工具调用），
        // 整条下线；绝不会出现 tool-call 被丢的情况（tool-call 不是 reasoning 块），
        // 也不破坏 tool-call → tool-result 的邻接配对。
        changed = true
        droppedEmpty += 1
        continue
      }
      stripped.push({ ...message, content: keptBlocks })
      changed = true
      strippedReasoning += 1
    } else {
      stripped.push(message)
    }
  }
  if (!changed) return options
  logger.info(
    `kernel: wire thinking trim — boundary=${boundary} messages=${messages.length} stripped=${strippedReasoning} droppedEmpty=${droppedEmpty}`
  )
  return { ...options, messages: stripped } as GenerateOptions
}

/** 中性门实现：任何内部异常都吞掉并按 fail-safe 原样透传（门承诺永不抛错）。 */
function gate(options: unknown): unknown {
  try {
    return trimPriorTurnThinking(options as GenerateOptions)
  } catch (error) {
    logger.error(`kernel: thinking replay trim gate failed, passing through — ${String(error)}`)
    return options
  }
}

/** 装载中性门（boot 一次）。返回真值便于测试断言。 */
export function installThinkingReplayTrim(): boolean {
  const holder = globalThis as Record<string, unknown>
  if (typeof holder[GATE_KEY] === 'function') return false
  holder[GATE_KEY] = gate
  logger.info('kernel: prior-turn thinking replay trim installed (intra-turn kept, prior turns stripped on the wire)')
  return true
}

/** 卸载（测试用）。 */
export function uninstallThinkingReplayTrim(): void {
  delete (globalThis as Record<string, unknown>)[GATE_KEY]
}

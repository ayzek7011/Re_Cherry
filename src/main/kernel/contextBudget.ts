/**
 * 上下文预算裁剪（传输层；请求端）——问题 1（大对话发送失败）的内核侧修复。
 *
 * 背景：dsh-agent-loop 每个 step 用 `session.deriveMessages()` 全量组装请求
 * （lib/index.js buildRequest），fork 在此之前没有任何预算治理——对话严格单调增长，
 * 超过 provider 上下文窗口的那一轮被 provider 整体拒绝且当轮终局。渲染层的
 * 助手设置 contextCount（上下文消息条数，Cherry 既有语义）原本只服务旧
 * ApiService 直连路径（filterContextMessages），内核通道从不消费。
 *
 * 方案：渲染层随发送/建册上行 contextCount（消息条数），经 Dsh_TopicSend
 * 白名单与建册输入落到内核话题注册表行；请求端在 dsh-llm-pi-ai 的
 * streamWithSnapshot 上用补丁文件里的第三个中性门（`globalThis.__recApplyContextBudget`
 * ，门缺失 = 零行为差异）调用本模块：按条数裁掉最旧的历史。
 *
 * 裁剪规则（correctness first）：
 *   - 预算 = 请求里允许的消息条数上限（含本轮新消息）；UNLIMITED_CONTEXT_COUNT
 *     （100000，渲染层已把 MAX_CONTEXT_COUNT=100 的"不限"折算成它）实际等于不裁剪。
 *   - 只从头部丢弃，尾部永远完整保留（本轮消息总在尾部窗口内）。
 *   - 窗口头部必须落在"真实用户消息"上（isTurnStartMessage，与 thinkingReplay
 *     同一份 dsh 词表：排除工具结果与注入快照）——回合内部（工具调用→工具结果
 *     链、注入快照）永远不会被拦腰截断；找不到边界就把整个窗口上探到会话开头。
 *   - 任何不可识别 / 未登记 / 门内部异常 → 原样透传（fail-safe，与 thinkingReplay
 *     同一原则）。门承诺永不抛错。
 *
 * 裁剪只发生在"发出去的请求"这一层：会话库（真源）与渲染层投影零改动，
 * 被裁掉的历史仍在 DB 与折叠视图里完整可见。
 */
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { loggerService } from '@logger'

import { type AnyMessage, isSnapshotMessage, isTurnStartMessage } from './thinkingReplay'

const logger = loggerService.withContext('KernelContextBudget')

/** 中性门（补丁侧）约定的全局键。 */
export const GATE_KEY = '__recApplyContextBudget' as const

/**
 * 会话 → 上下文预算（消息条数）。返回 undefined = 该会话未登记预算（透传）。
 * 由 kernel/index.ts 安装时注入 topics 注册表解析器（sessionId === 话题 id，
 * dsh-agent-loop buildRequest 把 `session.id` 原样放进请求）。
 */
export type ContextCountResolver = (sessionId: string) => number | undefined

let resolveContextCount: ContextCountResolver = () => undefined

/**
 * 纯函数：按预算裁剪请求消息。返回原对象（恒等）当且仅当无需/不可裁剪；
 * 永不修改入参，永不抛错。
 */
export function applyContextBudget(options: GenerateOptions, budget: number | undefined): GenerateOptions {
  if (budget === undefined || !Number.isFinite(budget) || budget <= 0) return options
  const messages = options.messages
  if (!Array.isArray(messages) || messages.length === 0) return options
  if (messages.length <= budget) return options

  // 尾部窗口的头部下标；上探到最近的"真实用户消息"，让回合保持完整。
  let head = messages.length - budget
  if (head < 0) return options
  while (head > 0 && !isTurnStartMessage(messages[head] as AnyMessage)) head -= 1
  // 回合的注入快照（dsh RuntimeContextProjection）排在当轮用户消息之后
  // （topics.ts 活体装载注释，真机实锤），落在用户消息起点之后即自动入窗。
  // 这里向上多收一颗快照是防御：上一回合结束时状态变化会把快照投影在该回合
  // 尾部——紧邻本轮用户消息的那颗快照仍是最新的工具面状态说明，随窗保留。
  while (head > 0 && isSnapshotMessage(messages[head - 1] as AnyMessage)) head -= 1
  // 上探到 0 = 窗口覆盖全量（找不到更近的边界），裁剪无意义。
  if (head <= 0) return options

  const kept = messages.length - head
  logger.info(`kernel: context budget — kept=${kept} dropped=${head} total=${messages.length} budget=${budget}`)
  return { ...options, messages: messages.slice(head) } as GenerateOptions
}

/** 中性门实现：任何内部异常都吞掉并按 fail-safe 原样透传（门承诺永不抛错）。 */
function gate(options: unknown): unknown {
  try {
    const generateOptions = options as GenerateOptions
    const sessionId =
      generateOptions !== null && typeof generateOptions === 'object' && typeof generateOptions.sessionId === 'string'
        ? generateOptions.sessionId
        : undefined
    if (sessionId === undefined) return options
    return applyContextBudget(generateOptions, resolveContextCount(sessionId))
  } catch (error) {
    logger.error(`kernel: context budget gate failed, passing through — ${String(error)}`)
    return options
  }
}

/** 装载中性门（boot 一次，注入注册表解析器）。返回真值便于测试断言。 */
export function installContextBudgetGate(resolver: ContextCountResolver): boolean {
  const holder = globalThis as Record<string, unknown>
  if (typeof holder[GATE_KEY] === 'function') return false
  resolveContextCount = resolver
  holder[GATE_KEY] = gate
  logger.info('kernel: context budget gate installed (per-session message-count spill on the wire)')
  return true
}

/** 卸载（测试用）。 */
export function uninstallContextBudgetGate(): void {
  delete (globalThis as Record<string, unknown>)[GATE_KEY]
  resolveContextCount = () => undefined
}

import { deepFreeze } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { applyContextBudget, GATE_KEY, installContextBudgetGate, uninstallContextBudgetGate } from '../contextBudget'

/**
 * 上下文预算裁剪的单元契约（形状沿用 thinkingReplay.test.ts 的真机探针词表）：
 *   - dsh 工具结果 = user-role + tool-result 块（source.kind==='tool'）——不能当窗口起点；
 *   - 注入快照 = user-role 文本以 "Current runtime context." 开头——不能当窗口起点；
 *   - 真实用户消息 = 窗口起点（回合不被拦腰截断）；
 *   - agent-loop 请求到达此处时已深冻结（读取可、改写抛错）。
 */

const text = (t: string) => ({ type: 'text', text: t })
const reasoning = (t: string) => ({ type: 'reasoning', text: t })
const toolCall = (name: string) => ({ type: 'tool-call', name, arguments: '{}' })
const toolResult = (id: string) => ({ type: 'tool-result', toolCallId: id, content: 'ok', isError: false })

const user = (t: string) => ({ role: 'user', content: [text(t)] })
const snapshot = () => ({ role: 'user', content: [text('Current runtime context.\nTools: read.')] })
const toolResultMessage = (id: string) => ({
  role: 'user',
  source: { kind: 'tool', callId: id },
  content: [toolResult(id)]
})
const assistant = (t: string) => ({
  role: 'assistant',
  source: { kind: 'model' },
  content: [reasoning('思考'), text(t)]
})

/** 三回合会话（turn1 带工具循环 + 快照；turn2 尾带快照=回合末状态投影）。 */
const longShape = () => [
  user('第一轮：帮我看看这个文件'),
  snapshot(),
  { role: 'assistant', source: { kind: 'model' }, content: [reasoning('第一步思考…'), toolCall('read')] },
  toolResultMessage('call_1'),
  assistant('第一轮答复。'),
  user('第二轮：你好'),
  assistant('第二轮答复。'),
  snapshot(), // 回合末状态投影（工具面变化）
  user('第三轮：结束')
]

const opts = (messages: unknown[], sessionId = 'topic-1') =>
  ({ provider: 'silicon', model: 'kimi', messages, sessionId }) as never

afterEach(() => {
  uninstallContextBudgetGate()
  vi.unstubAllGlobals()
})

describe('applyContextBudget：纯函数裁剪', () => {
  it('预算缺失/非法/超量不足 → 恒等透传', () => {
    const shape = longShape()
    const request = opts(shape)

    expect(applyContextBudget(request, undefined)).toBe(request)
    expect(applyContextBudget(request, Number.NaN)).toBe(request)
    expect(applyContextBudget(request, 0)).toBe(request)
    expect(applyContextBudget(request, -3)).toBe(request)
    expect(applyContextBudget(request, 9)).toBe(request) // length === budget
    expect(applyContextBudget(request, 100)).toBe(request) // length < budget
  })

  it('无消息/空数组 → 恒等透传', () => {
    const empty = opts([])
    expect(applyContextBudget(empty, 3)).toBe(empty)
    const noMessages = { provider: 'p', model: 'm' } as never
    expect(applyContextBudget(noMessages, 3)).toBe(noMessages)
  })

  it('裁剪：头部丢弃，窗口起点落在真实用户消息上，尾部完整', () => {
    const shape = longShape() // 9 条
    const request = deepFreeze(opts(shape)) // 深冻结：永不改写入参
    const out = applyContextBudget(request, 4)

    expect(out).not.toBe(request)
    const messages = out.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>
    expect(messages).toHaveLength(4)
    // 窗口 = [第二轮用户, 第二轮答复, 回合末快照, 第三轮用户]——回合完整、快照随窗
    expect(messages[0].role).toBe('user')
    expect(messages[0].content[0].text).toContain('第二轮')
    expect(messages[2].content[0].type).toBe('text')
    expect((messages[2].content[0] as { text: string }).text).toContain('Current runtime context')
    expect(messages[3].content[0].text).toContain('第三轮')
    // 尾部对象原引用（slice 不复制尾部）
    expect(messages[3]).toBe(shape[8])
  })

  it('窗口起点落在工具结果/快照上 → 上探到最近真实用户消息', () => {
    // 6 条；budget 3 → head=3 落在工具结果 → 上探到 u2（下标 2）
    const shape = [
      user('第一问'),
      assistant('答一'),
      user('第二问'),
      toolResultMessage('call_2'),
      assistant('答二'),
      user('第三问')
    ]
    const out = applyContextBudget(opts(shape), 3)
    const messages = out.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>
    expect(messages).toHaveLength(4) // [u2, tr, a2, u3]——上探扩窗 1 条
    expect(messages[0].content[0].text).toContain('第二问')
  })

  it('上探到 0（窗口覆盖全量/无边界）→ 恒等透传', () => {
    // budget 4 → head=5 → 落在 assistant → 4 快照 → 3 assistant → 2 工具结果 → 0？——全非边界 → head 降到 0
    const shape = [
      user('第一轮'),
      snapshot(),
      assistant('答'),
      toolResultMessage('c'),
      assistant('答二'),
      user('第二轮')
    ]
    const request = opts(shape)
    expect(applyContextBudget(request, 4)).toBe(request)
  })
})

describe('门 facade：globalThis 装载与 fail-safe', () => {
  it('装载后按 sessionId 解析预算；未登记会话透传', () => {
    const registry = new Map<string, number>([['topic-1', 4]])
    expect(installContextBudgetGate((id) => registry.get(id))).toBe(true)
    expect(installContextBudgetGate(() => 8)).toBe(false) // 幂等：二次装载 no-op
    expect(typeof (globalThis as Record<string, unknown>)[GATE_KEY]).toBe('function')

    const gate = (globalThis as Record<string, unknown>)[GATE_KEY] as (o: unknown) => unknown

    const shape = longShape()
    const out = gate(opts(shape, 'topic-1')) as { messages: unknown[] }
    expect(out.messages).toHaveLength(4) // 同纯函数用例

    const unknownRequest = opts(shape, 'topic-unknown')
    const passthrough = gate(unknownRequest)
    expect(passthrough).toBe(unknownRequest) // 未登记 → 原对象

    const noSessionRequest = { provider: 'p', model: 'm', messages: shape } // 无 sessionId → 透传
    expect(gate(noSessionRequest)).toBe(noSessionRequest)
  })

  it('解析器抛错/门内部异常 → fail-safe 原样透传，门永不抛错', () => {
    installContextBudgetGate(() => {
      throw new Error('registry exploded')
    })
    const gate = (globalThis as Record<string, unknown>)[GATE_KEY] as (o: unknown) => unknown
    const shape = longShape()
    const request = opts(shape, 'topic-1')
    expect(gate(request)).toBe(request)

    uninstallContextBudgetGate()
    // null/垃圾输入不抛
    installContextBudgetGate(() => 4)
    const rawGate = (globalThis as Record<string, unknown>)[GATE_KEY] as (o: unknown) => unknown
    expect(rawGate(null)).toBe(null)
    expect(rawGate('garbage')).toBe('garbage')
  })

  it('卸载后门消失、解析器复位', () => {
    installContextBudgetGate(() => 4)
    uninstallContextBudgetGate()
    expect((globalThis as Record<string, unknown>)[GATE_KEY]).toBeUndefined()
    // 重新装载可用（卸载复位了幂等标记）
    expect(installContextBudgetGate(() => 4)).toBe(true)
  })
})

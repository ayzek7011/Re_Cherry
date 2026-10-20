import { loggerService } from '@logger'
import type { ManagedToolStatusState } from '@shared/types/managedTool'
import { useEffect, useRef, useState } from 'react'

// fork 缝（原创缝 hook，~90 行）：V2 的状态读取走 useSharedCacheValue
//（'feature.deepseek_harness.status' / 'feature.hermes_dashboard.status' / gateway 运行态 /
// binary 快照，主进程共享缓存 + 推送）；fork 无 Cache 层——主进程在-3 已将同一状态面
// 改为全窗口 onStatus 广播（DeepSeekHarnessService/HermesDashboardService/ApiGatewayService/
// BinaryManager 的 publishStatus），本模块把四个消费点收敛为对号 hook。deepseek/hermes 的
// "立即拉当前值" 由 新增的 GetStatus 通道承担（code-cli:*:get-status，订阅前无推送
// 也能拿到当下状态）；binary 快照立即拉取用既有 binary.snapshots()。

const logger = loggerService.withContext('CodeCliStatus')

/** fork 缝：V2 gateway 运行态载荷（{running, lanRunning, port?}——与广播同一构造，见
 *  ApiGatewayService.buildRunningState）。 */
export interface ApiGatewayStatusState {
  running: boolean
  lanRunning?: boolean
  port?: number
}

const STOPPED: ManagedToolStatusState = { status: 'stopped' }
const GATEWAY_IDLE: ApiGatewayStatusState = { running: false, lanRunning: false }

/**
 * 浅比较：IPC 每次 invoke 都返回**新反序列化对象**，但内容往往一字未变。
 * 内容相同就保持旧 state 引用，订阅组件才不会因一次无变化的推送重渲染。
 */
function isSameStatusRecord(a: object, b: object): boolean {
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false
  }
  return true
}

/**
 * 四个同形状态 hook 的公共实现（deepseek / hermes / paperAgent / gateway）。
 *
 * **为什么用 ref 固定两个回调**：`getStatus` / `onStatus` 由调用方写成箭头函数字面量，每次渲染都是新
 * 引用。若把它们放进依赖数组，effect 每次渲染都重跑——重新发一次 `getStatus()` IPC 并重新
 * `onStatus` 订阅/退订；而 IPC 回来的对象引用必然与上次不同 ⇒ `setState` 每次都算变化 ⇒ 组件重渲染
 * ⇒ 依赖再次变化 ⇒ 形成**自持的"渲染 → IPC → setState → 渲染"环**，只能靠 IPC 往返延迟限速。
 * effect 现在只在挂载/卸载时各跑一次；回调经 ref 取最新，语义不变。
 *
 * **epoch 守卫**：主进程 getStatus handler 同步回复 + 消息按序投递，应答在序上不晚于其后的
 * 广播——这是当前"旧应答覆盖新广播"不可发生的依据。这条前提是隐性的（未来某个 handler 变成
 * 异步早捕获晚回复即失效），广播先到即置位、丢弃迟到的初值应答，把前提显式化成防线。
 * 初值读取失败留一行 warn：状态停在 initial 是可观察事实，失败本身不能无声。
 */
function useSubscribedStatus<T extends object>(
  getStatus: () => Promise<unknown>,
  onStatus: (callback: (status: unknown) => void) => () => void,
  initial: T
): T {
  const [state, setState] = useState<T>(initial)
  const getStatusRef = useRef(getStatus)
  getStatusRef.current = getStatus
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus

  useEffect(() => {
    let cancelled = false
    let broadcastArrived = false
    const apply = (status: unknown) => {
      if (cancelled || !status) return
      setState((prev) => (isSameStatusRecord(prev, status as object) ? prev : (status as T)))
    }
    void getStatusRef
      .current()
      .then((status) => {
        if (cancelled || broadcastArrived) return
        apply(status)
      })
      .catch((error) => logger.warn('Failed to fetch the initial tool status', error as Error))
    const unsubscribe = onStatusRef.current((status) => {
      broadcastArrived = true
      apply(status)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
  return state
}

/** DeepSeek Harness 状态（V2 useSharedCacheValue('feature.deepseek_harness.status') 的 fork 对位）。 */
export function useDeepSeekHarnessStatus(): ManagedToolStatusState {
  const { deepseekHarness } = window.api.codeCli
  return useSubscribedStatus(
    () => deepseekHarness.getStatus(),
    (cb) => deepseekHarness.onStatus((status) => cb(status)),
    STOPPED
  )
}

/** Hermes Dashboard 状态（V2 useSharedCacheValue('feature.hermes_dashboard.status') 的 fork 对位）。 */
export function useHermesDashboardStatus(): ManagedToolStatusState {
  const { hermesDashboard } = window.api.codeCli
  return useSubscribedStatus(
    () => hermesDashboard.getStatus(),
    (cb) => hermesDashboard.onStatus((status) => cb(status)),
    STOPPED
  )
}

/** Paper-Agent 状态（同 Hermes Dashboard 的订阅缝形状）。 */
export function usePaperAgentStatus(): ManagedToolStatusState {
  const { paperAgent } = window.api.codeCli
  return useSubscribedStatus(
    () => paperAgent.getStatus(),
    (cb) => paperAgent.onStatus((status) => cb(status)),
    STOPPED
  )
}

/** 统一网关运行态（V2 useApiGateway 的 running 面的 fork 对位）。 */
export function useApiGatewayStatus(): ApiGatewayStatusState {
  const { apiGateway } = window.api.codeCli
  return useSubscribedStatus(
    () => apiGateway.getStatus(),
    (cb) => apiGateway.onStatus((status) => cb(status)),
    GATEWAY_IDLE
  )
}

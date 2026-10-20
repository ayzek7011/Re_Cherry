import type { ManagedToolStatusState } from '@shared/types/managedTool'

import { useDeepSeekHarnessStatus } from './useCodeCliStatus'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/hooks/useManagedToolStatus.ts
//（2026-09-24）。fork 缝：openclaw 臂（useSharedCacheValue('feature.openclaw.
// gateway_status') + openclaw.get_status 探测）随 useOpenClawGatewayController 一并删除
//（openclaw 未移植）；deepseek 臂的 shared-cache 读取换用 useCodeCliStatus 订阅缝，状态形状
// 与"主推送为单一真源"语义逐字。
// （2026-10-19 清理）：openclaw 裁剪后遗留的 `_tool` 幽灵参数、`ManagedTool` 类型与恒真的
// `?? STOPPED`（useDeepSeekHarnessStatus 从不返回 undefined）一并移除。

const STOPPED: ManagedToolStatusState = { status: 'stopped' }

/**
 * Reads the main-owned status snapshot. `enabled=false` 返回停止态（调用方以 isXxxTool
 * 门控挂载，false 时其余控制器不消费这份状态）。
 */
export function useManagedToolStatus(enabled: boolean): ManagedToolStatusState {
  const deepSeek = useDeepSeekHarnessStatus()
  if (!enabled) return STOPPED
  return deepSeek
}

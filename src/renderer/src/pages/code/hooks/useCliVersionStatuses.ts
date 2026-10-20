import { loggerService } from '@logger'
import { CODE_CLI_TOOL_PRESET_MAP } from '@shared/data/presets/codeCliTools'
import type { CodeCli } from '@shared/types/codeCli'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { VersionStatus } from '../types'
import { type BinaryToolSnapshot, interpretBinarySnapshot } from '../utils/binarySnapshot'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/hooks/useCliVersionStatuses.ts
//（2026-09-24）。缝点三处，其余（重试/版本缓存/latestRef 数据流）逐字：
// ① IPC 缝：`ipcApi.request('binary.get_tool_snapshots', names)` → `window.api.codeCli.binary.
//   snapshots()`（fork 主进程白名单固定 ['dsh','hermes']，与工具集等价）；`binary.get_latest_versions
//   (refresh)` → `window.api.codeCli.binary.latestVersions()`（fork 无 refresh 形参——主进程
//   每次调用都现查，V2 的冷缓存两段式读取收敛为一次调用）；`useIpcOn('binary.availability_changed')`
//   → `window.api.codeCli.binary.onChanged(cb)`。
// ② 快照形状缝：fork 快照为 V2 子集（application 扁平状态串），`application?.status` →
//   `application`。v1（W4-4）例外：`operation`（进行中的安装/卸载）**保留**——它是"切页后
//   进度不丢"的唯一真相源（主进程持有），V2 的 operation 对象面其余字段仍不保留。
// ③ logger/toast 缝：import 对号。

const logger = loggerService.withContext('useCliVersionStatus')

const buildStatus = (
  snapshot: BinaryToolSnapshot | undefined,
  latest?: string,
  latestUnknown?: boolean
): VersionStatus => {
  const view = interpretBinarySnapshot(snapshot, { latest })
  return {
    installed: view.installed,
    source: view.source,
    // Backend-application fact drives update/uninstall/repair authority; a fixed
    // CLI's identity comes from the preset, so it carries no custom definition.
    ...(view.applicationStatus ? { applicationStatus: view.applicationStatus } : {}),
    ...(view.installedVersion !== undefined ? { current: view.installedVersion } : {}),
    ...(view.source === 'managed' ? { latest } : {}),
    ...(view.systemPath !== undefined ? { systemPath: view.systemPath } : {}),
    // （）：上次安装失败的原因随快照下发，版本卡据此显示持久的失败行。
    ...(view.lastFailure !== undefined ? { lastFailure: view.lastFailure } : {}),
    // v1（W4-4）：主进程进行中的操作随快照下发——页面重挂载后靠它恢复"正在安装"。
    ...(view.operation !== undefined ? { operation: view.operation } : {}),
    // （）：注册表型工具的"最新版"查询失败时如实标记——否则"没有更新"会冒充查询
    // 结论，版本卡渲染出假的"已是最新"徽章（主进程侧同源语义：查不到就抛，不冒充）。
    ...(latestUnknown ? { latestUnknown: true } : {}),
    canUpgrade: view.hasUpdate
  }
}

const SNAPSHOT_RETRY_MS = 2000
/** 重试封顶：读取失败永不冒充"未安装"，骨架保持到某次重试成功（或 onChanged 触发全量重拉）。 */
const SNAPSHOT_RETRY_MAX_MS = 30_000

export interface CliVersionStatusesState {
  statuses: Record<string, VersionStatus>
  /** False until a read settles — either successfully or at the retry cap. */
  resolved: boolean
}

/** Availability and managed upgrade status for every CLI tool. */
export const useCliVersionStatuses = (toolIds: readonly CodeCli[]): CliVersionStatusesState => {
  const [statuses, setStatuses] = useState<Record<string, VersionStatus>>({})
  const [resolved, setResolved] = useState(false)
  const [availabilityRevision, setAvailabilityRevision] = useState(0)
  const latestRef = useRef<Record<string, string | undefined>>({})
  const toolKey = toolIds.join('|')
  const tools = useMemo(() => (toolKey ? (toolKey.split('|') as CodeCli[]) : []), [toolKey])

  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0

    const refresh = async () => {
      // fork 缝①：V2 为 `await ipcApi.request('binary.get_tool_snapshots', binaryNames)`。
      const snapshots = await window.api.codeCli.binary
        .snapshots()
        .then((result) => result as Record<string, BinaryToolSnapshot>)
        .catch((error) => {
          logger.error('Failed to get CLI tool snapshots', error as Error)
          return null
        })
      if (cancelled) return
      if (!snapshots) {
        // 重试永不放弃、永不降级成"未安装"：读取失败渲染成确定的空结果是假陈述
        // （装配点把空 statuses 显示为可点击的「安装」，等于诱导重装）。封顶退避
        // 到 30s，onChanged 广播仍会立即触发全量重拉。
        attempts += 1
        retryTimer = setTimeout(
          () => void refresh(),
          Math.min(SNAPSHOT_RETRY_MAX_MS, SNAPSHOT_RETRY_MS * 2 ** (attempts - 1))
        )
        return
      }

      for (const toolId of tools) {
        // Latest applies only to an exactly-applied fixed snapshot — driven by the
        // live application fact, not a custom definition (a fixed CLI carries none).
        if (snapshots[CODE_CLI_TOOL_PRESET_MAP[toolId].executable]?.application !== 'applied') {
          delete latestRef.current[toolId]
        }
      }
      const hasAppliedCli = tools.some(
        (toolId) => snapshots[CODE_CLI_TOOL_PRESET_MAP[toolId].executable]?.application === 'applied'
      )
      // fork 缝①：V2 先读缓存（refresh=false）再按需强取（refresh=true）两段式；fork 的
      // latestVersions() 每次现查，收敛为一次调用。
      let latestVersions: Record<string, string | undefined> = {}
      let latestQueryFailed = false
      if (hasAppliedCli) {
        latestVersions = await window.api.codeCli.binary
          .latestVersions()
          .then((result) => {
            latestQueryFailed = false
            return result as Record<string, string | undefined>
          })
          .catch((error) => {
            logger.error('Failed to get latest binary versions', error as Error)
            latestQueryFailed = true
            return {}
          })
      }
      if (cancelled) return

      const next: Record<string, VersionStatus> = {}
      for (const toolId of tools) {
        const binaryName = CODE_CLI_TOOL_PRESET_MAP[toolId].executable
        const latest = latestVersions[binaryName] ?? latestRef.current[toolId]
        latestRef.current[toolId] = latest
        // 查询失败只对"注册表型且已应用"的工具标 unknown——paper-agent（source 型）的
        // 最新版本本来就不走这条通道，"未知"对它是常态而非失败。
        const toolLatestUnknown =
          latestQueryFailed &&
          snapshots[binaryName]?.application === 'applied' &&
          CODE_CLI_TOOL_PRESET_MAP[toolId].install !== 'source'
        next[toolId] = buildStatus(snapshots[binaryName], latest, toolLatestUnknown)
      }
      setStatuses(next)
      setResolved(true)
    }

    void refresh()
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [availabilityRevision, toolKey, tools])

  // fork 缝①：V2 为 `useIpcOn('binary.availability_changed', …)`。
  useEffect(() => {
    const unsubscribe = window.api.codeCli.binary.onChanged(() => {
      setAvailabilityRevision((revision) => revision + 1)
    })
    return unsubscribe
  }, [])

  return { statuses, resolved }
}

import { loggerService } from '@logger'
import { CODE_CLI_TOOL_PRESET_MAP } from '@shared/data/presets/codeCliTools'
import type { CodeCli } from '@shared/types/codeCli'
import type { InstallProgressPayload } from '@shared/types/installProgress'
import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { withDetail } from '../utils/errorDetail'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/hooks/useBinaryActions.ts
//（2026-09-24）。缝点三处：
// ① IPC 缝：`ipcApi.request('binary.install_tool', {name, targetVersion?})` → `window.api.
//   codeCli.binary.install(name, targetVersion?)`；`binary.remove_tool` →
// `window.api.codeCli.binary.remove(name)`。（）：targetVersion 真的贯通到主进程
//   并钉 spec（此前只是保形入参）。
// ② 结果缝：fork 主进程不抛错，返回结果对象——install 为 {success, message?}（V2 成功无返回/
//   失败靠 throw），remove 为 {removed, message?}（V2 为 {status:'cleanup_blocked'|…, message?}）。
//   remove 的 fail-closed 分态统一收敛为 removed=false（无 blocked/definition-only 对比面）。
// ③ toast 缝：`@renderer/services/toast` → fork `window.toast`；logger 缝：'@logger'。
// 失败不再只是日志——即时 toast（此处）+ 持久失败行（主进程 lastFailure 经快照）。

const logger = loggerService.withContext('useBinaryActions')

/**
 * Per-tool install/upgrade/remove actions. The busy Sets are global (not keyed
 * to the selected tool) so the sidebar can show every tool's install state
 * independently — installing one tool must not make another tool's card flash.
 */
export function useBinaryActions() {
  const { t } = useTranslation()
  const [installingTools, setInstallingTools] = useState<Set<string>>(() => new Set())
  const [upgradingTools, setUpgradingTools] = useState<Set<string>>(() => new Set())
  // （用户裁决）：安装步骤进度——主进程每完成一个阶段广播一次，进度条渲染步名。
  // 载荷形状与步骤词汇来自 @shared/types/installProgress（主进程、preload 桥、
  // 渲染层同一份契约）；detail 是下载字节进度、fraction 是进度条本体的确定性比例。
  const [installProgress, setInstallProgress] = useState<InstallProgressPayload | null>(null)
  useEffect(() => {
    const unsubscribe = window.api.codeCli.binary.onInstallProgress((payload) => setInstallProgress(payload))
    return unsubscribe
  }, [])

  // 同工具连点闸（state 更新到下一次渲染之前拦不住双击；useToolUpdateCheck 同款）：
  // 双发会被主进程变更闸以 OPERATION_BUSY_MESSAGE 拒掉，多弹一个 error toast，且第二发的
  // finally 会把第一发还在跑的 installProgress 误清掉。
  const inFlight = useRef<Set<string>>(new Set())

  // install and upgrade share one body — both run the same name-only
  // `binary.install_tool` request; main resolves the Code CLI's fixed recipe
  // itself. They differ only in the busy Set, the success toast, and the log
  // label. Failures are not toasted here: the main process tracks them in the
  // install-state map and the version card renders a persistent failure row.
  const runInstallTool = useCallback(
    async (
      toolId: CodeCli,
      setBusy: Dispatch<SetStateAction<Set<string>>>,
      messages: { successKey: string; failureKey: string; logLabel: string },
      targetVersion?: string
    ) => {
      // （）：targetVersion 真的传下去了——"检查到 A 却装了 B"是通道 tag 漂移下的
      // 常态（此前这里 `void targetVersion`，入参只是保形）。
      const executable = CODE_CLI_TOOL_PRESET_MAP[toolId].executable
      if (inFlight.current.has(executable)) return
      inFlight.current.add(executable)
      try {
        setBusy((prev) => new Set(prev).add(toolId))
        // fork 缝①：V2 为 `await ipcApi.request('binary.install_tool', {name, …})`。
        const result = (await window.api.codeCli.binary.install(
          CODE_CLI_TOOL_PRESET_MAP[toolId].executable,
          targetVersion
        )) as {
          success: boolean
          message?: string
        }
        if (result.success) {
          window.toast.success(t(messages.successKey))
        } else {
          // （真机反馈的静默失败）：主进程把失败原因（已 redactSecretText 清洗，
          // 含 pnpm ERR_PNPM_* 与"市场基线装不上"这类结论）随结果返回，此前只写日志——
          // 用户点安装看到的是"什么都没发生"。这里是即时信号；持久显示由主进程记录的
          // lastFailure（随快照下发）经版本卡的失败行承担。
          logger.error(messages.logLabel, new Error(result.message ?? 'install failed'))
          window.toast.error(withDetail(t('code.install_failed'), result.message))
        }
      } catch (error) {
        // 「Never fail silently … Do this also for fire-and-forget writes」：
        // 上面那条 toast 只覆盖"主进程正常返回 {success:false}"。IPC 调用本身 reject（通道缺失、
        // preload 未桥、主进程 handler 抛错）时主进程什么都没记录，版本卡也不会出现失败行——
        // 旧实现只写日志，用户看到的是"安装按钮转一圈又变回来"。这一臂必须自己报错。
        logger.error(messages.logLabel, error as Error)
        window.toast.error(withDetail(t(messages.failureKey), error instanceof Error ? error.message : String(error)))
      } finally {
        inFlight.current.delete(executable)
        setBusy((prev) => {
          const next = new Set(prev)
          next.delete(toolId)
          return next
        })
        // （）：本次尝试结束即清掉进度快照——否则切到别的工具再切回来，
        // 会看到上一轮残留的步骤名（"正在构建前端…"）挂在一个没在安装的工具上。
        setInstallProgress((prev) => (prev && prev.tool === CODE_CLI_TOOL_PRESET_MAP[toolId].executable ? null : prev))
      }
    },
    [t]
  )

  // `targetVersion` is only supplied when retrying a failed one-shot update, so
  // the retry repeats the same targeted install instead of a name-only no-op.
  // fork 缝②（续）：fork 无 operation 失败面，消费方不再传 targetVersion；参数形状保留。
  const install = useCallback(
    (toolId: CodeCli, targetVersion?: string) =>
      runInstallTool(
        toolId,
        setInstallingTools,
        {
          successKey: 'code.install_success',
          failureKey: 'code.install_failed',
          logLabel: 'Failed to install:'
        },
        targetVersion
      ),
    [runInstallTool]
  )

  const upgrade = useCallback(
    (toolId: CodeCli, latestVersion?: string) =>
      runInstallTool(
        toolId,
        setUpgradingTools,
        {
          successKey: 'code.upgrade_success',
          failureKey: 'code.upgrade_failed',
          logLabel: 'Failed to upgrade:'
        },
        latestVersion
      ),
    [runInstallTool]
  )

  const remove = useCallback(
    async (toolId: CodeCli): Promise<boolean> => {
      try {
        // fork 缝①：V2 为 `await ipcApi.request('binary.remove_tool', {name})`。
        const result = (await window.api.codeCli.binary.remove(CODE_CLI_TOOL_PRESET_MAP[toolId].executable)) as {
          removed: boolean
          message?: string
        }
        // A Code CLI is a fixed tool: it has no removable definition, so a
        // fail-closed cleanup_blocked has no definition-only fallback — surface it
        // as an error the user resolves (e.g. stop a dependent) before retrying.
        // fork 缝②（续）：失败分态收敛为 removed=false。
        if (!result.removed) {
          window.toast.error(result.message ?? t('settings.dependencies.uninstallFailed'))
          return false
        }
        window.toast.success(t('settings.dependencies.uninstallSuccess'))
        return true
      } catch (error) {
        logger.error('Failed to remove:', error as Error)
        // 与 install 的 reject 臂同形：IPC 通道本身失败（通道缺失/preload 未桥）时主进程
        // 什么都不记录，详情只进日志用户就只看到一句通用文案。
        window.toast.error(
          withDetail(t('settings.dependencies.uninstallFailed'), error instanceof Error ? error.message : String(error))
        )
        return false
      }
    },
    [t]
  )

  return {
    install,
    upgrade,
    remove,
    installingTools,
    upgradingTools,
    installProgress
  }
}

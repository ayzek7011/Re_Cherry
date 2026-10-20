import { loggerService } from '@logger'
import { useMinappPopup } from '@renderer/hooks/useMinappPopup'
import { CodeCli } from '@shared/types/codeCli'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { withDetail } from '../utils/errorDetail'
import { usePaperAgentStatus } from './useCodeCliStatus'

// （fork 原创）：Paper-Agent 受管 Web UI 控制器——照 useHermesDashboardController 同构
// （状态订阅 + 弹窗 + epoch 守卫），差别两处：
// ① 无 onConfigMayHaveChanged 面：它的模型供应商/检索密钥由自身 Web UI 的系统设置页写入
//    （home/paper-agent/config/model.json），没有"Cherry 侧配置文件随运行态失效"这条链。
// ② 启动失败分态由主进程 PaperAgentService 给出（not_installed/cancelled/startup_failed），
//    渲染层按表翻译。
// 弹窗与 dsh/hermes 同容器：软件内小程序 webview，id 遵守 code-mate-* 约定。
// （用户裁决 2026-10-19）：「关页即停」只覆盖**标签页**形态（顶部导航，TabsService
// 的 closeTab/closeOtherTabs 链）；侧栏弹窗布局下 hide 弹窗不算关页——受管进程继续
// 跑，停止走 /code 面板的停止按钮。

const logger = loggerService.withContext('usePaperAgentController')

export const PAPER_AGENT_START_FAILURE_REASONS = ['not_installed', 'cancelled', 'startup_failed'] as const
export type PaperAgentStartFailureReason = (typeof PAPER_AGENT_START_FAILURE_REASONS)[number]

const START_ERROR_KEYS: Record<PaperAgentStartFailureReason, string> = {
  cancelled: 'code.paper_agent.error.cancelled',
  not_installed: 'code.paper_agent.error.not_installed',
  startup_failed: 'code.paper_agent.error.startup_failed'
}

interface PaperAgentController {
  launching: boolean
  running: boolean
  starting: boolean
  stopping: boolean
  onLaunch: () => Promise<void>
  onOpenWebUi: () => Promise<void>
  onStop: () => Promise<boolean>
}

export function usePaperAgentController(selectedCliTool: CodeCli): PaperAgentController {
  const { t } = useTranslation()
  const { openSmartMinapp } = useMinappPopup()
  const snapshot = usePaperAgentStatus()
  const operationEpoch = useRef(0)
  const [pendingOperation, setPendingOperation] = useState<'launch' | 'stop' | null>(null)
  const isPaperAgent = selectedCliTool === CodeCli.PAPER_AGENT

  const openWebUi = useCallback(
    (webUrl: string) => {
      const target = new URL(webUrl)
      target.searchParams.set('cherry_navigation_revision', String(Date.now()))
      openSmartMinapp({
        id: 'code-mate-paper-agent',
        name: t('code.cli_tools.paper_agent'),
        url: target.toString()
      })
    },
    [openSmartMinapp, t]
  )

  const onLaunch = useCallback(async () => {
    const epoch = ++operationEpoch.current
    setPendingOperation('launch')
    try {
      const result = (await window.api.codeCli.paperAgent.start()) as
        | { success: true; url: string }
        | { success: false; reason: PaperAgentStartFailureReason; message: string }
      if (epoch !== operationEpoch.current) return
      if (!result.success) {
        logger.error('Failed to launch Paper-Agent', new Error(result.message), { reason: result.reason })
        window.toast.error(
          withDetail(t(START_ERROR_KEYS[result.reason] ?? START_ERROR_KEYS.startup_failed), result.message)
        )
        return
      }
      openWebUi(result.url)
    } catch (error) {
      logger.error('Failed to launch Paper-Agent', error as Error)
      window.toast.error(t(START_ERROR_KEYS.startup_failed))
    } finally {
      if (epoch === operationEpoch.current) setPendingOperation(null)
    }
  }, [openWebUi, t])

  const onStop = useCallback(async (): Promise<boolean> => {
    const epoch = ++operationEpoch.current
    setPendingOperation('stop')
    try {
      const result = (await window.api.codeCli.paperAgent.stop()) as { success: boolean; message?: string }
      if (epoch !== operationEpoch.current) return false
      if (!result.success) {
        logger.error('Failed to stop Paper-Agent', new Error(result.message))
        window.toast.error(withDetail(t('code.paper_agent.error.stop_failed'), result.message))
        return false
      }
      return true
    } catch (error) {
      logger.error('Failed to stop Paper-Agent', error as Error)
      window.toast.error(t('code.paper_agent.error.stop_failed'))
      return false
    } finally {
      if (epoch === operationEpoch.current) setPendingOperation(null)
    }
  }, [t])

  const onOpenWebUi = useCallback(async () => {
    if (snapshot.status === 'running' && snapshot.url) {
      openWebUi(snapshot.url)
      return
    }
    logger.error('Failed to open Paper-Agent Web UI', new Error('Paper-Agent is not running'))
    window.toast.error(t('code.paper_agent.error.open_failed'))
  }, [openWebUi, snapshot.status, snapshot.url, t])

  return {
    launching: isPaperAgent && pendingOperation === 'launch',
    running: isPaperAgent && snapshot.status === 'running',
    starting: isPaperAgent && snapshot.status === 'starting',
    stopping: isPaperAgent && pendingOperation === 'stop',
    onLaunch,
    onOpenWebUi,
    onStop
  }
}

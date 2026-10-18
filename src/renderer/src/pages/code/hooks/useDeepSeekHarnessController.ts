import { loggerService } from '@logger'
import { useMinappPopup } from '@renderer/hooks/useMinappPopup'
import { CodeCli, isApiGatewayProviderId, normalizeDeepSeekHarnessSettings } from '@shared/types/codeCli'
import type { CliProviderConfig } from '@shared/types/codeCliState'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { resolveLaunchModelId } from '../cliConfig'
import type { Provider } from '../cliConfig/providerView'
import { useManagedToolStatus } from './useManagedToolStatus'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/hooks/useDeepSeekHarnessController.ts
//（2026-09-24）。缝点四处，函数体逐字：
// ① 弹窗缝：V2 useMiniAppPopup.openSmartMiniApp（MiniAppWebviewService webview 池）→ fork
//   useMinappPopup.openSmartMinapp（既有 minapp 弹窗/Tab 池，minAppsCache 临时应用语义天然
//   支持不进 allMinApps 持久化）。config 形状 {appId,name,url,logo} → fork MinAppType
//   {id,name,url,logo?}——id 用 'code-mate-deepseek-harness'，logo 省略（V2 的 'deepseek' 为
//   V2 图标注册表键，fork 无该表）。
// ② IPC 缝：`ipcApi.request('deepseek_harness.start'|'.stop')` → `window.api.codeCli.
//   deepseekHarness.start|stop`（input 形状一致：{mode, uniqueModelId, agentPreset, permissionMode}）。
// ③ toast 缝：`@renderer/services/toast` → fork `window.toast`。
// ④ logger 缝：import 对号 '@logger'。

const logger = loggerService.withContext('useDeepSeekHarnessController')

interface UseDeepSeekHarnessControllerOptions {
  selectedCliTool: CodeCli
  enabledProvider?: Provider
  currentProviderConfig?: CliProviderConfig | null
  upsertProviderConfig: (
    providerId: string,
    partial: Pick<CliProviderConfig, 'modelId'> & Partial<CliProviderConfig>
  ) => Promise<string>
  setCurrentProvider: (providerId: string | null) => Promise<void>
}

interface DeepSeekHarnessController {
  launching: boolean
  running: boolean
  starting: boolean
  stopping: boolean
  autoHeal: boolean
  resetting: boolean
  onLaunch: () => Promise<void>
  onStop: () => Promise<boolean>
  onOpenWebUi: () => Promise<void>
  onToggleAutoHeal: (enabled: boolean) => Promise<void>
  onResetData: (keepSessions: boolean) => Promise<boolean>
}

export function useDeepSeekHarnessController({
  selectedCliTool,
  enabledProvider,
  currentProviderConfig,
  upsertProviderConfig,
  setCurrentProvider
}: UseDeepSeekHarnessControllerOptions): DeepSeekHarnessController {
  const { t } = useTranslation()
  const { openSmartMinapp } = useMinappPopup()
  const isDeepSeekHarness = selectedCliTool === CodeCli.DEEPSEEK_HARNESS
  // Status comes from main-pushed events (single source of truth); only the local
  // launching/stopping intents live here, covering the gap until events arrive.
  const { status, url } = useManagedToolStatus('deepseek-harness', isDeepSeekHarness)
  const [launching, setLaunching] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [autoHeal, setAutoHeal] = useState(true)
  const [resetting, setResetting] = useState(false)
  // 自愈开关初值：主进程换代记录文件（缺省 = 开）。读失败静默保持默认，不打断页面。
  useEffect(() => {
    if (!isDeepSeekHarness) return
    let cancelled = false
    window.api.codeCli.deepseekHarness
      .autoHeal()
      .then((result) => {
        if (!cancelled && result && typeof result.autoHeal === 'boolean') setAutoHeal(result.autoHeal)
      })
      .catch((error) => logger.warn('Failed to read the harness self-heal switch', error as Error))
    return () => {
      cancelled = true
    }
  }, [isDeepSeekHarness])
  const settings = useMemo(
    () => normalizeDeepSeekHarnessSettings(currentProviderConfig?.config),
    [currentProviderConfig?.config]
  )

  const openWebUi = useCallback(
    (webUrl: string) => {
      const target = new URL(webUrl)
      target.searchParams.set('cherry_navigation_revision', String(Date.now()))
      openSmartMinapp({
        id: 'code-mate-deepseek-harness',
        name: 'DeepSeek Harness',
        url: target.toString()
      })
    },
    [openSmartMinapp]
  )

  const handleLaunch = useCallback(async () => {
    const parsedModelId = await resolveLaunchModelId({
      enabledProvider,
      currentProviderConfig,
      upsertProviderConfig,
      setCurrentProvider,
      errorToastKey: 'code.select_provider_model',
      logLabel: 'Invalid DeepSeek Harness model id configured'
    })
    if (!parsedModelId || !enabledProvider) return

    try {
      setLaunching(true)
      // fork 缝②：V2 为 `await ipcApi.request('deepseek_harness.start', {...})`。
      const result = (await window.api.codeCli.deepseekHarness.start({
        mode: isApiGatewayProviderId(enabledProvider.id) ? 'gateway' : 'direct',
        uniqueModelId: parsedModelId.uniqueModelId,
        ...settings
      })) as { success: boolean; url?: string; message?: string }
      if (!result.success) {
        // fork 缝③（续）：fork toast 面不支持 undefined 占位，空 message 回落启动失败键。
        window.toast.error(result.message ?? t('code.launch.error'))
        return
      }
      if (result.url) openWebUi(result.url)
    } catch (error) {
      logger.error('Failed to launch DeepSeek Harness', error as Error)
      window.toast.error(t('code.launch.error'))
    } finally {
      setLaunching(false)
    }
  }, [currentProviderConfig, enabledProvider, openWebUi, setCurrentProvider, settings, t, upsertProviderConfig])

  const handleStop = useCallback(async (): Promise<boolean> => {
    try {
      setStopping(true)
      // fork 缝②：V2 为 `await ipcApi.request('deepseek_harness.stop')`。
      const result = (await window.api.codeCli.deepseekHarness.stop()) as { success: boolean; message?: string }
      if (!result.success) {
        // fork 缝③（续）：同上。
        window.toast.error(result.message ?? t('code.launch.error'))
        return false
      }
      return true
    } catch (error) {
      logger.error('Failed to stop DeepSeek Harness', error as Error)
      window.toast.error(t('code.launch.error'))
      return false
    } finally {
      setStopping(false)
    }
  }, [t])

  const handleOpenWebUi = useCallback(async () => {
    try {
      if (url) {
        openWebUi(url)
        return
      }
      throw new Error('DeepSeek Harness Web UI is not running')
    } catch (error) {
      logger.error('Failed to open DeepSeek Harness Web UI', error as Error)
      window.toast.error(t('code.launch.error'))
    }
  }, [openWebUi, t, url])

  const handleToggleAutoHeal = useCallback(
    async (enabled: boolean) => {
      try {
        const result = (await window.api.codeCli.deepseekHarness.autoHeal({ enabled })) as { autoHeal?: boolean }
        setAutoHeal(result.autoHeal ?? enabled)
      } catch (error) {
        logger.error('Failed to toggle the harness self-heal switch', error as Error)
        window.toast.error(t('code.launch.error'))
      }
    },
    [t]
  )

  const handleResetData = useCallback(
    async (keepSessions: boolean): Promise<boolean> => {
      try {
        setResetting(true)
        const result = (await window.api.codeCli.deepseekHarness.reset({ keepSessions })) as {
          success: boolean
          message?: string
        }
        if (!result.success) {
          window.toast.error(result.message ?? t('code.mate.reset.failed'))
          return false
        }
        window.toast.success(t('code.mate.reset.success'))
        return true
      } catch (error) {
        logger.error('Failed to reset harness data', error as Error)
        window.toast.error(t('code.mate.reset.failed'))
        return false
      } finally {
        setResetting(false)
      }
    },
    [t]
  )

  return {
    launching: isDeepSeekHarness && launching,
    running: isDeepSeekHarness && status === 'running',
    starting: isDeepSeekHarness && status === 'starting',
    stopping: isDeepSeekHarness && stopping,
    autoHeal,
    resetting: isDeepSeekHarness && resetting,
    onLaunch: handleLaunch,
    onStop: handleStop,
    onOpenWebUi: handleOpenWebUi,
    onToggleAutoHeal: handleToggleAutoHeal,
    onResetData: handleResetData
  }
}

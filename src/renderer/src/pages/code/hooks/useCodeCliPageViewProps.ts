import { loggerService } from '@logger'
import { useCodeCli } from '@renderer/hooks/useCodeCli'
import { useProviders } from '@renderer/hooks/useProvider'
import { CODE_CLI_TOOL_PRESET_MAP } from '@shared/data/presets/codeCliTools'
import {
  CLI_OWN_LOGIN_PROVIDER_ID,
  CodeCli,
  GATEWAY_CAPABLE_CLI_TOOLS,
  isApiGatewayProviderId,
  LOGIN_CAPABLE_CLI_TOOLS
} from '@shared/types/codeCli'
import type { CodeCliId } from '@shared/types/codeCliState'
import type { CliProviderConfig } from '@shared/types/codeCliState'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { clearCliConfig, resolveCliConfigApplyContext } from '../cliConfig'
import { toCliProvider } from '../cliConfig/providerView'
import type { CodeCliPageViewProps } from '../components/CodeCliPageView'
import { CLI_TOOLS, PROVIDERLESS_CLI_TOOLS } from '../constants/cliTools'
import { OWN_LOGIN_PROVIDER } from '../constants/ownLoginProvider'
import type { CodeToolMeta, VersionStatus } from '../types'
import { useApiGatewayProvider } from './useApiGatewayProvider'
import { useBinaryActions } from './useBinaryActions'
import { useCliVersionStatuses } from './useCliVersionStatuses'
import { useConfigMetadata } from './useConfigMetadata'
import { useConfigPanelController } from './useConfigPanelController'
import { useCurrentCliConfigConnection } from './useCurrentCliConfigConnection'
import { useDeepSeekHarnessController } from './useDeepSeekHarnessController'
import { useHermesDashboardController } from './useHermesDashboardController'
import { useLaunchDialogController } from './useLaunchDialogController'
import { usePaperAgentController } from './usePaperAgentController'
import { useRemoveCliToolDialog } from './useRemoveCliToolDialog'
import { useSortedSupportedProviders } from './useSortedSupportedProviders'
import { useToolUpdateCheck } from './useToolUpdateCheck'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/hooks/useCodeCliPageViewProps.ts
//（2026-09-24）。缝点八处，装配数据流（summaries/prependedProviders/sorted
// providers/gateway 兜底配置/canLaunch/handleRemove 清理链）逐字：
// ① sidebarShortcuts 段不搬：useSidebarShortcuts/isCliSidebarPinned/toggleCliSidebarShortcut 与
// sidebarProps.isSidebarPinned/onToggleSidebar 整体裁掉（fork 未建侧栏快捷方式面，父代理挂）。
// ② Gemini 臂删除：visibleTools 过滤与选种重定向 effect 随 GEMINI_CLI 裁剪（fork 工具集无该项）。
// ③ OpenClaw 臂删除：useOpenClawGatewayController 未移植（fork 工具集无 OPENCLAW），launching/
//   running/stopping 合成与 onLaunch/onStop/onOpenDashboard 分流收敛到 hermes/deepseek 两臂。
// ④ providers 投影缝：fork useProviders 出 fork 原生 Provider，先过 toCliProvider 投影再入本层
//   全部 hooks（4a 装配点须知）；fork 无 isLoading 面，isProvidersLoading 恒 false。
// ⑤ operation 面缝：fork 快照无 operation 广播面（见 ../types 缝注）——mergedInstallingTools 收敛
//   为本地 busy 集合副本，installError 恒 undefined，onInstall 不带 retry 目标版本。
// ⑥ IPC/toast/logger 缝：window.toast（4a 同款）、'@logger'。
// ⑦ 类型缝：CodeCliId ← @shared/types/codeCliState；Provider/Model 消费面 ← providerView 投影。

const logger = loggerService.withContext('CodeCliPage')

type CliToolOption = (typeof CLI_TOOLS)[number]

const CLI_TOOL_IDS = CLI_TOOLS.map((tool) => tool.value)

export function useCodeCliPageViewProps(
  initialTool?: CodeCli,
  onToolChange?: (tool: CodeCli) => void
): CodeCliPageViewProps {
  const { t } = useTranslation()
  const toMeta = useCallback(
    (tool: CliToolOption): CodeToolMeta => ({
      id: tool.value,
      label: t(tool.label),
      icon: tool.icon
    }),
    [t]
  )
  const {
    configs,
    selectedCliTool,
    currentToolState,
    currentProviderId,
    currentProviderConfig,
    providerConfigs,
    directory,
    upsertProviderConfig,
    deleteProviderConfig,
    setCurrentProvider,
    reorderProviders,
    selectTool,
    selectFolder
  } = useCodeCli(initialTool, onToolChange)

  const { install, upgrade, remove, installingTools, upgradingTools, installProgress } = useBinaryActions()
  const { providers: forkProviders } = useProviders()
  // fork 缝④（续）：fork 原生 Provider → V2 CLI 消费面（一次性投影，下游全部按 V2 形状消费）。
  const providers = useMemo(() => forkProviders.map(toCliProvider), [forkProviders])
  // fork 缝④（续）：fork useProviders 无 isLoading 面（enabled 集同步快照）。
  const isProvidersLoading = false
  const apiGatewayBundle = useApiGatewayProvider()
  const {
    filterProviders,
    filterProvidersForTool,
    makeModelFilter,
    resolveProviderMeta,
    resolveProviderMetaForTool,
    gatewayModelsById,
    modelById,
    defaultGatewayModelId,
    isGatewayModelsLoading
  } = useConfigMetadata(selectedCliTool, providers, isProvidersLoading)

  // Per-tool enabled-model summary for the sidebar's second line. Falls back to the
  // provider display name when no model applies (own login, Claude detailed models).
  const providerSummaries = useMemo(() => {
    const summaries: Record<string, string> = {}
    for (const tool of CLI_TOOLS) {
      const state = configs[tool.value as CodeCliId]
      const currentId = state?.current
      if (!currentId) continue
      if (currentId === CLI_OWN_LOGIN_PROVIDER_ID) {
        summaries[tool.value] = t('code.own_login.title', { toolName: t(tool.label) })
        continue
      }
      // The gateway is synthetic (absent from the real provider list); resolve its summary
      // from the bundle's provider so the sidebar still shows the selected model.
      const provider = isApiGatewayProviderId(currentId)
        ? apiGatewayBundle?.provider
        : providers.find((p) => p.id === currentId)
      if (!provider) continue
      if (!isApiGatewayProviderId(currentId) && filterProvidersForTool(tool.value, [provider]).length === 0) continue
      const meta = resolveProviderMetaForTool(tool.value, provider, state.providers[currentId])
      summaries[tool.value] = meta.modelName || meta.providerName
    }
    return summaries
  }, [configs, providers, apiGatewayBundle, filterProvidersForTool, resolveProviderMetaForTool, t])

  const handleReorderError = useCallback(
    (error: unknown) => {
      logger.error('Failed to reorder CLI providers:', error as Error)
      window.toast.error(t('code.apply_failed'))
    },
    [t]
  )
  // fork 缝②③（续）：LOGIN_CAPABLE_CLI_TOOLS 空集 + 网关 bundle 恒 null → 两个 show 标志在 fork
  // 恒 false（表达式保留 V2 原文形状，prependedProviders 随之为空集）。
  const showOwnLoginCard = LOGIN_CAPABLE_CLI_TOOLS.has(selectedCliTool)
  const showGatewayCard = GATEWAY_CAPABLE_CLI_TOOLS.has(selectedCliTool) && !!apiGatewayBundle
  const prependedProviders = useMemo(
    () =>
      [showGatewayCard ? apiGatewayBundle?.provider : null, showOwnLoginCard ? OWN_LOGIN_PROVIDER : null].filter(
        (p): p is NonNullable<typeof p> => p !== null
      ),
    [showGatewayCard, apiGatewayBundle, showOwnLoginCard]
  )
  const { supportedProviders, onReorder: handleReorder } = useSortedSupportedProviders({
    providers,
    currentToolState,
    selectedCliTool,
    filterProviders,
    reorderProviders,
    onReorderError: handleReorderError,
    prependedProviders
  })

  const selectedProvider = currentProviderId ? supportedProviders.find((p) => p.id === currentProviderId) : undefined
  const currentProviderIsPending = !!currentProviderId && !selectedProvider && isProvidersLoading
  const defaultGatewayProvider =
    !selectedProvider && !currentProviderIsPending && showGatewayCard ? apiGatewayBundle?.provider : undefined
  const savedGatewayConfig = defaultGatewayProvider ? providerConfigs[defaultGatewayProvider.id] : undefined
  const hasSavedGatewayContext = defaultGatewayProvider
    ? !!resolveCliConfigApplyContext(selectedCliTool, defaultGatewayProvider.id, savedGatewayConfig, gatewayModelsById)
    : false
  const defaultGatewayConfig = useMemo(
    () =>
      hasSavedGatewayContext
        ? savedGatewayConfig
        : defaultGatewayModelId
          ? // fork 缝⑦（续）：defaultGatewayModelId 由 fork useConfigMetadata 以 string 面（Model['id']）
            // 出——brand 收窄回 CliProviderConfig.modelId（网关臂在 fork 为 dormant 面，值形状一致）。
            { ...savedGatewayConfig, modelId: defaultGatewayModelId as CliProviderConfig['modelId'] }
          : null,
    [hasSavedGatewayContext, savedGatewayConfig, defaultGatewayModelId]
  )
  const enabledProvider = selectedProvider ?? defaultGatewayProvider
  const enabledProviderConfig = selectedProvider ? currentProviderConfig : defaultGatewayConfig
  const { setConnection: setCurrentCliConfigConnection, reload: reloadCliConfigConnection } =
    useCurrentCliConfigConnection({
      enabledProvider,
      selectedCliTool,
      currentProviderConfig: enabledProviderConfig,
      apiGatewayProvider: apiGatewayBundle
    })

  const { statuses, resolved } = useCliVersionStatuses(CLI_TOOL_IDS)
  // 手动检查更新 + paper-agent 生命周期控制器（版本状态合并需要前者，故先于此声明）。
  const updateCheck = useToolUpdateCheck()
  const paperAgent = usePaperAgentController(selectedCliTool)
  // fork 缝②（续）：无 GEMINI_CLI 可见性过滤与选种重定向（fork 工具集恒显 2 项）；statuses 的
  // resolved 标志随重定向 effect 一并裁掉。
  // （用户裁决）：resolved 不再裁掉——首探窗口（3-5s）期间版本卡要显示"检查中"
  // 而非可点击的「安装」（用户担心误点重装）。
  const snapshotsLoading = !resolved
  const visibleTools = CLI_TOOLS
  const activeTool = useMemo<CliToolOption | undefined>(
    () => visibleTools.find((tool) => tool.value === selectedCliTool),
    [selectedCliTool, visibleTools]
  )
  const isProviderlessTool = PROVIDERLESS_CLI_TOOLS.has(selectedCliTool)
  const isOwnLoginSelected = selectedProvider?.id === CLI_OWN_LOGIN_PROVIDER_ID
  const isDeepSeekHarnessTool = selectedCliTool === CodeCli.DEEPSEEK_HARNESS
  const isHermesDashboardTool = selectedCliTool === CodeCli.HERMES
  const isPaperAgentTool = selectedCliTool === CodeCli.PAPER_AGENT
  const activeMeta = activeTool ? toMeta(activeTool) : null
  const toolName = activeMeta?.label ?? ''
  // Local busy Sets give instant feedback; snapshot operations cover mutations
  // initiated in another window or before this page mounted.
  // v1（W4-4）：V2 的这条语义此前在 fork 里被丢了（快照无 operation 面），表现为"切走再回来
  // 进度就没了"——安装跑在主进程，局部 Set 随组件销毁。现在主进程把进行中的操作同步进快照，
  // 这里把它并回来：页面重挂载/整页刷新后仍显示"正在安装"与当前步骤。
  const snapshotOperation = statuses[selectedCliTool]?.operation
  const mergedInstallingTools = useMemo(() => {
    const next = new Set<string>(installingTools)
    if (snapshotOperation?.kind === 'install') next.add(selectedCliTool)
    return next
  }, [installingTools, snapshotOperation, selectedCliTool])
  const selectedExecutable = CODE_CLI_TOOL_PRESET_MAP[selectedCliTool].executable
  const snapshotVersionStatus: VersionStatus = statuses[selectedCliTool] ?? {
    installed: false,
    source: 'none',
    canUpgrade: false
  }
  // 手动检查更新的结论注入（只看选中工具）。结论带"它当时比对的当前版本"——装/
  // 升级后当前版本变了，旧结论自动不适用，回落到快照真值（无需清除广播，也无竞态）。
  // （）：只注入 **managed** 结论——系统来源/未安装根本没有"当前版本"可比，
  // 其结论不得覆盖版本卡（否则 canUpgrade:false 会把卡片压成"最新"）。
  const manualCheck = updateCheck.results[CODE_CLI_TOOL_PRESET_MAP[selectedCliTool].executable]
  const manualCheckApplies =
    manualCheck && manualCheck.source === 'managed' && manualCheck.forVersion === snapshotVersionStatus.current
  const versionStatus: VersionStatus =
    manualCheck && manualCheckApplies
      ? {
          ...snapshotVersionStatus,
          canUpgrade: manualCheck.canUpgrade,
          ...(manualCheck.latest ? { latest: manualCheck.latest } : {})
        }
      : snapshotVersionStatus
  const canLaunch = isPaperAgentTool
    ? versionStatus.installed
    : isHermesDashboardTool
      ? versionStatus.installed
      : (isProviderlessTool || isOwnLoginSelected || !!enabledProvider) &&
        (!isDeepSeekHarnessTool || !!enabledProviderConfig?.modelId)
  // （）：失败原因来自主进程（快照的 lastFailure），不再是恒 undefined 的占位——
  // 失败行/失败对话框因此真的会出现，并且刷新页面后仍在。
  const installError: string | undefined = versionStatus.lastFailure
  // The synthetic own-login entry is always available, so nudge to "select a provider" only when a
  // real provider exists to select — otherwise own-login is the sole option and no nag is warranted.
  const hasRealSupportedProvider = supportedProviders.some((p) => p.id !== CLI_OWN_LOGIN_PROVIDER_ID)
  const showProviderSelectionHint =
    versionStatus.installed &&
    !isProviderlessTool &&
    hasRealSupportedProvider &&
    !selectedProvider &&
    !currentProviderIsPending &&
    !defaultGatewayProvider

  const configPanel = useConfigPanelController({
    selectedCliTool,
    toolName,
    currentProviderId,
    providerConfigs,
    upsertProviderConfig,
    deleteProviderConfig,
    setCurrentProvider,
    setCurrentCliConfigConnection,
    makeModelFilter,
    apiGatewayProvider: apiGatewayBundle,
    gatewayModelsById,
    isGatewayModelsLoading
  })
  const launchDialog = useLaunchDialogController({
    selectedCliTool,
    toolName,
    directory,
    enabledProvider,
    isOwnLoginSelected,
    currentProviderConfig: enabledProviderConfig,
    apiGatewayProvider: apiGatewayBundle,
    gatewayModelsById,
    modelById,
    isModelsLoading: isGatewayModelsLoading,
    upsertProviderConfig,
    setCurrentProvider,
    selectFolder
  })
  const deepSeekHarness = useDeepSeekHarnessController({
    selectedCliTool,
    enabledProvider,
    currentProviderConfig: enabledProviderConfig,
    upsertProviderConfig,
    setCurrentProvider
  })
  const hermesDashboard = useHermesDashboardController(selectedCliTool, {
    onConfigMayHaveChanged: reloadCliConfigConnection
  })
  const deepSeekHarnessActionsDisabled =
    isDeepSeekHarnessTool && (deepSeekHarness.running || deepSeekHarness.starting || deepSeekHarness.stopping)
  const hermesDashboardActionsDisabled =
    isHermesDashboardTool && (hermesDashboard.running || hermesDashboard.starting || hermesDashboard.stopping)
  // paper-agent 同款——运行/启动/停止窗口内不放开变更类动作（卸载、配置编辑）。
  const paperAgentActionsDisabled =
    isPaperAgentTool && (paperAgent.running || paperAgent.starting || paperAgent.stopping)
  const providerActionsDisabled =
    deepSeekHarnessActionsDisabled || hermesDashboardActionsDisabled || paperAgentActionsDisabled
  const handleRemove = useCallback(
    async (toolId: CodeCli) => {
      if (toolId === CodeCli.DEEPSEEK_HARNESS && !(await deepSeekHarness.onStop())) return
      if (toolId === CodeCli.HERMES && !(await hermesDashboard.onStop())) return
      if (toolId === CodeCli.PAPER_AGENT && !(await paperAgent.onStop())) return
      const success = await remove(toolId)
      if (success && currentProviderId) {
        if (toolId !== CodeCli.DEEPSEEK_HARNESS) {
          try {
            await clearCliConfig({ cliTool: toolId })
          } catch (err) {
            logger.error('Failed to clear CLI config on tool removal:', err as Error)
            window.toast.error(t('code.clear_config_failed'))
          }
        }
        await setCurrentProvider(null)
        setCurrentCliConfigConnection(null)
      }
    },
    [
      deepSeekHarness,
      hermesDashboard,
      paperAgent,
      remove,
      currentProviderId,
      setCurrentProvider,
      setCurrentCliConfigConnection,
      t
    ]
  )
  const removeDialog = useRemoveCliToolDialog({ toolName, remove: handleRemove })

  return {
    sidebarProps: {
      tools: visibleTools,
      selectedCliTool,
      onSelectTool: selectTool,
      toMeta,
      statuses,
      installingTools: mergedInstallingTools,
      upgradingTools,
      providerSummaries
    },
    contentProps: activeMeta
      ? {
          selectedCliTool,
          activeMeta,
          versionStatus,
          versionCard: {
            visible: true,
            canLaunch,
            // 自愈开关与数据重置入口只属于编码助手卡（其余工具的 versionCard 不带这两项）。
            ...(selectedCliTool === CodeCli.DEEPSEEK_HARNESS
              ? {
                  autoHeal: { enabled: deepSeekHarness.autoHeal, onToggle: deepSeekHarness.onToggleAutoHeal },
                  onResetData: deepSeekHarness.onResetData
                }
              : {}),
            launching:
              launchDialog.launching ||
              deepSeekHarness.launching ||
              deepSeekHarness.starting ||
              hermesDashboard.launching ||
              hermesDashboard.starting ||
              paperAgent.launching ||
              paperAgent.starting,
            running: deepSeekHarness.running || hermesDashboard.running || paperAgent.running,
            stopping: deepSeekHarness.stopping || hermesDashboard.stopping || paperAgent.stopping,
            upgradeDisabled: providerActionsDisabled
          },
          installingTools: mergedInstallingTools,
          upgradingTools,
          installError,
          snapshotsLoading,
          // 一次判据、一处求值：载荷属于当前选中工具才透传（此前同一谓词写了三遍）。
          // v1（W4-4）：本地位空时回落到快照里那一份（重挂载后事件还没再来时的步骤名/比例）。
          installProgress:
            installProgress?.tool === selectedExecutable
              ? installProgress
              : snapshotOperation?.progress?.tool === selectedExecutable
                ? snapshotOperation.progress
                : undefined,
          // 手动检查更新按钮（三个工具页共用）。
          onCheckUpdates: () => void updateCheck.checkForUpdates(selectedCliTool),
          checkingUpdates: updateCheck.checkingTools.has(CODE_CLI_TOOL_PRESET_MAP[selectedCliTool].executable),
          providerState: {
            providerless: isProviderlessTool,
            showSelectionHint: showProviderSelectionHint
          },
          supportedProviders,
          providerConfigs,
          currentProviderId,
          // 此处原为 `currentCliConfigConnection ? t('code.cli_config.unknown_provider')
          // undefined`。但 `currentCliConfigConnection` 非 null 的语义是"磁盘上的 CLI 配置文件
          // **不属于**当前选中的服务商"（useCurrentCliConfigConnection.ts:107-112 只在"不匹配"时赋值），
          // 把它当模型名注入，选中卡片的第二行就显示成"我选的服务商 = 未知供应商"。
          // 外来配置的信息由配置面板的警示块承担（useConfigEditPanelBodyProps.tsx:86），
          // 这里不再借"模型名"通道表达它——卡片的模型名一律取 `resolveProviderMeta`。
          providerActionsDisabled,
          resolveProviderMeta,
          // fork 缝⑤（续）：无失败目标的 retry 面；name-only 安装即 fork 安装器的全部语义。
          onInstall: () => void install(selectedCliTool),
          onUpgrade: () => void upgrade(selectedCliTool, versionStatus.latest),
          // Uninstall authority is the live application fact: offer removal only
          // when the fixed CLI's exact recipe is applied or broken.
          onRemove:
            versionStatus.applicationStatus === 'applied' || versionStatus.applicationStatus === 'broken'
              ? () => removeDialog.requestRemove(selectedCliTool)
              : undefined,
          // paper-agent 无供应商/模型选择面——启动即拉起受管 uvicorn；dsh/hermes 走
          // 各自控制器，其余（无此集）走启动对话框。
          onLaunch: () =>
            isPaperAgentTool
              ? void paperAgent.onLaunch()
              : isHermesDashboardTool
                ? void hermesDashboard.onLaunch()
                : defaultGatewayProvider && !defaultGatewayConfig
                  ? configPanel.onToggleCurrent(defaultGatewayProvider)
                  : isDeepSeekHarnessTool
                    ? void deepSeekHarness.onLaunch()
                    : launchDialog.openLaunchDialog(),
          onStop: () =>
            isPaperAgentTool
              ? void paperAgent.onStop()
              : isDeepSeekHarnessTool
                ? void deepSeekHarness.onStop()
                : void hermesDashboard.onStop(),
          onOpenDashboard: () =>
            isPaperAgentTool
              ? void paperAgent.onOpenWebUi()
              : isDeepSeekHarnessTool
                ? void deepSeekHarness.onOpenWebUi()
                : void hermesDashboard.onOpenDashboard(),
          onConfigure: configPanel.openConfigurePanel,
          onToggleCurrent: configPanel.onToggleCurrent,
          onReorder: handleReorder
        }
      : undefined,
    emptyMessage: t('code.select_tool_to_start'),
    launchDialogProps: launchDialog.launchDialogProps,
    removeDialogProps: removeDialog.removeDialogProps,
    configPanelKey: configPanel.configPanelKey,
    configPanelProps: providerActionsDisabled ? undefined : configPanel.configPanelProps,
    ownLoginConfigPanelProps: configPanel.ownLoginConfigPanelProps
  }
}

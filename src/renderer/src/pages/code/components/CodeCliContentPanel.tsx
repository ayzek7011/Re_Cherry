import { CodeCli } from '@shared/types/codeCli'
import type { CliProviderConfig } from '@shared/types/codeCliState'
import type { InstallProgressPayload } from '@shared/types/installProgress'
import { ExternalLink } from 'lucide-react'
import { type FC, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { CodeToolMeta, VersionStatus } from '../types'
import { BinaryInstallErrorDialog } from './BinaryInstallErrorDialog'
import { ConfigList } from './ConfigList'
import { Button, SearchInput } from './shadcn'
import { VersionStatusCard } from './VersionStatusCard'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/components/CodeCliContentPanel.tsx
//（2026-09-24）。缝点三处，版本卡装配/供应商搜索/添加提示脚位逐字：
// ① Gemini 臂删除：gemini_cli_discontinued Alert 与 add_provider_hint 的 claude/codex/gemini
//   分支随工具集裁剪（getAddProviderHintKey 收敛为恒 'code.add_provider_hint'）。
// ② 导航缝：openSettingsTab('/settings/provider') → fork window.navigate 同路径（fork 既有
//   深链面同款，见 pages/settings/ProviderSettings/ProviderList.tsx）。
// ③ UI 面缝：Alert/Button/SearchInput → 本页 shim；BinaryInstallErrorDialog ← 本页移植件。

interface CodeCliContentPanelProps {
  selectedCliTool: CodeCli
  activeMeta: CodeToolMeta
  versionStatus: VersionStatus
  versionCard: {
    visible: boolean
    canLaunch: boolean
    launching: boolean
    running: boolean
    stopping: boolean
    upgradeDisabled: boolean
    /** 仅编码助手卡有值（启动自愈开关 + 数据重置入口）。 */
    autoHeal?: { enabled: boolean; onToggle: (enabled: boolean) => void | Promise<void> }
    onResetData?: (keepSessions: boolean) => void | Promise<unknown>
  }
  installingTools: Set<string>
  upgradingTools: Set<string>
  /** Failure message of the last install attempt for the selected tool (from the main-process install-state map). */
  installError?: string
  /** 首探窗口（快照未返回）——版本卡显示「检查中」而非可点击的「安装」。 */
  snapshotsLoading?: boolean
  /**
   * 安装进度（共享契约 `InstallProgressPayload`，仅当前工具的安装中有值）。
   *
   * 原来是三个平行 prop（step/detail/fraction），加一个字段就要改三层——正是共享
   * 词汇表要消掉的那种漂移。现在整份载荷透传：载荷加字段，这里不用动。
   */
  installProgress?: InstallProgressPayload
  /** 手动检查更新（三个工具页共用）。 */
  onCheckUpdates?: () => void
  checkingUpdates?: boolean
  providerState: {
    providerless: boolean
    showSelectionHint: boolean
  }
  supportedProviders: Provider[]
  providerConfigs: Record<string, CliProviderConfig>
  currentProviderId: string | null
  providerActionsDisabled?: boolean
  resolveProviderMeta: (provider: Provider, cfg?: CliProviderConfig) => { providerName: string; modelName?: string }
  onInstall: () => void
  onUpgrade: () => void
  onRemove?: () => void
  onLaunch: () => void
  onStop: () => void
  onOpenDashboard: () => void
  onConfigure: (provider: Provider) => void
  onToggleCurrent: (provider: Provider) => void
  onReorder: (nextProviders: Provider[]) => void | Promise<void>
}

import type { Provider } from '../cliConfig/providerView'

// fork 缝①（续）：V2 switch 分支（claude/codex/gemini）随工具集裁剪。
function getAddProviderHintKey(_cliTool: CodeCli): string {
  void _cliTool
  return 'code.add_provider_hint'
}

export const CodeCliContentPanel: FC<CodeCliContentPanelProps> = ({
  selectedCliTool,
  activeMeta,
  versionStatus,
  versionCard,
  installingTools,
  upgradingTools,
  installError,
  snapshotsLoading,
  installProgress,
  onCheckUpdates,
  checkingUpdates,
  providerState,
  supportedProviders,
  providerConfigs,
  currentProviderId,
  providerActionsDisabled,
  resolveProviderMeta,
  onInstall,
  onUpgrade,
  onRemove,
  onLaunch,
  onStop,
  onOpenDashboard,
  onConfigure,
  onToggleCurrent,
  onReorder
}) => {
  const { t } = useTranslation()
  const [providerSearch, setProviderSearch] = useState('')
  const [showInstallError, setShowInstallError] = useState(false)
  // paper-agent 不吃 Cherry 供应商——它的模型供应商与检索密钥由自身 Web UI 的
  // 系统设置页配置（home/paper-agent/config/model.json），因此不渲染供应商区。
  const isPaperAgent = selectedCliTool === CodeCli.PAPER_AGENT

  // Reset on tool switch: the dialog's controlled `open` goes false when
  // `installError` clears for the new tool, but Radix does not fire onOpenChange
  // on a controlled close, so `showInstallError` would stay true and re-surface
  // the dialog unprompted when switching back to a failed tool.
  useEffect(() => setShowInstallError(false), [selectedCliTool])

  return (
    <div className="flex-1 overflow-y-auto px-6 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="mx-auto max-w-2xl space-y-5">
        {versionCard.visible && (
          <VersionStatusCard
            toolId={selectedCliTool}
            toolName={activeMeta.label}
            status={versionStatus}
            onInstall={onInstall}
            onUpgrade={onUpgrade}
            onRemove={onRemove}
            onLaunch={onLaunch}
            onStop={onStop}
            onOpenDashboard={onOpenDashboard}
            onResetData={versionCard.onResetData}
            autoHeal={versionCard.autoHeal}
            canLaunch={versionCard.canLaunch}
            launching={versionCard.launching}
            running={versionCard.running}
            stopping={versionCard.stopping}
            isInstalling={installingTools.has(selectedCliTool)}
            isUpgrading={upgradingTools.has(selectedCliTool)}
            installProgress={installProgress}
            snapshotsLoading={snapshotsLoading}
            upgradeDisabled={versionCard.upgradeDisabled}
            installError={installError}
            onShowError={() => setShowInstallError(true)}
            onCheckUpdates={onCheckUpdates}
            checkingUpdates={checkingUpdates}
            launchDisabledHint={
              providerState.showSelectionHint
                ? t('code.select_provider_before_launch', { toolName: activeMeta.label })
                : undefined
            }
          />
        )}

        <BinaryInstallErrorDialog
          error={
            showInstallError && installError
              ? { name: activeMeta.label, message: installError, action: 'install' }
              : null
          }
          onOpenChange={(open) => !open && setShowInstallError(false)}
        />

        {isPaperAgent ? (
          <div className="rounded-lg border border-border-subtle bg-accent/10 px-4 py-3 text-muted-foreground text-xs">
            {t('code.paper_agent.hint')}
          </div>
        ) : providerState.providerless ? (
          <div className="rounded-lg border border-border-subtle bg-accent/10 px-4 py-3 text-muted-foreground text-xs">
            {t('code.providerless_hint')}
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {supportedProviders.length > 0 && (
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-medium text-foreground text-sm">{t('code.model_providers')}</h2>
                  <div className="w-52 shrink-0">
                    <SearchInput
                      size="sm"
                      value={providerSearch}
                      placeholder={t('code.search_provider_placeholder')}
                      onChange={(event) => setProviderSearch(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.stopPropagation()
                          setProviderSearch('')
                        }
                      }}
                      onClear={() => setProviderSearch('')}
                      clearLabel={t('common.clear')}
                    />
                  </div>
                </div>
              )}
              <ConfigList
                selectedCliTool={selectedCliTool}
                toolName={activeMeta.label}
                providers={supportedProviders}
                providerConfigs={providerConfigs}
                currentProviderId={currentProviderId}
                providerActionsDisabled={providerActionsDisabled}
                resolveMeta={resolveProviderMeta}
                onConfigure={onConfigure}
                onToggleCurrent={onToggleCurrent}
                onReorder={onReorder}
                searchTerm={providerSearch}
              />
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => window.navigate('/settings/provider')}
              className="w-full rounded-xl border-border-subtle border-dashed py-2 text-muted-foreground hover:border-border hover:text-foreground">
              {t(getAddProviderHintKey(selectedCliTool))}
              <ExternalLink size={10} />
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

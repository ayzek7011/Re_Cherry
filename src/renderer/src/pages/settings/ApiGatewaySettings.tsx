import { loggerService } from '@logger'
import { useApiGatewayStatus } from '@renderer/pages/code/hooks/useCodeCliStatus'
import { Button, InputNumber, Switch, Tag } from 'antd'
import type { FC } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SettingContainer, SettingDescription, SettingGroup, SettingRow, SettingRowTitle, SettingTitle } from '.'

const logger = loggerService.withContext('ApiGatewaySettings')

interface GatewayConfig {
  host: string
  port: number
  enabled: boolean
  apiKey: string | null
  running: boolean
}

/**
 * 统一网关设置：LAN 开关（setLanEnabled）、端口（syncConfig——主进程先持久化再收敛，
 * 运行中的网关自动按新端口重启）、显式重启（restart）。运行态经 useApiGatewayStatus
 * 订阅（与广播同一载荷构造）。三条 IPC 通道（CodeCli_ApiGateway_LanSetEnabled /
 * SyncGatewayConfig / Restart）自此不再是三层齐全却无人调用的孤儿桥。
 */
const ApiGatewaySettings: FC = () => {
  const { t } = useTranslation()
  const status = useApiGatewayStatus()

  const [config, setConfig] = useState<GatewayConfig | null>(null)
  const [portDraft, setPortDraft] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [lanPending, setLanPending] = useState(false)

  const refreshConfig = useCallback(async (): Promise<void> => {
    try {
      const next = (await window.api.codeCli.apiGateway.getConfig()) as GatewayConfig
      setConfig(next)
      setPortDraft(next.port)
    } catch (error) {
      // 读失败保形上次快照（初载为 null → 表单显示占位），留一行 forensic。
      logger.warn('Failed to read the API gateway config', error as Error)
    }
  }, [])

  useEffect(() => {
    void refreshConfig()
  }, [refreshConfig])
  // 运行态翻转（启停/重启/改端口收敛）后重拉一次：key/端口可能随启动流程落定。
  useEffect(() => {
    void refreshConfig()
  }, [status.running, refreshConfig])

  const handleLanToggle = useCallback(
    async (enabled: boolean) => {
      setLanPending(true)
      try {
        await window.api.codeCli.apiGateway.setLanEnabled(enabled)
        await refreshConfig()
      } catch (error) {
        logger.warn('Failed to toggle the API gateway LAN access', error as Error)
        window.toast.error(t('settings.apiGateway.operation_failed'))
      } finally {
        setLanPending(false)
      }
    },
    [refreshConfig, t]
  )

  const handleSavePort = useCallback(async () => {
    if (portDraft === null || portDraft === config?.port) return
    setSaving(true)
    try {
      await window.api.codeCli.apiGateway.syncConfig({ port: portDraft })
      await refreshConfig()
      window.toast.success(t('settings.apiGateway.saved'))
    } catch (error) {
      logger.warn('Failed to save the API gateway port', error as Error)
      window.toast.error(t('settings.apiGateway.operation_failed'))
    } finally {
      setSaving(false)
    }
  }, [config?.port, portDraft, refreshConfig, t])

  const handleRestart = useCallback(async () => {
    setRestarting(true)
    try {
      await window.api.codeCli.apiGateway.restart()
      await refreshConfig()
      window.toast.success(t('settings.apiGateway.restarted'))
    } catch (error) {
      logger.warn('Failed to restart the API gateway', error as Error)
      window.toast.error(t('settings.apiGateway.operation_failed'))
    } finally {
      setRestarting(false)
    }
  }, [refreshConfig, t])

  const running = status.running

  return (
    <SettingContainer>
      <SettingGroup>
        <SettingTitle>{t('settings.apiGateway.title')}</SettingTitle>
        <SettingDescription>{t('settings.apiGateway.description')}</SettingDescription>
        <SettingRow>
          <SettingRowTitle>{t('settings.apiGateway.status.label')}</SettingRowTitle>
          {running ? (
            <Tag color="green">
              {t('settings.apiGateway.status.running')}
              {status.lanRunning && status.port
                ? ` · ${t('settings.apiGateway.status.lan', { port: status.port })}`
                : ''}
            </Tag>
          ) : (
            <Tag>{t('settings.apiGateway.status.stopped')}</Tag>
          )}
        </SettingRow>
        <SettingRow>
          <SettingRowTitle>{t('settings.apiGateway.address.label')}</SettingRowTitle>
          <span className="font-mono text-xs">{config ? `http://${config.host}:${config.port}/v1` : '—'}</span>
        </SettingRow>
        <SettingRow>
          <SettingRowTitle>{t('settings.apiGateway.restart.label')}</SettingRowTitle>
          <Button size="small" onClick={() => void handleRestart()} loading={restarting}>
            {t('settings.apiGateway.restart.action')}
          </Button>
        </SettingRow>
      </SettingGroup>
      <SettingGroup>
        <SettingTitle>{t('settings.apiGateway.lan.title')}</SettingTitle>
        <SettingRow>
          <SettingRowTitle>{t('settings.apiGateway.lan.label')}</SettingRowTitle>
          <Switch
            checked={config?.enabled === true}
            loading={lanPending}
            onChange={(checked) => void handleLanToggle(checked)}
          />
        </SettingRow>
        <SettingDescription>{t('settings.apiGateway.lan.hint')}</SettingDescription>
      </SettingGroup>
      <SettingGroup>
        <SettingTitle>{t('settings.apiGateway.port.title')}</SettingTitle>
        <SettingRow>
          <SettingRowTitle>{t('settings.apiGateway.port.label')}</SettingRowTitle>
          <InputNumber
            min={1}
            max={65535}
            value={portDraft}
            onChange={(value) => setPortDraft(typeof value === 'number' ? value : null)}
            disabled={saving}
          />
          <Button
            size="small"
            type="primary"
            onClick={() => void handleSavePort()}
            loading={saving}
            disabled={portDraft === null || portDraft === config?.port}>
            {t('settings.apiGateway.port.save')}
          </Button>
        </SettingRow>
        <SettingDescription>{t('settings.apiGateway.port.hint')}</SettingDescription>
      </SettingGroup>
    </SettingContainer>
  )
}

export default ApiGatewaySettings

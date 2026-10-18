import { GithubOutlined } from '@ant-design/icons'
import { HStack } from '@renderer/components/Layout'
import { APP_NAME, AppLogo } from '@renderer/config/env'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useMinappPopup } from '@renderer/hooks/useMinappPopup'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { ThemeMode } from '@renderer/types'
import { runAsyncFunction } from '@renderer/utils'
import type { AppUpdateErrorCode, AppUpdatePrefs } from '@shared/types/appUpdate'
import { sliceReleaseNotes } from '@shared/utils/releaseNotes'
import { Alert, Avatar, Button, Input, Progress, Row, Switch, Tag } from 'antd'
import { Github, RefreshCw, Rss } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import styled from 'styled-components'

import { SettingContainer, SettingDivider, SettingGroup, SettingRow, SettingTitle } from '.'

const AboutSettings: FC = () => {
  const [version, setVersion] = useState('')
  const [prefs, setPrefs] = useState<AppUpdatePrefs | null>(null)
  const [sourceDraft, setSourceDraft] = useState<string | null>(null)
  const { t, i18n } = useTranslation()
  const { theme } = useTheme()
  const { openSmartMinapp } = useMinappPopup()
  const { update } = useRuntime()

  const onOpenWebsite = (url: string) => {
    void window.api.openWebsite(url)
  }

  const showReleases = async () => {
    const { appPath } = await window.api.getAppInfo()
    openSmartMinapp({
      id: 'cherrystudio-releases',
      name: t('settings.about.releases.title'),
      url: `file://${appPath}/resources/cherry-studio/releases.html?theme=${theme === ThemeMode.dark ? 'dark' : 'light'}`,
      logo: AppLogo
    })
  }

  useEffect(() => {
    void runAsyncFunction(async () => {
      const appInfo = await window.api.getAppInfo()
      setVersion(appInfo.version)
    })
    void window.api.update.getPrefs().then((value) => setPrefs(value as AppUpdatePrefs))
  }, [])

  const patchPrefs = (patch: Partial<AppUpdatePrefs>) => {
    void window.api.update.setPrefs(patch).then((value) => setPrefs(value as AppUpdatePrefs))
  }

  const checking = update?.phase === 'checking'
  const downloading = update?.phase === 'downloading'
  const hasVersion = update?.latestVersion != null
  const showUpdateBlock = hasVersion && update?.phase !== 'latest' && update !== null
  const notes = sliceReleaseNotes(update?.releaseNotes, i18n.language)
  const progress = update?.progress ?? null
  const errorCode: AppUpdateErrorCode | null = update?.phase === 'error' ? (update.errorCode ?? 'io') : null

  return (
    <SettingContainer theme={theme}>
      <SettingGroup theme={theme}>
        <SettingTitle>
          {t('settings.about.title')}
          <HStack alignItems="center">
            <Link to="https://github.com/ayzek7011/Re_Cherry">
              <GithubOutlined style={{ marginRight: 4, color: 'var(--color-text)', fontSize: 20 }} />
            </Link>
          </HStack>
        </SettingTitle>
        <SettingDivider />
        <AboutHeader>
          <Row align="middle">
            <AvatarWrapper onClick={() => onOpenWebsite('https://github.com/ayzek7011/Re_Cherry')}>
              <Avatar src={AppLogo} size={80} style={{ minHeight: 80 }} />
            </AvatarWrapper>
            <VersionWrapper>
              <Title>{APP_NAME}</Title>
              <Description>{t('settings.about.description')}</Description>
              <Tag
                onClick={() => onOpenWebsite('https://github.com/ayzek7011/Re_Cherry/releases')}
                color="cyan"
                style={{ marginTop: 8, cursor: 'pointer' }}>
                v{version}
              </Tag>
            </VersionWrapper>
          </Row>
        </AboutHeader>
      </SettingGroup>
      <SettingGroup theme={theme}>
        <SettingRow>
          <SettingRowTitle>
            <Rss size={18} />
            {t('settings.about.releases.title')}
          </SettingRowTitle>
          <Button onClick={showReleases}>{t('settings.about.releases.button')}</Button>
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>
            <Github size={18} />
            {t('settings.about.feedback.title')}
          </SettingRowTitle>
          <Button onClick={() => onOpenWebsite('https://github.com/ayzek7011/Re_Cherry/issues/new/choose')}>
            {t('settings.about.feedback.button')}
          </Button>
        </SettingRow>
      </SettingGroup>
      <SettingGroup theme={theme}>
        <SettingTitle>
          <HStack alignItems="center" gap={10}>
            <RefreshCw size={18} />
            {t('settings.about.update.title')}
          </HStack>
        </SettingTitle>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.about.update.current')}</SettingRowTitle>
          <VersionText>v{update?.currentVersion ?? version}</VersionText>
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.about.update.checkTitle')}</SettingRowTitle>
          <HStack alignItems="center" gap={8}>
            <CheckHint>
              {checking
                ? t('settings.about.update.checking')
                : update?.manual && update?.phase === 'latest'
                  ? t('settings.about.update.latest')
                  : ''}
            </CheckHint>
            <Button loading={checking} onClick={() => void window.api.update.check({ manual: true })}>
              {t('settings.about.update.check')}
            </Button>
          </HStack>
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.about.update.autoDownload')}</SettingRowTitle>
          <Switch
            checked={prefs?.autoDownload === true}
            onChange={(checked) => patchPrefs({ autoDownload: checked })}
          />
        </SettingRow>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.about.update.source')}</SettingRowTitle>
          <HStack alignItems="center" gap={8}>
            <SourceInput
              value={sourceDraft ?? prefs?.sourceUrl ?? ''}
              placeholder={t('settings.about.update.sourcePlaceholder')}
              onChange={(event) => setSourceDraft(event.target.value)}
              onBlur={() => {
                if (sourceDraft === null) return
                patchPrefs({ sourceUrl: sourceDraft })
                setSourceDraft(null)
              }}
            />
            <Button onClick={() => patchPrefs({ sourceUrl: '' })}>{t('settings.about.update.sourceReset')}</Button>
          </HStack>
        </SettingRow>
        {showUpdateBlock && (
          <>
            <SettingDivider />
            <UpdateBlock>
              <UpdateHead>
                <NewVersionText>
                  {update?.ignored
                    ? t('settings.about.update.ignored', { version: update.latestVersion })
                    : t('settings.about.update.available', { version: update.latestVersion })}
                </NewVersionText>
                <HStack alignItems="center" gap={8}>
                  {update?.phase === 'available' && !update.ignored && (
                    <Button type="primary" onClick={() => void window.api.update.download()}>
                      {t('settings.about.update.download')}
                    </Button>
                  )}
                  {downloading && (
                    <Button onClick={() => void window.api.update.cancel()}>{t('settings.about.update.cancel')}</Button>
                  )}
                  {update?.phase === 'downloaded' && (
                    <Button type="primary" onClick={() => void window.api.update.install()}>
                      {t('settings.about.update.install')}
                    </Button>
                  )}
                  {update?.ignored ? (
                    <Button onClick={() => patchPrefs({ ignoredVersion: null })}>
                      {t('settings.about.update.unignore')}
                    </Button>
                  ) : (
                    <Button onClick={() => patchPrefs({ ignoredVersion: update?.latestVersion ?? null })}>
                      {t('settings.about.update.ignore')}
                    </Button>
                  )}
                  {update?.releasePageUrl && (
                    <Button onClick={() => onOpenWebsite(update.releasePageUrl as string)}>
                      {t('settings.about.update.openReleasePage')}
                    </Button>
                  )}
                </HStack>
              </UpdateHead>
              {downloading && progress && (
                <Progress
                  percent={progress.percent}
                  status="active"
                  format={() =>
                    `${formatBytes(progress.transferred)} / ${formatBytes(progress.total)} · ${formatBytes(progress.bytesPerSecond)}/s`
                  }
                />
              )}
              {/* `verified === null` 的语义是"源没给摘要" —— 它就是未校验，不能当通过。 */}
              {update?.phase === 'downloaded' && update.verified !== true && (
                <Alert type="warning" showIcon message={t('settings.about.update.unverified')} />
              )}
              {update?.phase === 'downloaded' && update.verified === true && (
                <Alert type="success" showIcon message={t('settings.about.update.verified')} />
              )}
              {errorCode === 'unsupported' ? (
                <Alert type="info" showIcon message={t('settings.about.update.portable')} />
              ) : errorCode ? (
                <Alert type="error" showIcon message={t(UPDATE_ERROR_KEY[errorCode])} />
              ) : null}
              {notes && (
                <>
                  <NotesTitle>{t('settings.about.update.releaseNotes')}</NotesTitle>
                  <NotesBlock>{notes}</NotesBlock>
                </>
              )}
            </UpdateBlock>
          </>
        )}
      </SettingGroup>
    </SettingContainer>
  )
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

/** 错误码 → 文案键。用显式映射而不是模板键：编译器能查穷尽，静态套件的语言键门禁也能逐条解析。 */
const UPDATE_ERROR_KEY: Record<AppUpdateErrorCode, string> = {
  digest: 'settings.about.update.error.digest',
  http: 'settings.about.update.error.http',
  io: 'settings.about.update.error.io',
  network: 'settings.about.update.error.network',
  'no-asset': 'settings.about.update.error.no-asset',
  parse: 'settings.about.update.error.parse',
  unsupported: 'settings.about.update.error.unsupported'
}

const AboutHeader = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 5px 0;
`

const VersionWrapper = styled.div`
  display: flex;
  flex-direction: column;
  min-height: 80px;
  justify-content: center;
  align-items: flex-start;
`

const Title = styled.div`
  font-size: 20px;
  font-weight: bold;
  color: var(--color-text-1);
  margin-bottom: 5px;
`

const Description = styled.div`
  font-size: 14px;
  color: var(--color-text-2);
  text-align: center;
`

const AvatarWrapper = styled.div`
  position: relative;
  cursor: pointer;
  margin-right: 15px;
`

const VersionText = styled.div`
  font-size: 14px;
  color: var(--color-text-1);
`

const CheckHint = styled.div`
  font-size: 12px;
  color: var(--color-text-2);
`

const SourceInput = styled(Input)`
  width: 320px;
`

const UpdateBlock = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  padding: 5px 0;
`

const UpdateHead = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
`

const NewVersionText = styled.div`
  font-size: 14px;
  font-weight: bold;
  color: var(--color-text-1);
`

const NotesTitle = styled.div`
  font-size: 13px;
  color: var(--color-text-2);
`

const NotesBlock = styled.div`
  max-height: 260px;
  overflow-y: auto;
  overflow-x: hidden;
  white-space: pre-wrap;
  word-break: break-word;
  scrollbar-gutter: stable;
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text-2);
  background: var(--color-background-soft);
  border-radius: 6px;
  padding: 10px 12px;
`

export const SettingRowTitle = styled.div`
  font-size: 14px;
  line-height: 18px;
  color: var(--color-text-1);
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  .anticon {
    font-size: 16px;
    color: var(--color-text-1);
  }
`

export default AboutSettings

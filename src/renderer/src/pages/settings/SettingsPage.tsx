import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import Scrollbar from '@renderer/components/Scrollbar'
import ModelSettings from '@renderer/pages/settings/ModelSettings/ModelSettings'
import { Divider as AntDivider, Skeleton } from 'antd'
import {
  BarChart3,
  Blocks,
  Cloud,
  Command,
  FileCode,
  Globe,
  HardDrive,
  Info,
  MonitorCog,
  Package,
  PictureInPicture2,
  RadioTower,
  Settings2,
  Sparkles,
  Zap
} from 'lucide-react'
import type { FC } from 'react'
import { lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Route, Routes, useLocation } from 'react-router-dom'
import styled from 'styled-components'

import AboutSettings from './AboutSettings'
import DisplaySettings from './DisplaySettings/DisplaySettings'
import DocProcessSettings from './DocProcessSettings'
import GeneralSettings from './GeneralSettings'
import MCPSettings from './MCPSettings'
import QuickAssistantSettings from './QuickAssistantSettings'
import QuickPhraseSettings from './QuickPhraseSettings'
import ShortcutSettings from './ShortcutSettings'
import UsageSettings from './UsageSettings/UsageSettings'
import WebSearchSettings from './WebSearchSettings'

/**
 * 设置内部再分割。
 *
 * v1 已做路由级懒加载（`Router.tsx` 的 `./pages/settings/SettingsPage`），但设置内部再无切分：
 * 打开「设置 → 通用」会同时求值技能页（1253 行）、12 个 DataSettings 面板、全部 ProviderSettings
 * 面板。这三类各自连着一批重依赖，且只在对应路由下才会被看到，改为按需加载。
 * `ProviderList` 是 barrel 的具名导出，故用 `.then()` 取 default。
 */
const ProviderList = lazy(() => import('./ProviderSettings').then((module) => ({ default: module.ProviderList })))
const DataSettings = lazy(() => import('./DataSettings/DataSettings'))
const SkillsSettings = lazy(() => import('./SkillsSettings'))
const ApiGatewaySettings = lazy(() => import('./ApiGatewaySettings'))

/** 子页懒加载占位：骨架（内容区专属，导航保持可见；静默空白是最差失败形态）。 */
const SettingsLoadingFallback: FC = () => (
  <div style={{ padding: 24, width: '100%' }} role="status" aria-busy="true" aria-live="polite">
    <Skeleton active paragraph={{ rows: 6 }} />
  </div>
)

const SettingsPage: FC = () => {
  const { pathname } = useLocation()
  const { t } = useTranslation()

  const isRoute = (path: string): string => (pathname.startsWith(path) ? 'active' : '')

  return (
    <Container>
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none' }}>{t('settings.title')}</NavbarCenter>
      </Navbar>
      <ContentContainer id="content-container">
        <SettingMenus>
          <MenuItemLink to="/settings/provider">
            <MenuItem className={isRoute('/settings/provider')}>
              <Cloud size={18} />
              {t('settings.provider.title')}
            </MenuItem>
          </MenuItemLink>
          <MenuItemLink to="/settings/model">
            <MenuItem className={isRoute('/settings/model')}>
              <Package size={18} />
              {t('settings.model')}
            </MenuItem>
          </MenuItemLink>
          <MenuItemLink to="/settings/websearch">
            <MenuItem className={isRoute('/settings/websearch')}>
              <Globe size={18} />
              {t('settings.tool.websearch.title')}
            </MenuItem>
          </MenuItemLink>
          <MenuItemLink to="/settings/docprocess">
            <MenuItem className={isRoute('/settings/docprocess')}>
              <FileCode size={18} />
              {t('settings.tool.preprocess.title')}
            </MenuItem>
          </MenuItemLink>
          <MenuItemLink to="/settings/mcp">
            <MenuItem className={isRoute('/settings/mcp')}>
              <Blocks size={18} />
              {t('settings.mcp.title')}
            </MenuItem>
          </MenuItemLink>
          <MenuItemLink to="/settings/skills">
            <MenuItem className={isRoute('/settings/skills')}>
              <Sparkles size={18} />
              {t('settings.skills.title')}
            </MenuItem>
          </MenuItemLink>
          <MenuItemLink to="/settings/api-gateway">
            <MenuItem className={isRoute('/settings/api-gateway')}>
              <RadioTower size={18} />
              {t('settings.apiGateway.title')}
            </MenuItem>
          </MenuItemLink>
          <Divider />
          <MenuItemLink to="/settings/general">
            <MenuItem className={isRoute('/settings/general')}>
              <Settings2 size={18} />
              {t('settings.general.label')}
            </MenuItem>
          </MenuItemLink>
          <MenuItemLink to="/settings/display">
            <MenuItem className={isRoute('/settings/display')}>
              <MonitorCog size={18} />
              {t('settings.display.title')}
            </MenuItem>
          </MenuItemLink>
          <MenuItemLink to="/settings/data">
            <MenuItem className={isRoute('/settings/data')}>
              <HardDrive size={18} />
              {t('settings.data.title')}
            </MenuItem>
          </MenuItemLink>
          <Divider />
          <MenuItemLink to="/settings/quickphrase">
            <MenuItem className={isRoute('/settings/quickphrase')}>
              <Zap size={18} />
              {t('settings.quickPhrase.title')}
            </MenuItem>
          </MenuItemLink>
          <MenuItemLink to="/settings/usage">
            <MenuItem className={isRoute('/settings/usage')}>
              <BarChart3 size={18} />
              {t('settings.usage.title')}
            </MenuItem>
          </MenuItemLink>
          <MenuItemLink to="/settings/shortcut">
            <MenuItem className={isRoute('/settings/shortcut')}>
              <Command size={18} />
              {t('settings.shortcuts.title')}
            </MenuItem>
          </MenuItemLink>
          <Divider />
          <MenuItemLink to="/settings/quickAssistant">
            <MenuItem className={isRoute('/settings/quickAssistant')}>
              <PictureInPicture2 size={18} />
              {t('settings.quickAssistant.title')}
            </MenuItem>
          </MenuItemLink>
          <Divider />
          <MenuItemLink to="/settings/about">
            <MenuItem className={isRoute('/settings/about')}>
              <Info size={18} />
              {t('settings.about.label')}
            </MenuItem>
          </MenuItemLink>
        </SettingMenus>
        <SettingContent>
          {/* 局部 Suspense：只替换内容区，设置导航不闪烁（外层 RouteLoadingFallback 会盖住整页）。 */}
          <Suspense fallback={<SettingsLoadingFallback />}>
            <Routes>
              <Route path="provider" element={<ProviderList />} />
              <Route path="model" element={<ModelSettings />} />
              <Route path="websearch/*" element={<WebSearchSettings />} />
              <Route path="docprocess" element={<DocProcessSettings />} />
              <Route path="mcp/*" element={<MCPSettings />} />
              <Route path="skills" element={<SkillsSettings />} />
              <Route path="api-gateway" element={<ApiGatewaySettings />} />

              <Route path="quickphrase" element={<QuickPhraseSettings />} />
              <Route path="usage" element={<UsageSettings />} />
              <Route path="general/*" element={<GeneralSettings />} />
              <Route path="display" element={<DisplaySettings />} />
              <Route path="shortcut" element={<ShortcutSettings />} />
              <Route path="quickAssistant" element={<QuickAssistantSettings />} />
              <Route path="data" element={<DataSettings />} />
              <Route path="about" element={<AboutSettings />} />
            </Routes>
          </Suspense>
        </SettingContent>
      </ContentContainer>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
`

const ContentContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  height: calc(100vh - var(--navbar-height));
  padding: 1px 0;
`

const SettingMenus = styled(Scrollbar)`
  display: flex;
  flex-direction: column;
  min-width: var(--settings-width);
  border-right: 0.5px solid var(--color-border);
  padding: 10px;
  user-select: none;
  gap: 5px;
`

const MenuItemLink = styled(Link)`
  text-decoration: none;
  color: var(--color-text-1);
`

const MenuItem = styled.li`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  width: 100%;
  cursor: pointer;
  border-radius: var(--list-item-border-radius);
  font-weight: 500;
  transition: all 0.2s ease-in-out;
  border: 0.5px solid transparent;
  .anticon {
    font-size: 16px;
    opacity: 0.8;
  }
  &:hover {
    background: var(--color-background-soft);
  }
  &.active {
    background: var(--color-background-soft);
    border: 0.5px solid var(--color-border);
  }
`

const SettingContent = styled.div`
  display: flex;
  height: 100%;
  flex: 1;
`

const Divider = styled(AntDivider)`
  margin: 3px 0;
`

export default SettingsPage

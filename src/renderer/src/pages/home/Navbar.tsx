import { Navbar, NavbarCenter, NavbarLeft, NavbarRight } from '@renderer/components/app/Navbar'
import { HStack } from '@renderer/components/Layout'
import SearchPopup from '@renderer/components/Popups/SearchPopup'
import { modelGenerating } from '@renderer/hooks/useRuntime'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useShowAssistants, useShowTopics } from '@renderer/hooks/useStore'
import { useAppDispatch } from '@renderer/store'
import { setNarrowMode } from '@renderer/store/settings'
import type { Assistant, Topic } from '@renderer/types'
import { Tooltip } from 'antd'
import { t } from 'i18next'
import { FolderOpen, Menu, PanelLeftClose, PanelRightClose, Search } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import type { FC } from 'react'
import styled from 'styled-components'

import NavbarIcon from '../../components/NavbarIcon'
import AssistantsDrawer from './components/AssistantsDrawer'
import UpdateAppButton from './components/UpdateAppButton'

interface Props {
  activeAssistant: Assistant
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
  setActiveAssistant: (assistant: Assistant) => void
  position: 'left' | 'right'
}

const HeaderNavbar: FC<Props> = ({ activeAssistant, setActiveAssistant, activeTopic, setActiveTopic }) => {
  const { showAssistants, toggleShowAssistants } = useShowAssistants()
  const { topicPosition, narrowMode } = useSettings()
  const { showTopics, toggleShowTopics } = useShowTopics()
  const dispatch = useAppDispatch()

  useShortcut('search_message', () => {
    void SearchPopup.show()
  })

  const handleNarrowModeToggle = async () => {
    await modelGenerating()
    dispatch(setNarrowMode(!narrowMode))
  }

  const onShowAssistantsDrawer = () => {
    void AssistantsDrawer.show({
      activeAssistant,
      setActiveAssistant,
      activeTopic,
      setActiveTopic
    })
  }

  return (
    <Navbar className="home-navbar">
      <AnimatePresence initial={false}>
        {showAssistants && (
          <motion.div
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 'auto', opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            style={{ overflow: 'hidden', display: 'flex', flexDirection: 'row' }}>
            <NavbarLeft style={{ justifyContent: 'space-between', borderRight: 'none', padding: 0 }}>
              <Tooltip title={t('navbar.hide_sidebar')} mouseEnterDelay={0.8}>
                <NavbarIcon onClick={toggleShowAssistants}>
                  <PanelLeftClose size={18} />
                </NavbarIcon>
              </Tooltip>
            </NavbarLeft>
          </motion.div>
        )}
      </AnimatePresence>
      {!showAssistants && (
        <NavbarLeft
          style={{
            justifyContent: 'flex-start',
            borderRight: 'none',
            paddingLeft: 0,
            paddingRight: 0,
            minWidth: 'auto'
          }}>
          <Tooltip title={t('navbar.show_sidebar')} mouseEnterDelay={0.8} placement="right">
            <NavbarIcon onClick={() => toggleShowAssistants()}>
              <PanelRightClose size={18} />
            </NavbarIcon>
          </Tooltip>
          <AnimatePresence initial={false}>
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 'auto', opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
              style={{ overflow: 'hidden' }}>
              <NavbarIcon onClick={onShowAssistantsDrawer} style={{ marginLeft: 8 }}>
                <Menu size={18} />
              </NavbarIcon>
            </motion.div>
          </AnimatePresence>
        </NavbarLeft>
      )}
      <NavbarCenter>
        {activeTopic.workMode === true && (
          <Tooltip
            title={
              activeAssistant.workMode?.workingDir
                ? activeAssistant.workMode.workingDir
                : t('message.workMode.defaultWorkspaceHint')
            }
            mouseEnterDelay={0.4}>
            <WorkingDirChip
              onClick={async () => {
                const dir = activeAssistant.workMode?.workingDir
                if (dir !== undefined && dir.length > 0) {
                  // 自定义工作目录：沙箱按会话 cwd 放行（SandboxPolicyService.resolve），直接外部打开
                  void window.api.openPath(dir)
                } else {
                  // 默认围栏（数据文件夹 .agent）属内部实现：引导去权限模式页设置。
                  // 弹窗连带 AgentSettings→CodeEditor/SelectModelPopup 链（低频入口，不进首屏静态图）。
                  const { default: AgentSettingsPopup } = await import(
                    '@renderer/pages/settings/AgentSettings/AgentSettingsPopup'
                  )
                  void AgentSettingsPopup.show({ assistant: activeAssistant, tab: 'permission-mode' })
                }
              }}>
              <FolderOpen size={13} strokeWidth={1.8} />
              <span className="truncate">
                {activeAssistant.workMode?.workingDir
                  ? (activeAssistant.workMode.workingDir.split(/[\\/]/).filter(Boolean).pop() ??
                    activeAssistant.workMode.workingDir)
                  : t('message.workMode.defaultWorkspace')}
              </span>
            </WorkingDirChip>
          </Tooltip>
        )}
      </NavbarCenter>
      <NavbarRight
        style={{
          justifyContent: 'flex-end',
          flex: 1,
          position: 'relative',
          paddingRight: '15px'
        }}
        className="home-navbar-right">
        <HStack alignItems="center" gap={6}>
          <UpdateAppButton />
          <Tooltip title={t('chat.assistant.search.placeholder')} mouseEnterDelay={0.8}>
            <NarrowIcon onClick={() => SearchPopup.show()}>
              <Search size={18} />
            </NarrowIcon>
          </Tooltip>
          <Tooltip title={t('navbar.expand')} mouseEnterDelay={0.8}>
            <NarrowIcon onClick={handleNarrowModeToggle}>
              <i className="iconfont icon-icon-adaptive-width"></i>
            </NarrowIcon>
          </Tooltip>
          {topicPosition === 'right' && !showTopics && (
            <Tooltip title={t('navbar.show_sidebar')} mouseEnterDelay={2}>
              <NavbarIcon onClick={toggleShowTopics}>
                <PanelLeftClose size={18} />
              </NavbarIcon>
            </Tooltip>
          )}
          {topicPosition === 'right' && showTopics && (
            <Tooltip title={t('navbar.hide_sidebar')} mouseEnterDelay={2}>
              <NavbarIcon onClick={toggleShowTopics}>
                <PanelRightClose size={18} />
              </NavbarIcon>
            </Tooltip>
          )}
        </HStack>
      </NavbarRight>
    </Navbar>
  )
}

const NarrowIcon = styled(NavbarIcon)`
  @media (max-width: 1000px) {
    display: none;
  }
`

/** 工作目录 chip（开放项 4）：工作模式激活时顶栏展示生效工作目录，点击外部打开或前往设置。 */
const WorkingDirChip = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 240px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 0.5px solid var(--color-border);
  background: var(--color-background-soft);
  color: var(--color-text-2);
  font-size: 12px;
  line-height: 1.6;
  white-space: nowrap;
  overflow: hidden;
  cursor: pointer;
  transition: opacity 0.15s ease;
  &:hover {
    opacity: 0.75;
  }
  > span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
`

export default HeaderNavbar

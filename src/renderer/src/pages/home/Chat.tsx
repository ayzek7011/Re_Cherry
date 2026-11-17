import { loggerService } from '@logger'
import type { ContentSearchRef } from '@renderer/components/ContentSearch'
import { ContentSearch } from '@renderer/components/ContentSearch'
import { HStack } from '@renderer/components/Layout'
import MultiSelectActionPopup from '@renderer/components/Popups/MultiSelectionPopup'
import PromptPopup from '@renderer/components/Popups/PromptPopup'
import { QuickPanelProvider } from '@renderer/components/QuickPanel'
import { isChatCandidateModel, isWebSearchModel } from '@renderer/config/models'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useNavbarPosition, useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useShowTopics } from '@renderer/hooks/useStore'
import { useTimer } from '@renderer/hooks/useTimer'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { syncTopicNameToKernel } from '@renderer/services/topicNaming'
import { useAppSelector } from '@renderer/store'
import type { Assistant, Model, Topic } from '@renderer/types'
import { classNames } from '@renderer/utils'
import { Flex } from 'antd'
import { debounce } from 'lodash-es'
import { AnimatePresence, motion } from 'motion/react'
import type { FC } from 'react'
import React, { useEffect, useRef, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import ChatNavbar from './components/ChatNavBar'
import Inputbar from './Inputbar/Inputbar'
import { ChatContextProvider } from './Messages/ChatContextProvider'
import ChatNavigation from './Messages/ChatNavigation'
import Messages from './Messages/Messages'
import Tabs from './Tabs'

const logger = loggerService.withContext('Chat')

interface Props {
  assistant: Assistant
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
  setActiveAssistant: (assistant: Assistant) => void
}

const Chat: FC<Props> = (props) => {
  const { assistant, updateAssistant, updateTopic } = useAssistant(props.assistant.id)
  const { t } = useTranslation()
  const { topicPosition, messageStyle, messageNavigation } = useSettings()
  const { showTopics } = useShowTopics()
  // 多选态是本组件唯一需要的聊天上下文产物（容器类名 + 弹窗开关），直接窄订阅；
  // 整个 useChatContext 只在 Messages/ChatContextProvider 里实例化一份。
  const isMultiSelectMode = useAppSelector((state) => state.runtime.chat.isMultiSelectMode)
  const { isTopNavbar } = useNavbarPosition()

  const mainRef = React.useRef<HTMLDivElement>(null)
  const contentSearchRef = React.useRef<ContentSearchRef>(null)
  const [filterIncludeUser, setFilterIncludeUser] = useState(false)

  const { setTimeoutTimer } = useTimer()

  useHotkeys('esc', () => {
    contentSearchRef.current?.disable()
  })

  useShortcut('search_message_in_chat', () => {
    try {
      const selectedText = window.getSelection()?.toString().trim()
      contentSearchRef.current?.enable(selectedText)
    } catch (error) {
      logger.error('Error enabling content search:', error as Error)
    }
  })

  useShortcut('rename_topic', async () => {
    const topic = props.activeTopic
    if (!topic) return

    void EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR)

    const name = await PromptPopup.show({
      title: t('chat.topics.edit.title'),
      message: '',
      defaultValue: topic.name || '',
      extraNode: <div style={{ color: 'var(--color-text-3)', marginTop: 8 }}>{t('chat.topics.edit.title_tip')}</div>
    })
    if (name && topic.name !== name) {
      const updatedTopic = { ...topic, name, isNameManuallyEdited: true }
      updateTopic(updatedTopic as Topic)
      syncTopicNameToKernel(topic.id, name)
    }
  })

  useShortcut('select_model', async () => {
    // 与聊天窗模型钮同一个判据（键盘入口不能有第二套口径）
    const modelFilter = (m: Model) => isChatCandidateModel(m)
    // 弹窗连带 ModelSettings/CodeEditor 链（快捷键低频入口，不进首屏静态图）。
    const { SelectChatModelPopup } = await import('@renderer/components/Popups/SelectModelPopup')
    const selectedModel = await SelectChatModelPopup.show({
      model: assistant?.model,
      filter: modelFilter
    })
    if (selectedModel) {
      const enabledWebSearch = isWebSearchModel(selectedModel)
      updateAssistant({
        model: selectedModel,
        // `undefined` = provider 还不知道（冷启动窗口）——只换模型，**不得**写回持久化开关。
        ...(enabledWebSearch === undefined ? {} : { enableWebSearch: enabledWebSearch && assistant.enableWebSearch })
      })
    }
  })

  const contentSearchFilter: NodeFilter = {
    acceptNode(node) {
      const container = node.parentElement?.closest('.message-content-container')
      if (!container) return NodeFilter.FILTER_REJECT

      const message = container.closest('.message')
      if (!message) return NodeFilter.FILTER_REJECT

      if (filterIncludeUser) {
        return NodeFilter.FILTER_ACCEPT
      }
      if (message.classList.contains('message-assistant')) {
        return NodeFilter.FILTER_ACCEPT
      }
      return NodeFilter.FILTER_REJECT
    }
  }

  const userOutlinedItemClickHandler = () => {
    setFilterIncludeUser(!filterIncludeUser)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeoutTimer(
          'userOutlinedItemClickHandler',
          () => {
            contentSearchRef.current?.search()
            contentSearchRef.current?.focus()
          },
          0
        )
      })
    })
  }

  // 首帧标记走 ref：局部 let 每次渲染都会重置，messagesComponentUpdateHandler 里
  // 读到的永远是 false，silentSearch 联动实际从未生效
  const firstUpdateCompletedRef = useRef(false)
  // 防抖器只建一份：在渲染体内创建且从不 cancel 会每次渲染遗弃一个 pending 定时器
  const firstUpdateDebounceRef = useRef<ReturnType<typeof debounce> | null>(null)
  if (!firstUpdateDebounceRef.current) {
    firstUpdateDebounceRef.current = debounce(() => {
      contentSearchRef.current?.silentSearch()
    }, 10)
  }
  useEffect(
    () => () => {
      firstUpdateDebounceRef.current?.cancel()
    },
    []
  )

  const messagesComponentUpdateHandler = () => {
    if (firstUpdateCompletedRef.current) {
      firstUpdateDebounceRef.current?.()
    }
  }

  const messagesComponentFirstUpdateHandler = () => {
    setTimeoutTimer('messagesComponentFirstUpdateHandler', () => (firstUpdateCompletedRef.current = true), 300)
    firstUpdateDebounceRef.current?.()
  }

  const mainHeight = isTopNavbar ? 'calc(100vh - var(--navbar-height) - 6px)' : 'calc(100vh - var(--navbar-height))'

  return (
    <Container id="chat" className={classNames([messageStyle, { 'multi-select-mode': isMultiSelectMode }])}>
      <HStack>
        <motion.div
          layout
          transition={{ duration: 0.3, ease: 'easeInOut' }}
          style={{ flex: 1, display: 'flex', minWidth: 0, overflow: 'hidden' }}>
          <Main
            ref={mainRef}
            id="chat-main"
            vertical
            flex={1}
            justify="space-between"
            style={{ height: mainHeight, width: '100%' }}>
            {/* 聊天上下文（useChatContext 的唯一实例）在此下发：消息区所有子组件改读 context */}
            <ChatContextProvider topic={props.activeTopic}>
              <QuickPanelProvider>
                <ChatNavbar
                  activeAssistant={props.assistant}
                  activeTopic={props.activeTopic}
                  setActiveTopic={props.setActiveTopic}
                  setActiveAssistant={props.setActiveAssistant}
                  position="left"
                />
                <div
                  className="flex flex-1 flex-col justify-between"
                  style={{ height: `calc(${mainHeight} - var(--navbar-height))` }}>
                  <Messages
                    key={props.activeTopic.id}
                    assistant={assistant}
                    topic={props.activeTopic}
                    setActiveTopic={props.setActiveTopic}
                    onComponentUpdate={messagesComponentUpdateHandler}
                    onFirstUpdate={messagesComponentFirstUpdateHandler}
                  />
                  <ContentSearch
                    ref={contentSearchRef}
                    searchTarget={mainRef as React.RefObject<HTMLElement>}
                    filter={contentSearchFilter}
                    includeUser={filterIncludeUser}
                    onIncludeUserChange={userOutlinedItemClickHandler}
                  />
                  {messageNavigation === 'buttons' && <ChatNavigation containerId="messages" />}
                  <Inputbar assistant={assistant} setActiveTopic={props.setActiveTopic} topic={props.activeTopic} />
                  {isMultiSelectMode && <MultiSelectActionPopup topic={props.activeTopic} />}
                </div>
              </QuickPanelProvider>
            </ChatContextProvider>
          </Main>
        </motion.div>
        <AnimatePresence initial={false}>
          {topicPosition === 'right' && showTopics && (
            <motion.div
              key="right-tabs"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 'var(--assistants-width)', opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
              style={{
                overflow: 'hidden'
              }}>
              <Tabs
                activeAssistant={assistant}
                activeTopic={props.activeTopic}
                setActiveAssistant={props.setActiveAssistant}
                setActiveTopic={props.setActiveTopic}
                position="right"
              />
            </motion.div>
          )}
        </AnimatePresence>
      </HStack>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--navbar-height));
  flex: 1;
  overflow: hidden;
  [navbar-position='top'] & {
    height: calc(100vh - var(--navbar-height) - 6px);
    background-color: var(--color-background);
    border-top-left-radius: 10px;
    border-bottom-left-radius: 10px;
  }
`

const Main = styled(Flex)`
  [navbar-position='left'] & {
    height: calc(100vh - var(--navbar-height));
  }
  transform: translateZ(0);
  position: relative;
`

export default Chat

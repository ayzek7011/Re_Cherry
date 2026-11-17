import { loggerService } from '@logger'
import { HStack } from '@renderer/components/Layout'
import { useAppDispatch } from '@renderer/store'
import { loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import type { InputRef } from 'antd'
import { Divider, Input } from 'antd'
import { last } from 'lodash-es'
import { ChevronLeft, CornerDownLeft, Search } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import SearchMessage from './components/SearchMessage'
import SearchResults from './components/SearchResults'
import TopicMessages from './components/TopicMessages'
import TopicsHistory from './components/TopicsHistory'

type Route = 'topics' | 'topic' | 'search' | 'message'

let _search = ''
let _stack: Route[] = ['topics']
let _topic: Topic | undefined
let _message: Message | undefined

const HistoryPage: FC = () => {
  const { t } = useTranslation()
  const [search, setSearch] = useState(_search)
  const [searchKeywords, setSearchKeywords] = useState(_search)
  const [stack, setStack] = useState<Route[]>(_stack)
  const [topic, setTopic] = useState<Topic | undefined>(_topic)
  const [message, setMessage] = useState<Message | undefined>(_message)
  const inputRef = useRef<InputRef>(null)
  const dispatch = useAppDispatch()

  _search = search
  _stack = stack
  _topic = topic
  _message = message

  const goBack = useCallback(() => {
    const _stack = [...stack]
    const route = _stack.pop()
    setStack(_stack)
    route === 'search' && setSearch('')
    route === 'topic' && setTopic(undefined)
    route === 'message' && setMessage(undefined)
  }, [stack])

  const onSearch = useCallback(() => {
    setSearchKeywords(search)
    setStack(['topics', 'search'])
    setTopic(undefined)
  }, [search])

  // topic 不包含 messages，用到的时候才会获取
  const onTopicClick = useCallback(
    (topic: Topic | null | undefined) => {
      if (!topic) {
        window.toast.error(t('history.error.topic_not_found'))
        return
      }
      setStack((prev) => [...prev, 'topic'])
      setTopic(topic)
    },
    [t]
  )

  // 两个话题入口的面板签名不同（`TopicsHistory` 除回调外还接受 div 的鼠标事件），
  // 各自包一层；`useCallback` 保证 memo 的比较基准稳定。
  const handleTopicSelect = useCallback((topic: Topic) => onTopicClick(topic), [onTopicClick])
  const handleHistoryTopicClick = useCallback((topic: Topic) => onTopicClick(topic), [onTopicClick])

  const onMessageClick = useCallback(
    (message: Message) => {
      void dispatch(loadTopicMessagesThunk(message.topicId)).catch((error) => {
        // 同上，仅防未处理拒绝。
        logger.warn(`HistoryPage: failed to load messages for topic ${message.topicId}`, error as Error)
      })
      setStack(['topics', 'search', 'message'])
      setMessage(message)
    },
    [dispatch]
  )

  const isShow = (route: Route) => last(stack) === route
  const panelStyle = (route: Route) => (isShow(route) ? { display: 'flex' } : { display: 'none' })

  // 面板的 `style` 必须是稳定引用：`TopicsHistory` / `SearchResults` 已 memo，
  // 每次渲染新建内联对象会让 memo 完全失效，搜索框每敲一个字符都重渲染四个面板。
  const topicsPanelStyle = useMemo(() => panelStyle('topics'), [stack])
  const searchPanelStyle = useMemo(() => panelStyle('search'), [stack])
  const isSearchVisible = isShow('search')

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
    }
  }, [])

  return (
    <Container>
      <HStack style={{ padding: '0 12px', marginTop: 8 }}>
        <Input
          prefix={
            stack.length > 1 ? (
              <SearchIcon className="back-icon" onClick={goBack}>
                <ChevronLeft size={16} />
              </SearchIcon>
            ) : (
              <SearchIcon>
                <Search size={15} />
              </SearchIcon>
            )
          }
          suffix={search.length ? <CornerDownLeft size={16} /> : null}
          ref={inputRef}
          placeholder={t('history.search.placeholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value.trimStart())}
          allowClear
          autoFocus
          spellCheck={false}
          style={{ paddingLeft: 0 }}
          variant="borderless"
          size="middle"
          onPressEnter={onSearch}
        />
      </HStack>
      <Divider style={{ margin: 0, marginTop: 4, borderBlockStartWidth: 0.5 }} />

      <TopicsHistory keywords={search} onTopicClick={handleTopicSelect} onSearch={onSearch} style={topicsPanelStyle} />
      <TopicMessages topic={topic} style={panelStyle('topic')} />
      {/* 隐藏交给 `visible` + `style`，不再用"喂空串"表达不可见：
          喂空串会清空结果与高亮词，返回搜索视图时又重发一次内核检索并闪一次 spinner。 */}
      <SearchResults
        keywords={searchKeywords}
        visible={isSearchVisible}
        onMessageClick={onMessageClick}
        onTopicClick={handleHistoryTopicClick}
        style={searchPanelStyle}
      />
      <SearchMessage message={message} style={panelStyle('message')} />
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  height: 100%;
`

const SearchIcon = styled.div`
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  background-color: var(--color-background-soft);
  margin-right: 2px;
  &.back-icon {
    cursor: pointer;
    transition: background-color 0.2s;
    &:hover {
      background-color: var(--color-background-mute);
    }
  }
`

const logger = loggerService.withContext('HistoryPage')

export default HistoryPage

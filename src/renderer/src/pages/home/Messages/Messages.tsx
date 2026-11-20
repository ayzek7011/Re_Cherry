import { loggerService } from '@logger'
import { HtmlArtifactPopupHost } from '@renderer/components/CodeBlockView/HtmlArtifactPopupContext'
import ContextMenu from '@renderer/components/ContextMenu'
import { LoadingIcon } from '@renderer/components/Icons'
import { LOAD_MORE_COUNT } from '@renderer/config/constant'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useMessageOperations, useTopicMessages } from '@renderer/hooks/useMessageOperations'
import useScrollPosition from '@renderer/hooks/useScrollPosition'
import { useSetting } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useTimer } from '@renderer/hooks/useTimer'
import SelectionBox from '@renderer/pages/home/Messages/SelectionBox'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { getGroupedMessages } from '@renderer/services/MessagesService'
import { estimateHistoryTokens } from '@renderer/services/TokenService'
import store, { useAppDispatch } from '@renderer/store'
import { messageBlocksSelectors, updateOneBlock } from '@renderer/store/messageBlock'
import { updateMessageAndBlocksThunk } from '@renderer/store/thunk/messageThunk'
import type { Assistant, Topic } from '@renderer/types'
import type { MessageBlock } from '@renderer/types/newMessage'
import { type Message, MessageBlockType } from '@renderer/types/newMessage'
import {
  captureScrollableAsBlob,
  captureScrollableAsDataURL,
  removeSpecialCharactersForFileName,
  runAsyncFunction
} from '@renderer/utils'
import { updateCodeBlock } from '@renderer/utils/markdown'
import { getMainTextContent } from '@renderer/utils/messageUtils/find'
import { isTextLikeBlock } from '@renderer/utils/messageUtils/is'
import { last, throttle } from 'lodash-es'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import InfiniteScroll from 'react-infinite-scroll-component'
import styled from 'styled-components'

import { useChatContextValue } from './ChatContextProvider'
import {
  computeDisplayMessages,
  type DisplayOrderCache,
  EMPTY_DISPLAY_ORDER_CACHE,
  projectDisplayMessages,
  resolveDisplayOrder
} from './displayWindow'
import MessageAnchorLine from './MessageAnchorLine'
import MessageGroup from './MessageGroup'
import NarrowLayout from './NarrowLayout'
import Prompt from './Prompt'
import { MessagesContainer, ScrollContainer, scrollMessagesToBottom } from './shared'
import useParallelAnswers from './useParallelAnswers'

interface MessagesProps {
  assistant: Assistant
  topic: Topic
  setActiveTopic: (topic: Topic) => void
  onComponentUpdate?(): void
  onFirstUpdate?(): void
}

const logger = loggerService.withContext('Messages')

const Messages: React.FC<MessagesProps> = ({
  assistant,
  topic,
  setActiveTopic: _setActiveTopic,
  onComponentUpdate,
  onFirstUpdate
}) => {
  const { containerRef: scrollContainerRef, handleScroll: handleScrollPosition } = useScrollPosition(
    `topic-${topic.id}`
  )
  const [displayMessages, setDisplayMessages] = useState<Message[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  useAssistant(assistant.id)
  const showPrompt = useSetting('showPrompt')
  const messageNavigation = useSetting('messageNavigation')
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const messages = useTopicMessages(topic.id)
  const { displayCount, clearTopicMessages } = useMessageOperations(topic)
  const { setTimeoutTimer } = useTimer()

  const { isMultiSelectMode, handleSelectMessage } = useChatContextValue()

  const messageElements = useRef<Map<string, HTMLElement>>(new Map())
  const messagesRef = useRef<Message[]>(messages)
  const firstUpdateNotifiedRef = useRef(false)
  const displayOrderRef = useRef<DisplayOrderCache>(EMPTY_DISPLAY_ORDER_CACHE)

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const registerMessageElement = useCallback((id: string, element: HTMLElement | null) => {
    if (element) {
      messageElements.current.set(id, element)
    } else {
      messageElements.current.delete(id)
    }
  }, [])

  useEffect(() => {
    // 窗口"选中顺序"只在条数与末条变化时重算（computeDisplayMessages 是 O(全量) 反向推导）；
    // 流式内容变化只换实体引用 —— 但引用必须换，否则 MessageGroup 的 memo 会拿旧实体、流式文本冻结。
    // byId 同时交给 resolveDisplayOrder 做「缓存里的 id 是否都还在」的校验：回合开始时用户消息 id
    // 会重映射（临时 id → 内核 id），此时条数/末条都可能不变，只比 key 会让缓存里的旧 id 查不到实体，
    // 用户卡片会被静默吞掉（真机实证：生成期间消失、回合结束后回来）。
    const byId = new Map(messages.map((message) => [message.id, message]))
    displayOrderRef.current = resolveDisplayOrder(displayOrderRef.current, messages, displayCount, undefined, byId)
    setDisplayMessages((prev) => projectDisplayMessages(prev, displayOrderRef.current.ids, byId))
    setHasMore(messages.length > displayCount)
  }, [messages, displayCount])

  // NOTE: 如果设置为平滑滚动会导致滚动条无法跟随生成的新消息保持在底部位置
  const scrollToBottom = useCallback(() => {
    if (scrollContainerRef.current) {
      requestAnimationFrame(() => {
        scrollMessagesToBottom(scrollContainerRef.current)
      })
    }
  }, [scrollContainerRef])

  const clearTopic = useCallback(
    async (data: Topic) => {
      if (data && data.id !== topic.id) {
        await clearTopicMessages(data.id)
        return
      }

      await clearTopicMessages()
      setDisplayMessages([])
    },
    [clearTopicMessages, topic.id]
  )

  useEffect(() => {
    const unsubscribes = [
      EventEmitter.on(EVENT_NAMES.SEND_MESSAGE, scrollToBottom),
      EventEmitter.on(EVENT_NAMES.CLEAR_MESSAGES, async (data: Topic) => {
        window.modal.confirm({
          title: t('chat.input.clear.title'),
          content: t('chat.input.clear.content'),
          centered: true,
          onOk: () => clearTopic(data)
        })
      }),
      EventEmitter.on(EVENT_NAMES.COPY_TOPIC_IMAGE, async () => {
        await captureScrollableAsBlob(scrollContainerRef, async (blob) => {
          if (blob) {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
          }
        })
      }),
      EventEmitter.on(EVENT_NAMES.EXPORT_TOPIC_IMAGE, async () => {
        const imageData = await captureScrollableAsDataURL(scrollContainerRef)
        if (imageData) {
          void window.api.file.saveImage(removeSpecialCharactersForFileName(topic.name), imageData)
        }
      }),
      EventEmitter.on(
        EVENT_NAMES.EDIT_CODE_BLOCK,
        async (data: { msgBlockId: string; codeBlockId: string; newContent: string }) => {
          const { msgBlockId, codeBlockId, newContent } = data

          const msgBlock = messageBlocksSelectors.selectById(store.getState(), msgBlockId)

          // FIXME: 目前 error block 没有 content
          if (msgBlock && isTextLikeBlock(msgBlock) && msgBlock.type !== MessageBlockType.ERROR) {
            try {
              const updatedRaw = updateCodeBlock(msgBlock.content, codeBlockId, newContent)
              const updatedBlock: MessageBlock = {
                ...msgBlock,
                content: updatedRaw,
                updatedAt: new Date().toISOString()
              }

              dispatch(updateOneBlock({ id: msgBlockId, changes: { content: updatedRaw } }))
              await dispatch(updateMessageAndBlocksThunk(topic.id, null, [updatedBlock]))

              window.toast.success(t('code_block.edit.save.success'))
            } catch (error) {
              logger.error(
                `Failed to save code block ${codeBlockId} content to message block ${msgBlockId}:`,
                error as Error
              )
              window.toast.error(t('code_block.edit.save.failed.label'))
            }
          } else {
            logger.error(
              `Failed to save code block ${codeBlockId} content to message block ${msgBlockId}: no such message block or the block doesn't have a content field`
            )
            window.toast.error(t('code_block.edit.save.failed.label'))
          }
        }
      )
    ]

    return () => unsubscribes.forEach((unsub) => unsub())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistant, dispatch, scrollToBottom, topic])

  // 历史 token / 上下文计数做速率限制（leading + trailing，最多 2 次/秒）。
  // estimateHistoryTokens 会逐条 await getMessageParam 并拼接全文，而 messages 引用每个流式 delta 都换：
  // 不设限等于每帧全量重算。
  // 不用"只在条数/末条变化时算"的取舍：那会让生成期间计数冻结，属可见行为变更。
  const estimateTokensThrottledRef = useRef<ReturnType<typeof throttle> | null>(null)
  useEffect(() => {
    if (!estimateTokensThrottledRef.current) {
      estimateTokensThrottledRef.current = throttle((currentMessages: Message[], currentAssistant: Assistant) => {
        void runAsyncFunction(async () => {
          void EventEmitter.emit(EVENT_NAMES.ESTIMATED_TOKEN_COUNT, {
            tokensCount: await estimateHistoryTokens(currentAssistant, currentMessages)
          })
        })
      }, 500)
    }

    estimateTokensThrottledRef.current(messages, assistant)

    // 首帧回调只许触发一次：旧实现挂在估算 promise 的 .then 上，每个 delta 都回调一次
    // （反复重置 Chat 侧 300ms 首帧标记并重触发 silentSearch 防抖）。
    if (firstUpdateNotifiedRef.current) return
    firstUpdateNotifiedRef.current = true
    onFirstUpdate?.()
  }, [assistant, messages, onFirstUpdate])

  useEffect(() => {
    return () => {
      estimateTokensThrottledRef.current?.cancel()
    }
  }, [])

  const loadMoreMessages = useCallback(() => {
    if (!hasMore || isLoadingMore) return

    setIsLoadingMore(true)
    setTimeoutTimer(
      'loadMoreMessages',
      () => {
        const currentLength = displayMessages.length
        const newMessages = computeDisplayMessages(messages, currentLength, LOAD_MORE_COUNT)

        setDisplayMessages((prev) => [...prev, ...newMessages])
        setHasMore(currentLength + LOAD_MORE_COUNT < messages.length)
        setIsLoadingMore(false)
      },
      300
    )
  }, [displayMessages.length, hasMore, isLoadingMore, messages, setTimeoutTimer])

  useShortcut('copy_last_message', () => {
    const lastMessage = last(messages)
    if (lastMessage) {
      void navigator.clipboard.writeText(getMainTextContent(lastMessage))
      window.toast.success(t('message.copy.success'))
    }
  })

  useShortcut('edit_last_user_message', () => {
    const lastUserMessage = messagesRef.current.findLast((m) => m.role === 'user' && m.type !== 'clear')
    if (lastUserMessage) {
      void EventEmitter.emit(EVENT_NAMES.EDIT_MESSAGE, lastUserMessage.id)
    }
  })

  useEffect(() => {
    requestAnimationFrame(() => onComponentUpdate?.())
  }, [onComponentUpdate])

  // 并行回答（隐藏 parallel 子会话的旁答）：家族投影供给，仅作分组显示合并
  const parallelAnswers = useParallelAnswers(topic)

  // NOTE: 因为displayMessages是倒序的，所以得到的groupedMessages每个group内部也是倒序的，需要再倒一遍
  const groupedMessages = useMemo(() => {
    const grouped = Object.entries(getGroupedMessages(displayMessages))
    const newGrouped: {
      [key: string]: (Message & {
        index: number
      })[]
    } = {}
    grouped.forEach(([key, group]) => {
      const reversed = group.toReversed()
      // parallel 旁答并进对应问题的答案组（v1 多模型卡片）：追加在组尾（点选序）。
      // 只影响显示合并——不进 displayMessages 平铺（锚点/上下文计数/加载窗口均不受影响）。
      if (key.startsWith('assistant') && parallelAnswers.size > 0) {
        const extra = parallelAnswers.get(key.slice('assistant'.length))
        if (extra !== undefined && extra.length > 0) {
          reversed.push(...extra.map((m) => ({ ...m, index: -1 })))
        }
      }
      newGrouped[key] = reversed
    })
    return Object.entries(newGrouped)
  }, [displayMessages, parallelAnswers])

  return (
    <HtmlArtifactPopupHost>
      <MessagesContainer
        id="messages"
        className="messages-container"
        ref={scrollContainerRef}
        key={assistant.id}
        onScroll={handleScrollPosition}>
        <NarrowLayout style={{ display: 'flex', flexDirection: 'column-reverse' }}>
          <InfiniteScroll
            dataLength={displayMessages.length}
            next={loadMoreMessages}
            hasMore={hasMore}
            loader={null}
            scrollableTarget="messages"
            inverse
            style={{ overflow: 'visible' }}>
            <ContextMenu>
              <ScrollContainer>
                {groupedMessages.map(([key, groupMessages]) => (
                  <MessageGroup
                    key={key}
                    messages={groupMessages}
                    topic={topic}
                    registerMessageElement={registerMessageElement}
                  />
                ))}
                {isLoadingMore && (
                  <LoaderContainer>
                    <LoadingIcon color="var(--color-text-2)" />
                  </LoaderContainer>
                )}
              </ScrollContainer>
            </ContextMenu>
          </InfiniteScroll>

          {showPrompt && <Prompt assistant={assistant} key={assistant.prompt} topic={topic} />}
        </NarrowLayout>
        {messageNavigation === 'anchor' && <MessageAnchorLine messages={displayMessages} />}
        <SelectionBox
          isMultiSelectMode={isMultiSelectMode}
          scrollContainerRef={scrollContainerRef}
          messageElements={messageElements.current}
          handleSelectMessage={handleSelectMessage}
        />
      </MessagesContainer>
    </HtmlArtifactPopupHost>
  )
}

const LoaderContainer = styled.div`
  display: flex;
  justify-content: center;
  padding: 10px;
  width: 100%;
  background: var(--color-background);
  pointer-events: none;
`

export default Messages

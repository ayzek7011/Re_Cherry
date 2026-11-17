import AddButton from '@renderer/components/AddButton'
import AssistantAvatar from '@renderer/components/Avatar/AssistantAvatar'
import type { DraggableVirtualListRef } from '@renderer/components/DraggableList'
import { DraggableVirtualList } from '@renderer/components/DraggableList'
import { CopyIcon, DeleteIcon, EditIcon } from '@renderer/components/Icons'
import PromptPopup from '@renderer/components/Popups/PromptPopup'
import { isMac } from '@renderer/config/constant'
import { useAssistant, useAssistants } from '@renderer/hooks/useAssistant'
import { useInPlaceEdit } from '@renderer/hooks/useInPlaceEdit'
import { modelGenerating } from '@renderer/hooks/useRuntime'
import { useSettings } from '@renderer/hooks/useSettings'
import { finishTopicRenaming, startTopicRenaming, TopicManager } from '@renderer/hooks/useTopic'
import { fetchMessagesSummary } from '@renderer/services/ApiService'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { syncTopicNameToKernel } from '@renderer/services/topicNaming'
import type { RootState } from '@renderer/store'
import store from '@renderer/store'
import { newMessagesActions, selectGeneratingTopicIds } from '@renderer/store/newMessage'
import { setGenerating } from '@renderer/store/runtime'
import type { Assistant, Topic } from '@renderer/types'
import { classNames, removeSpecialCharactersForFileName } from '@renderer/utils'
import { copyTopicAsMarkdown, copyTopicAsPlainText } from '@renderer/utils/copy'
import {
  exportMarkdownToJoplin,
  exportMarkdownToSiyuan,
  exportMarkdownToYuque,
  exportTopicAsMarkdown,
  exportTopicToNotion,
  topicToMarkdown
} from '@renderer/utils/export'
import { listRootTopics, recallLastViewedBranch, rootTopicOf } from '@renderer/utils/topicBranch'
import type { MenuProps } from 'antd'
import { Dropdown, Tooltip } from 'antd'
import type { ItemType, MenuItemType } from 'antd/es/menu/interface'
import dayjs from 'dayjs'
import { findIndex } from 'lodash-es'
import {
  BrushCleaning,
  CheckSquare,
  FolderOpen,
  HelpCircle,
  ListChecks,
  MenuIcon,
  NotebookPen,
  PackagePlus,
  PinIcon,
  PinOffIcon,
  Sparkles,
  Square,
  UploadIcon,
  XIcon
} from 'lucide-react'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDispatch, useSelector } from 'react-redux'
import styled from 'styled-components'

import { TopicManagePanel, useTopicManageMode } from './TopicManageMode'

interface Props {
  assistant: Assistant
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
  position: 'left' | 'right'
}

export const Topics: React.FC<Props> = ({ assistant: _assistant, activeTopic, setActiveTopic, position }) => {
  const { t } = useTranslation()
  const { assistants } = useAssistants()
  const { assistant, addTopic, removeTopic, moveTopic, updateTopic, updateTopics } = useAssistant(_assistant.id)
  // 侧栏只展示"根话题"；fork 分支仅通过分支图切换。
  //
  // 显示序单源化：列表直接派生自 Redux 数组（listRootTopics），不再持有"对账快照"。
  // 旧快照（reconciledRoots）取的是注册表序（updatedAt desc = 最近活动序），三宗罪同根：
  // ①吞掉拖拽/置顶写入的数组序（用户排了也白排）；②改名/自动命名写入 store 却不刷新
  //   （名字一直显示旧值，直到数组成员变化才偶然恢复）；③每次对账重触发整列表按最近
  //   活动重排（顺序乱跳）。内核权威不受影响：对账（补齐/剪除，写入 store）照旧由
  // useTopic 兜底执行；本组件只做纯派生——store 变了立刻生效。
  const rootTopics = useMemo(() => listRootTopics(assistant?.topics ?? []), [assistant?.topics])
  const { showTopicTime, setTopicPosition, topicPosition } = useSettings()

  const renamingTopics = useSelector((state: RootState) => state.runtime.chat.renamingTopics)
  // 第三轮：pending 信号改为**回合口径**（PENDING/PROCESSING 的助手消息存在）——
  // 旧的 loadingByTopic 挂在发送任务队列上，queue 排空即熄（内核流还在打），黄点半路死；
  // fulfilled 的 true 已改在 kernelChat.finishTurn（回合真正结束时）落地。
  const generatingTopicIds = useSelector(selectGeneratingTopicIds)
  const topicFulfilledQuery = useSelector((state: RootState) => state.messages.fulfilledByTopic)
  const newlyRenamedTopics = useSelector((state: RootState) => state.runtime.chat.newlyRenamedTopics)

  const borderRadius = showTopicTime ? 12 : 'var(--list-item-border-radius)'

  const [deletingTopicId, setDeletingTopicId] = useState<string | null>(null)
  const deleteTimerRef = useRef<NodeJS.Timeout>(null)
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null)
  const listRef = useRef<DraggableVirtualListRef>(null)

  // 管理模式状态
  const manageState = useTopicManageMode()
  const { isManageMode, selectedIds, searchText, enterManageMode, exitManageMode, toggleSelectTopic } = manageState

  const { startEdit, isEditing, inputProps } = useInPlaceEdit({
    onSave: (name: string) => {
      const topic = assistant.topics.find((t) => t.id === editingTopicId)
      if (topic && name !== topic.name) {
        const updatedTopic = { ...topic, name, isNameManuallyEdited: true }
        updateTopic(updatedTopic)
        syncTopicNameToKernel(topic.id, name)
        window.toast.success(t('common.saved'))
      }
      setEditingTopicId(null)
    },
    onCancel: () => {
      setEditingTopicId(null)
    }
  })

  const isPending = useCallback((topicId: string) => generatingTopicIds.has(topicId), [generatingTopicIds])
  const isFulfilled = useCallback((topicId: string) => topicFulfilledQuery[topicId], [topicFulfilledQuery])
  const dispatch = useDispatch()

  useEffect(() => {
    // 第三轮：清除端与写入端同域（**根 id 投影**，kernelChat.finishTurn 记账在根行）。
    // rootTopicOf 拿 activeTopic 行对象上溯，行不在本帧清单也能经由 parentTopicId 到根。
    const rootId = rootTopicOf(activeTopic, assistant?.topics ?? []).id
    dispatch(newMessagesActions.setTopicFulfilled({ topicId: rootId, fulfilled: false }))
    // 依赖含 activeTopic 与 assistant?.topics：上溯链的中间行可能后到清单（分支新建/清单刷新），
    // 清单变则根 id 可能变。重跑是幂等的——reducer 同值赋值在 immer 下不产生新 revision，不成环。
  }, [activeTopic, assistant?.topics, dispatch, topicFulfilledQuery])

  const isRenaming = useCallback(
    (topicId: string) => {
      return renamingTopics.includes(topicId)
    },
    [renamingTopics]
  )

  const isNewlyRenamed = useCallback(
    (topicId: string) => {
      return newlyRenamedTopics.includes(topicId)
    },
    [newlyRenamedTopics]
  )

  const handleDeleteClick = useCallback((topicId: string, e: React.MouseEvent) => {
    e.stopPropagation()

    if (deleteTimerRef.current) {
      clearTimeout(deleteTimerRef.current)
    }

    setDeletingTopicId(topicId)

    deleteTimerRef.current = setTimeout(() => setDeletingTopicId(null), 2000)
  }, [])

  const onClearMessages = useCallback((topic: Topic) => {
    // window.keyv.set(EVENT_NAMES.CHAT_COMPLETION_PAUSED, true)
    store.dispatch(setGenerating(false))
    void EventEmitter.emit(EVENT_NAMES.CLEAR_MESSAGES, topic)
  }, [])

  const handleConfirmDelete = useCallback(
    async (topic: Topic, e: React.MouseEvent) => {
      e.stopPropagation()
      if (rootTopics.length === 1) {
        const newTopic = getDefaultTopic(assistant.id)
        addTopic(newTopic)
        setActiveTopic(newTopic)
      } else {
        const index = findIndex(rootTopics, (t) => t.id === topic.id)
        if (topic.id === activeTopic.id) {
          setActiveTopic(rootTopics[index + 1 === rootTopics.length ? index - 1 : index + 1])
        }
      }
      await modelGenerating()
      removeTopic(topic)
      setDeletingTopicId(null)
    },
    [activeTopic.id, addTopic, assistant.id, removeTopic, rootTopics, setActiveTopic]
  )

  // 第三轮（验收反馈"置顶还乱动"）：置顶改为**纯显示层分组**。
  // 旧实现是"物理重排版"（点击时写数组序），受 pinTopicsToTop 开关门控，且与浮顶/拖拽
  // 全都挤同一个数组序——谁后写谁赢，正是"点了置顶还是乱动"的病根。
  // 新语义：置顶行永远在顶区（与数组序解耦），点击只翻转 pinned 位；浮顶/拖拽只影响
  // 非置顶区的相对顺序，永远挤不动置顶区。
  const onPinTopic = useCallback(
    (topic: Topic) => {
      updateTopic({ ...topic, pinned: !topic.pinned })
    },
    [updateTopic]
  )

  const onDeleteTopic = useCallback(
    async (topic: Topic) => {
      await modelGenerating()
      if (topic.id === activeTopic?.id) {
        const index = findIndex(rootTopics, (t) => t.id === topic.id)
        setActiveTopic(rootTopics[index + 1 === rootTopics.length ? index - 1 : index + 1])
      }
      removeTopic(topic)
    },
    [removeTopic, rootTopics, setActiveTopic, activeTopic]
  )

  const onMoveTopic = useCallback(
    async (topic: Topic, toAssistant: Assistant) => {
      await modelGenerating()
      const index = findIndex(rootTopics, (t) => t.id === topic.id)
      setActiveTopic(rootTopics[index + 1 === rootTopics.length ? 0 : index + 1])
      moveTopic(topic, toAssistant)
    },
    [moveTopic, rootTopics, setActiveTopic]
  )

  const onSwitchTopic = useCallback(
    async (topic: Topic) => {
      // await modelGenerating()
      // 家族浏览记忆：进话题时恢复上次浏览的分支（无记忆/分支已删 → 落回点击的根话题）
      const recalled = recallLastViewedBranch(topic, assistant?.topics ?? [])
      setActiveTopic(recalled)
    },
    [setActiveTopic, assistant]
  )

  const exportMenuOptions = useSelector((state: RootState) => state.settings.exportMenuOptions)

  const [_targetTopic, setTargetTopic] = useState<Topic | null>(null)
  const targetTopic = useDeferredValue(_targetTopic)
  const getTopicMenuItems = useMemo(() => {
    const topic = targetTopic
    if (!topic) return []

    const menus: MenuProps['items'] = [
      {
        label: t('chat.topics.auto_rename'),
        key: 'auto-rename',
        icon: <Sparkles size={14} />,
        disabled: isRenaming(topic.id),
        async onClick() {
          const messages = await TopicManager.getTopicMessages(topic.id)
          if (messages.length >= 2) {
            startTopicRenaming(topic.id)
            try {
              const { text: summaryText, error } = await fetchMessagesSummary({ messages })
              if (summaryText) {
                const updatedTopic = { ...topic, name: summaryText, isNameManuallyEdited: false }
                updateTopic(updatedTopic)
                syncTopicNameToKernel(topic.id, summaryText)
              } else if (error) {
                window.toast?.error(`${t('message.error.fetchTopicName')}: ${error}`)
              }
            } finally {
              finishTopicRenaming(topic.id)
            }
          }
        }
      },
      {
        label: t('chat.topics.edit.title'),
        key: 'rename',
        icon: <EditIcon size={14} />,
        disabled: isRenaming(topic.id),
        async onClick() {
          const name = await PromptPopup.show({
            title: t('chat.topics.edit.title'),
            message: '',
            defaultValue: topic?.name || '',
            extraNode: (
              <div style={{ color: 'var(--color-text-3)', marginTop: 8 }}>{t('chat.topics.edit.title_tip')}</div>
            )
          })
          if (name && topic?.name !== name) {
            const updatedTopic = { ...topic, name, isNameManuallyEdited: true }
            updateTopic(updatedTopic)
            syncTopicNameToKernel(topic.id, name)
          }
        }
      },
      {
        label: t('chat.topics.prompt.label'),
        key: 'topic-prompt',
        icon: <PackagePlus size={14} />,
        extra: (
          <Tooltip title={t('chat.topics.prompt.tips')}>
            <HelpCircle size={14} />
          </Tooltip>
        ),
        async onClick() {
          const prompt = await PromptPopup.show({
            title: t('chat.topics.prompt.edit.title'),
            message: '',
            defaultValue: topic?.prompt || '',
            inputProps: {
              rows: 8,
              allowClear: true
            }
          })

          prompt !== null &&
            (() => {
              const updatedTopic = { ...topic, prompt: prompt.trim() }
              updateTopic(updatedTopic)
              topic.id === activeTopic.id && setActiveTopic(updatedTopic)
            })()
        }
      },
      {
        label: topic.pinned ? t('chat.topics.unpin') : t('chat.topics.pin'),
        key: 'pin',
        icon: topic.pinned ? <PinOffIcon size={14} /> : <PinIcon size={14} />,
        onClick() {
          onPinTopic(topic)
        }
      },
      {
        label: t('notes.save'),
        key: 'notes',
        icon: <NotebookPen size={14} />,
        onClick: async () => {
          /* notes export removed */
        }
      },
      {
        label: t('chat.topics.clear.title'),
        key: 'clear-messages',
        icon: <BrushCleaning size={14} />,
        onClick: () => onClearMessages(topic)
      },
      {
        label: t('settings.topic.position.label'),
        key: 'topic-position',
        icon: <MenuIcon size={14} />,
        children: [
          {
            label: t('settings.topic.position.left'),
            key: 'left',
            onClick: () => setTopicPosition('left')
          },
          {
            label: t('settings.topic.position.right'),
            key: 'right',
            onClick: () => setTopicPosition('right')
          }
        ]
      },
      {
        label: t('chat.topics.copy.title'),
        key: 'copy',
        icon: <CopyIcon size={14} />,
        children: [
          {
            label: t('chat.topics.copy.image'),
            key: 'img',
            onClick: () => EventEmitter.emit(EVENT_NAMES.COPY_TOPIC_IMAGE, topic)
          },
          {
            label: t('chat.topics.copy.md'),
            key: 'md',
            onClick: () => copyTopicAsMarkdown(topic)
          },
          {
            label: t('chat.topics.copy.plain_text'),
            key: 'plain_text',
            onClick: () => copyTopicAsPlainText(topic)
          }
        ]
      },
      {
        label: t('chat.topics.export.title'),
        key: 'export',
        icon: <UploadIcon size={14} />,
        children: [
          exportMenuOptions.image && {
            label: t('chat.topics.export.image'),
            key: 'image',
            onClick: () => EventEmitter.emit(EVENT_NAMES.EXPORT_TOPIC_IMAGE, topic)
          },
          exportMenuOptions.markdown && {
            label: t('chat.topics.export.md.label'),
            key: 'markdown',
            onClick: () => exportTopicAsMarkdown(topic)
          },
          exportMenuOptions.markdown_reason && {
            label: t('chat.topics.export.md.reason'),
            key: 'markdown_reason',
            onClick: () => exportTopicAsMarkdown(topic, true)
          },
          exportMenuOptions.docx && {
            label: t('chat.topics.export.word'),
            key: 'word',
            onClick: async () => {
              const markdown = await topicToMarkdown(topic)
              void window.api.export.toWord(markdown, removeSpecialCharactersForFileName(topic.name))
            }
          },
          exportMenuOptions.notion && {
            label: t('chat.topics.export.notion'),
            key: 'notion',
            onClick: async () => {
              void exportTopicToNotion(topic)
            }
          },
          exportMenuOptions.yuque && {
            label: t('chat.topics.export.yuque'),
            key: 'yuque',
            onClick: async () => {
              const markdown = await topicToMarkdown(topic)
              void exportMarkdownToYuque(topic.name, markdown)
            }
          },
          exportMenuOptions.obsidian && {
            label: t('chat.topics.export.obsidian'),
            key: 'obsidian',
            onClick: async () => {
              // 25KB 低频点击路径不进首屏静态图（懒加载先例 exportBackends.ts:723）。
              const { default: ObsidianExportPopup } = await import('@renderer/components/Popups/ObsidianExportPopup')
              await ObsidianExportPopup.show({ title: topic.name, topic, processingMethod: '3' })
            }
          },
          exportMenuOptions.joplin && {
            label: t('chat.topics.export.joplin'),
            key: 'joplin',
            onClick: async () => {
              const topicMessages = await TopicManager.getTopicMessages(topic.id)
              void exportMarkdownToJoplin(topic.name, topicMessages)
            }
          },
          exportMenuOptions.siyuan && {
            label: t('chat.topics.export.siyuan'),
            key: 'siyuan',
            onClick: async () => {
              const markdown = await topicToMarkdown(topic)
              void exportMarkdownToSiyuan(topic.name, markdown)
            }
          }
        ].filter(Boolean) as ItemType<MenuItemType>[]
      }
    ]

    if (assistants.length > 1 && rootTopics.length > 1) {
      menus.push({
        label: t('chat.topics.move_to'),
        key: 'move',
        icon: <FolderOpen size={14} />,
        popupClassName: 'move-to-submenu',
        children: assistants
          .filter((a) => a.id !== assistant.id)
          .map((a) => ({
            label: a.name,
            key: a.id,
            icon: <AssistantAvatar assistant={a} size={18} />,
            onClick: () => onMoveTopic(topic, a)
          }))
      })
    }

    if (rootTopics.length > 1 && !topic.pinned) {
      menus.push({ type: 'divider' })
      menus.push({
        label: t('common.delete'),
        danger: true,
        key: 'delete',
        icon: <DeleteIcon size={14} className="lucide-custom" />,
        onClick: () => onDeleteTopic(topic)
      })
    }

    return menus
  }, [
    targetTopic,
    t,
    isRenaming,
    exportMenuOptions.image,
    exportMenuOptions.markdown,
    exportMenuOptions.markdown_reason,
    exportMenuOptions.docx,
    exportMenuOptions.notion,
    exportMenuOptions.yuque,
    exportMenuOptions.obsidian,
    exportMenuOptions.joplin,
    exportMenuOptions.siyuan,
    assistants,
    assistant,
    updateTopic,
    activeTopic.id,
    setActiveTopic,
    onPinTopic,
    onClearMessages,
    setTopicPosition,
    onMoveTopic,
    onDeleteTopic,
    rootTopics.length
  ])

  // 置顶区无条件分组（第三轮）：置顶行在前，组内保持数组序；
  // 不再有开关——"固定"名不副实的双重根源（开关+物理重排）一并消除
  const sortedTopics = useMemo(() => {
    const pinned = rootTopics.filter((topic) => topic.pinned)
    const rest = rootTopics.filter((topic) => !topic.pinned)
    return [...pinned, ...rest]
  }, [rootTopics])

  // Filter topics based on search text (only in manage mode)
  // Supports: case-insensitive, space-separated keywords (all must match)
  const deferredSearchText = useDeferredValue(searchText)
  const filteredTopics = useMemo(() => {
    if (!isManageMode || !deferredSearchText.trim()) {
      return sortedTopics
    }
    // Split by spaces and filter out empty strings
    const keywords = deferredSearchText
      .toLowerCase()
      .split(/\s+/)
      .filter((k) => k.length > 0)
    if (keywords.length === 0) {
      return sortedTopics
    }
    // All keywords must match (AND logic)
    return sortedTopics.filter((topic) => {
      const lowerName = topic.name.toLowerCase()
      return keywords.every((keyword) => lowerName.includes(keyword))
    })
  }, [sortedTopics, deferredSearchText, isManageMode])

  const singlealone = topicPosition === 'right' && position === 'right'

  return (
    <>
      <DraggableVirtualList
        ref={listRef}
        className="topics-tab"
        list={filteredTopics}
        onUpdate={updateTopics}
        style={{ height: '100%', padding: '8px 0 10px 10px', paddingBottom: isManageMode ? 70 : 10 }}
        itemContainerStyle={{ paddingBottom: '8px' }}
        header={
          <HeaderRow>
            <AddButton onClick={() => EventEmitter.emit(EVENT_NAMES.ADD_NEW_TOPIC)}>
              {t('chat.add.topic.title')}
            </AddButton>
            <Tooltip title={t('chat.topics.manage.title')} mouseEnterDelay={0.5}>
              <HeaderIconButton
                onClick={isManageMode ? exitManageMode : enterManageMode}
                className={isManageMode ? 'active' : ''}>
                <ListChecks size={14} />
              </HeaderIconButton>
            </Tooltip>
          </HeaderRow>
        }
        disabled={isManageMode}>
        {(topic) => {
          const isActive = topic.id === activeTopic?.id
          const topicName = topic.name.replace('`', '')
          const topicPrompt = topic.prompt
          const fullTopicPrompt = t('common.prompt') + ': ' + topicPrompt
          const isSelected = selectedIds.has(topic.id)
          const canSelect = !topic.pinned

          const getTopicNameClassName = () => {
            if (isRenaming(topic.id)) return 'animation-shimmer'
            if (isNewlyRenamed(topic.id)) return 'animation-reveal'
            return ''
          }

          const handleItemClick = () => {
            if (isManageMode) {
              if (canSelect) {
                toggleSelectTopic(topic.id)
              }
            } else {
              void onSwitchTopic(topic)
            }
          }

          return (
            <Dropdown menu={{ items: getTopicMenuItems }} trigger={['contextMenu']} disabled={isManageMode}>
              <TopicListItem
                onContextMenu={() => setTargetTopic(topic)}
                className={classNames(
                  isActive && !isManageMode ? 'active' : '',
                  singlealone ? 'singlealone' : '',
                  isManageMode && isSelected ? 'selected' : '',
                  isManageMode && !canSelect ? 'disabled' : ''
                )}
                onClick={editingTopicId === topic.id && isEditing ? undefined : handleItemClick}
                style={{
                  borderRadius,
                  cursor:
                    editingTopicId === topic.id && isEditing
                      ? 'default'
                      : isManageMode && !canSelect
                        ? 'not-allowed'
                        : 'pointer'
                }}>
                {isPending(topic.id) && !isActive && <PendingIndicator />}
                {isFulfilled(topic.id) && !isActive && <FulfilledIndicator />}
                <TopicNameContainer>
                  {isManageMode && (
                    <SelectIcon className={!canSelect ? 'disabled' : ''}>
                      {isSelected ? (
                        <CheckSquare size={16} color="var(--color-primary)" />
                      ) : (
                        <Square size={16} color="var(--color-text-3)" />
                      )}
                    </SelectIcon>
                  )}
                  {editingTopicId === topic.id && isEditing ? (
                    <TopicEditInput {...inputProps} onClick={(e) => e.stopPropagation()} />
                  ) : (
                    <TopicName
                      className={getTopicNameClassName()}
                      title={topicName}
                      onDoubleClick={
                        isManageMode
                          ? undefined
                          : () => {
                              setEditingTopicId(topic.id)
                              startEdit(topic.name)
                            }
                      }>
                      {topicName}
                    </TopicName>
                  )}
                  {!topic.pinned && (
                    <Tooltip
                      placement="bottom"
                      mouseEnterDelay={0.7}
                      mouseLeaveDelay={0}
                      title={
                        <div style={{ fontSize: '12px', opacity: 0.8, fontStyle: 'italic' }}>
                          {t('chat.topics.delete.shortcut', { key: isMac ? '⌘' : 'Ctrl' })}
                        </div>
                      }>
                      <MenuButton
                        className="menu"
                        onClick={(e) => {
                          if (e.ctrlKey || e.metaKey) {
                            void handleConfirmDelete(topic, e)
                          } else if (deletingTopicId === topic.id) {
                            void handleConfirmDelete(topic, e)
                          } else {
                            handleDeleteClick(topic.id, e)
                          }
                        }}>
                        {deletingTopicId === topic.id ? (
                          <DeleteIcon size={14} color="var(--color-error)" style={{ pointerEvents: 'none' }} />
                        ) : (
                          <XIcon size={14} color="var(--color-text-3)" style={{ pointerEvents: 'none' }} />
                        )}
                      </MenuButton>
                    </Tooltip>
                  )}
                  {topic.pinned && (
                    <MenuButton className="pin">
                      <PinIcon size={14} color="var(--color-text-3)" />
                    </MenuButton>
                  )}
                </TopicNameContainer>
                {topicPrompt && (
                  <TopicPromptText className="prompt" title={fullTopicPrompt}>
                    {fullTopicPrompt}
                  </TopicPromptText>
                )}
                {showTopicTime && (
                  <TopicTime className="time">{dayjs(topic.createdAt).format('YYYY/MM/DD HH:mm')}</TopicTime>
                )}
              </TopicListItem>
            </Dropdown>
          )
        }}
      </DraggableVirtualList>

      {/* 管理模式底部面板 */}
      <TopicManagePanel
        assistant={assistant}
        assistants={assistants}
        activeTopic={activeTopic}
        setActiveTopic={setActiveTopic}
        updateTopics={updateTopics}
        moveTopic={moveTopic}
        manageState={manageState}
        filteredTopics={filteredTopics}
      />
    </>
  )
}

const TopicListItem = styled.div`
  padding: 7px 12px;
  border-radius: var(--list-item-border-radius);
  font-size: 13px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  cursor: pointer;
  width: calc(var(--assistants-width) - 20px);

  .menu {
    opacity: 0;
    color: var(--color-text-3);
  }

  &:hover {
    background-color: var(--color-list-item-hover);
    transition: background-color 0.1s;

    .menu {
      opacity: 1;
    }
  }

  &.active {
    background-color: var(--color-list-item);
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    .menu {
      opacity: 1;

      &:hover {
        color: var(--color-text-2);
      }
    }
  }
  &.singlealone {
    &:hover {
      background-color: var(--color-background-soft);
    }
    &.active {
      background-color: var(--color-background-mute);
      box-shadow: none;
    }
  }

  &.selected {
    background-color: var(--color-primary-bg);
    box-shadow: inset 0 0 0 1px var(--color-primary);
  }

  &.disabled {
    opacity: 0.5;
  }
`

const TopicNameContainer = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
  height: 20px;
`

const TopicName = styled.div`
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 13px;
  position: relative;
  flex: 1;
  text-align: left;

  &.animation-reveal {
    -webkit-line-clamp: unset;
    -webkit-box-orient: unset;
  }
`

const TopicEditInput = styled.input`
  background: var(--color-background);
  border: none;
  color: var(--color-text-1);
  font-size: 13px;
  font-family: inherit;
  padding: 2px 6px;
  width: 100%;
  outline: none;
  padding: 0;
`

const PendingIndicator = styled.div.attrs({
  className: 'animation-pulse'
})`
  --pulse-size: 5px;
  width: 5px;
  height: 5px;
  position: absolute;
  left: 3px;
  top: 15px;
  border-radius: 50%;
  background-color: var(--color-status-warning);
`

const FulfilledIndicator = styled.div.attrs({
  className: 'animation-pulse'
})`
  --pulse-size: 5px;
  width: 5px;
  height: 5px;
  position: absolute;
  left: 3px;
  top: 15px;
  border-radius: 50%;
  background-color: var(--color-status-success);
`

const TopicPromptText = styled.div`
  color: var(--color-text-2);
  font-size: 12px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  ~ .prompt-text {
    margin-top: 10px;
  }
`

const TopicTime = styled.div`
  color: var(--color-text-3);
  font-size: 11px;
`

const MenuButton = styled.div`
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  min-width: 20px;
  min-height: 20px;
  .anticon {
    font-size: 12px;
  }
`

const HeaderRow = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding-right: 10px;
  margin-bottom: 8px;
  margin-top: 2px;
`

const HeaderIconButton = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  min-width: 32px;
  min-height: 32px;
  border-radius: var(--list-item-border-radius);
  cursor: pointer;
  color: var(--color-text-2);
  transition: all 0.2s;

  &:hover {
    background-color: var(--color-background-mute);
    color: var(--color-text-1);
  }

  &.active {
    color: var(--color-primary);

    &:hover {
      background-color: var(--color-background-mute);
    }
  }
`

const SelectIcon = styled.div`
  display: flex;
  align-items: center;
  margin-right: 4px;

  &.disabled {
    opacity: 0.5;
  }
`

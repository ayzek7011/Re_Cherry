// import { InfoCircleOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import { CopyIcon, DeleteIcon, EditIcon, RefreshIcon } from '@renderer/components/Icons'
import { isChatCandidateModel, isVisionModel } from '@renderer/config/models'
import type { MessageMenubarButtonId, MessageMenubarScope } from '@renderer/config/registry/messageMenubar'
import { DEFAULT_MESSAGE_MENUBAR_SCOPE, getMessageMenubarConfig } from '@renderer/config/registry/messageMenubar'
import type { TranslateLanguage } from '@renderer/config/translateLanguages'
import { langCodeToI18nKey } from '@renderer/config/translateLanguages'
import { useMessageEditing } from '@renderer/context/MessageEditingContext'
import { useMessageOperations } from '@renderer/hooks/useMessageOperations'
import { useMessageTranslationStatus, useTranslateLanguages } from '@renderer/hooks/useMessageTranslate'
import { useEnableDeveloperMode, useMessageStyle, useSettings } from '@renderer/hooks/useSettings'
import { useTemporaryValue } from '@renderer/hooks/useTemporaryValue'
import { getMessageTitle } from '@renderer/services/MessagesService'
import {
  abortMessageTranslation,
  closeMessageTranslation,
  copyMessageTranslation,
  startMessageTranslation
} from '@renderer/services/messageTranslate'
import type { RootState } from '@renderer/store'
import store from '@renderer/store'
import { messageBlocksSelectors } from '@renderer/store/messageBlock'
import { selectMessagesForTopic } from '@renderer/store/newMessage'
import { TraceIcon } from '@renderer/trace/pages/Component'
import type { Assistant, Model, Topic } from '@renderer/types'
import { type Message, MessageBlockType } from '@renderer/types/newMessage'
import { captureScrollableAsBlob, captureScrollableAsDataURL, classNames } from '@renderer/utils'
import { copyMessageAsPlainText } from '@renderer/utils/copy'
import {
  exportMarkdownToJoplin,
  exportMarkdownToSiyuan,
  exportMarkdownToYuque,
  exportMessageAsMarkdown,
  exportMessageToNotion,
  messageToMarkdown
} from '@renderer/utils/export'
// import { withMessageThought } from '@renderer/utils/formats'
import { removeTrailingDoubleSpaces } from '@renderer/utils/markdown'
import { findMainTextBlocks, getMainTextContent } from '@renderer/utils/messageUtils/find'
import type { MenuProps } from 'antd'
import { Dropdown, Popconfirm, Tooltip } from 'antd'
import dayjs from 'dayjs'
import type { TFunction } from 'i18next'
import {
  AtSign,
  Bug,
  Check,
  CirclePause,
  FilePenLine,
  Languages,
  ListChecks,
  Menu,
  Save,
  ThumbsUp,
  Upload
} from 'lucide-react'
import type { Dispatch, FC, ReactNode, SetStateAction } from 'react'
import { Fragment, memo, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSelector } from 'react-redux'
import styled from 'styled-components'

import { useChatContextValue } from './ChatContextProvider'
import MessageTokens from './MessageTokens'

interface Props {
  message: Message
  assistant: Assistant
  topic: Topic
  model?: Model
  index?: number
  isGrouped?: boolean
  isLastMessage: boolean
  isAssistantMessage: boolean
  messageContainerRef: React.RefObject<HTMLDivElement>
  setModel: (model: Model) => void
  onUpdateUseful?: (msgId: string) => void
}

const logger = loggerService.withContext('MessageMenubar')

type MessageOperationsHandlers = ReturnType<typeof useMessageOperations>

type MessageMenubarButtonContext = {
  assistant: Assistant
  confirmDeleteMessage: boolean
  confirmRegenerateMessage: boolean
  copied: boolean
  deleteMessage: MessageOperationsHandlers['deleteMessage']
  dropdownItems: MenuProps['items']
  enableDeveloperMode: boolean
  handleResendUserMessage: (messageUpdate?: Message) => Promise<void>
  handleTraceUserMessage: () => void | Promise<void>
  handleTranslate: (language: TranslateLanguage) => void | Promise<void>
  hasTranslationBlocks: boolean
  isAssistantMessage: boolean
  isBubbleStyle: boolean
  isGrouped?: boolean
  isLastMessage: boolean
  isTranslating: boolean
  isUserMessage: boolean
  message: Message
  onCopy: (e: React.MouseEvent) => void
  onEdit: () => void | Promise<void>
  onMentionModel: (e: React.MouseEvent) => void | Promise<void>
  onRegenerate: (e?: React.MouseEvent) => void | Promise<void>
  onUseful: (e: React.MouseEvent) => void
  removeMessageBlock: MessageOperationsHandlers['removeMessageBlock']
  setShowDeleteTooltip: Dispatch<SetStateAction<boolean>>
  showDeleteTooltip: boolean
  softHoverBg: boolean
  t: TFunction
  translateLanguages: TranslateLanguage[]
}

type MessageMenubarButtonRenderer = (ctx: MessageMenubarButtonContext) => ReactNode | null

const MessageMenubar: FC<Props> = (props) => {
  const {
    message,
    isGrouped,
    isLastMessage,
    isAssistantMessage,
    assistant,
    topic,
    model,
    messageContainerRef,
    onUpdateUseful
  } = props
  const { t } = useTranslation()
  const { toggleMultiSelectMode } = useChatContextValue()
  const [copied, setCopied] = useTemporaryValue(false, 2000)
  // remove confirm for regenerate; tooltip stays simple
  const [showDeleteTooltip, setShowDeleteTooltip] = useState(false)
  // const assistantModel = assistant?.model
  const { deleteMessage, resendMessage, regenerateAssistantMessage, switchModelAnswer, removeMessageBlock } =
    useMessageOperations(topic)

  const { isBubbleStyle } = useMessageStyle()
  const { enableDeveloperMode } = useEnableDeveloperMode()
  const { confirmDeleteMessage, confirmRegenerateMessage } = useSettings()

  // const loading = useTopicLoading(topic)

  const isUserMessage = message.role === 'user'

  const exportMenuOptions = useSelector((state: RootState) => state.settings.exportMenuOptions)
  // const processedMessage = useMemo(() => {
  //   if (message.role === 'assistant' && message.model && isReasoningModel(message.model)) {
  //     return withMessageThought(message)
  //   }
  //   return message
  // }, [message])

  const mainTextContent = useMemo(() => {
    // 只处理助手消息和来自推理模型的消息
    // if (message.role === 'assistant' && message.model && isReasoningModel(message.model)) {
    // return getMainTextContent(withMessageThought(message))
    // }
    return getMainTextContent(message)
  }, [message])

  const onCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()

      const currentMessageId = message.id // from props
      const latestMessageEntity = store.getState().messages.entities[currentMessageId]

      let contentToCopy = ''
      if (latestMessageEntity) {
        contentToCopy = getMainTextContent(latestMessageEntity)
      } else {
        contentToCopy = getMainTextContent(message)
      }

      void navigator.clipboard.writeText(removeTrailingDoubleSpaces(contentToCopy.trimStart()))

      window.toast.success(t('message.copied'))
      setCopied(true)
    },
    [message, setCopied, t] // message is needed for message.id and as a fallback. t is for translation.
  )

  const handleResendUserMessage = useCallback(
    async (messageUpdate?: Message) => {
      await resendMessage(messageUpdate ?? message, assistant)
    },
    [assistant, message, resendMessage]
  )

  const { startEditing } = useMessageEditing()

  const onEdit = useCallback(async () => {
    startEditing(message.id)
  }, [message.id, startEditing])

  const handleTraceUserMessage = useCallback(async () => {
    if (message.traceId) {
      void window.api.trace.openWindow(
        message.topicId,
        message.traceId,
        true,
        message.role === 'user' ? undefined : message.model?.name
      )
    }
  }, [message])

  // 消息级原地翻译（V1 MessageMenubar handleTranslate 移植）：翻译中直接忽略（上游守卫同款）
  const { isTranslating, hasTranslationBlocks } = useMessageTranslationStatus(message)
  const translateLanguages = useTranslateLanguages()

  const handleTranslate = useCallback(
    async (language: TranslateLanguage) => {
      if (isTranslating) return
      await startMessageTranslation({ topicId: topic.id, message, sourceText: mainTextContent, language })
    },
    [isTranslating, topic.id, message, mainTextContent]
  )

  const menubarScope: MessageMenubarScope = topic?.type ?? DEFAULT_MESSAGE_MENUBAR_SCOPE
  const { buttonIds, dropdownRootAllowKeys } = getMessageMenubarConfig(menubarScope)

  const isEditable = useMemo(() => {
    return findMainTextBlocks(message).length > 0 // 使用 MCP Server 后会有大于一段 MatinTextBlock
  }, [message])

  const dropdownItems = useMemo(() => {
    const items: MenuProps['items'] = [
      ...(isEditable && message.role === 'user'
        ? [
            {
              label: t('common.edit'),
              key: 'edit',
              icon: <FilePenLine size={15} />,
              onClick: onEdit
            }
          ]
        : []),
      {
        label: t('chat.multiple.select.label'),
        key: 'multi-select',
        icon: <ListChecks size={15} />,
        onClick: () => {
          toggleMultiSelectMode(true)
        }
      },
      {
        label: t('chat.save.label'),
        key: 'save',
        icon: <Save size={15} />,
        children: [
          {
            label: t('chat.save.file.title'),
            key: 'file',
            onClick: () => {
              const fileName = dayjs(message.createdAt).format('YYYYMMDDHHmm') + '.md'
              void window.api.file.save(fileName, mainTextContent)
            }
          }
        ]
      },
      {
        label: t('chat.topics.export.title'),
        key: 'export',
        icon: <Upload size={15} />,
        children: [
          exportMenuOptions.plain_text && {
            label: t('chat.topics.copy.plain_text'),
            key: 'copy_message_plain_text',
            onClick: () => copyMessageAsPlainText(message)
          },
          exportMenuOptions.image && {
            label: t('chat.topics.copy.image'),
            key: 'img',
            onClick: async () => {
              await captureScrollableAsBlob(messageContainerRef, async (blob) => {
                if (blob) {
                  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
                }
              })
            }
          },
          exportMenuOptions.image && {
            label: t('chat.topics.export.image'),
            key: 'image',
            onClick: async () => {
              const imageData = await captureScrollableAsDataURL(messageContainerRef)
              const title = await getMessageTitle(message)
              if (title && imageData) {
                const success = await window.api.file.saveImage(title, imageData)
                if (success) window.toast.success(t('chat.topics.export.image_saved'))
              }
            }
          },
          exportMenuOptions.markdown && {
            label: t('chat.topics.export.md.label'),
            key: 'markdown',
            onClick: () => exportMessageAsMarkdown(message)
          },
          exportMenuOptions.markdown_reason && {
            label: t('chat.topics.export.md.reason'),
            key: 'markdown_reason',
            onClick: () => exportMessageAsMarkdown(message, true)
          },
          exportMenuOptions.docx && {
            label: t('chat.topics.export.word'),
            key: 'word',
            onClick: async () => {
              const markdown = messageToMarkdown(message)
              const title = await getMessageTitle(message)
              void window.api.export.toWord(markdown, title)
            }
          },
          exportMenuOptions.notion && {
            label: t('chat.topics.export.notion'),
            key: 'notion',
            onClick: async () => {
              const title = await getMessageTitle(message)
              const markdown = messageToMarkdown(message)
              void exportMessageToNotion(title, markdown, message)
            }
          },
          exportMenuOptions.yuque && {
            label: t('chat.topics.export.yuque'),
            key: 'yuque',
            onClick: async () => {
              const title = await getMessageTitle(message)
              const markdown = messageToMarkdown(message)
              void exportMarkdownToYuque(title, markdown)
            }
          },
          exportMenuOptions.obsidian && {
            label: t('chat.topics.export.obsidian'),
            key: 'obsidian',
            onClick: async () => {
              const title = topic.name?.replace(/\\/g, '_') || t('common.unnamed')
              // 动态加载：ObsidianExportPopup 低频导出路径不进首屏图（exportBackends.ts 先例）
              const { default: ObsidianExportPopup } = await import('@renderer/components/Popups/ObsidianExportPopup')
              await ObsidianExportPopup.show({ title, message, processingMethod: '1' })
            }
          },
          exportMenuOptions.joplin && {
            label: t('chat.topics.export.joplin'),
            key: 'joplin',
            onClick: async () => {
              const title = await getMessageTitle(message)
              void exportMarkdownToJoplin(title, message)
            }
          },
          exportMenuOptions.siyuan && {
            label: t('chat.topics.export.siyuan'),
            key: 'siyuan',
            onClick: async () => {
              const title = await getMessageTitle(message)
              const markdown = messageToMarkdown(message)
              void exportMarkdownToSiyuan(title, markdown)
            }
          }
        ].filter(Boolean)
      }
    ].filter(Boolean)

    if (!dropdownRootAllowKeys || dropdownRootAllowKeys.length === 0) {
      return items
    }

    const allowSet = new Set(dropdownRootAllowKeys)
    return items.filter((item) => {
      if (!item || typeof item !== 'object') {
        return false
      }
      if ('type' in item && item.type === 'divider') {
        return false
      }
      if ('key' in item && item.key) {
        return allowSet.has(String(item.key))
      }
      return false
    })
  }, [
    dropdownRootAllowKeys,
    exportMenuOptions.docx,
    exportMenuOptions.image,
    exportMenuOptions.joplin,
    exportMenuOptions.markdown,
    exportMenuOptions.markdown_reason,
    exportMenuOptions.notion,
    exportMenuOptions.obsidian,
    exportMenuOptions.plain_text,
    exportMenuOptions.siyuan,
    exportMenuOptions.yuque,
    isEditable,
    mainTextContent,
    message,
    messageContainerRef,
    onEdit,
    t,
    toggleMultiSelectMode,
    // 导出文件名带话题名（Obsidian 导出用 topic.name），改名后菜单要重建
    topic.name
  ])

  const onRegenerate = async (e: React.MouseEvent | undefined) => {
    e?.stopPropagation?.()
    // No need to reset or edit the message anymore
    // const selectedModel = isGrouped ? model : assistantModel
    // const _message = resetAssistantMessage(message, selectedModel)
    // editMessage(message.id, { ..._message }) // REMOVED

    // Call the function from the hook
    void regenerateAssistantMessage(message, assistant)
  }

  // 按条件筛选能够提及的模型，该函数仅在isAssistantMessage时会用到
  const mentionModelFilter = useMemo(() => {
    const defaultFilter = (model: Model) => isChatCandidateModel(model)

    if (!isAssistantMessage) {
      return defaultFilter
    }
    const state = store.getState()
    const topicMessages: Message[] = selectMessagesForTopic(state, topic.id)
    // 理论上助手消息只会关联一条用户消息
    const relatedUserMessage = topicMessages.find((msg) => {
      return msg.role === 'user' && message.askId === msg.id
    })
    // 无关联用户消息时，默认返回所有模型
    if (!relatedUserMessage) {
      return defaultFilter
    }

    const relatedUserMessageBlocks = relatedUserMessage.blocks.map((msgBlockId) =>
      messageBlocksSelectors.selectById(store.getState(), msgBlockId)
    )

    if (!relatedUserMessageBlocks) {
      return defaultFilter
    }

    if (relatedUserMessageBlocks.some((block) => block && block.type === MessageBlockType.IMAGE)) {
      return (m: Model) => isVisionModel(m) && defaultFilter(m)
    } else {
      return defaultFilter
    }
  }, [isAssistantMessage, message.askId, topic.id])

  // 切换模型回答（v1 遗产按钮）：走隐藏 parallel 子会话（不污染主话题上下文），
  // 旁答经 useParallelAnswers 投影并进本组卡片；工作模式 active 时入口隐藏（实装）。
  const onMentionModel = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      // 模型选择弹窗连带 ModelSettings/CodeEditor 链（低频入口，不进首屏静态图）。
      const { SelectChatModelPopup } = await import('@renderer/components/Popups/SelectModelPopup')
      const selectedModel = await SelectChatModelPopup.show({ model, filter: mentionModelFilter })
      if (!selectedModel) return
      void switchModelAnswer(message, selectedModel, { ...assistant, model: selectedModel })
    },
    [switchModelAnswer, assistant, mentionModelFilter, message, model]
  )

  const onUseful = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onUpdateUseful?.(message.id)
    },
    [message.id, onUpdateUseful]
  )

  const softHoverBg = isBubbleStyle && isUserMessage && !isLastMessage
  const isUserBubbleStyleMessage = isBubbleStyle && isUserMessage
  const showMessageTokens = !isBubbleStyle || isAssistantMessage || isUserBubbleStyleMessage

  const buttonContext: MessageMenubarButtonContext = {
    assistant,
    confirmDeleteMessage,
    confirmRegenerateMessage,
    copied,
    deleteMessage,
    dropdownItems,
    enableDeveloperMode,
    handleResendUserMessage,
    handleTraceUserMessage,
    handleTranslate,
    hasTranslationBlocks,
    isAssistantMessage,
    isBubbleStyle,
    isGrouped,
    isLastMessage,
    isTranslating,
    isUserMessage,
    message,
    onCopy,
    onEdit,
    onMentionModel,
    onRegenerate,
    onUseful,
    removeMessageBlock,
    setShowDeleteTooltip,
    showDeleteTooltip,
    softHoverBg,
    t,
    translateLanguages
  }

  return (
    <>
      {showMessageTokens && (
        <FooterMetadata className="message-footer-metadata">
          {isUserBubbleStyleMessage && (
            <MessageTime>{dayjs(message?.updatedAt ?? message.createdAt).format('MM/DD HH:mm')}</MessageTime>
          )}
          <MessageTokens message={message} />
        </FooterMetadata>
      )}
      <MenusBar
        className={classNames({ menubar: true, show: isLastMessage, 'user-bubble-style': isUserBubbleStyleMessage })}>
        {buttonIds.map((buttonId) => {
          const renderFn = buttonRenderers[buttonId]
          if (!renderFn) {
            logger.warn(`No renderer registered for MessageMenubar button id: ${buttonId}`)
            return null
          }
          const element = renderFn(buttonContext)
          if (!element) {
            return null
          }
          return <Fragment key={buttonId}>{element}</Fragment>
        })}
      </MenusBar>
    </>
  )
}

const FooterMetadata = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  height: 26px;
  line-height: 26px;
  min-width: 0;

  .message-tokens {
    display: flex;
    align-items: center;
    height: 26px;
    line-height: 26px;
  }
`

const MessageTime = styled.div`
  flex-shrink: 0;
  font-size: 10px;
  height: 26px;
  line-height: 26px;
  color: var(--color-text-3);
`

const MenusBar = styled.div`
  display: flex;
  flex-direction: row;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
`

const ActionButton = styled.div<{ $softHoverBg?: boolean }>`
  cursor: pointer;
  border-radius: 8px;
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  width: 26px;
  height: 26px;
  transition: all 0.2s ease;
  &:hover {
    background-color: ${(props) =>
      props.$softHoverBg ? 'var(--color-background-soft)' : 'var(--color-background-mute)'};
    color: var(--color-text-1);
    .anticon,
    .lucide {
      color: var(--color-text-1);
    }
  }
  .anticon,
  .iconfont {
    cursor: pointer;
    font-size: 14px;
    color: var(--color-icon);
  }
  .icon-at {
    font-size: 16px;
  }
`

const buttonRenderers: Record<MessageMenubarButtonId, MessageMenubarButtonRenderer> = {
  'user-regenerate': ({
    message,
    confirmRegenerateMessage,
    handleResendUserMessage,
    setShowDeleteTooltip,
    t,
    isBubbleStyle
  }) => {
    if (message.role !== 'user') {
      return null
    }

    if (confirmRegenerateMessage) {
      return (
        <Popconfirm
          title={t('message.regenerate.confirm')}
          okButtonProps={{ danger: true }}
          onConfirm={() => handleResendUserMessage()}
          onOpenChange={(open) => open && setShowDeleteTooltip(false)}>
          <Tooltip title={t('common.regenerate')} mouseEnterDelay={0.8}>
            <ActionButton
              className="message-action-button"
              onClick={(e) => e.stopPropagation()}
              $softHoverBg={isBubbleStyle}>
              <RefreshIcon size={15} />
            </ActionButton>
          </Tooltip>
        </Popconfirm>
      )
    }

    return (
      <Tooltip title={t('common.regenerate')} mouseEnterDelay={0.8}>
        <ActionButton
          className="message-action-button"
          onClick={() => handleResendUserMessage()}
          $softHoverBg={isBubbleStyle}>
          <RefreshIcon size={15} />
        </ActionButton>
      </Tooltip>
    )
  },
  'user-edit': ({ message, onEdit, softHoverBg, t }) => {
    if (message.role !== 'user') {
      return null
    }

    return (
      <Tooltip title={t('common.edit')} mouseEnterDelay={0.8}>
        <ActionButton className="message-action-button" onClick={onEdit} $softHoverBg={softHoverBg}>
          <EditIcon size={15} />
        </ActionButton>
      </Tooltip>
    )
  },
  copy: ({ onCopy, softHoverBg, copied, t }) => (
    <Tooltip title={t('common.copy')} mouseEnterDelay={0.8}>
      <ActionButton className="message-action-button" onClick={onCopy} $softHoverBg={softHoverBg}>
        {!copied && <CopyIcon size={15} />}
        {copied && <Check size={15} color="var(--color-primary)" />}
      </ActionButton>
    </Tooltip>
  ),
  'assistant-regenerate': ({
    isAssistantMessage,
    confirmRegenerateMessage,
    onRegenerate,
    setShowDeleteTooltip,
    softHoverBg,
    t
  }) => {
    if (!isAssistantMessage) {
      return null
    }

    if (confirmRegenerateMessage) {
      return (
        <Popconfirm
          title={t('message.regenerate.confirm')}
          okButtonProps={{ danger: true }}
          onConfirm={() => onRegenerate()}
          onOpenChange={(open) => open && setShowDeleteTooltip(false)}>
          <Tooltip title={t('common.regenerate')} mouseEnterDelay={0.8}>
            <ActionButton
              className="message-action-button"
              onClick={(e) => e.stopPropagation()}
              $softHoverBg={softHoverBg}>
              <RefreshIcon size={15} />
            </ActionButton>
          </Tooltip>
        </Popconfirm>
      )
    }

    return (
      <Tooltip title={t('common.regenerate')} mouseEnterDelay={0.8}>
        <ActionButton className="message-action-button" onClick={onRegenerate} $softHoverBg={softHoverBg}>
          <RefreshIcon size={15} />
        </ActionButton>
      </Tooltip>
    )
  },
  'assistant-mention-model': ({ isAssistantMessage, onMentionModel, softHoverBg, t }) => {
    if (!isAssistantMessage) {
      return null
    }

    return (
      <Tooltip title={t('message.mention.title')} mouseEnterDelay={0.8}>
        <ActionButton className="message-action-button" onClick={onMentionModel} $softHoverBg={softHoverBg}>
          <AtSign size={15} />
        </ActionButton>
      </Tooltip>
    )
  },
  // 消息级原地翻译（V1 messageMenubar translate 按钮移植）：用户消息无入口；翻译中 =
  // 停止按钮；常态 = 语言下拉（内置 20 语言，上游 translateLanguages 同交互），已有译文时
  // 追加 复制/关闭 两项；点击语言重译（上游 getTranslationUpdater 原地重置语义）。
  translate: ({
    isUserMessage,
    isTranslating,
    translateLanguages,
    handleTranslate,
    hasTranslationBlocks,
    message,
    softHoverBg,
    t
  }) => {
    if (isUserMessage) {
      return null
    }

    if (isTranslating) {
      return (
        <Tooltip title={t('translate.stop')} mouseEnterDelay={0.8}>
          <ActionButton
            className="message-action-button"
            onClick={(e) => {
              e.stopPropagation()
              abortMessageTranslation(message.id)
            }}
            $softHoverBg={softHoverBg}>
            <CirclePause size={15} />
          </ActionButton>
        </Tooltip>
      )
    }

    const items: MenuProps['items'] = [
      ...translateLanguages.map((item) => ({
        label: item.emoji + ' ' + t(langCodeToI18nKey.get(item.langCode) ?? item.langCode),
        key: item.langCode,
        onClick: () => void handleTranslate(item)
      })),
      ...(hasTranslationBlocks
        ? [
            { type: 'divider' as const },
            {
              label: '📋 ' + t('common.copy'),
              key: 'translate-copy',
              onClick: () => void copyMessageTranslation(message)
            },
            {
              label: '✖ ' + t('messageTranslate.close'),
              key: 'translate-close',
              onClick: () => void closeMessageTranslation(message.topicId, message.id)
            }
          ]
        : [])
    ]

    return (
      <Dropdown
        menu={{
          style: {
            maxHeight: 250,
            overflowY: 'auto',
            backgroundClip: 'border-box'
          },
          items,
          onClick: (e) => e.domEvent.stopPropagation()
        }}
        trigger={['click']}
        placement="top"
        arrow>
        <Tooltip title={t('messageTranslate.action')} mouseEnterDelay={1.2}>
          <ActionButton
            className="message-action-button"
            onClick={(e) => e.stopPropagation()}
            $softHoverBg={softHoverBg}>
            <Languages size={15} />
          </ActionButton>
        </Tooltip>
      </Dropdown>
    )
  },
  useful: ({ isAssistantMessage, isGrouped, onUseful, softHoverBg, message, t }) => {
    if (!isAssistantMessage || !isGrouped) {
      return null
    }

    return (
      <Tooltip title={t('chat.message.useful.label')} mouseEnterDelay={0.8}>
        <ActionButton className="message-action-button" onClick={onUseful} $softHoverBg={softHoverBg}>
          {message.useful ? (
            <ThumbsUp size={17.5} fill="var(--color-primary)" strokeWidth={0} />
          ) : (
            <ThumbsUp size={15} />
          )}
        </ActionButton>
      </Tooltip>
    )
  },
  delete: ({
    confirmDeleteMessage,
    deleteMessage,
    message,
    setShowDeleteTooltip,
    showDeleteTooltip,
    softHoverBg,
    t
  }) => {
    const deleteTooltip = (
      <Tooltip
        title={t('common.delete')}
        mouseEnterDelay={1}
        open={showDeleteTooltip}
        onOpenChange={setShowDeleteTooltip}>
        <DeleteIcon size={15} />
      </Tooltip>
    )

    const handleDeleteMessage = async () => {
      const ok = await deleteMessage(message.id, message.traceId, message.model?.name)
      if (!ok) window.toast.error(t('message.delete.failed'))
    }

    if (confirmDeleteMessage) {
      return (
        <Popconfirm
          title={t('message.message.delete.content')}
          okButtonProps={{ danger: true }}
          onConfirm={async () => await handleDeleteMessage()}
          onOpenChange={(open) => open && setShowDeleteTooltip(false)}>
          <ActionButton
            className="message-action-button"
            onClick={(e) => e.stopPropagation()}
            $softHoverBg={softHoverBg}>
            {deleteTooltip}
          </ActionButton>
        </Popconfirm>
      )
    }

    return (
      <ActionButton
        className="message-action-button"
        onClick={async (e) => {
          e.stopPropagation()
          await handleDeleteMessage()
        }}
        $softHoverBg={softHoverBg}>
        {deleteTooltip}
      </ActionButton>
    )
  },
  trace: ({ enableDeveloperMode, message, handleTraceUserMessage, t }) => {
    if (!enableDeveloperMode || !message.traceId) {
      return null
    }

    return (
      <Tooltip title={t('trace.label')} mouseEnterDelay={0.8}>
        <ActionButton className="message-action-button" onClick={() => handleTraceUserMessage()}>
          <TraceIcon size={16} className={'lucide lucide-trash'} />
        </ActionButton>
      </Tooltip>
    )
  },
  'inspect-data': ({ message, enableDeveloperMode, t }) => {
    if (!enableDeveloperMode) {
      return null
    }

    const handleInspect = async (e: React.MouseEvent) => {
      e.stopPropagation()
      // 点击时按需读取：不在 menubar 顶层订阅全量块实体（否则流式期间每个 token
      // 都会让所有历史消息的 menubar 重渲染）
      const blockEntities = messageBlocksSelectors.selectEntities(store.getState())
      const blocks = message.blocks.map((blockId) => blockEntities[blockId]).filter(Boolean)
      // InspectMessagePopup 拖入 CodeEditor（低频调试入口，不进首屏静态图）。
      const { default: InspectMessagePopup } = await import('@renderer/components/Popups/InspectMessagePopup')
      void InspectMessagePopup.show({
        title: `Message: ${message.id}`,
        message,
        blocks
      })
    }

    return (
      <Tooltip title={t('message.inspect_data')} mouseEnterDelay={0.8}>
        <ActionButton className="message-action-button" onClick={handleInspect}>
          <Bug size={15} />
        </ActionButton>
      </Tooltip>
    )
  },
  'more-menu': ({ isUserMessage, dropdownItems, softHoverBg }) => {
    if (isUserMessage) {
      return null
    }

    return (
      <Dropdown
        menu={{ items: dropdownItems, onClick: (e) => e.domEvent.stopPropagation() }}
        trigger={['click']}
        placement="topRight">
        <ActionButton className="message-action-button" onClick={(e) => e.stopPropagation()} $softHoverBg={softHoverBg}>
          <Menu size={19} />
        </ActionButton>
      </Dropdown>
    )
  }
}

export default memo(MessageMenubar)

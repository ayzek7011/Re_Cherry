import { useTranslationHydration } from '@renderer/hooks/useMessageTranslate'
import { getModelUniqId } from '@renderer/services/ModelService'
import type { Message } from '@renderer/types/newMessage'
import { Flex } from 'antd'
import { isEmpty } from 'lodash-es'
import React from 'react'
import styled from 'styled-components'

import MessageBlockRenderer from './Blocks'
interface Props {
  message: Message
}

const MessageContent: React.FC<Props> = ({ message }) => {
  // 译文块水合：messageBlocks 切片不持久化且译文不入内核日志，重投影后从 Dexie
  // message_translations 复原本地增强（无持久行时零开销——单键 point get）。
  useTranslationHydration(message)
  return (
    <>
      {!isEmpty(message.mentions) && (
        <Flex gap="8px" wrap style={{ marginBottom: '10px' }}>
          {message.mentions?.map((model) => (
            <MentionTag key={getModelUniqId(model)}>{'@' + model.name}</MentionTag>
          ))}
        </Flex>
      )}
      <MessageBlockRenderer blocks={message.blocks} message={message} />
    </>
  )
}

const MentionTag = styled.span`
  color: var(--color-link);
`

// const SearchingText = styled.div`
//   font-size: 14px;
//   line-height: 1.6;
//   text-decoration: none;
//   color: var(--color-text-1);
// `

export default React.memo(MessageContent)

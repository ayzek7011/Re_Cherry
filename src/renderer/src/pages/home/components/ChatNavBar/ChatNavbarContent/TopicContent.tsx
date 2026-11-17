import AssistantAvatar from '@renderer/components/Avatar/AssistantAvatar'
import HorizontalScrollContainer from '@renderer/components/HorizontalScrollContainer'
import type { Assistant, Topic } from '@renderer/types'
import { ChevronRight } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import SelectModelButton from '../../SelectModelButton'
import Tools from '../Tools'

type TopicContentProps = {
  assistant: Assistant
  activeTopic?: Topic
  setActiveTopic?: (topic: Topic) => void
}

const TopicContent = ({ assistant, activeTopic, setActiveTopic }: TopicContentProps) => {
  const { t } = useTranslation()
  const assistantName = useMemo(() => assistant.name || t('chat.default.name'), [assistant.name, t])

  return (
    <>
      <HorizontalScrollContainer className="ml-2 flex-initial">
        <div className="flex flex-nowrap items-center gap-2">
          {/* Assistant Label */}
          <div
            className="flex h-full cursor-pointer items-center gap-1.5"
            onClick={async () => {
              // 弹窗连带 AgentSettings→CodeEditor/SelectModelPopup 链（低频入口，不进首屏静态图）。
              const { default: AssistantSettingsPopup } = await import('@renderer/pages/settings/AssistantSettings')
              await AssistantSettingsPopup.show({ assistant })
            }}>
            <AssistantAvatar assistant={assistant} size={24} />
            <span className="max-w-40 truncate text-xs">{assistantName}</span>
          </div>

          {/* Separator */}
          <ChevronRight className="h-4 w-4 text-gray-400" />

          {/* Model Button */}
          <SelectModelButton assistant={assistant} />
        </div>
      </HorizontalScrollContainer>
      <Tools assistant={assistant} activeTopic={activeTopic} setActiveTopic={setActiveTopic} />
    </>
  )
}

export default TopicContent

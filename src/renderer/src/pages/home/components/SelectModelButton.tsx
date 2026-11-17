import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { isLocalAi } from '@renderer/config/env'
import { isChatCandidateModel, isWebSearchModel } from '@renderer/config/models'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useProvider } from '@renderer/hooks/useProvider'
import { getProviderName } from '@renderer/services/ProviderService'
import type { Assistant, Model } from '@renderer/types'
import { Button, Tag } from 'antd'
import { ChevronsUpDown } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  assistant: Assistant
}

const SelectModelButton: FC<Props> = ({ assistant }) => {
  const { model, updateAssistant } = useAssistant(assistant.id)
  const { t } = useTranslation()
  const timerRef = useRef<NodeJS.Timeout>(undefined)
  const provider = useProvider(model?.provider)

  // 对话选单：唯一判据 `isChatCandidateModel`（嵌入/重排/生图模型都不能对话）
  const modelFilter = (model: Model) => isChatCandidateModel(model)

  const onSelectModel = async (event: React.MouseEvent<HTMLElement>) => {
    event.currentTarget.blur()
    // 弹窗连带 ModelSettings/CodeEditor 链（低频入口，不进首屏静态图）。
    const { SelectChatModelPopup } = await import('@renderer/components/Popups/SelectModelPopup')
    const selectedModel = await SelectChatModelPopup.show({ model, filter: modelFilter })
    if (selectedModel) {
      // 避免更新数据造成关闭弹框的卡顿
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        const enabledWebSearch = isWebSearchModel(selectedModel)
        updateAssistant({
          model: selectedModel,
          // `undefined` = provider 还不知道（冷启动窗口）——只换模型，**不得**写回持久化开关。
          ...(enabledWebSearch === undefined ? {} : { enableWebSearch: enabledWebSearch && assistant.enableWebSearch })
        })
      }, 200)
    }
  }

  useEffect(() => {
    return () => {
      clearTimeout(timerRef.current)
    }
  }, [])

  if (isLocalAi) {
    return null
  }

  const providerName = getProviderName(model)

  return (
    <DropdownButton size="small" type="text" onClick={onSelectModel}>
      <ButtonContent>
        <ModelAvatar model={model} size={20} />
        <ModelName>
          {model ? model.name : t('button.select_model')} {providerName ? ' | ' + providerName : ''}
        </ModelName>
      </ButtonContent>
      <ChevronsUpDown size={14} color="var(--color-icon)" />
      {!provider && <Tag color="error">{t('models.invalid_model')}</Tag>}
    </DropdownButton>
  )
}

const DropdownButton = styled(Button)`
  font-size: 11px;
  border-radius: 15px;
  padding: 13px 5px;
  -webkit-app-region: none;
  box-shadow: none;
  background-color: transparent;
  border: 1px solid transparent;
  margin-top: 1px;
`

const ButtonContent = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
`

const ModelName = styled.span`
  font-weight: 500;
  margin-right: -2px;
  font-size: 12px;
`

export default SelectModelButton

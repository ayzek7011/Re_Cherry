import { CloseCircleFilled, PictureOutlined, QuestionCircleOutlined } from '@ant-design/icons'
import EmojiPicker from '@renderer/components/EmojiPicker'
import { ResetIcon } from '@renderer/components/Icons'
import { HStack } from '@renderer/components/Layout'
import Selector from '@renderer/components/Selector'
import { TopView } from '@renderer/components/TopView'
import { DEFAULT_TEMPERATURE } from '@renderer/config/constant'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useDefaultAssistant } from '@renderer/hooks/useAssistant'
import useAssistantIdentityImage from '@renderer/hooks/useAssistantIdentityImage'
import { createIdentityImage, releaseIdentityImage } from '@renderer/services/assistantIdentity'
import { DEFAULT_ASSISTANT_SETTINGS } from '@renderer/services/AssistantService'
import type { AssistantSettings as AssistantSettingsType } from '@renderer/types'
import { getLeadingEmoji, modalConfirm } from '@renderer/utils'
import {
  Button,
  Col,
  Divider,
  Flex,
  Input,
  InputNumber,
  Modal,
  Popover,
  Row,
  Slider,
  Switch,
  Tooltip,
  Upload
} from 'antd'
import TextArea from 'antd/es/input/TextArea'
import type { Dispatch, FC, SetStateAction } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { SettingContainer, SettingRow, SettingSubtitle } from '..'

const AssistantSettings: FC = () => {
  const { defaultAssistant, updateDefaultAssistant } = useDefaultAssistant()
  const [temperature, setTemperature] = useState(defaultAssistant.settings?.temperature ?? DEFAULT_TEMPERATURE)
  const [enableTemperature, setEnableTemperature] = useState(defaultAssistant.settings?.enableTemperature ?? false)
  const [enableMaxTokens, setEnableMaxTokens] = useState(defaultAssistant?.settings?.enableMaxTokens ?? false)
  const [maxTokens, setMaxTokens] = useState(defaultAssistant?.settings?.maxTokens ?? 0)
  const [topP, setTopP] = useState(defaultAssistant.settings?.topP ?? 1)
  const [enableTopP, setEnableTopP] = useState(defaultAssistant.settings?.enableTopP ?? false)
  const [toolUseMode, setToolUseMode] = useState<AssistantSettingsType['toolUseMode']>(
    defaultAssistant.settings?.toolUseMode ?? 'function'
  )
  const [emoji, setEmoji] = useState(defaultAssistant.emoji || getLeadingEmoji(defaultAssistant.name) || '')
  const [name, setName] = useState(
    defaultAssistant.name.replace(getLeadingEmoji(defaultAssistant.name) || '', '').trim()
  )
  const [uploading, setUploading] = useState(false)
  const identityImageUrl = useAssistantIdentityImage(emoji)
  const { theme } = useTheme()

  const { t } = useTranslation()

  const onUpdateAssistantSettings = (settings: Partial<AssistantSettingsType>) => {
    updateDefaultAssistant({
      ...defaultAssistant,
      settings: {
        ...defaultAssistant.settings,
        temperature: settings.temperature ?? temperature,
        enableTemperature: settings.enableTemperature ?? enableTemperature,
        enableMaxTokens: settings.enableMaxTokens ?? enableMaxTokens,
        maxTokens: settings.maxTokens ?? maxTokens,
        streamOutput: settings.streamOutput ?? true,
        topP: settings.topP ?? topP,
        enableTopP: settings.enableTopP ?? enableTopP,
        toolUseMode: settings.toolUseMode ?? toolUseMode
      }
    })
  }

  const handleChange =
    (setter: Dispatch<SetStateAction<number>>, updater: (value: number) => void) => (value: number | null) => {
      if (value !== null) {
        setter(value)
        updater(value)
      }
    }
  const onTemperatureChange = handleChange(setTemperature, (value) => onUpdateAssistantSettings({ temperature: value }))
  const onMaxTokensChange = handleChange(setMaxTokens, (value) => onUpdateAssistantSettings({ maxTokens: value }))
  const onTopPChange = handleChange(setTopP, (value) => onUpdateAssistantSettings({ topP: value }))

  const onReset = () => {
    setTemperature(DEFAULT_TEMPERATURE)
    setEnableTemperature(true)
    setEnableMaxTokens(false)
    setMaxTokens(0)
    setTopP(1)
    setEnableTopP(false)
    setToolUseMode('function')
    updateDefaultAssistant({
      ...defaultAssistant,
      settings: { ...DEFAULT_ASSISTANT_SETTINGS }
    })
  }

  /** 标识单路径写入：库选 emoji 与 `img:` 图片引用都落在 defaultAssistant.emoji 上；被替换的图片标识在无人引用时回收。 */
  const applyIdentity = (next: string) => {
    const previous = defaultAssistant.emoji
    setEmoji(next)
    updateDefaultAssistant({ ...defaultAssistant, emoji: next, name })
    if (next !== previous) {
      void releaseIdentityImage(previous)
    }
  }

  const handleEmojiSelect = (selectedEmoji: string) => {
    applyIdentity(selectedEmoji)
  }

  const handleEmojiDelete = () => {
    applyIdentity('')
  }

  const handleImageSelect = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      window.toast.error(t('assistants.settings.identity.image_invalid'))
      return
    }
    setUploading(true)
    try {
      applyIdentity(await createIdentityImage(file))
    } catch {
      window.toast.error(t('assistants.settings.identity.image_failed'))
    } finally {
      setUploading(false)
    }
  }

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newName = e.target.value
    setName(newName)
    updateDefaultAssistant({ ...defaultAssistant, name: newName })
  }

  return (
    <SettingContainer
      style={{ height: 'auto', background: 'transparent', padding: `0 0 12px 0`, gap: 10 }}
      theme={theme}>
      <HStack gap={8} alignItems="center" mt={10}>
        <Popover
          content={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Upload
                accept="image/png,image/jpeg,image/webp,image/gif"
                showUploadList={false}
                beforeUpload={(file) => {
                  void handleImageSelect(file)
                  return false
                }}>
                <Button
                  icon={<PictureOutlined style={{ fontSize: 14 }} />}
                  loading={uploading}
                  style={{ width: '100%' }}>
                  {t('assistants.settings.identity.image')}
                </Button>
              </Upload>
              <EmojiPicker onEmojiClick={handleEmojiSelect} />
            </div>
          }
          arrow
          trigger="click">
          <EmojiButtonWrapper>
            <Button style={{ fontSize: 20, padding: '4px', minWidth: '30px', height: '30px' }}>
              {identityImageUrl ? (
                <img
                  src={identityImageUrl}
                  alt=""
                  style={{ width: 22, height: 22, borderRadius: 11, objectFit: 'cover', verticalAlign: 'middle' }}
                />
              ) : (
                emoji
              )}
            </Button>
            {emoji && (
              <CloseCircleFilled
                className="delete-icon"
                onClick={(e) => {
                  e.stopPropagation()
                  handleEmojiDelete()
                }}
                style={{
                  display: 'none',
                  position: 'absolute',
                  top: '-8px',
                  right: '-8px',
                  fontSize: '16px',
                  color: '#ff4d4f',
                  cursor: 'pointer'
                }}
              />
            )}
          </EmojiButtonWrapper>
        </Popover>
        <Input
          placeholder={t('common.assistant') + t('common.name')}
          value={name}
          onChange={handleNameChange}
          style={{ flex: 1 }}
        />
      </HStack>
      <SettingSubtitle style={{ marginTop: 0 }}>{t('common.prompt')}</SettingSubtitle>
      <TextArea
        rows={4}
        placeholder={t('common.assistant') + t('common.prompt')}
        value={defaultAssistant.prompt}
        onChange={(e) => updateDefaultAssistant({ ...defaultAssistant, prompt: e.target.value })}
        spellCheck={false}
      />
      <SettingSubtitle
        style={{
          display: 'flex',
          flexDirection: 'row',
          justifyContent: 'space-between',
          marginTop: 0
        }}>
        {t('settings.assistant.model_params')}
        <Tooltip title={t('common.reset')} mouseLeaveDelay={0}>
          <Button type="text" onClick={onReset} icon={<ResetIcon size={16} />} />
        </Tooltip>
      </SettingSubtitle>
      <Divider style={{ margin: '2px 0' }} />
      <SettingRow>
        <HStack alignItems="center">
          <Label>{t('chat.settings.temperature.label')}</Label>
          <Tooltip title={t('chat.settings.temperature.tip')}>
            <QuestionIcon />
          </Tooltip>
        </HStack>
        <Switch
          style={{ marginLeft: 10 }}
          checked={enableTemperature}
          onChange={(enabled) => {
            setEnableTemperature(enabled)
            onUpdateAssistantSettings({ enableTemperature: enabled })
          }}
        />
      </SettingRow>
      {enableTemperature && (
        <Row align="middle" gutter={12} style={{ marginTop: -5, marginBottom: -10 }}>
          <Col span={20}>
            <Slider
              min={0}
              max={2}
              onChange={setTemperature}
              onChangeComplete={onTemperatureChange}
              value={typeof temperature === 'number' ? temperature : 0}
              marks={{ 0: '0', 0.7: '0.7', 2: '2' }}
              step={0.01}
            />
          </Col>
          <Col span={4}>
            <InputNumber
              min={0}
              max={2}
              step={0.01}
              value={temperature}
              onChange={onTemperatureChange}
              style={{ width: '100%' }}
            />
          </Col>
        </Row>
      )}
      <Divider style={{ margin: '2px 0' }} />
      <SettingRow>
        <HStack alignItems="center">
          <Label>{t('chat.settings.top_p.label')}</Label>
          <Tooltip title={t('chat.settings.top_p.tip')}>
            <QuestionIcon />
          </Tooltip>
        </HStack>
        <Switch
          style={{ marginLeft: 10 }}
          checked={enableTopP}
          onChange={(enabled) => {
            setEnableTopP(enabled)
            onUpdateAssistantSettings({ enableTopP: enabled })
          }}
        />
      </SettingRow>
      {enableTopP && (
        <Row align="middle" gutter={12} style={{ marginTop: -5, marginBottom: -10 }}>
          <Col span={20}>
            <Slider
              min={0}
              max={1}
              onChange={setTopP}
              onChangeComplete={onTopPChange}
              value={typeof topP === 'number' ? topP : 1}
              marks={{ 0: '0', 0.5: '0.5', 1: '1' }}
              step={0.01}
            />
          </Col>
          <Col span={4}>
            <InputNumber min={0} max={1} step={0.01} value={topP} onChange={onTopPChange} style={{ width: '100%' }} />
          </Col>
        </Row>
      )}
      <Divider style={{ margin: '2px 0' }} />
      <Flex justify="space-between" align="center">
        <HStack alignItems="center">
          <Label>{t('chat.settings.max_tokens.label')}</Label>
          <Tooltip title={t('chat.settings.max_tokens.tip')}>
            <QuestionIcon />
          </Tooltip>
        </HStack>
        <Switch
          style={{ marginLeft: 10 }}
          checked={enableMaxTokens}
          onChange={async (enabled) => {
            if (enabled) {
              const confirmed = await modalConfirm({
                title: t('chat.settings.max_tokens.confirm'),
                content: t('chat.settings.max_tokens.confirm_content'),
                okButtonProps: {
                  danger: true
                }
              })
              if (!confirmed) return
            }

            setEnableMaxTokens(enabled)
            onUpdateAssistantSettings({ enableMaxTokens: enabled })
          }}
        />
      </Flex>
      {enableMaxTokens && (
        <Row align="middle" gutter={20}>
          <Col span={24}>
            <InputNumber
              disabled={!enableMaxTokens}
              min={0}
              max={10000000}
              step={100}
              value={maxTokens}
              changeOnBlur
              onChange={onMaxTokensChange}
              style={{ width: '100%' }}
            />
          </Col>
        </Row>
      )}
      <Divider style={{ margin: '2px 0' }} />
      <SettingRow>
        <Label>{t('assistants.settings.tool_use_mode.label')}</Label>
        <Selector
          value={toolUseMode}
          options={[
            { label: t('assistants.settings.tool_use_mode.prompt'), value: 'prompt' },
            { label: t('assistants.settings.tool_use_mode.function'), value: 'function' }
          ]}
          onChange={(value) => {
            setToolUseMode(value)
            onUpdateAssistantSettings({ toolUseMode: value })
          }}
          size={14}
        />
      </SettingRow>
    </SettingContainer>
  )
}

interface Props {
  resolve: (data: any) => void
}

const PopupContainer: React.FC<Props> = ({ resolve }) => {
  const [open, setOpen] = useState(true)
  const { t } = useTranslation()

  const onOk = () => {
    setOpen(false)
  }

  const onCancel = () => {
    setOpen(false)
  }

  const onClose = () => {
    resolve({})
  }

  // 同类：不在渲染期给静态类写属性（严格模式下执行两次；卸载后引用仍指向
  // 旧闭包）。关闭路径由 show() 内的 TopView.hide 与 `static hide()` 覆盖。

  return (
    <Modal
      title={t('settings.assistant.title')}
      open={open}
      onOk={onOk}
      onCancel={onCancel}
      afterClose={onClose}
      transitionName="animation-move-down"
      centered
      width={500}
      footer={null}>
      <AssistantSettings />
    </Modal>
  )
}

const TopViewKey = 'DefaultAssistantSettingsPopup'

export default class DefaultAssistantSettingsPopup {
  static topviewId = 0
  static hide() {
    TopView.hide(TopViewKey)
  }
  static show() {
    return new Promise<any>((resolve) => {
      TopView.show(
        <PopupContainer
          resolve={(v) => {
            resolve(v)
            TopView.hide(TopViewKey)
          }}
        />,
        TopViewKey
      )
    })
  }
}

const EmojiButtonWrapper = styled.div`
  position: relative;
  display: inline-block;

  &:hover .delete-icon {
    display: block !important;
  }
`

const Label = styled.p`
  margin: 0;
  font-size: 14px;
  margin-right: 5px;
`

const QuestionIcon = styled(QuestionCircleOutlined)`
  font-size: 14px;
  cursor: pointer;
  color: var(--color-text-3);
`

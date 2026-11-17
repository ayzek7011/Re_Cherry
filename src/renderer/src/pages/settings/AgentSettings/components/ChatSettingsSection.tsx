import { QuestionCircleOutlined } from '@ant-design/icons'
import CodeEditor from '@renderer/components/CodeEditor'
import EditableNumber from '@renderer/components/EditableNumber'
import { DeleteIcon, ResetIcon } from '@renderer/components/Icons'
import { HStack } from '@renderer/components/Layout'
import Selector from '@renderer/components/Selector'
import {
  DEFAULT_CONTEXTCOUNT,
  DEFAULT_TEMPERATURE,
  MAX_CONTEXT_COUNT,
  MAX_TOOL_CALLS,
  MIN_TOOL_CALLS
} from '@renderer/config/constant'
import { useTimer } from '@renderer/hooks/useTimer'
import { SettingRow } from '@renderer/pages/settings'
import { DEFAULT_ASSISTANT_SETTINGS } from '@renderer/services/AssistantService'
import type { Assistant, AssistantSettingCustomParameters, AssistantSettings } from '@renderer/types'
import { modalConfirm } from '@renderer/utils'
import { Button, Col, Divider, Input, InputNumber, Row, Select, Slider, Switch, Tooltip } from 'antd'
import { isNull } from 'lodash-es'
import { PlusIcon } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  assistant: Assistant
  updateAssistantSettings: (settings: Partial<AssistantSettings>) => void
}

/**
 * "聊天设置"采样参数区块 —— 从 AssistantSettings/AssistantModelSettings.tsx 原样搬入
 * （temperature/topP/contextCount/maxTokens/流式输出/工具调用方式/最大工具调用次数/自定义参数 + 重置），
 * 仅把默认模型行留在了基础页（搬家不重写）。
 */
const ChatSettingsSection: FC<Props> = ({ assistant, updateAssistantSettings }) => {
  const [temperature, setTemperature] = useState(assistant?.settings?.temperature ?? DEFAULT_TEMPERATURE)
  const [contextCount, setContextCount] = useState(assistant?.settings?.contextCount ?? DEFAULT_CONTEXTCOUNT)
  const enableMaxTokens = useMemo(
    () => assistant?.settings?.enableMaxTokens ?? DEFAULT_ASSISTANT_SETTINGS.enableMaxTokens,
    [assistant?.settings?.enableMaxTokens]
  )
  const [maxTokens, setMaxTokens] = useState(assistant?.settings?.maxTokens ?? 0)
  const streamOutput = useMemo(
    () => assistant?.settings?.streamOutput ?? DEFAULT_ASSISTANT_SETTINGS.streamOutput,
    [assistant?.settings?.streamOutput]
  )
  const toolUseMode = useMemo(
    () => assistant?.settings?.toolUseMode ?? DEFAULT_ASSISTANT_SETTINGS.toolUseMode,
    [assistant?.settings?.toolUseMode]
  )
  const [maxToolCalls, setMaxToolCalls] = useState(assistant?.settings?.maxToolCalls ?? 20)
  const enableMaxToolCalls = useMemo(
    () => assistant?.settings?.enableMaxToolCalls ?? DEFAULT_ASSISTANT_SETTINGS.enableMaxToolCalls,
    [assistant?.settings?.enableMaxToolCalls]
  )
  const [topP, setTopP] = useState(assistant?.settings?.topP ?? 1)
  const enableTopP = useMemo(
    () => assistant?.settings?.enableTopP ?? DEFAULT_ASSISTANT_SETTINGS.enableTopP,
    [assistant?.settings?.enableTopP]
  )
  const [customParameters, setCustomParameters] = useState<AssistantSettingCustomParameters[]>(
    assistant?.settings?.customParameters ?? []
  )
  const enableTemperature = useMemo(
    () => assistant?.settings?.enableTemperature ?? DEFAULT_ASSISTANT_SETTINGS.enableTemperature,
    [assistant?.settings?.enableTemperature]
  )

  const customParametersRef = useRef(customParameters)

  customParametersRef.current = customParameters

  /**
   * 延迟写入的采样参数必须能在卸载 / 重置前落库。
   *
   * 旧实现把写入挂在 500ms/1000ms 的 `setTimeoutTimer` 上，而 `useTimer` 在卸载时
   * `clearAllTimers()`：改完参数立刻关弹窗或切 tab，`setTemperature` 已经跑过、界面
   * 看上去改好了，但写入从未发生；「重置」也不会清挂起的定时器，于是旧值在重置后
   * 被反写回去。这里给每个字段留一份最新值 ref：卸载时 flush，重置时连定时器一起清空。
   */
  const pendingRef = useRef<{
    temperature?: number
    topP?: number
    contextCount?: number
    maxTokens?: number
    maxToolCalls?: number
  }>({})

  /** 排程一次延迟写入：ref 先记最新值，回调触发后清标记。 */
  const scheduleWrite = <K extends keyof typeof pendingRef.current>(
    key: K,
    value: NonNullable<(typeof pendingRef.current)[K]>,
    delay: number
  ) => {
    pendingRef.current[key] = value
    setTimeoutTimer(
      `${key}_onChange`,
      () => {
        pendingRef.current[key] = undefined
        updateAssistantSettings({ [key]: value })
      },
      delay
    )
  }

  /** 把还没落库的挂起值一次性写入（卸载时调用）。 */
  const flushPendingWrites = () => {
    const pending = pendingRef.current
    pendingRef.current = {}
    const flush: Partial<AssistantSettings> = {}
    if (pending.temperature !== undefined) flush.temperature = pending.temperature
    if (pending.topP !== undefined) flush.topP = pending.topP
    if (pending.contextCount !== undefined) flush.contextCount = pending.contextCount
    if (pending.maxTokens !== undefined) flush.maxTokens = pending.maxTokens
    if (pending.maxToolCalls !== undefined) flush.maxToolCalls = pending.maxToolCalls
    if (Object.keys(flush).length > 0) {
      updateAssistantSettings(flush)
    }
  }

  const { t } = useTranslation()
  const { setTimeoutTimer, clearAllTimeoutTimers } = useTimer()

  const onTemperatureChange = (value) => {
    if (!isNaN(value as number)) {
      updateAssistantSettings({ temperature: value })
    }
  }

  const onContextCountChange = (value) => {
    if (!isNaN(value as number)) {
      updateAssistantSettings({ contextCount: value })
    }
  }

  const onTopPChange = (value) => {
    if (!isNaN(value as number)) {
      updateAssistantSettings({ topP: value })
    }
  }

  const onAddCustomParameter = () => {
    const newParam = { name: '', value: '', type: 'string' as const }
    const newParams = [...customParameters, newParam]
    setCustomParameters(newParams)
    updateAssistantSettings({ customParameters: newParams })
  }

  const onUpdateCustomParameter = (
    index: number,
    field: 'name' | 'value' | 'type',
    value: string | number | boolean | object
  ) => {
    const newParams = [...customParameters]
    if (field === 'type') {
      let defaultValue: any = ''
      switch (value) {
        case 'number':
          defaultValue = 0
          break
        case 'boolean':
          defaultValue = false
          break
        case 'json':
          defaultValue = ''
          break
        default:
          defaultValue = ''
      }
      newParams[index] = {
        ...newParams[index],
        type: value as any,
        value: defaultValue
      }
    } else {
      newParams[index] = { ...newParams[index], [field]: value }
    }
    setCustomParameters(newParams)
  }

  const renderParameterValueInput = (param: (typeof customParameters)[0], index: number) => {
    switch (param.type) {
      case 'number':
        return (
          <InputNumber
            style={{ width: '100%' }}
            value={param.value as number}
            onChange={(value) => onUpdateCustomParameter(index, 'value', value || 0)}
            step={0.01}
          />
        )
      case 'boolean':
        return (
          <Select
            value={param.value as boolean}
            onChange={(value) => onUpdateCustomParameter(index, 'value', value)}
            style={{ width: '100%' }}
            options={[
              { label: 'true', value: true },
              { label: 'false', value: false }
            ]}
          />
        )
      case 'json': {
        const jsonValue = typeof param.value === 'string' ? param.value : JSON.stringify(param.value, null, 2)
        let hasJsonError = false
        if (jsonValue.trim()) {
          try {
            JSON.parse(jsonValue)
          } catch {
            hasJsonError = true
          }
        }
        return (
          <>
            <CodeEditor
              value={jsonValue}
              language="json"
              onChange={(value) => onUpdateCustomParameter(index, 'value', value)}
              expanded={false}
              height="auto"
              maxHeight="200px"
              minHeight="60px"
              options={{ lint: true, lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
              style={{
                borderRadius: 6,
                overflow: 'hidden',
                border: `1px solid ${hasJsonError ? 'var(--color-error)' : 'var(--color-border)'}`
              }}
            />
            {hasJsonError && (
              <div style={{ color: 'var(--color-error)', fontSize: 12, marginTop: 4 }}>
                {t('models.json_parse_error')}
              </div>
            )}
          </>
        )
      }
      default:
        return (
          <Input
            value={param.value as string}
            onChange={(e) => onUpdateCustomParameter(index, 'value', e.target.value)}
          />
        )
    }
  }

  const onDeleteCustomParameter = (index: number) => {
    const newParams = customParameters.filter((_, i) => i !== index)
    setCustomParameters(newParams)
    updateAssistantSettings({ customParameters: newParams })
  }

  const onReset = () => {
    // 先清掉挂起的延迟写入，否则重置后它们会把刚重置的值再写回去。
    clearAllTimeoutTimers()
    pendingRef.current = {}
    setTemperature(DEFAULT_ASSISTANT_SETTINGS.temperature)
    setContextCount(DEFAULT_ASSISTANT_SETTINGS.contextCount)
    setMaxTokens(DEFAULT_ASSISTANT_SETTINGS.maxTokens)
    setTopP(DEFAULT_ASSISTANT_SETTINGS.topP)
    setCustomParameters(DEFAULT_ASSISTANT_SETTINGS.customParameters)
    setMaxToolCalls(DEFAULT_ASSISTANT_SETTINGS.maxToolCalls)
    updateAssistantSettings(DEFAULT_ASSISTANT_SETTINGS)
  }

  useEffect(() => {
    return () => {
      flushPendingWrites()
      updateAssistantSettings({ customParameters: customParametersRef.current })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const formatSliderTooltip = (value?: number) => {
    if (value === undefined) return ''
    return value.toString()
  }

  return (
    <Container>
      <SettingRow style={{ minHeight: 30 }}>
        <HStack alignItems="center">
          <Label>
            {t('chat.settings.temperature.label')}
            <Tooltip title={t('chat.settings.temperature.tip')}>
              <QuestionIcon />
            </Tooltip>
          </Label>
        </HStack>
        <Switch
          checked={enableTemperature}
          onChange={(enabled) => {
            updateAssistantSettings({ enableTemperature: enabled })
          }}
        />
      </SettingRow>
      {enableTemperature && (
        <Row align="middle" gutter={12}>
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
            <EditableNumber
              min={0}
              max={2}
              step={0.01}
              value={temperature}
              changeOnBlur
              onChange={(value) => {
                if (!isNull(value)) {
                  setTemperature(value)
                  scheduleWrite('temperature', value, 500)
                }
              }}
              style={{ width: '100%' }}
            />
          </Col>
        </Row>
      )}
      <Divider style={{ margin: '10px 0' }} />

      <SettingRow style={{ minHeight: 30 }}>
        <HStack alignItems="center">
          <Label>{t('chat.settings.top_p.label')}</Label>
          <Tooltip title={t('chat.settings.top_p.tip')}>
            <QuestionIcon />
          </Tooltip>
        </HStack>
        <Switch
          checked={enableTopP}
          onChange={(enabled) => {
            updateAssistantSettings({ enableTopP: enabled })
          }}
        />
      </SettingRow>
      {enableTopP && (
        <Row align="middle" gutter={12}>
          <Col span={20}>
            <Slider
              min={0}
              max={1}
              onChange={setTopP}
              onChangeComplete={onTopPChange}
              value={typeof topP === 'number' ? topP : 1}
              marks={{ 0: '0', 1: '1' }}
              step={0.01}
            />
          </Col>
          <Col span={4}>
            <EditableNumber
              min={0}
              max={1}
              step={0.01}
              value={topP}
              changeOnBlur
              onChange={(value) => {
                if (!isNull(value)) {
                  setTopP(value)
                  scheduleWrite('topP', value, 500)
                }
              }}
              style={{ width: '100%' }}
            />
          </Col>
        </Row>
      )}
      <Divider style={{ margin: '10px 0' }} />

      <Row align="middle">
        <Col span={20}>
          <Label>
            {t('chat.settings.context_count.label')}{' '}
            <Tooltip title={t('chat.settings.context_count.tip')}>
              <QuestionIcon />
            </Tooltip>
          </Label>
        </Col>
        <Col span={4}>
          <EditableNumber
            min={0}
            max={MAX_CONTEXT_COUNT}
            step={1}
            value={contextCount}
            changeOnBlur
            onChange={(value) => {
              if (!isNull(value)) {
                setContextCount(value)
                scheduleWrite('contextCount', value, 500)
              }
            }}
            formatter={(value) => (value === MAX_CONTEXT_COUNT ? t('chat.settings.max') : (value ?? ''))}
            style={{ width: '100%' }}
          />
        </Col>
      </Row>
      <Row align="middle" gutter={24}>
        <Col span={24}>
          <ContextSliderWrapper>
            <Slider
              min={0}
              max={MAX_CONTEXT_COUNT}
              onChange={setContextCount}
              onChangeComplete={onContextCountChange}
              value={typeof contextCount === 'number' ? contextCount : 0}
              marks={{
                0: '0',
                25: '25',
                50: '50',
                75: '75',
                100: <span style={{ position: 'absolute', right: -2 }}>{t('chat.settings.max')}</span>
              }}
              step={1}
              tooltip={{ formatter: formatSliderTooltip, open: false }}
            />
          </ContextSliderWrapper>
        </Col>
      </Row>
      <Divider style={{ margin: '10px 0' }} />
      <SettingRow style={{ minHeight: 30 }}>
        <HStack alignItems="center">
          <Label>{t('chat.settings.max_tokens.label')}</Label>
          <Tooltip title={t('chat.settings.max_tokens.tip')}>
            <QuestionIcon />
          </Tooltip>
        </HStack>
        <Switch
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
            updateAssistantSettings({ enableMaxTokens: enabled })
          }}
        />
      </SettingRow>
      {enableMaxTokens && (
        <Row align="middle" style={{ marginTop: 5, marginBottom: 5 }}>
          <Col span={24}>
            <InputNumber
              disabled={!enableMaxTokens}
              min={0}
              max={10000000}
              step={100}
              value={maxTokens}
              changeOnBlur
              onChange={(value) => {
                if (!isNull(value)) {
                  setMaxTokens(value)
                  scheduleWrite('maxTokens', value, 1000)
                }
              }}
              style={{ width: '100%' }}
            />
          </Col>
        </Row>
      )}
      <Divider style={{ margin: '10px 0' }} />
      <SettingRow style={{ minHeight: 30 }}>
        <Label>{t('models.stream_output')}</Label>
        <Switch
          checked={streamOutput}
          onChange={(checked) => {
            updateAssistantSettings({ streamOutput: checked })
          }}
        />
      </SettingRow>
      <Divider style={{ margin: '10px 0' }} />
      <SettingRow style={{ minHeight: 30 }}>
        <Label>{t('assistants.settings.tool_use_mode.label')}</Label>
        <Selector
          value={toolUseMode}
          options={[
            { label: t('assistants.settings.tool_use_mode.prompt'), value: 'prompt' },
            { label: t('assistants.settings.tool_use_mode.function'), value: 'function' }
          ]}
          onChange={(value) => {
            updateAssistantSettings({ toolUseMode: value })
          }}
          size={14}
        />
      </SettingRow>
      <Divider style={{ margin: '10px 0' }} />
      <SettingRow style={{ minHeight: 30 }}>
        <HStack alignItems="center">
          <Label>{t('assistants.settings.max_tool_calls.label')}</Label>
          <Tooltip title={t('assistants.settings.max_tool_calls.tip')}>
            <QuestionIcon />
          </Tooltip>
        </HStack>
        <Switch
          checked={enableMaxToolCalls}
          onChange={(enabled) => {
            updateAssistantSettings({ enableMaxToolCalls: enabled })
          }}
        />
      </SettingRow>
      {enableMaxToolCalls && (
        <Row align="middle" style={{ marginTop: 5, marginBottom: 5 }}>
          <Col span={24}>
            <InputNumber
              min={MIN_TOOL_CALLS}
              max={MAX_TOOL_CALLS}
              step={1}
              value={maxToolCalls}
              onChange={(value) => {
                if (!isNull(value)) {
                  setMaxToolCalls(value)
                  scheduleWrite('maxToolCalls', value, 500)
                }
              }}
              style={{ width: '100%' }}
            />
          </Col>
        </Row>
      )}
      <Divider style={{ margin: '10px 0' }} />
      <SettingRow style={{ minHeight: 30 }}>
        <Label>{t('models.custom_parameters')}</Label>
        <Button icon={<PlusIcon size={18} />} onClick={onAddCustomParameter}>
          {t('models.add_parameter')}
        </Button>
      </SettingRow>
      {customParameters.map((param, index) => (
        <div key={index} style={{ marginTop: 10 }}>
          <Row align="stretch" gutter={10}>
            <Col span={6}>
              <Input
                placeholder={t('models.parameter_name')}
                value={param.name}
                onChange={(e) => onUpdateCustomParameter(index, 'name', e.target.value)}
              />
            </Col>
            <Col span={6}>
              <Select
                value={param.type}
                onChange={(value) => onUpdateCustomParameter(index, 'type', value)}
                style={{ width: '100%' }}>
                <Select.Option value="string">{t('models.parameter_type.string')}</Select.Option>
                <Select.Option value="number">{t('models.parameter_type.number')}</Select.Option>
                <Select.Option value="boolean">{t('models.parameter_type.boolean')}</Select.Option>
                <Select.Option value="json">{t('models.parameter_type.json')}</Select.Option>
              </Select>
            </Col>
            {param.type !== 'json' && <Col span={10}>{renderParameterValueInput(param, index)}</Col>}
            <Col span={param.type === 'json' ? 12 : 2} style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button
                color="danger"
                variant="filled"
                icon={<DeleteIcon size={14} className="lucide-custom" />}
                onClick={() => onDeleteCustomParameter(index)}
              />
            </Col>
          </Row>
          {param.type === 'json' && <div style={{ marginTop: 6 }}>{renderParameterValueInput(param, index)}</div>}
        </div>
      ))}
      <Divider style={{ margin: '15px 0' }} />
      <HStack justifyContent="flex-end">
        <Button onClick={onReset} danger type="primary" icon={<ResetIcon size={16} />}>
          {t('chat.settings.reset')}
        </Button>
      </HStack>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  padding: 0;
`

const Label = styled.p`
  margin-right: 5px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
`

const QuestionIcon = styled(QuestionCircleOutlined)`
  font-size: 12px;
  cursor: pointer;
  color: var(--color-text-3);
`

const ContextSliderWrapper = styled.div`
  padding-bottom: 5px;
`

export default ChatSettingsSection

import CopyIcon from '@renderer/components/Icons/CopyIcon'
import {
  EmbeddingTag,
  ImageGenerationTag,
  ReasoningTag,
  RerankerTag,
  ToolsCallingTag,
  VisionTag,
  WebSearchTag
} from '@renderer/components/Tags/Model'
import { WarnTooltip } from '@renderer/components/TooltipIcons'
import { endpointTypeOptions } from '@renderer/config/endpointTypes'
import {
  isEmbeddingModel,
  isFunctionCallingModel,
  isGenerateImageModel,
  isReasoningModel,
  isRerankModel,
  isVisionModel,
  isWebSearchModel
} from '@renderer/config/models'
import { useDynamicLabelWidth } from '@renderer/hooks/useDynamicLabelWidth'
import type { Model, ModelCapability, ModelType, Provider } from '@renderer/types'
import { getDefaultGroupName, getDifference, getUnion, uniqueObjectArray } from '@renderer/utils'
import { isNewApiProvider } from '@renderer/utils/provider'
import type { ModalProps } from 'antd'
import { Button, Divider, Flex, Form, Input, InputNumber, message, Modal, Select, Switch, Tooltip } from 'antd'
import type { TFunction } from 'i18next'
import { cloneDeep } from 'lodash-es'
import { ChevronDown, ChevronUp, RotateCcw, SaveIcon } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface ModelEditContentProps {
  provider: Provider
  model: Model
  onUpdateModel: (model: Model) => void
}

const symbols = ['$', '¥', '€', '£']
const ModelEditContent: FC<ModelEditContentProps & ModalProps> = ({ provider, model, onUpdateModel, ...props }) => {
  const [form] = Form.useForm()
  const { t } = useTranslation()
  const [showMoreSettings, setShowMoreSettings] = useState(false)
  const [currencySymbol, setCurrencySymbol] = useState(model.pricing?.currencySymbol || '$')
  const [isCustomCurrency, setIsCustomCurrency] = useState(!symbols.includes(model.pricing?.currencySymbol || '$'))
  const [modelCapabilities, setModelCapabilities] = useState(model.capabilities || [])
  const originalModelCapabilities = cloneDeep(model.capabilities || [])
  const [supportedTextDelta, setSupportedTextDelta] = useState(model.supported_text_delta)
  const [hasUserModified, setHasUserModified] = useState(false)

  const labelWidth = useDynamicLabelWidth([t('settings.models.add.endpoint_type.label')])

  /**
   * 价格字段的空值语义：`Number(x) || 0` 把「清空输入框」当成 0 写库。
   * 清空是用户重填前的中间态，此时保留原值；只有真的填了数字才写。
   */
  const toTokenPrice = (raw: unknown, fallback: number | undefined): number => {
    if (raw === null || raw === undefined || raw === '') return fallback ?? 0
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : (fallback ?? 0)
  }

  // 自动保存函数
  const autoSave = (overrides?: {
    capabilities?: ModelCapability[]
    supported_text_delta?: boolean
    currencySymbol?: string
    isCustomCurrency?: boolean
  }) => {
    const formValues = form.getFieldsValue()
    const currentIsCustomCurrency = overrides?.isCustomCurrency ?? isCustomCurrency
    const currentCurrencySymbol = overrides?.currencySymbol ?? currencySymbol
    const finalCurrencySymbol = currentIsCustomCurrency
      ? formValues.customCurrencySymbol || currentCurrencySymbol
      : formValues.currencySymbol || currentCurrencySymbol || '$'
    const updatedModel: Model = {
      ...model,
      id: formValues.id || model.id,
      name: formValues.name || model.name,
      group: formValues.group || model.group,
      endpoint_type: isNewApiProvider(provider) ? formValues.endpointType : model.endpoint_type,
      capabilities: overrides?.capabilities ?? modelCapabilities,
      supported_text_delta: overrides?.supported_text_delta ?? supportedTextDelta,
      pricing: {
        input_per_million_tokens: toTokenPrice(
          formValues.input_per_million_tokens,
          model.pricing?.input_per_million_tokens
        ),
        output_per_million_tokens: toTokenPrice(
          formValues.output_per_million_tokens,
          model.pricing?.output_per_million_tokens
        ),
        currencySymbol: finalCurrencySymbol
      }
    }
    onUpdateModel(updatedModel)
  }

  const onFinish = (values: any) => {
    const finalCurrencySymbol = isCustomCurrency ? values.customCurrencySymbol : values.currencySymbol
    const updatedModel: Model = {
      ...model,
      id: values.id || model.id,
      name: values.name || model.name,
      group: values.group || model.group,
      endpoint_type: isNewApiProvider(provider) ? values.endpointType : model.endpoint_type,
      capabilities: modelCapabilities,
      supported_text_delta: supportedTextDelta,
      pricing: {
        input_per_million_tokens: toTokenPrice(
          values.input_per_million_tokens,
          model.pricing?.input_per_million_tokens
        ),
        output_per_million_tokens: toTokenPrice(
          values.output_per_million_tokens,
          model.pricing?.output_per_million_tokens
        ),
        currencySymbol: finalCurrencySymbol || '$'
      }
    }
    onUpdateModel(updatedModel)
    setShowMoreSettings(false)
    props.onOk?.(undefined as any)
  }

  const currencyOptions = [
    ...symbols.map((symbol) => ({ label: symbol, value: symbol })),
    { label: t('models.price.custom'), value: 'custom' }
  ]

  const defaultTypes: ModelType[] = useMemo(
    () => [
      ...(isVisionModel(model) ? (['vision'] as const) : []),
      ...(isReasoningModel(model) ? (['reasoning'] as const) : []),
      ...(isFunctionCallingModel(model) ? (['function_calling'] as const) : []),
      ...(isWebSearchModel(model) ? (['web_search'] as const) : []),
      ...(isEmbeddingModel(model) ? (['embedding'] as const) : []),
      ...(isRerankModel(model) ? (['rerank'] as const) : []),
      // 生图能力位（宽语义 = `isGenerateImageModel`）——用户手选即最高优先，
      // 与 V2 `EditModelDrawer` 把主类型选成 image 时写 `IMAGE_GENERATION` 同一件事。
      ...(isGenerateImageModel(model) ? (['image_generation'] as const) : [])
    ],
    [model]
  )

  const selectedTypes: ModelType[] = useMemo(
    () =>
      getUnion(
        modelCapabilities?.filter((t) => t.isUserSelected).map((t) => t.type) || [],
        getDifference(
          defaultTypes,
          modelCapabilities?.filter((t) => t.isUserSelected === false).map((t) => t.type) || []
        )
      ),
    [defaultTypes, modelCapabilities]
  )

  // 被rerank/embedding改变的类型
  // const changedTypesRef = useRef<string[]>([])

  useEffect(() => {
    if (showMoreSettings) {
      const newModelCapabilities = getUnion(
        selectedTypes.map((type) => {
          const existingCapability = modelCapabilities?.find((m) => m.type === type)
          return {
            type: type,
            isUserSelected: existingCapability?.isUserSelected ?? undefined
          }
        }),
        modelCapabilities?.filter((t) => t.isUserSelected === false),
        (item) => item.type
      )
      setModelCapabilities(newModelCapabilities)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMoreSettings])

  // 监听modelCapabilities变化，自动保存（但跳过初始化时的保存）
  useEffect(() => {
    if (hasUserModified && showMoreSettings) {
      autoSave()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelCapabilities])

  // 能力标签组原先定义在渲染体内并按 `<ModelCapability />` 使用。
  // 那样每次父渲染都会产生新的组件类型 → React 卸载重挂整组（DOM 重建、焦点丢失）；
  // 而 `updateType` 的 `useCallback(..., [])` 之所以"看起来没问题"，正是靠这次重挂刷新闭包。
  // 现在标签组提为模块级组件（见文件末尾 `ModelCapabilityTags`），闭包正确性由依赖数组保证。
  const updateType = useCallback(
    (type: ModelType) => {
      setHasUserModified(true)
      setModelCapabilities((prev) =>
        uniqueObjectArray([
          ...prev.filter((t) => t.type !== type),
          { type, isUserSelected: !selectedTypes.includes(type) }
        ])
      )
    },
    [selectedTypes]
  )

  const handleResetTypes = () => {
    setModelCapabilities(originalModelCapabilities)
    setHasUserModified(false) // 重置后清除修改标志
  }

  return (
    <Modal title={t('models.edit')} footer={null} transitionName="animation-move-down" centered {...props}>
      <Form
        form={form}
        labelCol={{ flex: isNewApiProvider(provider) ? labelWidth : '110px' }}
        labelAlign="left"
        colon={false}
        style={{ marginTop: 15 }}
        initialValues={{
          id: model.id,
          name: model.name,
          group: model.group,
          endpointType: model.endpoint_type,
          input_per_million_tokens: model.pricing?.input_per_million_tokens ?? 0,
          output_per_million_tokens: model.pricing?.output_per_million_tokens ?? 0,
          currencySymbol: symbols.includes(model.pricing?.currencySymbol || '$')
            ? model.pricing?.currencySymbol || '$'
            : 'custom',
          customCurrencySymbol: symbols.includes(model.pricing?.currencySymbol || '$')
            ? ''
            : model.pricing?.currencySymbol || ''
        }}
        onFinish={onFinish}>
        <Form.Item
          name="id"
          label={t('settings.models.add.model_id.label')}
          tooltip={t('settings.models.add.model_id.tooltip')}
          rules={[{ required: true }]}>
          <Flex justify="space-between" gap={5}>
            <Input
              placeholder={t('settings.models.add.model_id.placeholder')}
              spellCheck={false}
              maxLength={200}
              disabled={true}
              value={model.id}
              onChange={(e) => {
                const value = e.target.value
                form.setFieldValue('name', value)
                form.setFieldValue('group', getDefaultGroupName(value))
              }}
              suffix={
                <CopyIcon
                  size={14}
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    const val = form.getFieldValue('name')
                    void navigator.clipboard.writeText((val.id || model.id) as string)
                    message.success(t('message.copied'))
                  }}
                />
              }
            />
          </Flex>
        </Form.Item>
        <Form.Item
          name="name"
          label={t('settings.models.add.model_name.label')}
          tooltip={t('settings.models.add.model_name.tooltip')}>
          <Input placeholder={t('settings.models.add.model_name.placeholder')} spellCheck={false} />
        </Form.Item>
        <Form.Item
          name="group"
          label={t('settings.models.add.group_name.label')}
          tooltip={t('settings.models.add.group_name.tooltip')}>
          <Input placeholder={t('settings.models.add.group_name.placeholder')} spellCheck={false} />
        </Form.Item>
        {isNewApiProvider(provider) && (
          <Form.Item
            name="endpointType"
            label={t('settings.models.add.endpoint_type.label')}
            tooltip={t('settings.models.add.endpoint_type.tooltip')}
            rules={[{ required: true, message: t('settings.models.add.endpoint_type.required') }]}>
            <Select placeholder={t('settings.models.add.endpoint_type.placeholder')}>
              {endpointTypeOptions.map((opt) => (
                <Select.Option key={opt.value} value={opt.value}>
                  {t(opt.label)}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
        )}
        <Form.Item style={{ marginBottom: 8, textAlign: 'center' }}>
          <Flex justify="space-between" align="center" style={{ position: 'relative' }}>
            <Button
              color="default"
              variant="filled"
              icon={showMoreSettings ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              iconPosition="end"
              onClick={() => setShowMoreSettings(!showMoreSettings)}
              style={{ color: 'var(--color-text-3)' }}>
              {t('settings.moresetting.label')}
            </Button>
            <Button type="primary" htmlType="submit" icon={<SaveIcon size={16} />}>
              {t('common.save')}
            </Button>
          </Flex>
        </Form.Item>
        {showMoreSettings && (
          <div style={{ marginBottom: 8 }}>
            <Divider style={{ margin: '16px 0 16px 0' }} />
            <ModelCapabilityTags
              t={t}
              selectedTypes={selectedTypes}
              hasUserModified={hasUserModified}
              onToggle={updateType}
              onReset={handleResetTypes}
            />
            <Divider style={{ margin: '16px 0 12px 0' }} />
            <Form.Item
              name="supported_text_delta"
              style={{ marginBottom: 10 }}
              labelCol={{ flex: 1 }}
              label={t('settings.models.add.supported_text_delta.label')}
              tooltip={t('settings.models.add.supported_text_delta.tooltip')}>
              <Switch
                checked={supportedTextDelta}
                style={{ marginLeft: 'auto' }}
                size="small"
                onChange={(checked) => {
                  setSupportedTextDelta(checked)
                  // 直接传递新值给autoSave
                  autoSave({ supported_text_delta: checked })
                }}
              />
            </Form.Item>
            <Divider style={{ margin: '12px 0 16px 0' }} />
            <Form.Item name="currencySymbol" label={t('models.price.currency')} style={{ marginBottom: 10 }}>
              <Select
                style={{ width: '100px' }}
                options={currencyOptions}
                onChange={(value) => {
                  if (value === 'custom') {
                    const customSymbol = form.getFieldValue('customCurrencySymbol') || ''
                    setIsCustomCurrency(true)
                    setCurrencySymbol(customSymbol)
                    // 自动保存
                    autoSave({
                      isCustomCurrency: true,
                      currencySymbol: customSymbol
                    })
                  } else {
                    setIsCustomCurrency(false)
                    setCurrencySymbol(value)
                    // 自动保存
                    autoSave({
                      isCustomCurrency: false,
                      currencySymbol: value
                    })
                  }
                }}
                dropdownMatchSelectWidth={false}
              />
            </Form.Item>

            {isCustomCurrency && (
              <Form.Item
                name="customCurrencySymbol"
                label={t('models.price.custom_currency')}
                style={{ marginBottom: 10 }}
                rules={[{ required: isCustomCurrency }]}>
                <Input
                  style={{ width: '100px' }}
                  placeholder={t('models.price.custom_currency_placeholder')}
                  defaultValue={model.pricing?.currencySymbol}
                  maxLength={5}
                  // 只刷新展示用的符号；落库交给失焦（同 ：输入框不做按键级持久化）。
                  onChange={(e) => setCurrencySymbol(e.target.value)}
                  onBlur={(e) => {
                    autoSave({
                      currencySymbol: e.target.value,
                      isCustomCurrency: true
                    })
                  }}
                />
              </Form.Item>
            )}

            <Form.Item label={t('models.price.input')} style={{ marginBottom: 10 }} name="input_per_million_tokens">
              <InputNumber
                placeholder="0.00"
                defaultValue={model.pricing?.input_per_million_tokens}
                min={0}
                step={0.01}
                precision={2}
                style={{ width: '240px' }}
                addonAfter={`${currencySymbol} / ${t('models.price.million_tokens')}`}
                // 输入框每敲一位都 autoSave 会把 llm + assistants 两个
                // 持久化切片各写一次并广播两次；改为失焦提交（同名值不再触发）。
                onBlur={() => autoSave()}
              />
            </Form.Item>
            <Form.Item label={t('models.price.output')} style={{ marginBottom: 10 }} name="output_per_million_tokens">
              <InputNumber
                placeholder="0.00"
                defaultValue={model.pricing?.output_per_million_tokens}
                min={0}
                step={0.01}
                precision={2}
                style={{ width: '240px' }}
                addonAfter={`${currencySymbol} / ${t('models.price.million_tokens')}`}
                onBlur={() => autoSave()}
              />
            </Form.Item>
          </div>
        )}
      </Form>
    </Modal>
  )
}

const TypeTitle = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 12px 0;
  font-size: 14px;
  font-weight: 600;
`

interface ModelCapabilityTagsProps {
  t: TFunction
  selectedTypes: ModelType[]
  hasUserModified: boolean
  /** 翻转某项能力（父级持有状态与持久化） */
  onToggle: (type: ModelType) => void
  /** 恢复为打开弹窗时的能力集合 */
  onReset: () => void
}

/**
 * 模型能力标签组。
 *
 * 必须是**模块级**组件，不能定义在 `ModelEditContent` 的渲染体内：定义在渲染体内时每次父渲染
 * 都会产生新的组件类型，React 会卸载重挂整组（DOM 重建、焦点丢失）。
 */
function ModelCapabilityTags({ t, selectedTypes, hasUserModified, onToggle, onReset }: ModelCapabilityTagsProps) {
  // 排他标签组：嵌入 / 重排 / 生图 三者互斥，且任一被选中即禁用其余"能力"标签
  // —— 一个模型不可能既是嵌入模型、又是重排模型、又是生图模型。
  const exclusiveTypes: ModelType[] = ['embedding', 'rerank', 'image_generation']
  const selectedExclusive = exclusiveTypes.filter((type) => selectedTypes.includes(type))
  const isExclusiveDisabled = (type: ModelType) => selectedExclusive.some((selected) => selected !== type)
  const isOtherDisabled = selectedExclusive.length > 0

  return (
    <>
      <TypeTitle>
        <Flex align="center" gap={4} style={{ height: 24 }}>
          {t('models.type.select')}
          <WarnTooltip title={t('settings.moresetting.check.warn')} />
        </Flex>

        {hasUserModified && (
          <Tooltip title={t('common.reset')}>
            <Button size="small" icon={<RotateCcw size={14} />} onClick={onReset} type="text" />
          </Tooltip>
        )}
      </TypeTitle>
      <Flex justify="flex-start" align="center" gap={4} wrap={'wrap'} style={{ marginBottom: 8 }}>
        <VisionTag
          showLabel
          inactive={isOtherDisabled || !selectedTypes.includes('vision')}
          disabled={isOtherDisabled}
          onClick={() => onToggle('vision')}
        />
        <WebSearchTag
          showLabel
          inactive={isOtherDisabled || !selectedTypes.includes('web_search')}
          disabled={isOtherDisabled}
          onClick={() => onToggle('web_search')}
        />
        <ReasoningTag
          showLabel
          inactive={isOtherDisabled || !selectedTypes.includes('reasoning')}
          disabled={isOtherDisabled}
          onClick={() => onToggle('reasoning')}
        />
        <ToolsCallingTag
          showLabel
          inactive={isOtherDisabled || !selectedTypes.includes('function_calling')}
          disabled={isOtherDisabled}
          onClick={() => onToggle('function_calling')}
        />
        {/* 排他组：生图 / 重排 / 嵌入（三枚同组互斥，且任一被选中即禁用上面那四个能力标签）。
            与嵌入/重排一样**不传 showLabel** —— 那三枚用文字当图标，再渲染 children 会变成「生图 生图」。 */}
        <ImageGenerationTag
          inactive={isExclusiveDisabled('image_generation') || !selectedTypes.includes('image_generation')}
          disabled={isExclusiveDisabled('image_generation')}
          onClick={() => onToggle('image_generation')}
        />
        <RerankerTag
          disabled={isExclusiveDisabled('rerank')}
          inactive={isExclusiveDisabled('rerank') || !selectedTypes.includes('rerank')}
          onClick={() => onToggle('rerank')}
        />
        <EmbeddingTag
          inactive={isExclusiveDisabled('embedding') || !selectedTypes.includes('embedding')}
          disabled={isExclusiveDisabled('embedding')}
          onClick={() => onToggle('embedding')}
        />
      </Flex>
    </>
  )
}

export default ModelEditContent

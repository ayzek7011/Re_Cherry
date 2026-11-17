import { HStack } from '@renderer/components/Layout'
import ModelSelector from '@renderer/components/ModelSelector'
import { InfoTooltip } from '@renderer/components/TooltipIcons'
import { isChatCandidateModel, isVisionModel } from '@renderer/config/models'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useDefaultModel } from '@renderer/hooks/useAssistant'
import { useProviders } from '@renderer/hooks/useProvider'
import { getModelUniqId, hasModel } from '@renderer/services/ModelService'
import { isPaintingCandidateModel } from '@renderer/services/paintingModelSelection'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { setPaintingModel } from '@renderer/store/llm'
import type { Model } from '@renderer/types'
import { Button } from 'antd'
import { find } from 'lodash-es'
import { MessageSquareMore, Palette, Rocket, ScanText, Settings2 } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { SettingContainer, SettingDescription, SettingGroup, SettingTitle } from '..'
import DefaultAssistantSettings from './DefaultAssistantSettings'
import ImageDescriberPopup from './ImageDescriberPopup'
import TopicNamingModalPopup from './QuickModelPopup'

interface ModelSettingsProps {
  showSettingsButton?: boolean
  showDescription?: boolean
  compact?: boolean
  /** V2 同名 prop：onboarding 复用点传 false 隐藏绘画模型行（V2 OnboardingPage 同形）。 */
  showPaintingModel?: boolean
}

const ModelSettings: FC<ModelSettingsProps> = ({
  showSettingsButton = true,
  showDescription = true,
  compact = false,
  showPaintingModel = true
}) => {
  const { defaultModel, quickModel, imageDescriberModel, setDefaultModel, setQuickModel, setImageDescriberModel } =
    useDefaultModel()
  const { providers } = useProviders()
  const allModels = providers.map((p) => p.models).flat()
  const { theme } = useTheme()
  const { t } = useTranslation()
  // fork 缝：绘画模型（llm.paintingModel）读写——V2 走 Preference feature.paintings.default_model_id，
  // fork 用 redux llm 切片；绘画页只读它播种新草稿，此处是唯一编辑点。
  const dispatch = useAppDispatch()
  const paintingModel = useAppSelector((state) => state.llm.paintingModel)

  // 对话/默认模型选单：统一判据（嵌入/重排/生图都不能对话）
  const modelPredicate = useCallback((m: Model) => isChatCandidateModel(m), [])

  const defaultModelValue = useMemo(
    () => (hasModel(defaultModel) ? getModelUniqId(defaultModel) : undefined),
    [defaultModel]
  )

  const defaultQuickModel = useMemo(() => (hasModel(quickModel) ? getModelUniqId(quickModel) : undefined), [quickModel])

  // 转述模型（识图通道）：下拉只列视觉模型（嵌入/重排/文生图天然不通过 isVisionModel）。
  const describerModelValue = useMemo(
    () => (imageDescriberModel && hasModel(imageDescriberModel) ? getModelUniqId(imageDescriberModel) : undefined),
    [imageDescriberModel]
  )

  // fork 缝：绘画模型回显值（redux llm.paintingModel，缺省/已移除 → undefined）。
  const paintingModelValue = useMemo(
    () => (paintingModel && hasModel(paintingModel) ? getModelUniqId(paintingModel) : undefined),
    [paintingModel]
  )

  const containerStyle = compact ? { padding: 0, background: 'transparent' } : undefined
  const groupStyle = compact ? { padding: 0, border: 'none', background: 'transparent' } : undefined

  return (
    <SettingContainer theme={theme} style={containerStyle}>
      <SettingGroup theme={theme} style={groupStyle}>
        <SettingTitle style={{ marginBottom: 12 }}>
          <HStack alignItems="center" gap={10}>
            <MessageSquareMore size={18} color="var(--color-text)" />
            {t('settings.models.default_assistant_model')}
          </HStack>
        </SettingTitle>
        <HStack alignItems="center">
          <ModelSelector
            providers={providers}
            predicate={modelPredicate}
            value={defaultModelValue}
            defaultValue={defaultModelValue}
            style={{ width: compact ? '100%' : 360 }}
            size={compact ? 'large' : 'middle'}
            onChange={(value) => setDefaultModel(find(allModels, JSON.parse(value)) as Model)}
            placeholder={t('settings.models.empty')}
          />
          {showSettingsButton && (
            <Button icon={<Settings2 size={16} />} style={{ marginLeft: 8 }} onClick={DefaultAssistantSettings.show} />
          )}
        </HStack>
        {showDescription && (
          <SettingDescription>{t('settings.models.default_assistant_model_description')}</SettingDescription>
        )}
      </SettingGroup>
      <SettingGroup theme={theme} style={groupStyle}>
        <SettingTitle style={{ marginBottom: 12 }}>
          <HStack alignItems="center" gap={10}>
            <Rocket size={18} color="var(--color-text)" />
            {t('settings.models.quick_model.label')}
            <InfoTooltip title={t('settings.models.quick_model.tooltip')} />
          </HStack>
        </SettingTitle>
        <HStack alignItems="center">
          <ModelSelector
            providers={providers}
            predicate={modelPredicate}
            value={defaultQuickModel}
            defaultValue={defaultQuickModel}
            style={{ width: compact ? '100%' : 360 }}
            size={compact ? 'large' : 'middle'}
            onChange={(value) => setQuickModel(find(allModels, JSON.parse(value)) as Model)}
            placeholder={t('settings.models.empty')}
          />
          {showSettingsButton && (
            <Button icon={<Settings2 size={16} />} style={{ marginLeft: 8 }} onClick={TopicNamingModalPopup.show} />
          )}
        </HStack>
        {showDescription && <SettingDescription>{t('settings.models.quick_model.description')}</SettingDescription>}
      </SettingGroup>
      <SettingGroup theme={theme} style={groupStyle}>
        <SettingTitle style={{ marginBottom: 12 }}>
          <HStack alignItems="center" gap={10}>
            <ScanText size={18} color="var(--color-text)" />
            {t('settings.models.image_describer.label')}
            <InfoTooltip title={t('settings.models.image_describer.description')} />
          </HStack>
        </SettingTitle>
        <HStack alignItems="center">
          {/* 同另两栏：一个普通模型栏，用户手选；允许清空（清空 = 未配置）。 */}
          {/* 设置按钮弹提示词编辑（'' = 内置默认），同另两栏的设置按钮形态。 */}
          <ModelSelector
            providers={providers}
            predicate={isVisionModel}
            value={describerModelValue}
            style={{ width: compact ? '100%' : 360 }}
            size={compact ? 'large' : 'middle'}
            allowClear
            onChange={(value) =>
              setImageDescriberModel(value ? (find(allModels, JSON.parse(value)) as Model) : undefined)
            }
            placeholder={t('settings.models.image_describer.label')}
          />
          {showSettingsButton && (
            <Button icon={<Settings2 size={16} />} style={{ marginLeft: 8 }} onClick={ImageDescriberPopup.show} />
          )}
        </HStack>
        {showDescription && <SettingDescription>{t('settings.models.image_describer.description')}</SettingDescription>}
      </SettingGroup>
      {/* fork 缝：V2「设置 › 默认模型」的绘画模型行（V2 走 Preference + DataApi selector）；
          fork 用 redux llm.paintingModel，谓词取 paintingModelSelection 的单一来源
          isPaintingCandidateModel。键名/文案照抄 V2：settings.models.painting_model[_description]。
          onboarding 复用点由 V2 同名 prop `showPaintingModel={false}` 隐藏（V2 OnboardingPage 同形）。 */}
      {showPaintingModel && (
        <SettingGroup theme={theme} style={groupStyle}>
          <SettingTitle style={{ marginBottom: 12 }}>
            <HStack alignItems="center" gap={10}>
              <Palette size={18} color="var(--color-text)" />
              {t('settings.models.painting_model')}
            </HStack>
          </SettingTitle>
          <HStack alignItems="center">
            {/* 允许清空（清空 = 未配置绘画模型，绘画页回落到 provider 首个可用模型）。 */}
            <ModelSelector
              providers={providers}
              predicate={isPaintingCandidateModel}
              value={paintingModelValue}
              style={{ width: 360 }}
              size="middle"
              allowClear
              onChange={(value) =>
                dispatch(setPaintingModel({ model: value ? (find(allModels, JSON.parse(value)) as Model) : undefined }))
              }
              placeholder={t('settings.models.empty')}
            />
          </HStack>
          {showDescription && (
            <SettingDescription>{t('settings.models.painting_model_description')}</SettingDescription>
          )}
        </SettingGroup>
      )}
    </SettingContainer>
  )
}

export default ModelSettings

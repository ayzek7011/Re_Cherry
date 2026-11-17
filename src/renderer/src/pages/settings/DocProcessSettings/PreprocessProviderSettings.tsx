/**
 * 自 CS_V1 移植（单个文档处理 provider 表单）。
 * v0.4 验收轮补 V1 的官网/取密钥外链（PREPROCESS_PROVIDER_CONFIG）：标题行官网
 * 图标链接 + apiKey 帮助行「点击这里获取密钥」。多 Key 管理弹窗（ApiKeyListPopup）保留。
 * 表单为本地 state + blur 提交（apiKey 经 formatApiKeys 规范化逗号分隔多 key；
 * apiHost trim 去尾 /）；无 model 字段 UI（mistral 默认值来自切片初始表）。
 * local-paddle（模型下载卡片）与 vision-model（视觉模型选择器）两个本地/自带
 * 模型条目各有专属面板——两者都是通道里的服务商条目，不是独立系统。
 */
import ModelSelector from '@renderer/components/ModelSelector'
import { ApiKeyListPopup } from '@renderer/components/Popups/ApiKeyListPopup'
import { isVisionModel } from '@renderer/config/models'
import { PREPROCESS_PROVIDER_CONFIG } from '@renderer/config/preprocessProviders'
import { useLocalPaddle } from '@renderer/hooks/useLocalPaddle'
import { usePreprocessProvider } from '@renderer/hooks/usePreprocess'
import { useProviders } from '@renderer/hooks/useProvider'
import { getModelUniqId, hasModel } from '@renderer/services/ModelService'
import type { Model, PreprocessProvider } from '@renderer/types'
import { formatApiKeys, hasObjectKey } from '@renderer/utils'
import { Button, Divider, Flex, Input, Progress, Slider, Switch, Tooltip } from 'antd'
import { find } from 'lodash-es'
import { ExternalLink, List } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { SettingHelpLink, SettingHelpText, SettingHelpTextRow, SettingSubtitle, SettingTitle } from '..'

interface Props {
  provider: PreprocessProvider
}

const PreprocessProviderSettings: FC<Props> = ({ provider: _provider }) => {
  const { provider: preprocessProvider, updateProvider } = usePreprocessProvider(_provider.id)
  const { t } = useTranslation()
  const [apiKey, setApiKey] = useState(preprocessProvider?.apiKey || '')
  const [apiHost, setApiHost] = useState(preprocessProvider?.apiHost || '')

  useEffect(() => {
    setApiKey(preprocessProvider?.apiKey ?? '')
    setApiHost(preprocessProvider?.apiHost ?? '')
  }, [preprocessProvider?.apiKey, preprocessProvider?.apiHost, preprocessProvider?.options])

  // 找不到该 provider 时渲染显式占位，不再 `return null`
  //（静默整块消失是最坏失败模式）。位置仍在全部 hooks 之后——hook 顺序不得条件化。
  if (!preprocessProvider) {
    return (
      <SettingHelpTextRow>
        <SettingHelpText>
          {t('settings.tool.preprocess.provider_not_found', { defaultValue: '未找到该文档处理服务商' })}
        </SettingHelpText>
      </SettingHelpTextRow>
    )
  }

  const providerConfig = PREPROCESS_PROVIDER_CONFIG[preprocessProvider.id]
  const officialWebsite = providerConfig?.official
  const apiKeyWebsite = providerConfig?.apiKey

  const onUpdateApiKey = () => {
    if (apiKey !== preprocessProvider.apiKey) {
      updateProvider({ apiKey })
    }
  }

  const openApiKeyList = async () => {
    await ApiKeyListPopup.show({
      providerId: preprocessProvider.id,
      title: `${preprocessProvider.name} ${t('settings.provider.api.key.list.title')}`,
      showHealthCheck: false
    })
  }

  const onUpdateApiHost = () => {
    let trimmedHost = apiHost?.trim() || ''
    if (trimmedHost.endsWith('/')) {
      trimmedHost = trimmedHost.slice(0, -1)
    }
    if (trimmedHost !== preprocessProvider.apiHost) {
      updateProvider({ apiHost: trimmedHost })
    } else {
      setApiHost(preprocessProvider.apiHost || '')
    }
  }

  return (
    <>
      <SettingTitle>
        <Flex align="center" gap={8}>
          <ProviderName>{preprocessProvider.name}</ProviderName>
          {officialWebsite && (
            <SettingHelpLink target="_blank" href={officialWebsite}>
              <ExternalLink className="text-[12px]" />
            </SettingHelpLink>
          )}
        </Flex>
      </SettingTitle>
      <Divider className="my-[10px] w-full" />
      {preprocessProvider.id === 'local-paddle' && <LocalPaddleModelPanel />}
      {preprocessProvider.id === 'vision-model' && <VisionModelPanel />}
      {hasObjectKey(preprocessProvider, 'apiKey') && (
        <>
          <SettingSubtitle className="mt-[5px] mb-[10px] flex items-center justify-between">
            {preprocessProvider.id === 'paddleocr'
              ? t('settings.tool.preprocess.paddleocr.aistudio_access_token')
              : t('settings.provider.api_key.label')}
            {preprocessProvider.id !== 'paddleocr' && (
              <Tooltip title={t('settings.provider.api.key.list.open')} mouseEnterDelay={0.5}>
                <Button type="text" size="small" onClick={openApiKeyList} icon={<List size={14} />} />
              </Tooltip>
            )}
          </SettingSubtitle>
          <Flex gap={8}>
            <Input.Password
              value={apiKey}
              placeholder={
                preprocessProvider.id === 'paddleocr'
                  ? t('settings.tool.preprocess.paddleocr.aistudio_access_token')
                  : t('settings.provider.api_key.label')
              }
              onChange={(e) => setApiKey(formatApiKeys(e.target.value))}
              onBlur={onUpdateApiKey}
              spellCheck={false}
              type="password"
              autoFocus={apiKey === ''}
            />
          </Flex>
          {preprocessProvider.id !== 'paddleocr' && (
            <SettingHelpTextRow className="mt-[5px] justify-between">
              {apiKeyWebsite && (
                <SettingHelpLink target="_blank" href={apiKeyWebsite}>
                  {t('settings.provider.get_api_key')}
                </SettingHelpLink>
              )}
              <SettingHelpText>{t('settings.provider.api_key.tip')}</SettingHelpText>
            </SettingHelpTextRow>
          )}
        </>
      )}

      {hasObjectKey(preprocessProvider, 'apiHost') && (
        <>
          <SettingSubtitle className="mt-[5px] mb-[10px]">
            {preprocessProvider.id === 'paddleocr'
              ? t('settings.tool.preprocess.paddleocr.api_url')
              : t('settings.provider.api_host')}
          </SettingSubtitle>
          <Flex>
            <Input
              value={apiHost}
              placeholder={
                preprocessProvider.id === 'paddleocr'
                  ? t('settings.tool.preprocess.paddleocr.api_url')
                  : t('settings.provider.api_host')
              }
              onChange={(e) => setApiHost(e.target.value)}
              onBlur={onUpdateApiHost}
            />
          </Flex>
          {preprocessProvider.id === 'paddleocr' && (
            <SettingHelpTextRow className="!flex-col">
              <SettingHelpText>{t('settings.tool.preprocess.paddleocr.api_url_label')}</SettingHelpText>
            </SettingHelpTextRow>
          )}
        </>
      )}
    </>
  )
}

const ProviderName = styled.span`
  font-size: 14px;
  font-weight: 500;
`

/** LocalPaddle 模型下载卡片（收编自 CS_V2 LocalModelRequirement 形态裁剪：
 * 状态机 not_downloaded/downloading/ready/error/unsupported，进度轮询自 useLocalPaddle）。 */
const LocalPaddleModelPanel: FC = () => {
  const { provider, updateProvider } = usePreprocessProvider('local-paddle')
  const { status, download, cancel, remove } = useLocalPaddle()
  const { t } = useTranslation()
  // 页级并发（用户裁定：缺省 5、上限 20——实测 CPU 跑不满，串行循环三段互相空转）
  const concurrency = provider?.localConcurrency

  return (
    <>
      <SettingSubtitle className="mt-[5px] mb-[10px]">
        {t('settings.tool.preprocess.local_paddle.model_title')}
      </SettingSubtitle>
      {status.status === 'ready' && (
        <>
          <SettingHelpTextRow>
            <SettingHelpText>{t('settings.tool.preprocess.local_paddle.ready')}</SettingHelpText>
          </SettingHelpTextRow>
          <Button className="mt-2" size="small" onClick={() => void remove()}>
            {t('settings.tool.preprocess.local_paddle.remove')}
          </Button>
        </>
      )}
      {status.status === 'downloading' && (
        <>
          <Progress percent={status.percent ?? 0} />
          <Button className="mt-2" size="small" onClick={cancel}>
            {t('settings.tool.preprocess.local_paddle.cancel')}
          </Button>
        </>
      )}
      {(status.status === 'not_downloaded' || status.status === 'error') && (
        <>
          <SettingHelpTextRow>
            <SettingHelpText>{t('settings.tool.preprocess.local_paddle.not_downloaded')}</SettingHelpText>
          </SettingHelpTextRow>
          {status.status === 'error' && status.error !== undefined && (
            <SettingHelpTextRow>
              <SettingHelpText>
                {`${t('settings.tool.preprocess.local_paddle.error_prefix')}: ${status.error}`}
              </SettingHelpText>
            </SettingHelpTextRow>
          )}
          <Button className="mt-2" type="primary" size="small" onClick={() => void download()}>
            {status.status === 'error'
              ? t('settings.tool.preprocess.local_paddle.retry')
              : t('settings.tool.preprocess.local_paddle.download')}
          </Button>
        </>
      )}
      {status.status === 'unsupported' && (
        <SettingHelpTextRow>
          <SettingHelpText>{t('settings.tool.preprocess.local_paddle.unsupported')}</SettingHelpText>
        </SettingHelpTextRow>
      )}
      <SettingSubtitle className="mt-[10px] mb-[10px]">
        {t('settings.tool.preprocess.local_paddle.concurrency')}
      </SettingSubtitle>
      <Slider
        defaultValue={concurrency ?? 5}
        style={{ width: '100%' }}
        min={1}
        max={20}
        step={1}
        marks={{ 1: '1', 5: '5', 10: '10', 20: '20' }}
        onChangeComplete={(next) => updateProvider({ localConcurrency: next })}
      />
      <SettingSubtitle className="mt-[10px] mb-[10px]">
        {t('settings.tool.preprocess.local_paddle.gpu_acceleration')}
      </SettingSubtitle>
      <Switch
        checked={provider?.gpuAcceleration !== false}
        onChange={(checked) => updateProvider({ gpuAcceleration: checked })}
      />
      <SettingHelpTextRow className="!flex-col">
        <SettingHelpText>{t('settings.tool.preprocess.local_paddle.help')}</SettingHelpText>
      </SettingHelpTextRow>
    </>
  )
}

/**
 * 视觉模型文档解析面板：选一个视觉模型写入 preprocess 切片该条目的
 * visionModel 字段（持久化 Model 对象，llm.imageDescriberModel 同款形态）——
 * 执行缝在 preprocess/vision（本机光栅化 + 多模态 chat 逐页转写）。
 * 下拉只列视觉模型（isVisionModel 是唯一判据，与设置页转述模型共用）。
 */
const VisionModelPanel: FC = () => {
  const { provider, updateProvider } = usePreprocessProvider('vision-model')
  const { providers } = useProviders()
  const { t } = useTranslation()
  const allModels = useMemo(() => providers.flatMap((p) => p.models), [providers])
  const visionModel = provider?.visionModel
  const value = useMemo(
    () => (visionModel && hasModel(visionModel) ? getModelUniqId(visionModel) : undefined),
    [visionModel]
  )
  const onSelect = useCallback(
    (selected: string) => {
      const model = find(allModels, JSON.parse(selected)) as Model | undefined
      if (model !== undefined) {
        updateProvider({ visionModel: model })
      }
    },
    [allModels, updateProvider]
  )
  // 页级并发（用户裁定：缺省 8、上限 20——并发调高是对自己钥匙配额的判断）
  const concurrency = provider?.visionConcurrency

  return (
    <>
      <SettingSubtitle className="mt-[5px] mb-[10px]">
        {t('settings.tool.preprocess.vision_model.model_title')}
      </SettingSubtitle>
      <ModelSelector
        providers={providers}
        predicate={isVisionModel}
        value={value}
        defaultValue={value}
        style={{ width: '100%' }}
        onChange={onSelect}
        placeholder={t('settings.tool.preprocess.vision_model.model_placeholder')}
      />
      <SettingSubtitle className="mt-[10px] mb-[10px]">
        {t('settings.tool.preprocess.vision_model.concurrency')}
      </SettingSubtitle>
      <Slider
        defaultValue={concurrency ?? 8}
        style={{ width: '100%' }}
        min={1}
        max={40}
        step={1}
        marks={{ 1: '1', 8: '8', 12: '12', 20: '20', 40: '40' }}
        onChangeComplete={(next) => updateProvider({ visionConcurrency: next })}
      />
      <SettingHelpTextRow className="!flex-col">
        <SettingHelpText>{t('settings.tool.preprocess.vision_model.help')}</SettingHelpText>
      </SettingHelpTextRow>
    </>
  )
}

export default PreprocessProviderSettings

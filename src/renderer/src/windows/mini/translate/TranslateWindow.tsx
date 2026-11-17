/**
 * 快捷助手小窗翻译视图（V2 quickAssistant/translate/TranslateWindow 整编）：
 * 挂载即自动翻译传入文本（只读源语言块 = 自动检测 + 目标语言下拉），
 * 文本/目标语言/翻译模型变化即重新翻译并作废旧结果；无目标语言持久化（组件内 state）。
 */
import Scrollbar from '@renderer/components/Scrollbar'
import {
  BUILTIN_TRANSLATE_LANGUAGES,
  langCodeToI18nKey,
  type TranslateLangCode
} from '@renderer/config/translateLanguages'
import { useDefaultModel } from '@renderer/hooks/useAssistant'
import { useSmoothStream } from '@renderer/hooks/useSmoothStream'
import { lightStream, lightStreamAbort } from '@renderer/services/lightLlm'
import { loggerService } from '@renderer/services/LoggerService'
import { useAppSelector } from '@renderer/store'
import { buildTranslatePrompt, detectLanguage, TRANSLATE_PROMPT } from '@renderer/utils/translate'
import { Select } from 'antd'
import { ArrowLeftRight } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { v4 as uuid } from 'uuid'

const logger = loggerService.withContext('MiniTranslateWindow')

interface TranslateWindowProps {
  text: string
  /** fork 缝：译文上报给宿主（`HomeWindow`），使翻译路由下 Footer 的「按 C 复制」胶囊可点。 */
  onResultChange?: (result: string) => void
}

const TranslateWindow: FC<TranslateWindowProps> = ({ text, onResultChange }) => {
  const { t } = useTranslation()
  // fork 缝（P0-D）：V2 用 `useDefaultModel().translateModel`（未配翻译模型时回落默认对话
  // 模型）。fork 的 useDefaultModel 只暴露 defaultModel，故按同一语义合成：主翻译页选择器
  // 写入的 state.llm.translateModel 优先，未配置时回落默认对话模型。此前只读 translateModel，
  // 而该字段的唯一写入者在主翻译页——小窗里恒为 undefined，翻译必然发出「未配置」提示。
  const { defaultModel } = useDefaultModel()
  const configuredTranslateModel = useAppSelector((state) => state.llm.translateModel)
  const translateModel = useMemo(
    () => configuredTranslateModel ?? defaultModel,
    [configuredTranslateModel, defaultModel]
  )

  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [targetLanguage, setTargetLanguage] = useState<TranslateLangCode>('zh-cn')
  /** V1 语义：源语言块显示"自动检测 (检测到的语言)"，检测不出则只显示"自动检测"。 */
  const [detectedLanguage, setDetectedLanguage] = useState<TranslateLangCode | null>(null)

  // 在途请求的 requestId：新请求/卸载使其作废，旧事件与旧终态一律丢弃
  const requestIdRef = useRef<string | null>(null)

  // playout 句柄放进 ref，不放进 effect 依赖数组。
  // 旧实现的死循环链条：`streamDone: !isTranslating` → `reset` 依赖 `streamDone`
  // → 请求开始/结束翻转 `isTranslating` → `reset` 换 identity → 翻译 effect 因依赖变化重跑
  // → cleanup abort 旧流 + 再发一次 lightStream……翻译永不收敛，模型费用无界。
  // 终态不再由 `isTranslating` 推导，改由流自身的 `done`/`error`/通道结束显式 `update(text, true)`。
  const smoothStream = useSmoothStream({ onUpdate: setResult })
  const smoothStreamRef = useRef(smoothStream)
  useEffect(() => {
    smoothStreamRef.current = smoothStream
  })

  const languageLabel = (code: TranslateLangCode) => {
    const key = langCodeToI18nKey.get(code)
    return key ? t(key) : code
  }

  const languageOptions = useMemo(
    () =>
      BUILTIN_TRANSLATE_LANGUAGES.map((lang) => ({
        value: lang.langCode,
        label: `${lang.emoji} ${t(langCodeToI18nKey.get(lang.langCode) ?? lang.value)}`
      })),
    [t]
  )

  useEffect(() => {
    const { reset, update } = smoothStreamRef.current
    reset('')

    const source = text.trim()
    // fork 缝：V1 的源语言块在检测后显示实际语言（`自动检测 (中文)`）；检测是本地 franc，零额外请求。
    // franc-min 经动态装载（不进首屏 eager 图），作废语义随 effect cleanup。
    let detectionCancelled = false
    void detectLanguage(source).then((detected) => {
      if (!detectionCancelled) setDetectedLanguage(detected)
    })
    if (source.length === 0 || !translateModel) {
      // 不发请求也不置错：中性空态由 error/未配模型提示分支承担。
      // 显式收敛 playout（`update('', true)`）：否则"队列空 + streamDone=false"会让 rAF 自旋。
      update('', true)
      setError(source.length === 0 ? null : t('translate.error.not_configured'))
      return
    }

    const requestId = `mini-translate:${uuid()}`
    requestIdRef.current = requestId
    setError(null)
    let accumulated = ''

    const run = async () => {
      try {
        await lightStream(
          requestId,
          {
            provider: translateModel.provider,
            model: translateModel.id,
            messages: [
              { role: 'user', text: buildTranslatePrompt(TRANSLATE_PROMPT, languageLabel(targetLanguage), source) }
            ],
            source: 'cherry-quick-assistant'
          },
          (event) => {
            if (requestIdRef.current !== requestId) return
            if (event.type === 'delta') {
              accumulated += event.text
              // 走 `update` 的累计文本契约（内部按前缀差量入队）；与 `addChunk` 混用会把
              // 终态的整段累计再入队一次，译文重复。
              update(accumulated, false)
            } else if (event.type === 'error') {
              setError(`${t('translate.error.failed')}: ${event.message}`)
            }
          }
        )
      } catch (err) {
        if (requestIdRef.current !== requestId) return
        setError(`${t('translate.error.failed')}: ${err instanceof Error ? err.message : String(err)}`)
        logger.warn('mini translate failed', err as Error)
      } finally {
        // 终态由「流结束」显式驱动：done / error / 通道断开三条路都收敛 playout，
        // 先把已收到的字符吐完再停循环。旧代码这里翻转 isTranslating，正是自我重入的扳机。
        if (requestIdRef.current === requestId) {
          update(accumulated, true)
        }
      }
    }

    void run()

    return () => {
      detectionCancelled = true
      // 卸载即作废在途流：后续事件按 requestId 失配丢弃
      // fork 缝：作废之外额外发起真取消——重译/换语言/卸载时主进程 abort 旧流，
      // 否则旧模型继续生成到结束并计费（UI 行为不变：事件照旧失配丢弃、已生成内容保留）。
      void lightStreamAbort(requestId)
      requestIdRef.current = null
    }
    // 依赖只剩三个真输入：文本 / 目标语言 / 模型 id。languageLabel 随 targetLanguage 一并重算，
    // playout 句柄经 ref 持有。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, targetLanguage, translateModel?.id])

  useHotkeys('c', () => {
    if (!result) return
    void navigator.clipboard.writeText(result)
    window.toast.success(t('message.copy.success'))
  })

  // 译文变化即上报宿主（卸载时上报空串，避免宿主留着上一段译文可复制）。
  useEffect(() => {
    onResultChange?.(result)
  }, [onResultChange, result])
  useEffect(() => () => onResultChange?.(''), [onResultChange])

  return (
    <Container>
      <LanguageRow>
        <SourceBlock title={t('translate.auto_detect')}>
          {`${t('translate.auto_detect')}${detectedLanguage ? ` (${languageLabel(detectedLanguage)})` : ''}`}
        </SourceBlock>
        <ArrowLeftRight size={16} color="var(--color-text-secondary)" />
        <TargetSelect
          value={targetLanguage}
          options={languageOptions}
          showSearch
          optionFilterProp="label"
          popupMatchSelectWidth={false}
          onChange={(value) => setTargetLanguage(value as TranslateLangCode)}
        />
      </LanguageRow>
      {error !== null && <ErrorMsg>{error}</ErrorMsg>}
      <ResultArea>
        {result.length === 0 ? (
          <EmptyText>{`${t('translate.output_empty')}...`}</EmptyText>
        ) : (
          <Scrollbar style={{ flex: 1, minHeight: 0 }}>
            <ResultText>{result}</ResultText>
          </Scrollbar>
        )}
      </ResultArea>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  gap: 8px;
  -webkit-app-region: none;
`

const LanguageRow = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 12px;
`

const SourceBlock = styled.div`
  display: flex;
  flex: 1;
  min-width: 0;
  height: 32px;
  align-items: center;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background-color: var(--color-background-opacity);
  color: var(--color-text-secondary);
  font-size: 13px;
  padding: 0 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const TargetSelect = styled(Select)`
  flex: 1;
  min-width: 0;
`

const ResultArea = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
`

const ResultText = styled.div`
  width: 100%;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 14px;
  line-height: 1.6;
`

// fork 缝：--color-text-tertiary 全仓未定义（无 fallback 的 var() 使该声明失效、颜色回落
// inherit）→ 空态文案失去弱化层次；改用既有定义的 --color-text-3（assets/styles/color.css）。
const EmptyText = styled.div`
  color: var(--color-text-3);
  font-style: italic;
  font-size: 13px;
`

const ErrorMsg = styled.div`
  color: var(--color-error);
  background: rgba(255, 0, 0, 0.15);
  border: 1px solid var(--color-error);
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 12px;
  word-break: break-all;
`

export default TranslateWindow

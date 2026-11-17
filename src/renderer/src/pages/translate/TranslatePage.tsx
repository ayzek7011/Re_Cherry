/**
 * 翻译页（V2 页面结构重做）：Navbar + 顶栏（语言栏 / 译·停 / 模型·历史·设置）+ 双栏 grid
 * + 历史与设置两个 antd Drawer。状态编排全部留在本页，子组件只做展示与回调。
 * AI 通路仍是 fork 轻量服务面（services/lightLlm，source: 'cherry-translate'），无会话无内核旁路。
 */
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { SelectChatModelPopup } from '@renderer/components/Popups/SelectModelPopup/chat-model-popup'
import { isChatCandidateModel } from '@renderer/config/models'
import { langCodeToI18nKey, type TranslateLangCode } from '@renderer/config/translateLanguages'
import { db } from '@renderer/databases'
import { lightStream, lightStreamAbort } from '@renderer/services/lightLlm'
import { loggerService } from '@renderer/services/LoggerService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { setTranslateModel } from '@renderer/store/llm'
import type { AnyTranslateLangCode, TranslateRecord } from '@renderer/types/translate'
import { cn } from '@renderer/utils/style'
import {
  buildTranslatePrompt,
  detectLanguage,
  determineTargetLanguage,
  TRANSLATE_PROMPT
} from '@renderer/utils/translate'
import { CirclePause, History, Languages, SlidersHorizontal } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { v4 as uuid } from 'uuid'

import IconButton from './components/IconButton'
import TranslateHistoryList from './components/TranslateHistory'
import TranslateInputPane from './components/TranslateInputPane'
import TranslateLanguageBar from './components/TranslateLanguageBar'
import TranslateOutputPane from './components/TranslateOutputPane'
import TranslateSettings from './components/TranslateSettings'

const logger = loggerService.withContext('TranslatePage')

const COPY_FEEDBACK_MS = 1500

const TranslatePage = () => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const translateModel = useAppSelector((state) => state.llm.translateModel)
  // 偏好项回补（V2 feature.translate.page.* 的 fork redux 对位）
  const translateAutoCopy = useAppSelector((state) => state.settings.translateAutoCopy)
  const translateCustomPrompt = useAppSelector((state) => state.settings.translateCustomPrompt)
  const translateCustomLanguages = useAppSelector((state) => state.settings.translateCustomLanguages)

  const [sourceText, setSourceText] = useState('')
  const [outputText, setOutputText] = useState('')
  const [translating, setTranslating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [source, setSource] = useState<AnyTranslateLangCode | 'auto'>('auto')
  const [target, setTarget] = useState<AnyTranslateLangCode>('zh-cn')
  /** V1 语义（`TranslatePage.tsx:86/241-242`）：源语言为 auto 时检测到的实际语言，用于显示与落库。 */
  const [detectedLanguage, setDetectedLanguage] = useState<TranslateLangCode | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [history, setHistory] = useState<TranslateRecord[]>([])
  /** 历史读取失败原因（null = 没有失败）。见 ：失败不得伪装成"暂无记录"。 */
  const [historyError, setHistoryError] = useState<string | null>(null)

  const cancelledRef = useRef(false)
  const requestIdRef = useRef<string | undefined>(undefined)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  /** 卸载作废在途流：卸载后不再写状态、不再落历史。 */
  useEffect(() => {
    return () => {
      cancelledRef.current = true
      clearTimeout(copiedTimerRef.current)
    }
  }, [])

  const loadHistory = useCallback(async () => {
    try {
      const records = await db.translate_records.orderBy('createdAt').reverse().limit(50).toArray()
      setHistory(records)
      setHistoryError(null)
    } catch (error) {
      // Dexie 打不开/表结构不符时不能只落一条 warn——抽屉会渲染成官方的
      // "暂无翻译记录"空态，误导用户以为没有记录（本地历史是唯一副本），进而重复翻译或误判数据丢失。
      logger.error('load translate history failed', error as Error)
      setHistoryError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  const languageLabel = useCallback(
    (code: AnyTranslateLangCode | 'auto') => {
      // 自定义语言优先（其 value 即展示名），内置走 i18n 键族。
      const custom = translateCustomLanguages.find((lang) => lang.langCode === code)
      if (custom !== undefined) return `${custom.emoji} ${custom.value}`.trim()
      const key = langCodeToI18nKey.get(code)
      return key ? t(key) : t('translate.auto_detect')
    },
    [t, translateCustomLanguages]
  )

  /** 翻译（V2 useTranslate 单飞语义：新调用作废旧调用；requestId 不匹配的流事件一律丢弃）。 */
  const translate = useCallback(async () => {
    const text = sourceText.trim()
    if (text.length === 0 || translating) return
    if (!translateModel) {
      window.toast.error(t('translate.error.not_configured'))
      return
    }
    const decided = determineTargetLanguage(source, target)
    if (!decided.ok) {
      window.toast.warning(
        t(decided.reason === 'same_language' ? 'translate.error.same_language' : 'translate.error.not_pair')
      )
      return
    }
    const targetLabel = languageLabel(decided.target)
    // V1 `TranslatePage.tsx:239-242`：auto 源语言先检测再翻译，检测结果用于显示与历史落库。
    // fork 缝：只走离线 franc 档（V1 的 llm 档依赖已下线的老管线），检测不出则保持 null。
    // franc-min 动态装载（不进首屏 eager 图），await 后再进入翻译单飞。
    const detected = source === 'auto' ? await detectLanguage(text) : null
    setDetectedLanguage(detected)

    cancelledRef.current = false
    setTranslating(true)
    setOutputText('')
    const requestId = `translate:${uuid()}`
    requestIdRef.current = requestId
    let accumulated = ''

    try {
      await lightStream(
        requestId,
        {
          provider: translateModel.provider,
          model: translateModel.id,
          // 偏好项回补：自定义翻译指令（空 = 内置 TRANSLATE_PROMPT）
          messages: [
            {
              role: 'user',
              text: buildTranslatePrompt(
                translateCustomPrompt.trim().length > 0 ? translateCustomPrompt : TRANSLATE_PROMPT,
                targetLabel,
                text
              )
            }
          ],
          source: 'cherry-translate'
        },
        (event) => {
          if (cancelledRef.current || requestId !== requestIdRef.current) return
          if (event.type === 'delta') {
            accumulated += event.text
            setOutputText(accumulated)
          } else if (event.type === 'error') {
            window.toast.error(`${t('translate.error.failed')}: ${event.message}`)
          }
        }
      )
      if (!cancelledRef.current && accumulated.trim().length > 0) {
        // 偏好项回补（V2 feature.translate.page.auto_copy 同语义）：翻译成功即复制。
        if (translateAutoCopy) {
          navigator.clipboard.writeText(accumulated).catch((error: unknown) => {
            logger.warn('translate auto-copy failed', error instanceof Error ? error : new Error(String(error)))
          })
        }
        const record: TranslateRecord = {
          id: uuid(),
          sourceText: text,
          targetText: accumulated,
          // V1:201 落库写的是 `actualSourceLanguage.langCode`（auto 已解析成实际语言），
          // fork 同义：检测出来了就写检测结果，否则保持 'auto'。
          sourceLanguage: detected ?? decided.source,
          targetLanguage: decided.target,
          createdAt: Date.now()
        }
        await db.translate_records.put(record)
        void loadHistory()
      } else if (!cancelledRef.current && accumulated.trim().length === 0) {
        window.toast.error(t('translate.error.empty'))
      }
    } catch (error) {
      if (!cancelledRef.current) {
        window.toast.error(`${t('translate.error.failed')}: ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      // 卸载守卫此前只覆盖事件回调与成功/失败分支，漏了 `finally`——
      // 翻译中切走路由（懒加载页面，卸载很常见）后仍在已卸载组件上 `setTranslating(false)`。
      if (!cancelledRef.current && requestId === requestIdRef.current) {
        setTranslating(false)
        requestIdRef.current = undefined
      }
    }
  }, [
    sourceText,
    translating,
    translateModel,
    source,
    target,
    translateAutoCopy,
    translateCustomPrompt,
    languageLabel,
    loadHistory,
    t
  ])

  const abort = useCallback(() => {
    // fork 缝：「停止」额外发起真取消——作废事件之外，主进程 abort 该 requestId 的在途流
    //（UI 行为不变：cancelledRef 照旧使在途事件失效、已生成内容保留）。
    if (requestIdRef.current !== undefined) {
      void lightStreamAbort(requestIdRef.current)
    }
    cancelledRef.current = true
    setTranslating(false)
  }, [])

  /** 源/目标互换（V2 handleExchange 语义：语言互换 + 文本互换；auto 源不可交换）。 */
  const exchange = useCallback(() => {
    if (source === 'auto') {
      window.toast.info(t('translate.error.auto_source'))
      return
    }
    setSource(target)
    setTarget(source)
    setSourceText(outputText)
    setOutputText(sourceText)
  }, [source, target, sourceText, outputText, t])

  const selectModel = useCallback(async () => {
    // 翻译模型必须是能对话的模型：用统一判据（此前不传 filter，嵌入/重排/生图都能被选中）
    const selected = await SelectChatModelPopup.show({
      model: translateModel ?? undefined,
      filter: isChatCandidateModel
    })
    if (selected) dispatch(setTranslateModel({ model: selected }))
  }, [dispatch, translateModel])

  const copyOutput = useCallback(async () => {
    if (outputText.length === 0) return
    try {
      await navigator.clipboard.writeText(outputText)
      setCopied(true)
      clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
    } catch (error) {
      logger.warn('copy translate output failed', error as Error)
      window.toast.error(t('common.copy_failed'))
    }
  }, [outputText, t])

  /** 历史回填（V2 TranslatePage.tsx:573-602 `onHistoryItemClick`：文本 + 语言对一起恢复）。 */
  const handleHistoryItemClick = useCallback((record: TranslateRecord) => {
    setSourceText(record.sourceText)
    setOutputText(record.targetText)
    // fork 缝：V2:599-601 恢复记录的 source/target 语言（V2 落库时把 auto 解析成了实际源语言，
    // 故回填后语言栏显示的是当时真实用到的语言对）。V2 另有 `nextTargetLanguage` 兜底
    // （targetLanguage 为 unknown 时的回退），fork 的 target 类型不含 unknown，无对应态。
    setSource(record.sourceLanguage)
    setTarget(record.targetLanguage)
    // V2:601 选中历史即收起抽屉。
    setHistoryOpen(false)
  }, [])

  const toggleHistory = useCallback(() => {
    setHistoryOpen((open) => !open)
    setSettingsOpen(false)
  }, [])

  const toggleSettings = useCallback(() => {
    setSettingsOpen((open) => !open)
    setHistoryOpen(false)
  }, [])

  const couldTranslate = sourceText.trim().length > 0

  return (
    <div
      data-ui="translate.view"
      className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none' }}>{t('translate.title')}</NavbarCenter>
      </Navbar>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        <div className="flex shrink-0 items-center gap-3 border-border-subtle border-b p-3">
          <TranslateLanguageBar
            source={source}
            onSourceChange={setSource}
            target={target}
            onTargetChange={setTarget}
            detectedLanguage={detectedLanguage}
            languageLabel={languageLabel}
            customLanguages={translateCustomLanguages}
            exchangeDisabled={translating}
            onExchange={exchange}
          />
          {translating ? (
            <button
              type="button"
              onClick={abort}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-secondary px-3 text-secondary-foreground text-sm transition-all hover:bg-secondary-hover focus-visible:bg-secondary-hover focus-visible:outline-none">
              <CirclePause size={14} className="lucide-custom" />
              <span>{t('translate.stop')}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void translate()}
              disabled={!couldTranslate}
              className={cn(
                'flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm transition-all focus-visible:outline-none',
                couldTranslate
                  ? 'bg-emerald-600 text-white hover:opacity-90'
                  : 'cursor-not-allowed bg-muted text-foreground-disabled'
              )}>
              <Languages size={14} className="lucide-custom" />
              <span>{t('translate.start')}</span>
            </button>
          )}
          <span className="flex-1" />
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void selectModel()}
              aria-label={translateModel?.name ?? t('translate.select_model')}
              title={translateModel?.name ?? t('translate.select_model')}
              className="flex h-8 min-w-0 max-w-52 items-center gap-1.5 rounded-md px-2 text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
              {translateModel ? (
                <>
                  <ModelAvatar model={translateModel} size={20} />
                  <span className="truncate">{translateModel.name}</span>
                </>
              ) : (
                <span className="truncate text-muted-foreground">{t('translate.select_model')}</span>
              )}
            </button>
            <IconButton
              size="md"
              className="h-8 w-8"
              active={historyOpen}
              onClick={toggleHistory}
              aria-label={t('translate.history')}
              aria-pressed={historyOpen}>
              <History size={14} className="lucide-custom" />
            </IconButton>
            <IconButton
              size="md"
              className="h-8 w-8"
              active={settingsOpen}
              onClick={toggleSettings}
              aria-label={t('translate.settings')}
              aria-pressed={settingsOpen}>
              <SlidersHorizontal size={14} className="lucide-custom" />
            </IconButton>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-1">
          <section className="flex min-h-0 min-w-0 flex-col">
            <TranslateInputPane
              text={sourceText}
              onTextChange={setSourceText}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault()
                  void translate()
                }
              }}
              disabled={translating}
            />
          </section>
          <section className="flex min-h-0 min-w-0 flex-col border-border-subtle border-l">
            <TranslateOutputPane
              translatedContent={outputText}
              translating={translating}
              copied={copied}
              onCopy={() => void copyOutput()}
            />
          </section>
        </div>

        <TranslateHistoryList
          isOpen={historyOpen}
          items={history}
          languageLabel={languageLabel}
          error={historyError}
          onRetry={() => void loadHistory()}
          onClose={() => setHistoryOpen(false)}
          onHistoryItemClick={handleHistoryItemClick}
        />
        <TranslateSettings
          visible={settingsOpen}
          model={translateModel}
          onClose={() => setSettingsOpen(false)}
          onSelectModel={() => void selectModel()}
        />
      </div>
    </div>
  )
}

export default TranslatePage

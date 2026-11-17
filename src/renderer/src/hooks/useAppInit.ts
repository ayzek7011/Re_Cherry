import PrivacyPolicyUpdateNotice from '@renderer/components/app/PrivacyPolicyUpdateNotice'
import { isMac, LATEST_PRIVACY_POLICY_VERSION } from '@renderer/config/constant'
import { isLocalAi } from '@renderer/config/env'
import { useTheme } from '@renderer/context/ThemeProvider'
import db from '@renderer/databases'
import { changeAppLanguage, setDayjsLocale } from '@renderer/i18n'
import FileManager from '@renderer/services/FileManager'
import {
  initKernelBridge,
  syncImageDescriberToKernel,
  syncPreprocessToKernel,
  syncProvidersToKernel,
  syncWebSearchToKernel
} from '@renderer/services/kernelChat'
import tabsService from '@renderer/services/TabsService'
import { handleSaveData, useAppDispatch, useAppSelector } from '@renderer/store'
import { setAvatar } from '@renderer/store/runtime'
import type { WebSearchState } from '@renderer/store/websearch'
import { checkDataLimit } from '@renderer/utils'
import { defaultLanguage } from '@shared/config/constant'
import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo } from 'react'

import { useDefaultModel } from './useAssistant'
import useFullScreenNotice from './useFullScreenNotice'
import { useInjectCustomCss } from './useInjectCustomCss'
import { useRuntime } from './useRuntime'
import { useNavbarPosition, useSettings } from './useSettings'
import useUpdateHandler from './useUpdateHandler'

/** `syncWebSearchToKernel` 的参数形状（用 `Parameters` 取，避免与 kernelChat 的声明漂移）。 */
type KernelWebSearchSyncConfig = Parameters<typeof syncWebSearchToKernel>[0]

/**
 * websearch 切片 → 内核网络搜索配置投影。
 *
 * 抽取为纯函数的原因：**只有这几个输入字段变化才需要重推内核**。此前 effect 依赖整个
 * `state.websearch` 切片对象（Redux 每次 websearch action 都产出新引用），于是设置页里拨动
 * 任意无关开关（`setDefaultProvider`/`setOverwrite`/`setProviderConfig`…）都会把含
 * `apiKey`/`basicAuthPassword` 的完整 provider 清单重新跨 IPC 推一次主进程
 * （mini 窗口的 store 广播还会额外制造触发源）。本函数让"载荷只由这些字段决定"可测。
 */
export function buildKernelWebSearchConfig(input: {
  providers: WebSearchState['providers']
  subscribeSources: WebSearchState['subscribeSources']
  excludeDomains: WebSearchState['excludeDomains']
  searchWithTime: WebSearchState['searchWithTime']
  maxResults: WebSearchState['maxResults']
  compressionConfig: WebSearchState['compressionConfig']
  language?: string
}): KernelWebSearchSyncConfig {
  return {
    providers: (input.providers ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      apiKey: p.apiKey,
      apiHost: p.apiHost,
      url: p.url,
      engines: p.engines,
      basicAuthUsername: p.basicAuthUsername,
      basicAuthPassword: p.basicAuthPassword,
      usingBrowser: p.usingBrowser
    })),
    // 订阅源黑名单（ublacklist 模式）平铺合并；excludeDomains 单独透传
    blacklist: (input.subscribeSources ?? []).flatMap((s) => s.blacklist ?? []),
    excludeDomains: input.excludeDomains ?? [],
    searchWithTime: input.searchWithTime ?? false,
    maxResults: input.maxResults ?? 5,
    language: input.language,
    // 结果压缩投影：embeddingModel(Model) 收窄为 {providerId, modelId} 引用，
    // 密钥由主进程自解析（同知识库先例），不在此通道传 apiKey。
    compression: input.compressionConfig
      ? {
          method: input.compressionConfig.method ?? 'none',
          cutoffLimit: input.compressionConfig.cutoffLimit,
          cutoffUnit: input.compressionConfig.cutoffUnit,
          documentCount: input.compressionConfig.documentCount,
          embedding: input.compressionConfig.embeddingModel
            ? {
                providerId: input.compressionConfig.embeddingModel.provider,
                modelId: input.compressionConfig.embeddingModel.id,
                dimensions: input.compressionConfig.embeddingDimensions
              }
            : undefined,
          // rerank 实装：重排模型引用同形收窄（undefined = 不重排）。
          rerank: input.compressionConfig.rerankModel
            ? {
                providerId: input.compressionConfig.rerankModel.provider,
                modelId: input.compressionConfig.rerankModel.id
              }
            : undefined
        }
      : undefined
  }
}

export function useAppInit() {
  const dispatch = useAppDispatch()
  const {
    proxyUrl,
    proxyBypassRules,
    language,
    windowStyle,
    proxyMode,
    customCss,
    enableDataCollection,
    privacyPolicyVersion
  } = useSettings()
  const { isLeftNavbar } = useNavbarPosition()
  const { minappShow } = useRuntime()
  const { setDefaultModel, setQuickModel } = useDefaultModel()
  const avatar = useLiveQuery(() => db.settings.get('image://avatar'))
  const { theme } = useTheme()

  useEffect(() => {
    document.getElementById('spinner')?.remove()
    // eslint-disable-next-line no-restricted-syntax
    console.timeEnd('init')
  }, [])
  useEffect(() => {
    void window.api.getDataPathFromArgs().then((dataPath) => {
      if (dataPath) {
        window.navigate('/settings/data', { replace: true })
      }
    })
  }, [])

  useEffect(() => {
    // 具名解绑由 preload 桥的返回函数负责：组件重挂载（严格模式/HMR）时监听器叠加会让一次保存触发 N 次 flush
    return window.api.events.onSaveData(() => handleSaveData())
  }, [])

  useFullScreenNotice()

  useUpdateHandler()

  useEffect(() => {
    if (privacyPolicyVersion === LATEST_PRIVACY_POLICY_VERSION) {
      PrivacyPolicyUpdateNotice.hide()
      return
    }

    void PrivacyPolicyUpdateNotice.show()
  }, [privacyPolicyVersion])

  useEffect(() => {
    avatar?.value && dispatch(setAvatar(avatar.value))
  }, [avatar, dispatch])

  useEffect(() => {
    if (proxyMode === 'system') {
      void window.api.setProxy('system', undefined)
    } else if (proxyMode === 'custom') {
      void (proxyUrl && window.api.setProxy(proxyUrl, proxyBypassRules))
    } else {
      // set proxy to none for direct mode
      void window.api.setProxy('', undefined)
    }
  }, [proxyUrl, proxyMode, proxyBypassRules])

  useEffect(() => {
    const currentLanguage = language || navigator.language || defaultLanguage
    void changeAppLanguage(currentLanguage)
    setDayjsLocale(currentLanguage)
  }, [language])

  useEffect(() => {
    const isMacTransparentWindow = windowStyle === 'transparent' && isMac

    if (minappShow && isLeftNavbar) {
      window.root.style.background = isMacTransparentWindow ? 'var(--color-background)' : 'var(--navbar-background)'
      return
    }

    window.root.style.background = isMacTransparentWindow ? 'var(--navbar-background-mac)' : 'var(--navbar-background)'
  }, [windowStyle, minappShow, theme, isLeftNavbar])

  useEffect(() => {
    if (isLocalAi) {
      const model = JSON.parse(import.meta.env.VITE_RENDERER_INTEGRATED_MODEL)
      setDefaultModel(model)
      setQuickModel(model)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // 路径地基收口到 FileManager.syncRuntimePaths：幂等、失败重试、mini 窗口共用同一引导
    //（此前这里一次性 then 无 catch——瞬时 IPC 故障会让整个会话的文件定位全坏且无信号）。
    void FileManager.syncRuntimePaths()
  }, [])

  // 注入实现收口到 useInjectCustomCss（mini 窗口共用同一实现）。
  useInjectCustomCss(customCss)

  useEffect(() => {
    void window.api.config.set('enableDataCollection', enableDataCollection)
  }, [enableDataCollection])

  useEffect(() => {
    // dsh 内核桥：订阅内核 session 事件流
    initKernelBridge()
  }, [])

  const kernelProviders = useAppSelector((state) => state.llm.providers)
  const imageDescriberModel = useAppSelector((state) => state.llm.imageDescriberModel)
  const imageDescriberPrompt = useAppSelector((state) => state.llm.imageDescriberPrompt)
  // 网络搜索：只订阅**载荷真正读取的字段**。此前订阅整个 websearch 切片，
  // 任意无关 action（defaultProvider/overwrite/providerConfig…，含 mini 窗口广播进来的）都会
  // 重推一次含密钥的 provider 清单。逐字段订阅 + useMemo 投影后，只有这些输入变化才发 IPC。
  const webSearchProviders = useAppSelector((state) => state.websearch.providers)
  const webSearchSubscribeSources = useAppSelector((state) => state.websearch.subscribeSources)
  const webSearchExcludeDomains = useAppSelector((state) => state.websearch.excludeDomains)
  const webSearchSearchWithTime = useAppSelector((state) => state.websearch.searchWithTime)
  const webSearchMaxResults = useAppSelector((state) => state.websearch.maxResults)
  const webSearchCompressionConfig = useAppSelector((state) => state.websearch.compressionConfig)
  // 应用语言随投影上行——KernelWebSearchConfig.language 供 local-google/bing
  // 追加 lang: 语言过滤（此前载荷从不携带该字段，消费端是死路）。语言变更也重推。
  const webSearchKernelConfig = useMemo(
    () =>
      buildKernelWebSearchConfig({
        providers: webSearchProviders,
        subscribeSources: webSearchSubscribeSources,
        excludeDomains: webSearchExcludeDomains,
        searchWithTime: webSearchSearchWithTime,
        maxResults: webSearchMaxResults,
        compressionConfig: webSearchCompressionConfig,
        language
      }),
    [
      webSearchProviders,
      webSearchSubscribeSources,
      webSearchExcludeDomains,
      webSearchSearchWithTime,
      webSearchMaxResults,
      webSearchCompressionConfig,
      language
    ]
  )

  useEffect(() => {
    void syncWebSearchToKernel(webSearchKernelConfig)
  }, [webSearchKernelConfig])

  // MCP：mcp 切片 servers（配置含命令/env 密钥）整体投影进主进程 MCPService
  // 内存（不落盘不进会话；内核桥挂载时按 serverId 反查）。
  const mcpServers = useAppSelector((state) => state.mcp.servers)

  useEffect(() => {
    void window.api.dshSyncMcpServers(mcpServers ?? [])
  }, [mcpServers])

  // 文档处理通道：preprocess 切片 providers（含 apiKey，只进主进程内存，
  // webSearch/MCP 同先例）整体投影进主进程内存配置表——ocr_document 工具与知识库
  // 摄取的 PDF 路由按此表反查服务商。：vision-model 条目的视觉模型引用
  //（provider + model 两个 id）同行投影，主进程按它走 OpenAI 兼容多模态 chat。
  const preprocessProviders = useAppSelector((state) => state.preprocess.providers)

  useEffect(() => {
    void syncPreprocessToKernel(
      (preprocessProviders ?? []).map((provider) => ({
        id: provider.id,
        apiKey: provider.apiKey,
        apiHost: provider.apiHost,
        model: provider.model,
        visionModel:
          provider.visionModel === undefined
            ? undefined
            : { provider: provider.visionModel.provider, model: provider.visionModel.id },
        visionConcurrency: provider.visionConcurrency,
        localConcurrency: provider.localConcurrency,
        gpuAcceleration: provider.gpuAcceleration
      }))
    )
  }, [preprocessProviders])

  useEffect(() => {
    // 把 provider 配置同步进内核（provider 变更时自动重同步）
    void syncProvidersToKernel(kernelProviders)
  }, [kernelProviders])

  // 固定标签页的跨重启恢复：tabs 切片在 persist `blacklist` 里，固定集合存在已持久化的
  // settings.pinnedTabs；等 rehydrate 到位后补回标签条（幂等，见 TabsService.restorePinnedTabs）。
  const pinnedTabs = useAppSelector((state) => state.settings.pinnedTabs)

  useEffect(() => {
    if ((pinnedTabs ?? []).length === 0) return
    tabsService.restorePinnedTabs()
  }, [pinnedTabs])

  useEffect(() => {
    // 转述模型配置同步（识图通道补全）：变更即推。undefined → null =
    // 通道关闭（describe_images 不挂载，渲染层图片门禁回收现状）；
    // prompt 为 '' = 内置默认提示词。
    void syncImageDescriberToKernel(imageDescriberModel ?? undefined, imageDescriberPrompt ?? '')
  }, [imageDescriberModel, imageDescriberPrompt])

  useEffect(() => {
    void checkDataLimit()
  }, [])

  // 历史文件行修复：修"下载落盘后缀被 Content-Type 叠加"造成的分类错误
  // （`xxx.png` + octet-stream → `xxx.png.bin` / type `other`，文件页「图片」里看不到 AI 生成的图）。
  // 幂等、只修分类与显示名，失败只记日志（见 FileManager.repairLegacyDownloadedFiles）。
  // 同点补一次"扩展名丢前导点"历史行（saveBase64Image/savePastedImage 曾回 `png`，
  // 契约是 `.png`——无点行按 id+ext 定位全失败，见 FileManager.repairDotlessExtRows）。
  useEffect(() => {
    void FileManager.repairLegacyDownloadedFiles()
    void FileManager.repairDotlessExtRows()
  }, [])
}

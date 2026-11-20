import type { TokenUsageData } from '@cherrystudio/analytics-client'
import type { SpanEntity, TokenUsage } from '@mcp-trace/trace-core'
import type { SpanContext } from '@opentelemetry/api'
import type { LogLevel, LogSourceWithContext } from '@shared/config/logger'
import type { FileChangeEvent, WebviewKeyEvent } from '@shared/config/types'
import type { WorkModeApprovalTier } from '@shared/config/workMode'
import type { ExternalAppInfo } from '@shared/externalApp/types'
import { IpcChannel } from '@shared/IpcChannel'
import type { FileReadByIdResult } from '@shared/types/fileRead'
import type { InstallProgressPayload } from '@shared/types/installProgress'
import type { Notification } from '@types'
import type { FileMetadata, Shortcut, ThemeMode, WebDavConfig } from '@types'
import type { OpenDialogOptions } from 'electron'
import { contextBridge, ipcRenderer, shell, webUtils } from 'electron'
import type { CreateDirectoryOptions } from 'webdav'

/**
 * 流式补全终态事件的宽限期（毫秒，与内核无关，纯 preload 侧兜底）：终态事件与 invoke 回复分走两条通道，
 * 回复先到时必须再多等一会儿才能让已排队的 done/error 送达（详见 `dshStreamComplete`）。超时即摘监听。
 */
const STREAM_TERMINAL_GRACE_MS = 2000

type DirectoryListOptions = {
  recursive?: boolean
  maxDepth?: number
  includeHidden?: boolean
  includeFiles?: boolean
  includeDirectories?: boolean
  maxEntries?: number
  searchPattern?: string
}

// Custom APIs for renderer
const api = {
  dshSyncProviders: (providers: unknown[]) => ipcRenderer.invoke(IpcChannel.Dsh_SyncProviders, providers),
  dshSyncImageDescriber: (config: { provider: string; model: string; prompt: string } | null) =>
    ipcRenderer.invoke(IpcChannel.Dsh_SyncImageDescriber, config),
  dshSyncWebSearch: (config: unknown) => ipcRenderer.invoke(IpcChannel.Dsh_SyncWebSearch, config),
  dshSyncMcpServers: (servers: unknown[]) => ipcRenderer.invoke(IpcChannel.Dsh_SyncMcpServers, servers),
  dshSyncPreprocess: (providers: unknown[]) => ipcRenderer.invoke(IpcChannel.Dsh_SyncPreprocess, providers),
  // 应用更新：检查 / 下载 / 取消 / 安装 / 偏好读写。状态由主进程在每次变化后主动推送。
  update: {
    getState: () => ipcRenderer.invoke(IpcChannel.App_Update_GetState),
    getPrefs: () => ipcRenderer.invoke(IpcChannel.App_Update_GetPrefs),
    setPrefs: (patch: unknown) => ipcRenderer.invoke(IpcChannel.App_Update_SetPrefs, patch),
    check: (options?: { manual?: boolean }) => ipcRenderer.invoke(IpcChannel.App_Update_Check, options),
    download: () => ipcRenderer.invoke(IpcChannel.App_Update_Download),
    cancel: () => ipcRenderer.invoke(IpcChannel.App_Update_Cancel),
    install: () => ipcRenderer.invoke(IpcChannel.App_Update_Install),
    onState: (callback: (state: unknown) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state)
      ipcRenderer.on(IpcChannel.App_Update_State, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.App_Update_State, listener)
      }
    }
  },
  // 编码助手：受管 Web UI 工具生命周期 + 状态广播订阅（薄转发）。
  codeCli: {
    deepseekHarness: {
      start: (input: unknown) => ipcRenderer.invoke(IpcChannel.CodeCli_DeepseekHarness_Start, input),
      stop: () => ipcRenderer.invoke(IpcChannel.CodeCli_DeepseekHarness_Stop),
      // 渲染层订阅缝（useCodeCliStatus）的"立即拉当前值"通道。
      getStatus: () => ipcRenderer.invoke(IpcChannel.CodeCli_DeepseekHarness_GetStatus),
      onStatus: (callback: (status: unknown) => void): (() => void) => {
        const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status)
        ipcRenderer.on(IpcChannel.CodeCli_DeepseekHarness_Status, listener)
        return () => {
          ipcRenderer.removeListener(IpcChannel.CodeCli_DeepseekHarness_Status, listener)
        }
      },
      // 数据重置（入参只收布尔，路径主进程派生）与自愈开关（省参 = 读，默认开）。
      reset: (input: { keepSessions: boolean }) => ipcRenderer.invoke(IpcChannel.CodeCli_DeepseekHarness_Reset, input),
      autoHeal: (input?: { enabled: boolean }) => ipcRenderer.invoke(IpcChannel.CodeCli_DeepseekHarness_AutoHeal, input)
    },
    // Hermes Dashboard（收尾）：生命周期 + 状态广播订阅（照 deepseekHarness 写法）；
    // readConfig/writeConfig 为 code_cli 配置读写通道（V2 经 zod 路由 ipcApi.request，
    // fork 摊平为直连通道，入参校验在主进程 ipc.ts）。
    hermesDashboard: {
      // fork 缝：V2 zod schema 的 hermes_dashboard.start 入参为 z.void()，形参保形
      // 为可选（fork 主进程 handler 不消费入参）。
      start: (input?: unknown) => ipcRenderer.invoke(IpcChannel.CodeCli_HermesDashboard_Start, input),
      stop: () => ipcRenderer.invoke(IpcChannel.CodeCli_HermesDashboard_Stop),
      // 同 deepseekHarness.getStatus。
      getStatus: () => ipcRenderer.invoke(IpcChannel.CodeCli_HermesDashboard_GetStatus),
      onStatus: (callback: (status: unknown) => void): (() => void) => {
        const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status)
        ipcRenderer.on(IpcChannel.CodeCli_HermesDashboard_Status, listener)
        return () => {
          ipcRenderer.removeListener(IpcChannel.CodeCli_HermesDashboard_Status, listener)
        }
      }
    },
    readConfig: (targets: unknown) => ipcRenderer.invoke(IpcChannel.CodeCli_ReadConfig, targets),
    writeConfig: (payload: unknown) => ipcRenderer.invoke(IpcChannel.CodeCli_WriteConfig, payload),
    // Paper-Agent（源码型受管工具）Web UI 生命周期（照 hermesDashboard 写法）。
    paperAgent: {
      start: () => ipcRenderer.invoke(IpcChannel.CodeCli_PaperAgent_Start),
      stop: () => ipcRenderer.invoke(IpcChannel.CodeCli_PaperAgent_Stop),
      getStatus: () => ipcRenderer.invoke(IpcChannel.CodeCli_PaperAgent_GetStatus),
      onStatus: (callback: (status: unknown) => void): (() => void) => {
        const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status)
        ipcRenderer.on(IpcChannel.CodeCli_PaperAgent_Status, listener)
        return () => {
          ipcRenderer.removeListener(IpcChannel.CodeCli_PaperAgent_Status, listener)
        }
      }
    },
    // 受管 CLI 安装器：装卸/快照/最新版本 + 变化广播订阅（照 onStatus 写法）。
    binary: {
      // targetVersion 来自"检查更新"的结论——检查到 A 就装 A（主进程订 spec）。
      install: (name: string, targetVersion?: string) =>
        ipcRenderer.invoke(IpcChannel.CodeCli_Binary_Install, name, targetVersion),
      remove: (name: string) => ipcRenderer.invoke(IpcChannel.CodeCli_Binary_Remove, name),
      snapshots: () => ipcRenderer.invoke(IpcChannel.CodeCli_Binary_Snapshots),
      latestVersions: () => ipcRenderer.invoke(IpcChannel.CodeCli_Binary_LatestVersions),
      // 手动检查更新（强制重探 + 现查最新版本；失败返回 {success:false, message}）。
      checkUpdates: (name: string) => ipcRenderer.invoke(IpcChannel.CodeCli_Binary_CheckUpdates, name),
      onChanged: (callback: () => void): (() => void) => {
        const listener = (_event: Electron.IpcRendererEvent) => callback()
        ipcRenderer.on(IpcChannel.CodeCli_Binary_Changed, listener)
        return () => {
          ipcRenderer.removeListener(IpcChannel.CodeCli_Binary_Changed, listener)
        }
      },
      // 安装步骤进度订阅。：载荷形状与步骤词汇取自
      // @shared/types/installProgress（主进程广播、本桥、渲染层同一份契约——步骤名写错是
      // 编译错误，新工具/新步骤不会悄悄漏展示）。
      onInstallProgress: (callback: (payload: InstallProgressPayload) => void): (() => void) => {
        const listener = (_event: Electron.IpcRendererEvent, payload: InstallProgressPayload) => callback(payload)
        ipcRenderer.on(IpcChannel.CodeCli_Binary_InstallProgress, listener)
        return () => {
          ipcRenderer.removeListener(IpcChannel.CodeCli_Binary_InstallProgress, listener)
        }
      }
    },
    // 统一网关：生命周期 + LAN 开关 + 配置部分更新 + 状态广播订阅
    //（照 deepseekHarness 写法；syncConfig 为 {enabled?, port?, host?} 部分更新，
    // 主进程先持久化再收敛）。
    apiGateway: {
      start: () => ipcRenderer.invoke(IpcChannel.CodeCli_ApiGateway_Start),
      stop: () => ipcRenderer.invoke(IpcChannel.CodeCli_ApiGateway_Stop),
      restart: () => ipcRenderer.invoke(IpcChannel.CodeCli_ApiGateway_Restart),
      setLanEnabled: (enabled: boolean) => ipcRenderer.invoke(IpcChannel.CodeCli_ApiGateway_LanSetEnabled, enabled),
      syncConfig: (partial: { enabled?: boolean; port?: number; host?: string }) =>
        ipcRenderer.invoke(IpcChannel.CodeCli_SyncGatewayConfig, partial),
      // 立即拉当前运行态（载荷 {running, lanRunning?, port?} 同 Status 广播）。
      getStatus: () => ipcRenderer.invoke(IpcChannel.CodeCli_ApiGateway_GetStatus),
      // 网关配置读取（host/port/apiKey|null/running）——合成网关 provider 数据源。
      getConfig: () => ipcRenderer.invoke(IpcChannel.CodeCli_ApiGateway_GetConfig),
      onStatus: (callback: (status: unknown) => void): (() => void) => {
        const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status)
        ipcRenderer.on(IpcChannel.CodeCli_ApiGateway_Status, listener)
        return () => {
          ipcRenderer.removeListener(IpcChannel.CodeCli_ApiGateway_Status, listener)
        }
      }
    }
  },
  webSearch: {
    check: (providerId: string) => ipcRenderer.invoke(IpcChannel.WebSearch_Check, providerId)
  },
  // MCP 设置页通道：与主进程 MCPService 一一对应的薄转发（invoke）+ 日志事件订阅。
  mcp: {
    listTools: (server: unknown) => ipcRenderer.invoke(IpcChannel.Mcp_ListTools, server),
    listPrompts: (server: unknown) => ipcRenderer.invoke(IpcChannel.Mcp_ListPrompts, server),
    listResources: (server: unknown) => ipcRenderer.invoke(IpcChannel.Mcp_ListResources, server),
    getServerVersion: (server: unknown) => ipcRenderer.invoke(IpcChannel.Mcp_GetServerVersion, server),
    getServerLogs: (server: unknown) => ipcRenderer.invoke(IpcChannel.Mcp_GetServerLogs, server),
    restartServer: (server: unknown) => ipcRenderer.invoke(IpcChannel.Mcp_RestartServer, server),
    stopServer: (server: unknown) => ipcRenderer.invoke(IpcChannel.Mcp_StopServer, server),
    removeServer: (server: unknown) => ipcRenderer.invoke(IpcChannel.Mcp_RemoveServer, server),
    checkConnectivity: (server: unknown) => ipcRenderer.invoke(IpcChannel.Mcp_CheckConnectivity, server),
    // 运行时依赖探测（v1）：命令名 → PATH 中的可执行绝对路径 | null（主进程校验命令名）。
    checkCommand: (command: string) => ipcRenderer.invoke(IpcChannel.Mcp_CheckCommand, command),
    // DXT 扩展安装（上游同构）：File 读成 ArrayBuffer + 原始文件名 invoke（不依赖 File.path 扩展）。
    uploadDxt: async (file: File) => {
      const buffer = await file.arrayBuffer()
      return ipcRenderer.invoke(IpcChannel.Mcp_UploadDxt, buffer, file.name)
    },
    onServerLog: (callback: (log: unknown) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, log: unknown) => callback(log)
      ipcRenderer.on(IpcChannel.Mcp_ServerLog, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.Mcp_ServerLog, listener)
      }
    }
  },
  // 知识库通道：主进程 KnowledgeService 薄转发（嵌入引用只含 id，密钥主进程自解析）。
  knowledgeBase: {
    create: (base: unknown) => ipcRenderer.invoke(IpcChannel.KnowledgeBase_Create, base),
    reset: (baseId: string) => ipcRenderer.invoke(IpcChannel.KnowledgeBase_Reset, baseId),
    delete: (baseId: string) => ipcRenderer.invoke(IpcChannel.KnowledgeBase_Delete, baseId),
    add: (payload: unknown) => ipcRenderer.invoke(IpcChannel.KnowledgeBase_Add, payload),
    remove: (payload: unknown) => ipcRenderer.invoke(IpcChannel.KnowledgeBase_Remove, payload),
    search: (payload: unknown) => ipcRenderer.invoke(IpcChannel.KnowledgeBase_Search, payload)
  },
  // 文档处理通道 local-paddle 条目（收编自 localModel）：下载生命周期；
  // 进度由渲染层轮询 getStatus。
  preprocess: {
    localPaddle: {
      getStatus: () => ipcRenderer.invoke(IpcChannel.Preprocess_LocalPaddle_GetStatus),
      download: () => ipcRenderer.invoke(IpcChannel.Preprocess_LocalPaddle_Download),
      cancel: () => ipcRenderer.invoke(IpcChannel.Preprocess_LocalPaddle_Cancel),
      remove: () => ipcRenderer.invoke(IpcChannel.Preprocess_LocalPaddle_Remove)
    }
  },
  // 技能通道：主进程 SkillService 薄转发（磁盘 = 真相源，列表全量投影）。
  skills: {
    installFromZip: (zipFilePath: string) => ipcRenderer.invoke(IpcChannel.Skill_InstallFromZip, zipFilePath),
    installFromDirectory: (directoryPath: string) =>
      ipcRenderer.invoke(IpcChannel.Skill_InstallFromDirectory, directoryPath),
    installFromUrl: (url: string) => ipcRenderer.invoke(IpcChannel.Skill_InstallFromUrl, url),
    uninstall: (folderName: string) => ipcRenderer.invoke(IpcChannel.Skill_Uninstall, folderName),
    list: () => ipcRenderer.invoke(IpcChannel.Skill_List)
  },
  dshStreamSmoke: (payload: unknown) => ipcRenderer.invoke(IpcChannel.Dsh_StreamSmoke, payload),
  dshComplete: (payload: unknown) => ipcRenderer.invoke(IpcChannel.Dsh_Complete, payload),
  dshStreamComplete: (payload: unknown, onEvent: (data: unknown) => void) => {
    const requestId = (payload as { requestId: string }).requestId
    let terminal = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const listener = (_event: Electron.IpcRendererEvent, data: { requestId?: string; type?: string }) => {
      if (data?.requestId !== requestId) return
      if (data.type === 'done' || data.type === 'error') {
        terminal = true
        if (graceTimer !== undefined) {
          clearTimeout(graceTimer)
          graceTimer = undefined
        }
      }
      onEvent(data)
    }
    ipcRenderer.on(IpcChannel.Dsh_CompletionEvent, listener)
    const off = () => ipcRenderer.off(IpcChannel.Dsh_CompletionEvent, listener)
    // 修复（"快速助手完成输出后不自动停止"）：这条轻通路（不建内核会话）的终态事件（done/error）
    // 与 invoke 回复走的是**两条不同通道**，会赛跑——主进程在 `send(done)` 之后立刻 return，回复常常先被
    // 渲染层处理，于是 `.finally(off)` 在终态事件排队期间就把监听摘掉了：正文 delta 早已送达、末条 done
    // 永远到不了 ⇒ 消息停在 processing、块停在 streaming、"按 ESC 暂停"一直挂着（真机与隔离实例探针都能复现）。
    // 现在回复落地后**先等终态事件**（最多 STREAM_TERMINAL_GRACE_MS），拿到即摘；超时才兜底摘掉。
    return ipcRenderer.invoke(IpcChannel.Dsh_StreamComplete, payload).finally(() => {
      if (terminal) {
        off()
        return
      }
      graceTimer = setTimeout(off, STREAM_TERMINAL_GRACE_MS)
    })
  },
  dshLightImage: (payload: unknown) => ipcRenderer.invoke(IpcChannel.Dsh_LightImage, payload),
  dshLightImageAbort: (requestId: string) => ipcRenderer.invoke(IpcChannel.Dsh_LightImageAbort, requestId),
  // fork 缝：流式补全的真取消缝（requestId 配对；主进程 `requestId → AbortController`）。
  dshStreamAbort: (requestId: string) => ipcRenderer.invoke(IpcChannel.Dsh_StreamAbort, requestId),

  dshTopicList: () => ipcRenderer.invoke(IpcChannel.Dsh_TopicList),
  dshTopicCreate: (input: unknown) => ipcRenderer.invoke(IpcChannel.Dsh_TopicCreate, input),
  dshTopicRename: (id: string, name: string) => ipcRenderer.invoke(IpcChannel.Dsh_TopicRename, id, name),
  dshTopicDelete: (id: string) => ipcRenderer.invoke(IpcChannel.Dsh_TopicDelete, id),
  dshTopicDestroyTurns: (id: string, anchorUserSeqs: number[]) =>
    ipcRenderer.invoke(IpcChannel.Dsh_TopicDestroyTurns, id, anchorUserSeqs),
  dshTopicOpen: (id: string) => ipcRenderer.invoke(IpcChannel.Dsh_TopicOpen, id),
  dshTopicFork: (topicId: string, anchorUserMessageSeq: number) =>
    ipcRenderer.invoke(IpcChannel.Dsh_TopicFork, topicId, anchorUserMessageSeq),
  dshTopicBranches: (rootTopicId: string) => ipcRenderer.invoke(IpcChannel.Dsh_TopicBranches, rootTopicId),
  dshTopicSend: (
    id: string,
    text: string,
    options?: {
      reasoningEffort?: string
      builtinTools?: string[]
      externalTools?: string[]
      tier?: WorkModeApprovalTier
      /** 随消息附带的图片（base64，识图通道；内核准入后并入用户消息内容块）。 */
      images?: Array<{ mediaType: string; data: string; name?: string }>
      /** 网络搜索：本轮 web_search 的提供商（与 topics.TopicSendOptions 逐字段对齐）。 */
      webSearch?: { providerId: string }
      /** 聊天生图：本轮 generate_image 工具的绘画模型（与 topics.TopicSendOptions 逐字段对齐）。 */
      generateImage?: { providerId: string; modelId: string }
      /** 持久记忆：本轮 memory 工具的助手 id（与 topics.TopicSendOptions 逐字段对齐）。 */
      memory?: { assistantId: string }
      /** 知识库检索：本轮可检索库清单。 */
      knowledgeBases?: Array<{
        id: string
        chunkSize?: number
        chunkOverlap?: number
        documentCount?: number
        threshold?: number
        embedding: { providerId: string; modelId: string; dimensions: number }
      }>
      /** 技能：本轮可读技能清单。 */
      skills?: Array<{
        id: string
        folderName: string
        name: string
        description: string
        contentHash?: string
        author?: string | null
      }>
      /** 文档阅读：本轮附件文档清单。 */
      documents?: Array<{ name: string; path: string; ext?: string }>
    }
  ) => ipcRenderer.invoke(IpcChannel.Dsh_TopicSend, id, text, options),
  /** 内核图片附件回放同步：按 ref 读回核验字节并落入文件仓（确定性 id，幂等）。 */
  dshAttachmentSync: (ref: {
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
  }) => ipcRenderer.invoke(IpcChannel.Dsh_AttachmentSync, ref),
  dshTopicStop: (id: string) => ipcRenderer.invoke(IpcChannel.Dsh_TopicStop, id),
  dshTopicRunning: (id: string) => ipcRenderer.invoke(IpcChannel.Dsh_TopicRunning, id),
  dshTopicEvents: (id: string) => ipcRenderer.invoke(IpcChannel.Dsh_TopicEvents, id),
  dshTopicGet: (id: string) => ipcRenderer.invoke(IpcChannel.Dsh_TopicGet, id),
  dshApprovalDecide: (decision: { requestId: string; behavior: 'allow' | 'deny' }) =>
    ipcRenderer.invoke(IpcChannel.Dsh_ApprovalDecide, decision),
  dshQuestionAnswer: (answer: { requestId: string; answers: { id: string; selected: string[]; custom?: string }[] }) =>
    ipcRenderer.invoke(IpcChannel.Dsh_QuestionAnswer, answer),
  dshOnApprovalRequest: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: unknown) => {
      callback(data)
    }
    ipcRenderer.on(IpcChannel.Dsh_ApprovalRequest, listener)
    return () => ipcRenderer.off(IpcChannel.Dsh_ApprovalRequest, listener)
  },
  dshOnQuestionRequest: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: unknown) => {
      callback(data)
    }
    ipcRenderer.on(IpcChannel.Dsh_QuestionRequest, listener)
    return () => ipcRenderer.off(IpcChannel.Dsh_QuestionRequest, listener)
  },
  dshSearchMessages: (terms: string[]) => ipcRenderer.invoke(IpcChannel.Dsh_SearchMessages, terms),
  dshOnSessionEvent: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: unknown) => {
      callback(data)
    }
    ipcRenderer.on(IpcChannel.Dsh_SessionEvent, listener)
    return () => ipcRenderer.off(IpcChannel.Dsh_SessionEvent, listener)
  },
  getAppInfo: () => ipcRenderer.invoke(IpcChannel.App_Info),
  getDiskInfo: (directoryPath: string): Promise<{ free: number; size: number } | null> =>
    ipcRenderer.invoke(IpcChannel.App_GetDiskInfo, directoryPath),
  reload: () => ipcRenderer.invoke(IpcChannel.App_Reload),
  quit: () => ipcRenderer.invoke(IpcChannel.App_Quit),
  setProxy: (proxy: string | undefined, bypassRules?: string) =>
    ipcRenderer.invoke(IpcChannel.App_Proxy, proxy, bypassRules),
  setLanguage: (lang: string) => ipcRenderer.invoke(IpcChannel.App_SetLanguage, lang),
  setEnableSpellCheck: (isEnable: boolean) => ipcRenderer.invoke(IpcChannel.App_SetEnableSpellCheck, isEnable),
  setSpellCheckLanguages: (languages: string[]) => ipcRenderer.invoke(IpcChannel.App_SetSpellCheckLanguages, languages),
  setLaunchOnBoot: (isActive: boolean) => ipcRenderer.invoke(IpcChannel.App_SetLaunchOnBoot, isActive),
  setLaunchToTray: (isActive: boolean) => ipcRenderer.invoke(IpcChannel.App_SetLaunchToTray, isActive),
  setTray: (isActive: boolean) => ipcRenderer.invoke(IpcChannel.App_SetTray, isActive),
  setTrayOnClose: (isActive: boolean) => ipcRenderer.invoke(IpcChannel.App_SetTrayOnClose, isActive),
  setTheme: (theme: ThemeMode) => ipcRenderer.invoke(IpcChannel.App_SetTheme, theme),
  handleZoomFactor: (delta: number, reset: boolean = false) =>
    ipcRenderer.invoke(IpcChannel.App_HandleZoomFactor, delta, reset),
  select: (options: Electron.OpenDialogOptions) => ipcRenderer.invoke(IpcChannel.App_Select, options),
  hasWritePermission: (path: string) => ipcRenderer.invoke(IpcChannel.App_HasWritePermission, path),
  resolvePath: (path: string) => ipcRenderer.invoke(IpcChannel.App_ResolvePath, path),
  isPathInside: (childPath: string, parentPath: string) =>
    ipcRenderer.invoke(IpcChannel.App_IsPathInside, childPath, parentPath),
  setAppDataPath: (path: string) => ipcRenderer.invoke(IpcChannel.App_SetAppDataPath, path),
  getDataPathFromArgs: () => ipcRenderer.invoke(IpcChannel.App_GetDataPathFromArgs),
  copy: (oldPath: string, newPath: string, occupiedDirs: string[] = []) =>
    ipcRenderer.invoke(IpcChannel.App_Copy, oldPath, newPath, occupiedDirs),
  setStopQuitApp: (stop: boolean, reason: string) => ipcRenderer.invoke(IpcChannel.App_SetStopQuitApp, stop, reason),
  flushAppData: () => ipcRenderer.invoke(IpcChannel.App_FlushAppData),
  isNotEmptyDir: (path: string) => ipcRenderer.invoke(IpcChannel.App_IsNotEmptyDir, path),
  relaunchApp: (options?: Electron.RelaunchOptions) => ipcRenderer.invoke(IpcChannel.App_RelaunchApp, options),
  resetData: () => ipcRenderer.invoke(IpcChannel.App_ResetData),
  openWebsite: (url: string) => ipcRenderer.invoke(IpcChannel.Open_Website, url),
  getCacheSize: () => ipcRenderer.invoke(IpcChannel.App_GetCacheSize),
  clearCache: () => ipcRenderer.invoke(IpcChannel.App_ClearCache),
  logToMain: (source: LogSourceWithContext, level: LogLevel, message: string, data: any[]) =>
    ipcRenderer.invoke(IpcChannel.App_LogToMain, source, level, message, data),
  setFullScreen: (value: boolean): Promise<void> => ipcRenderer.invoke(IpcChannel.App_SetFullScreen, value),
  isFullScreen: (): Promise<boolean> => ipcRenderer.invoke(IpcChannel.App_IsFullScreen),
  getSystemFonts: (): Promise<string[]> => ipcRenderer.invoke(IpcChannel.App_GetSystemFonts),
  getIpCountry: (): Promise<string> => ipcRenderer.invoke(IpcChannel.App_GetIpCountry),
  mockCrashRenderProcess: () => ipcRenderer.invoke(IpcChannel.APP_CrashRenderProcess),
  notification: {
    send: (notification: Notification) => ipcRenderer.invoke(IpcChannel.Notification_Send, notification)
  },
  system: {
    getDeviceType: () => ipcRenderer.invoke(IpcChannel.System_GetDeviceType),
    getHostname: () => ipcRenderer.invoke(IpcChannel.System_GetHostname)
  },
  devTools: {
    toggle: () => ipcRenderer.invoke(IpcChannel.System_ToggleDevTools)
  },
  zip: {
    decompress: (text: Buffer) => ipcRenderer.invoke(IpcChannel.Zip_Decompress, text)
  },
  backup: {
    restore: (path: string) => ipcRenderer.invoke(IpcChannel.Backup_Restore, path),
    // Direct backup methods (copy IndexedDB/LocalStorage directories directly)
    backup: (fileName: string, destinationPath: string, skipBackupFile: boolean) =>
      ipcRenderer.invoke(IpcChannel.Backup_Backup, fileName, destinationPath, skipBackupFile),
    backupToWebdav: (webdavConfig: WebDavConfig) => ipcRenderer.invoke(IpcChannel.Backup_BackupToWebdav, webdavConfig),
    restoreFromWebdav: (webdavConfig: WebDavConfig) =>
      ipcRenderer.invoke(IpcChannel.Backup_RestoreFromWebdav, webdavConfig),
    listWebdavFiles: (webdavConfig: WebDavConfig) =>
      ipcRenderer.invoke(IpcChannel.Backup_ListWebdavFiles, webdavConfig),
    checkConnection: (webdavConfig: WebDavConfig) =>
      ipcRenderer.invoke(IpcChannel.Backup_CheckConnection, webdavConfig),
    createDirectory: (webdavConfig: WebDavConfig, path: string, options?: CreateDirectoryOptions) =>
      ipcRenderer.invoke(IpcChannel.Backup_CreateDirectory, webdavConfig, path, options),
    deleteWebdavFile: (fileName: string, webdavConfig: WebDavConfig) =>
      ipcRenderer.invoke(IpcChannel.Backup_DeleteWebdavFile, fileName, webdavConfig),
    backupToLocalDir: (fileName: string, localConfig: { localBackupDir?: string; skipBackupFile?: boolean }) =>
      ipcRenderer.invoke(IpcChannel.Backup_BackupToLocalDir, fileName, localConfig),
    restoreFromLocalBackup: (fileName: string, localBackupDir?: string) =>
      ipcRenderer.invoke(IpcChannel.Backup_RestoreFromLocalBackup, fileName, localBackupDir),
    listLocalBackupFiles: (localBackupDir?: string) =>
      ipcRenderer.invoke(IpcChannel.Backup_ListLocalBackupFiles, localBackupDir),
    deleteLocalBackupFile: (fileName: string, localBackupDir?: string) =>
      ipcRenderer.invoke(IpcChannel.Backup_DeleteLocalBackupFile, fileName, localBackupDir),
    checkWebdavConnection: (webdavConfig: WebDavConfig) =>
      ipcRenderer.invoke(IpcChannel.Backup_CheckConnection, webdavConfig)
  },
  file: {
    select: (options?: OpenDialogOptions): Promise<FileMetadata[] | null> =>
      ipcRenderer.invoke(IpcChannel.File_Select, options),
    upload: (file: FileMetadata) => ipcRenderer.invoke(IpcChannel.File_Upload, file),
    delete: (fileId: string) => ipcRenderer.invoke(IpcChannel.File_Delete, fileId),
    deleteDir: (dirPath: string) => ipcRenderer.invoke(IpcChannel.File_DeleteDir, dirPath),
    deleteExternalFile: (filePath: string) => ipcRenderer.invoke(IpcChannel.File_DeleteExternalFile, filePath),
    deleteExternalDir: (dirPath: string) => ipcRenderer.invoke(IpcChannel.File_DeleteExternalDir, dirPath),
    move: (path: string, newPath: string) => ipcRenderer.invoke(IpcChannel.File_Move, path, newPath),
    moveDir: (dirPath: string, newDirPath: string) => ipcRenderer.invoke(IpcChannel.File_MoveDir, dirPath, newDirPath),
    rename: (path: string, newName: string) => ipcRenderer.invoke(IpcChannel.File_Rename, path, newName),
    renameDir: (dirPath: string, newName: string) => ipcRenderer.invoke(IpcChannel.File_RenameDir, dirPath, newName),
    read: (fileId: string, detectEncoding?: boolean) =>
      ipcRenderer.invoke(IpcChannel.File_Read, fileId, detectEncoding),
    // /⑥：区分「不存在」与「读失败」的读通道（File_Read 对两者抛同一个通用错误）
    readById: (fileId: string): Promise<FileReadByIdResult> => ipcRenderer.invoke(IpcChannel.File_ReadById, fileId),
    readExternal: (filePath: string, detectEncoding?: boolean) =>
      ipcRenderer.invoke(IpcChannel.File_ReadExternal, filePath, detectEncoding),
    clear: (spanContext?: SpanContext) => ipcRenderer.invoke(IpcChannel.File_Clear, spanContext),
    get: (filePath: string): Promise<FileMetadata | null> => ipcRenderer.invoke(IpcChannel.File_Get, filePath),
    createTempFile: (fileName: string): Promise<string> => ipcRenderer.invoke(IpcChannel.File_CreateTempFile, fileName),
    mkdir: (dirPath: string) => ipcRenderer.invoke(IpcChannel.File_Mkdir, dirPath),
    write: (filePath: string, data: Uint8Array | string) => ipcRenderer.invoke(IpcChannel.File_Write, filePath, data),
    writeWithId: (id: string, content: string) => ipcRenderer.invoke(IpcChannel.File_WriteWithId, id, content),
    // 生成图内容寻址落盘（id = 源串 sha256；同 id 同文件，回放不堆积）
    saveGeneratedImage: (payload: { id: string; source: string }): Promise<unknown> =>
      ipcRenderer.invoke(IpcChannel.File_SaveGeneratedImage, payload),
    open: (options?: OpenDialogOptions) => ipcRenderer.invoke(IpcChannel.File_Open, options),
    openPath: (path: string) => ipcRenderer.invoke(IpcChannel.File_OpenPath, path),
    save: (path: string, content: string | NodeJS.ArrayBufferView, options?: any) =>
      ipcRenderer.invoke(IpcChannel.File_Save, path, content, options),
    selectFolder: (options?: OpenDialogOptions): Promise<string | null> =>
      ipcRenderer.invoke(IpcChannel.File_SelectFolder, options),
    saveImage: (name: string, data: string): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannel.File_SaveImage, name, data),
    binaryImage: (fileId: string) => ipcRenderer.invoke(IpcChannel.File_BinaryImage, fileId),
    base64Image: (fileId: string): Promise<{ mime: string; base64: string; data: string }> =>
      ipcRenderer.invoke(IpcChannel.File_Base64Image, fileId),
    saveBase64Image: (data: string) => ipcRenderer.invoke(IpcChannel.File_SaveBase64Image, data),
    savePastedImage: (imageData: Uint8Array, extension?: string) =>
      ipcRenderer.invoke(IpcChannel.File_SavePastedImage, imageData, extension),
    download: (url: string, isUseContentType?: boolean) =>
      ipcRenderer.invoke(IpcChannel.File_Download, url, isUseContentType),
    copy: (fileId: string, destPath: string) => ipcRenderer.invoke(IpcChannel.File_Copy, fileId, destPath),
    base64File: (fileId: string) => ipcRenderer.invoke(IpcChannel.File_Base64File, fileId),
    pdfInfo: (fileId: string) => ipcRenderer.invoke(IpcChannel.File_GetPdfInfo, fileId),
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    openFileWithRelativePath: (file: FileMetadata) => ipcRenderer.invoke(IpcChannel.File_OpenWithRelativePath, file),
    isTextFile: (filePath: string): Promise<boolean> => ipcRenderer.invoke(IpcChannel.File_IsTextFile, filePath),
    isDirectory: (filePath: string): Promise<boolean> => ipcRenderer.invoke(IpcChannel.File_IsDirectory, filePath),
    getDirectoryStructure: (dirPath: string) => ipcRenderer.invoke(IpcChannel.File_GetDirectoryStructure, dirPath),
    // 笔记（V1 原样）：用户自选笔记目录的校验/补全
    validateNotesDirectory: (dirPath: string) => ipcRenderer.invoke(IpcChannel.File_ValidateNotesDirectory, dirPath),
    listDirectory: (dirPath: string, options?: DirectoryListOptions) =>
      ipcRenderer.invoke(IpcChannel.File_ListDirectory, dirPath, options),
    checkFileName: (dirPath: string, fileName: string, isFile: boolean) =>
      ipcRenderer.invoke(IpcChannel.File_CheckFileName, dirPath, fileName, isFile),
    startFileWatcher: (dirPath: string, config?: any) =>
      ipcRenderer.invoke(IpcChannel.File_StartWatcher, dirPath, config),
    stopFileWatcher: () => ipcRenderer.invoke(IpcChannel.File_StopWatcher),
    pauseFileWatcher: () => ipcRenderer.invoke(IpcChannel.File_PauseWatcher),
    resumeFileWatcher: () => ipcRenderer.invoke(IpcChannel.File_ResumeWatcher),
    batchUploadMarkdown: (filePaths: string[], targetPath: string) =>
      ipcRenderer.invoke(IpcChannel.File_BatchUploadMarkdown, filePaths, targetPath),
    onFileChange: (callback: (data: FileChangeEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: any) => {
        if (data && typeof data === 'object') {
          callback(data)
        }
      }
      ipcRenderer.on(IpcChannel.File_Change, listener)
      return () => ipcRenderer.off(IpcChannel.File_Change, listener)
    },
    showInFolder: (path: string): Promise<void> => ipcRenderer.invoke(IpcChannel.File_ShowInFolder, path)
  },
  fs: {
    read: (pathOrUrl: string, encoding?: BufferEncoding) => ipcRenderer.invoke(IpcChannel.Fs_Read, pathOrUrl, encoding),
    readText: (pathOrUrl: string): Promise<string> => ipcRenderer.invoke(IpcChannel.Fs_ReadText, pathOrUrl)
  },
  export: {
    toWord: (markdown: string, fileName: string) => ipcRenderer.invoke(IpcChannel.Export_Word, markdown, fileName)
  },
  openPath: (path: string) => ipcRenderer.invoke(IpcChannel.Open_Path, path),
  shortcuts: {
    update: (shortcuts: Shortcut[]) => ipcRenderer.invoke(IpcChannel.Shortcuts_Update, shortcuts)
  },
  window: {
    setMinimumSize: (width: number, height: number) =>
      ipcRenderer.invoke(IpcChannel.Windows_SetMinimumSize, width, height),
    resetMinimumSize: () => ipcRenderer.invoke(IpcChannel.Windows_ResetMinimumSize),
    getSize: (): Promise<[number, number]> => ipcRenderer.invoke(IpcChannel.Windows_GetSize)
  },
  config: {
    set: (key: string, value: any, isNotify: boolean = false) =>
      ipcRenderer.invoke(IpcChannel.Config_Set, key, value, isNotify)
  },
  miniWindow: {
    hide: () => ipcRenderer.invoke(IpcChannel.MiniWindow_Hide),
    close: () => ipcRenderer.invoke(IpcChannel.MiniWindow_Close),
    setPin: (isPinned: boolean) => ipcRenderer.invoke(IpcChannel.MiniWindow_SetPin, isPinned)
  },
  aes: {
    decrypt: (encryptedData: string, iv: string, secretKey: string) =>
      ipcRenderer.invoke(IpcChannel.Aes_Decrypt, encryptedData, iv, secretKey)
  },
  providerKeys: {
    getAll: () => ipcRenderer.invoke(IpcChannel.ProviderKeys_GetAll),
    set: (providerId: string, apiKey: string) => ipcRenderer.invoke(IpcChannel.ProviderKeys_Set, providerId, apiKey),
    remove: (providerId: string) => ipcRenderer.invoke(IpcChannel.ProviderKeys_Remove, providerId)
  },
  shell: {
    openExternal: (url: string, options?: Electron.OpenExternalOptions) => {
      // Defense-in-depth: validate URL scheme before forwarding to shell.openExternal
      const ALLOWED_PROTOCOLS = ['http:', 'https:', 'mailto:', 'obsidian:']
      try {
        const parsed = new URL(url)
        if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
          return Promise.reject(new Error(`Blocked openExternal for untrusted URL scheme: ${parsed.protocol}`))
        }
      } catch {
        return Promise.reject(new Error('Blocked openExternal for invalid URL'))
      }
      return shell.openExternal(url, options)
    }
  },
  protocol: {
    onReceiveData: (callback: (data: { url: string; params: any }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { url: string; params: any }) => {
        callback(data)
      }
      ipcRenderer.on('protocol-data', listener)
      return () => {
        ipcRenderer.off('protocol-data', listener)
      }
    }
  },
  externalApps: {
    detectInstalled: (): Promise<ExternalAppInfo[]> => ipcRenderer.invoke(IpcChannel.ExternalApps_DetectInstalled)
  },
  nutstore: {
    getSSOUrl: () => ipcRenderer.invoke(IpcChannel.Nutstore_GetSsoUrl),
    decryptToken: (token: string) => ipcRenderer.invoke(IpcChannel.Nutstore_DecryptToken, token),
    getDirectoryContents: (token: string, path: string) =>
      ipcRenderer.invoke(IpcChannel.Nutstore_GetDirectoryContents, token, path)
  },
  obsidian: {
    getVaults: () => ipcRenderer.invoke(IpcChannel.Obsidian_GetVaults),
    getFolders: (vaultName: string) => ipcRenderer.invoke(IpcChannel.Obsidian_GetFiles, vaultName),
    getFiles: (vaultName: string) => ipcRenderer.invoke(IpcChannel.Obsidian_GetFiles, vaultName)
  },
  searchService: {
    openUrlInSearchWindow: (uid: string, url: string) => ipcRenderer.invoke(IpcChannel.SearchWindow_OpenUrl, uid, url),
    closeSearchWindow: (uid: string) => ipcRenderer.invoke(IpcChannel.SearchWindow_Close, uid)
  },
  webview: {
    setOpenLinkExternal: (webviewId: number, isExternal: boolean) =>
      ipcRenderer.invoke(IpcChannel.Webview_SetOpenLinkExternal, webviewId, isExternal),
    setSpellCheckEnabled: (webviewId: number, isEnable: boolean) =>
      ipcRenderer.invoke(IpcChannel.Webview_SetSpellCheckEnabled, webviewId, isEnable),
    printToPDF: (webviewId: number) => ipcRenderer.invoke(IpcChannel.Webview_PrintToPDF, webviewId),
    saveAsHTML: (webviewId: number) => ipcRenderer.invoke(IpcChannel.Webview_SaveAsHTML, webviewId),
    onFindShortcut: (callback: (payload: WebviewKeyEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: WebviewKeyEvent) => {
        callback(payload)
      }
      ipcRenderer.on(IpcChannel.Webview_SearchHotkey, listener)
      return () => {
        ipcRenderer.off(IpcChannel.Webview_SearchHotkey, listener)
      }
    }
  },
  storeSync: {
    subscribe: () => ipcRenderer.invoke(IpcChannel.StoreSync_Subscribe),
    unsubscribe: () => ipcRenderer.invoke(IpcChannel.StoreSync_Unsubscribe),
    onUpdate: (action: any) => ipcRenderer.invoke(IpcChannel.StoreSync_OnUpdate, action)
  },
  quoteToMainWindow: (text: string) => ipcRenderer.invoke(IpcChannel.App_QuoteToMain, text),
  setDisableHardwareAcceleration: (isDisable: boolean) =>
    ipcRenderer.invoke(IpcChannel.App_SetDisableHardwareAcceleration, isDisable),
  setUseSystemTitleBar: (isActive: boolean) => ipcRenderer.invoke(IpcChannel.App_SetUseSystemTitleBar, isActive),
  trace: {
    saveData: (topicId: string) => ipcRenderer.invoke(IpcChannel.TRACE_SAVE_DATA, topicId),
    getData: (topicId: string, traceId: string, modelName?: string) =>
      ipcRenderer.invoke(IpcChannel.TRACE_GET_DATA, topicId, traceId, modelName),
    saveEntity: (entity: SpanEntity) => ipcRenderer.invoke(IpcChannel.TRACE_SAVE_ENTITY, entity),
    bindTopic: (topicId: string, traceId: string) => ipcRenderer.invoke(IpcChannel.TRACE_BIND_TOPIC, topicId, traceId),
    tokenUsage: (spanId: string, usage: TokenUsage) => ipcRenderer.invoke(IpcChannel.TRACE_TOKEN_USAGE, spanId, usage),
    cleanHistory: (topicId: string, traceId: string, modelName?: string) =>
      ipcRenderer.invoke(IpcChannel.TRACE_CLEAN_HISTORY, topicId, traceId, modelName),
    cleanTopic: (topicId: string, traceId?: string) =>
      ipcRenderer.invoke(IpcChannel.TRACE_CLEAN_TOPIC, topicId, traceId),
    openWindow: (topicId: string, traceId: string, autoOpen?: boolean, modelName?: string) =>
      ipcRenderer.invoke(IpcChannel.TRACE_OPEN_WINDOW, topicId, traceId, autoOpen, modelName),
    setTraceWindowTitle: (title: string) => ipcRenderer.invoke(IpcChannel.TRACE_SET_TITLE, title),
    addEndMessage: (spanId: string, modelName: string, context: string) =>
      ipcRenderer.invoke(IpcChannel.TRACE_ADD_END_MESSAGE, spanId, modelName, context),
    cleanLocalData: () => ipcRenderer.invoke(IpcChannel.TRACE_CLEAN_LOCAL_DATA),
    addStreamMessage: (spanId: string, modelName: string, context: string, message: any) =>
      ipcRenderer.invoke(IpcChannel.TRACE_ADD_STREAM_MESSAGE, spanId, modelName, context, message)
  },
  windowControls: {
    minimize: (): Promise<void> => ipcRenderer.invoke(IpcChannel.Windows_Minimize),
    maximize: (): Promise<void> => ipcRenderer.invoke(IpcChannel.Windows_Maximize),
    unmaximize: (): Promise<void> => ipcRenderer.invoke(IpcChannel.Windows_Unmaximize),
    close: (): Promise<void> => ipcRenderer.invoke(IpcChannel.Windows_Close),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IpcChannel.Windows_IsMaximized),
    onMaximizedChange: (callback: (isMaximized: boolean) => void): (() => void) => {
      const channel = IpcChannel.Windows_MaximizedChanged
      const listener = (_: Electron.IpcRendererEvent, isMaximized: boolean) => callback(isMaximized)
      ipcRenderer.on(channel, listener)
      return () => {
        ipcRenderer.removeListener(channel, listener)
      }
    }
  },
  analytics: {
    trackTokenUsage: (data: TokenUsageData) => ipcRenderer.invoke(IpcChannel.Analytics_TrackTokenUsage, data)
  },
  /**
   * 主 → 渲染的**具名**事件面（收窄暴露面时补的显式桥）。
   *
   * 此前渲染层用 `window.electron.ipcRenderer.on(<channel>, …)` 直连：那既绕开三层契约
   * （任意字符串 channel，无声明、无检查），也让 preload 的暴露面等于整个 Electron API。
   * 这里每个方法就是一个声明出口：通道是 `IpcChannel` 常量，回调不接触 `IpcRendererEvent`
   * （不把 `sender` 交给渲染层），返回值统一是解绑函数。
   *
   * `once` 只用于 trace 窗口：它的载荷由窗口生命周期投递（首次 did-finish-load + 语言订阅），
   * 语义与内核的 `onXxx` 订阅缝（可重复触发）不同。
   */
  events: {
    onThemeUpdated: (callback: (theme: ThemeMode) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, theme: ThemeMode) => callback(theme)
      ipcRenderer.on(IpcChannel.ThemeUpdated, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.ThemeUpdated, listener)
      }
    },
    onSaveData: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on(IpcChannel.App_SaveData, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.App_SaveData, listener)
      }
    },
    onNavigateToAbout: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on(IpcChannel.Windows_NavigateToAbout, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.Windows_NavigateToAbout, listener)
      }
    },
    onFullscreenStatusChanged: (callback: (isFullscreen: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, isFullscreen: boolean) => callback(isFullscreen)
      ipcRenderer.on(IpcChannel.FullscreenStatusChanged, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.FullscreenStatusChanged, listener)
      }
    },
    onShowMiniWindow: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on(IpcChannel.ShowMiniWindow, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.ShowMiniWindow, listener)
      }
    },
    onStoreSyncBroadcast: (callback: (action: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, action: unknown) => callback(action)
      ipcRenderer.on(IpcChannel.StoreSync_BroadcastSync, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.StoreSync_BroadcastSync, listener)
      }
    },
    onBackupProgress: (callback: (data: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data)
      ipcRenderer.on(IpcChannel.BackupProgress, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.BackupProgress, listener)
      }
    },
    onRestoreProgress: (callback: (data: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data)
      ipcRenderer.on(IpcChannel.RestoreProgress, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.RestoreProgress, listener)
      }
    },
    onQuoteToMain: (callback: (selectedText: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, selectedText: string) => callback(selectedText)
      ipcRenderer.on(IpcChannel.App_QuoteToMain, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.App_QuoteToMain, listener)
      }
    },
    onNotificationClick: (callback: (notification: Notification) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, notification: Notification) => callback(notification)
      ipcRenderer.on(IpcChannel.Notification_Click, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.Notification_Click, listener)
      }
    },
    onTraceSelected: (
      callback: (payload: { traceId: string; topicId: string; modelName?: string }) => void
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { traceId: string; topicId: string; modelName?: string }
      ) => callback(payload)
      ipcRenderer.once(IpcChannel.Trace_SetTrace, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.Trace_SetTrace, listener)
      }
    },
    onTraceLanguageChanged: (callback: (payload: { lang: string }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { lang: string }) => callback(payload)
      ipcRenderer.once(IpcChannel.Trace_SetLanguage, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.Trace_SetLanguage, listener)
      }
    }
  }
}

/**
 * 渲染层可见的 `window.electron`（不再 expose `@electron-toolkit/preload` 的整个
 * `electronAPI`）。
 *
 * 旧暴露面把三层 IPC 契约降级成"建议"：`window.electron.ipcRenderer.invoke/send` 接受**任意
 * 字符串 channel**，主进程约 250 个 handler（含 `App_ResetData` / `File_Write` /
 * `CodeCli_Binary_Remove` 这类破坏性操作）对渲染层全部可达，且 `webFrame`/`webUtils` 与
 * 整个 `process.env` 一并外泄。现在只留渲染层真正用到的两件事：
 *
 * - `ipcRenderer.invoke/send`：**白名单**通道。白名单是显式的（不是"以 'dsh:' 开头的都放行"），
 *   未登记即拒绝并带上面名——渲染层不需要 preload 声明就能调任何 handler 的路径就此关闭。
 *   新增通道时三层一起改，这里漏登记会在第一次调用时如实失败。
 * - `process`：只有 `platform` 与三个日志相关键（`LoggerService` 的开发期开关）。
 *   `env` 的其余键（含用户环境里的密钥与 `DSH_*`）不再进入渲染层。
 * - `webFrame` / `webUtils` 整体移除：渲染层取文件路径走 `window.api.file.getPathForFile`
 *  （同一 `webUtils.getPathForFile`，只在 preload 侧调用）。
 */
const RENDERER_INVOKE_CHANNELS: ReadonlySet<string> = new Set<string>([
  IpcChannel.App_LogToMain,
  IpcChannel.Backup_Backup,
  IpcChannel.Backup_CheckConnection,
  IpcChannel.Backup_ListLocalBackupFiles,
  IpcChannel.Backup_Restore,
  IpcChannel.Backup_RestoreFromLocalBackup,
  IpcChannel.File_Read,
  IpcChannel.File_ReadExternal,
  IpcChannel.File_ReadById,
  IpcChannel.File_Write
])

// 渲染层可能用 `send` 的通道；今天为空（全部走 invoke 或 `events` 面的具名监听）。
const RENDERER_SEND_CHANNELS: ReadonlySet<string> = new Set<string>([])

const ALLOWED_RENDERER_ENV_KEYS = ['NODE_ENV', 'CSLOGGER_RENDERER_LEVEL', 'CSLOGGER_RENDERER_SHOW_MODULES'] as const

const rendererProcess = {
  platform: process.platform,
  env: Object.fromEntries(
    ALLOWED_RENDERER_ENV_KEYS.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])
  ) as Record<string, string | undefined>
}

const electronBridge = {
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
      if (!RENDERER_INVOKE_CHANNELS.has(channel)) {
        return Promise.reject(new Error(`preload: channel "${channel}" is not exposed to the renderer`))
      }
      return ipcRenderer.invoke(channel, ...args)
    },
    send: (channel: string, ...args: unknown[]): void => {
      if (!RENDERER_SEND_CHANNELS.has(channel)) {
        throw new Error(`preload: channel "${channel}" is not exposed to the renderer`)
      }
      ipcRenderer.send(channel, ...args)
    }
  },
  process: rendererProcess
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronBridge)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[Preload]Failed to expose APIs:', error as Error)
  }
} else {
  window.electron = electronBridge as unknown as Window['electron']
  window.api = api
}

export type WindowApiType = typeof api

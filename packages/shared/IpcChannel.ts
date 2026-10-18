export enum IpcChannel {
  App_GetCacheSize = 'app:get-cache-size',
  App_ClearCache = 'app:clear-cache',
  App_SetLaunchOnBoot = 'app:set-launch-on-boot',
  App_SetLanguage = 'app:set-language',
  App_SetEnableSpellCheck = 'app:set-enable-spell-check',
  App_SetSpellCheckLanguages = 'app:set-spell-check-languages',
  App_Reload = 'app:reload',
  App_Quit = 'app:quit',
  App_Info = 'app:info',
  App_Proxy = 'app:proxy',
  App_SetLaunchToTray = 'app:set-launch-to-tray',
  App_SetTray = 'app:set-tray',
  App_SetTrayOnClose = 'app:set-tray-on-close',
  App_SetTheme = 'app:set-theme',
  App_HandleZoomFactor = 'app:handle-zoom-factor',
  App_Select = 'app:select',
  App_HasWritePermission = 'app:has-write-permission',
  App_ResolvePath = 'app:resolve-path',
  App_IsPathInside = 'app:is-path-inside',
  App_Copy = 'app:copy',
  App_SetStopQuitApp = 'app:set-stop-quit-app',
  App_SetAppDataPath = 'app:set-app-data-path',
  App_GetDataPathFromArgs = 'app:get-data-path-from-args',
  App_FlushAppData = 'app:flush-app-data',
  App_IsNotEmptyDir = 'app:is-not-empty-dir',
  App_RelaunchApp = 'app:relaunch-app',
  App_ResetData = 'app:reset-data',
  App_LogToMain = 'app:log-to-main',
  App_SaveData = 'app:save-data',
  App_GetDiskInfo = 'app:get-disk-info',
  App_SetFullScreen = 'app:set-full-screen',
  App_IsFullScreen = 'app:is-full-screen',
  App_GetSystemFonts = 'app:get-system-fonts',
  App_GetIpCountry = 'app:get-ip-country',
  APP_CrashRenderProcess = 'app:crash-render-process',

  App_QuoteToMain = 'app:quote-to-main',
  App_SetDisableHardwareAcceleration = 'app:set-disable-hardware-acceleration',
  App_SetUseSystemTitleBar = 'app:set-use-system-title-bar',

  App_Update_GetState = 'app:update:get-state',
  App_Update_GetPrefs = 'app:update:get-prefs',
  App_Update_SetPrefs = 'app:update:set-prefs',
  App_Update_Check = 'app:update:check',
  App_Update_Download = 'app:update:download',
  App_Update_Cancel = 'app:update:cancel',
  App_Update_Install = 'app:update:install',
  App_Update_State = 'app:update:state',

  Notification_Send = 'notification:send',

  Webview_SetOpenLinkExternal = 'webview:set-open-link-external',
  Webview_SetSpellCheckEnabled = 'webview:set-spell-check-enabled',
  Webview_SearchHotkey = 'webview:search-hotkey',
  Webview_PrintToPDF = 'webview:print-to-pdf',
  Webview_SaveAsHTML = 'webview:save-as-html',

  // Open
  Open_Path = 'open:path',
  Open_Website = 'open:website',

  Config_Set = 'config:set',

  MiniWindow_Hide = 'miniwindow:hide',
  MiniWindow_Close = 'miniwindow:close',
  MiniWindow_SetPin = 'miniwindow:set-pin',

  // nutstore
  Nutstore_GetSsoUrl = 'nutstore:get-sso-url',
  Nutstore_DecryptToken = 'nutstore:decrypt-token',
  Nutstore_GetDirectoryContents = 'nutstore:get-directory-contents',

  //aes
  Aes_Decrypt = 'aes:decrypt',

  Windows_ResetMinimumSize = 'window:reset-minimum-size',
  Windows_SetMinimumSize = 'window:set-minimum-size',
  Windows_Resize = 'window:resize',
  Windows_GetSize = 'window:get-size',
  Windows_Minimize = 'window:minimize',
  Windows_Maximize = 'window:maximize',
  Windows_Unmaximize = 'window:unmaximize',
  Windows_Close = 'window:close',
  Windows_IsMaximized = 'window:is-maximized',
  Windows_MaximizedChanged = 'window:maximized-changed',
  Windows_NavigateToAbout = 'window:navigate-to-about',

  //file
  File_Open = 'file:open',
  File_OpenPath = 'file:openPath',
  File_Save = 'file:save',
  File_Select = 'file:select',
  File_Upload = 'file:upload',
  File_Clear = 'file:clear',
  File_Read = 'file:read',
  File_ReadExternal = 'file:readExternal',
  // /⑥：按 id 读文件仓成员并要求区分「不存在」与「读失败」。
  // `File_Read` 对任何失败都抛同一个通用错误（消费方无法区分），本通道返回
  // `FileReadByIdResult` 判别式，供 `config/minapps.ts` 正确播种自定义小应用。
  File_ReadById = 'file:readById',
  File_Delete = 'file:delete',
  File_DeleteDir = 'file:deleteDir',
  File_DeleteExternalFile = 'file:deleteExternalFile',
  File_DeleteExternalDir = 'file:deleteExternalDir',
  File_Move = 'file:move',
  File_MoveDir = 'file:moveDir',
  File_Rename = 'file:rename',
  File_RenameDir = 'file:renameDir',
  File_Get = 'file:get',
  File_SelectFolder = 'file:selectFolder',
  File_CreateTempFile = 'file:createTempFile',
  File_Mkdir = 'file:mkdir',
  File_Write = 'file:write',
  File_WriteWithId = 'file:writeWithId',
  // 聊天页 generate_image 出图的内容寻址落盘（id 由渲染层按源串 sha256 给出，
  // 同一张图重复投影只落一份——原先这批图只进 IMAGE 块元数据，文件页看不到）
  File_SaveGeneratedImage = 'file:saveGeneratedImage',
  File_SaveImage = 'file:saveImage',
  File_Base64Image = 'file:base64Image',
  File_SaveBase64Image = 'file:saveBase64Image',
  File_SavePastedImage = 'file:savePastedImage',
  File_Download = 'file:download',
  File_Copy = 'file:copy',
  File_BinaryImage = 'file:binaryImage',
  /** 文件仓变更事件（主 → 渲染）：迁移前是枚举外裸字面量。 */
  File_Change = 'file-change',
  File_Base64File = 'file:base64File',
  File_GetPdfInfo = 'file:getPdfInfo',
  Fs_Read = 'fs:read',
  Fs_ReadText = 'fs:readText',
  File_OpenWithRelativePath = 'file:openWithRelativePath',
  File_IsTextFile = 'file:isTextFile',
  File_IsDirectory = 'file:isDirectory',
  File_ListDirectory = 'file:listDirectory',
  File_GetDirectoryStructure = 'file:getDirectoryStructure',
  // 笔记（V1 原样）：校验/补全用户自选的笔记目录（主进程侧 handler 一直在，只是通道被删过）
  File_ValidateNotesDirectory = 'file:validateNotesDirectory',
  File_CheckFileName = 'file:checkFileName',
  File_StartWatcher = 'file:startWatcher',
  File_StopWatcher = 'file:stopWatcher',
  File_PauseWatcher = 'file:pauseWatcher',
  File_ResumeWatcher = 'file:resumeWatcher',
  File_BatchUploadMarkdown = 'file:batchUploadMarkdown',
  File_ShowInFolder = 'file:showInFolder',

  Export_Word = 'export:word',

  // obsidian（V1 移植）：只读枚举本地 Obsidian vault 与 vault 目录结构；导出内容
  // 不走文件写入 IPC，由渲染层经 obsidian:// deep link + 剪贴板交付给 Obsidian 本体
  Obsidian_GetVaults = 'obsidian:get-vaults',
  Obsidian_GetFiles = 'obsidian:get-files',

  Shortcuts_Update = 'shortcuts:update',

  // backup
  Backup_Backup = 'backup:backup',
  Backup_Restore = 'backup:restore',
  Backup_BackupToWebdav = 'backup:backupToWebdav',
  Backup_RestoreFromWebdav = 'backup:restoreFromWebdav',
  Backup_ListWebdavFiles = 'backup:listWebdavFiles',
  Backup_CheckConnection = 'backup:checkConnection',
  Backup_CreateDirectory = 'backup:createDirectory',
  Backup_DeleteWebdavFile = 'backup:deleteWebdavFile',
  Backup_BackupToLocalDir = 'backup:backupToLocalDir',
  Backup_RestoreFromLocalBackup = 'backup:restoreFromLocalBackup',
  Backup_ListLocalBackupFiles = 'backup:listLocalBackupFiles',
  Backup_DeleteLocalBackupFile = 'backup:deleteLocalBackupFile',

  // zip
  Zip_Decompress = 'zip:decompress',

  // system
  System_GetDeviceType = 'system:getDeviceType',
  System_GetHostname = 'system:getHostname',

  // DevTools
  System_ToggleDevTools = 'system:toggleDevTools',

  // events
  BackupProgress = 'backup-progress',
  ThemeUpdated = 'theme:updated',
  RestoreProgress = 'restore-progress',

  FullscreenStatusChanged = 'fullscreen-status-changed',

  ShowMiniWindow = 'show-mini-window',

  /** 通知点击（主 → 渲染）：随 loadURL 的 electron Notification 'click' 事件下发。 */
  Notification_Click = 'notification-click',

  /** cherrystudio:// deep link 的原始载荷（主 → 渲染；preload 桥此前用的是裸字符串）。 */
  Protocol_Data = 'protocol-data',

  /** trace 窗口的选中目标（主 → 渲染 traceWindow.html）。 */
  Trace_SetTrace = 'trace:set-trace',
  /** trace 窗口语言（主 → 渲染 traceWindow.html；与 App_SetLanguage='app:set-language' 不是同一条）。 */
  Trace_SetLanguage = 'trace:set-language',

  // Search Window
  SearchWindow_OpenUrl = 'search-window:open-url',
  SearchWindow_Close = 'search-window:close',

  //Store Sync
  StoreSync_Subscribe = 'store-sync:subscribe',
  StoreSync_Unsubscribe = 'store-sync:unsubscribe',
  StoreSync_OnUpdate = 'store-sync:on-update',
  StoreSync_BroadcastSync = 'store-sync:broadcast-sync',

  // TRACE
  TRACE_SAVE_DATA = 'trace:saveData',
  TRACE_GET_DATA = 'trace:getData',
  TRACE_SAVE_ENTITY = 'trace:saveEntity',
  TRACE_BIND_TOPIC = 'trace:bindTopic',
  TRACE_CLEAN_TOPIC = 'trace:cleanTopic',
  TRACE_TOKEN_USAGE = 'trace:tokenUsage',
  TRACE_CLEAN_HISTORY = 'trace:cleanHistory',
  TRACE_OPEN_WINDOW = 'trace:openWindow',
  TRACE_SET_TITLE = 'trace:setTitle',
  TRACE_ADD_END_MESSAGE = 'trace:addEndMessage',
  TRACE_CLEAN_LOCAL_DATA = 'trace:cleanLocalData',
  TRACE_ADD_STREAM_MESSAGE = 'trace:addStreamMessage',

  // ExternalApps
  ExternalApps_DetectInstalled = 'external-apps:detect-installed',

  // Analytics
  Analytics_TrackTokenUsage = 'analytics:track-token-usage',

  // provider key 加密存储（K 线）
  ProviderKeys_GetAll = 'provider-keys:get-all',
  ProviderKeys_Set = 'provider-keys:set',
  ProviderKeys_Remove = 'provider-keys:remove',

  // dsh kernel
  Dsh_SyncProviders = 'dsh:sync-providers',
  Dsh_SyncImageDescriber = 'dsh:sync-image-describer',
  /** 网络搜索配置同步：渲染层 websearch 切片 → 主进程 WebSearchService。 */
  Dsh_SyncWebSearch = 'dsh:sync-web-search',
  /** MCP 服务器配置同步：渲染层 mcp 切片 → 主进程 MCPService（内存投影）。 */
  Dsh_SyncMcpServers = 'dsh:sync-mcp-servers',
  /**
   * 文档处理通道配置同步（三轮）：渲染层 preprocess 切片 providers（含 apiKey，
   * 只进主进程内存）→ preprocessChannel 配置表；ocr_document 工具与知识库摄取按此路由。
   */
  Dsh_SyncPreprocess = 'dsh:sync-preprocess',
  /** MCP 设置页通道：服务器生命周期与发现（上游 Mcp_* 命名子集）。 */
  Mcp_ListTools = 'mcp:list-tools',
  Mcp_ListPrompts = 'mcp:list-prompts',
  Mcp_ListResources = 'mcp:list-resources',
  Mcp_GetServerVersion = 'mcp:get-server-version',
  Mcp_GetServerLogs = 'mcp:get-server-logs',
  Mcp_RestartServer = 'mcp:restart-server',
  Mcp_StopServer = 'mcp:stop-server',
  Mcp_RemoveServer = 'mcp:remove-server',
  Mcp_CheckConnectivity = 'mcp:check-connectivity',
  /** MCP 运行时依赖探测（v1）：PATH 中能否解析命令（fork 不托管 uv/bun 二进制，stdio
   *  服务器靠系统 PATH 的 npx/uvx——见 main/services/mcp/commandResolution.ts）。 */
  Mcp_CheckCommand = 'mcp:check-command',
  /** DXT（.dxt）扩展安装（自上游 Mcp_UploadDxt 移植）：ArrayBuffer + 文件名，返回解包结果。 */
  Mcp_UploadDxt = 'mcp:upload-dxt',
  /** MCP 服务器日志事件（主 → 渲染，上游 Mcp_ServerLog 同语义）。 */
  Mcp_ServerLog = 'mcp:server-log',
  /** 知识库通道：库文件生命周期 + 条目处理 + 检索（上游 KnowledgeBase_* 命名子集）。 */
  KnowledgeBase_Create = 'knowledge-base:create',
  KnowledgeBase_Reset = 'knowledge-base:reset',
  KnowledgeBase_Delete = 'knowledge-base:delete',
  KnowledgeBase_Add = 'knowledge-base:add',
  KnowledgeBase_Remove = 'knowledge-base:remove',
  KnowledgeBase_Search = 'knowledge-base:search',
  /** 文档处理通道 local-paddle 条目（收编自 LocalModel_*）：OCR 权重下载生命周期（进度渲染层轮询 getStatus）。 */
  Preprocess_LocalPaddle_GetStatus = 'preprocess:local-paddle:get-status',
  Preprocess_LocalPaddle_Download = 'preprocess:local-paddle:download',
  Preprocess_LocalPaddle_Cancel = 'preprocess:local-paddle:cancel',
  Preprocess_LocalPaddle_Remove = 'preprocess:local-paddle:remove',
  /** 技能通道：zip/目录/URL 安装 + 卸载真删盘 + 库扫描（上游 Skill_* 命名子集）。 */
  Skill_InstallFromZip = 'skill:install-from-zip',
  Skill_InstallFromDirectory = 'skill:install-from-directory',
  Skill_InstallFromUrl = 'skill:install-from-url',
  Skill_Uninstall = 'skill:uninstall',
  Skill_List = 'skill:list',
  /** 网络搜索连通性检查：'test query' 真跑一次（设置页「检查」按钮）。 */
  WebSearch_Check = 'web-search:check',
  Dsh_StreamSmoke = 'dsh:stream-smoke',
  Dsh_Complete = 'dsh:complete',
  Dsh_StreamComplete = 'dsh:stream-complete',
  // fork 缝：轻量流式补全的真取消通道（无载荷校验：requestId 配对，未命中即无害空操作）。
  Dsh_StreamAbort = 'dsh:stream-abort',
  Dsh_CompletionEvent = 'dsh:completion-event',
  Dsh_TopicList = 'dsh:topic-list',
  Dsh_TopicCreate = 'dsh:topic-create',
  Dsh_TopicRename = 'dsh:topic-rename',
  Dsh_TopicDelete = 'dsh:topic-delete',
  Dsh_TopicDestroyTurns = 'dsh:topic-destroy-turns',
  Dsh_TopicOpen = 'dsh:topic-open',
  Dsh_TopicFork = 'dsh:topic-fork',
  Dsh_TopicBranches = 'dsh:topic-branches',
  Dsh_TopicSend = 'dsh:topic-send',
  Dsh_TopicStop = 'dsh:topic-stop',
  Dsh_TopicRunning = 'dsh:topic-running',
  Dsh_TopicEvents = 'dsh:topic-events',
  Dsh_TopicGet = 'dsh:topic-get',
  Dsh_ApprovalRequest = 'dsh:approval-request',
  Dsh_ApprovalDecide = 'dsh:approval-decide',
  Dsh_QuestionRequest = 'dsh:question-request',
  Dsh_QuestionAnswer = 'dsh:question-answer',
  Dsh_SearchMessages = 'dsh:search-messages',
  Dsh_SessionEvent = 'dsh:session-event',
  /** 内核图片附件 → 渲染层文件仓的回放同步（识图通道；读 ref、写字节、返回 FileMetadata）。 */
  Dsh_AttachmentSync = 'dsh:attachment-sync',
  /** 轻量图像模态（绘画页/生图工具的执行缝；OpenAI 兼容平面直连，实现 kernel/lightLlmModalities）。 */
  Dsh_LightImage = 'dsh:light-image',
  Dsh_LightImageAbort = 'dsh:light-image-abort',

  // 编码助手（自 CS_V2 Code Mate 移植）：受管 Web UI 工具的生命周期通道。
  CodeCli_DeepseekHarness_Start = 'code-cli:deepseek-harness:start',
  CodeCli_DeepseekHarness_Stop = 'code-cli:deepseek-harness:stop',
  /** 主 → 渲染状态广播（starting/running/stopped/error + url）。 */
  CodeCli_DeepseekHarness_Status = 'code-cli:deepseek-harness:status',
  /** 立即拉当前状态（渲染层订阅缝 useCodeCliStatus 的初值通道；载荷同 Status）。 */
  CodeCli_DeepseekHarness_GetStatus = 'code-cli:deepseek-harness:get-status',
  /** 数据重置（入参只收 keepSessions 布尔；路径全部主进程从 paths.ts 派生）。 */
  CodeCli_DeepseekHarness_Reset = 'code-cli:deepseek-harness:reset',
  /** 启动自愈开关：带 { enabled } 即写，省参即读（默认开）。 */
  CodeCli_DeepseekHarness_AutoHeal = 'code-cli:deepseek-harness:auto-heal',
  CodeCli_HermesDashboard_Start = 'code-cli:hermes-dashboard:start',
  CodeCli_HermesDashboard_Stop = 'code-cli:hermes-dashboard:stop',
  /** 主 → 渲染状态广播（同 DeepseekHarness_Status 语义）。 */
  CodeCli_HermesDashboard_Status = 'code-cli:hermes-dashboard:status',
  /** 立即拉当前状态（载荷同 Status）。 */
  CodeCli_HermesDashboard_GetStatus = 'code-cli:hermes-dashboard:get-status',
  /** Paper-Agent（源码型受管工具）Web UI 生命周期。 */
  CodeCli_PaperAgent_Start = 'code-cli:paper-agent:start',
  CodeCli_PaperAgent_Stop = 'code-cli:paper-agent:stop',
  /** 主 → 渲染状态广播（同 DeepseekHarness_Status 语义）。 */
  CodeCli_PaperAgent_Status = 'code-cli:paper-agent:status',
  /** 立即拉当前状态（载荷同 Status）。 */
  CodeCli_PaperAgent_GetStatus = 'code-cli:paper-agent:get-status',
  /** hermes 配置文件读写（target 枚举 = 写白名单，渲染层永不传路径）。 */
  CodeCli_ReadConfig = 'code-cli:read-config',
  CodeCli_WriteConfig = 'code-cli:write-config',
  /** 受管 CLI 工具安装器：装卸/快照/版本（portable，{userData}/Data/CodeMate/）。 */
  CodeCli_Binary_Install = 'code-cli:binary:install',
  CodeCli_Binary_Remove = 'code-cli:binary:remove',
  CodeCli_Binary_Snapshots = 'code-cli:binary:snapshots',
  CodeCli_Binary_LatestVersions = 'code-cli:binary:latest-versions',
  /** 手动检查更新（强制重探快照 + 现查最新版本；source 型走 GitHub HEAD SHA 对比）。 */
  CodeCli_Binary_CheckUpdates = 'code-cli:binary:check-updates',
  /** 安装/卸载/快照变化广播（无载荷，消费者重拉快照）。 */
  CodeCli_Binary_Changed = 'code-cli:binary:changed',
  /** 安装步骤进度广播（载荷 {tool, step}，step 为 i18n 键尾）。 */
  CodeCli_Binary_InstallProgress = 'code-cli:binary:install-progress',
  /** 统一网关：生命周期 + 状态广播 + 渲染层配置同步（enabled/port/host）。 */
  CodeCli_ApiGateway_Start = 'code-cli:api-gateway:start',
  CodeCli_ApiGateway_Stop = 'code-cli:api-gateway:stop',
  CodeCli_ApiGateway_Restart = 'code-cli:api-gateway:restart',
  CodeCli_ApiGateway_LanSetEnabled = 'code-cli:api-gateway:lan:set-enabled',
  CodeCli_ApiGateway_Status = 'code-cli:api-gateway:status',
  /** 立即拉当前运行态（载荷 {running, lanRunning?, port?} 同 Status 广播）。 */
  CodeCli_ApiGateway_GetStatus = 'code-cli:api-gateway:get-status',
  /** 网关配置读取（host/port/apiKey——渲染层合成网关 provider 与 hermes 配置草稿用）。 */
  CodeCli_ApiGateway_GetConfig = 'code-cli:api-gateway:get-config',
  CodeCli_SyncGatewayConfig = 'code-cli:sync-gateway-config'
}

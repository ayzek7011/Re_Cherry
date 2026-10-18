import fs from 'node:fs'
import { arch } from 'node:os'
import path from 'node:path'

import type { TokenUsageData } from '@cherrystudio/analytics-client'
import { loggerService } from '@logger'
import { isLinux, isPortable, isWin } from '@main/constant'
import { getIpCountry } from '@main/utils/ipService'
import { handleZoomFactor } from '@main/utils/zoom'
import type { SpanEntity, TokenUsage } from '@mcp-trace/trace-core'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH } from '@shared/config/constant'
import { IpcChannel } from '@shared/IpcChannel'
import { CodeCli } from '@shared/types/codeCli'
import { redactSecretText } from '@shared/utils/redaction'
import type { MCPServer, Notification, Shortcut, ThemeMode } from '@types'
import checkDiskSpace from 'check-disk-space'
import type { ProxyConfig } from 'electron'
import { BrowserWindow, dialog, ipcMain, session, shell, webContents } from 'electron'
import fontList from 'font-list'

import { apiGatewayService } from './features/apiGateway/ApiGatewayService'
import { analyticsService } from './services/AnalyticsService'
import appService from './services/AppService'
import { appUpdateService, parsePrefsPatch } from './services/AppUpdateService'
import BackupManager from './services/BackupManager'
import { binaryManager } from './services/binaryManager/BinaryManager'
import { BINARY_TOOL_NAMES, type BinaryToolName, isBinaryToolName } from './services/binaryManager/presets'
import { parseCliConfigReadInput, parseCliConfigWriteInput } from './services/codeCli/configPayload'
import { readCliConfigFiles, writeCliConfigFiles } from './services/codeCli/configWriter'
import { configManager } from './services/ConfigManager'
import { deepSeekHarnessService } from './services/deepSeekHarness/DeepSeekHarnessService'
import { ExportService } from './services/ExportService'
import { externalAppsService } from './services/ExternalAppsService'
import { fileStorage as fileManager } from './services/FileStorage'
import FileService from './services/FileSystemService'
import { hermesDashboardService } from './services/hermes/HermesDashboardService'
import { knowledgeService } from './services/knowledge/KnowledgeService'
import { openTraceWindow, setTraceWindowTitle } from './services/NodeTraceService'
import NotificationService from './services/NotificationService'
import * as NutstoreService from './services/NutstoreService'
import ObsidianVaultService from './services/ObsidianVaultService'
import { paperAgentService } from './services/paperAgent/PaperAgentService'
import * as localPaddle from './services/preprocess/localPaddle'
import { providerKeyStore } from './services/ProviderKeyStore'
import { proxyManager } from './services/ProxyManager'
import { searchService } from './services/SearchService'
import { isSafeExternalUrl } from './services/security'
import { registerShortcuts, registerUniversalShortcuts, unregisterAllShortcuts } from './services/ShortcutService'
import { skillService } from './services/skills/SkillService'
import {
  addEndMessage,
  addStreamMessage,
  bindTopic,
  cleanHistoryTrace,
  cleanLocalData,
  cleanTopic,
  getSpans,
  saveEntity,
  saveSpans,
  tokenUsage
} from './services/SpanCacheService'
import storeSyncService from './services/StoreSyncService'
import { themeService } from './services/ThemeService'
import { setOpenLinkExternal } from './services/WebviewService'
import { windowService } from './services/WindowService'
import { calculateDirectorySize, getResourcePath } from './utils'
import { decrypt } from './utils/aes'
import {
  getCacheDir,
  getConfigDir,
  getFilesDir,
  getNotesDir,
  hasWritePermission,
  isPathInside,
  untildify
} from './utils/file'
import { updateAppDataConfig } from './utils/init'
import { getDeviceType, getHostname } from './utils/system'
import { decompress } from './utils/zip'

const logger = loggerService.withContext('IPC')

const backupManager = new BackupManager()
const exportService = new ExportService()
// obsidian vault 只读枚举（V1 移植）：配置路径在首次调用时惰性解析，不占启动序
const obsidianVaultService = new ObsidianVaultService()

// `registerIpc` 函数体里有**进程级**副作用，此前无任何幂等保护。
// `ipcMain.handle` 重复注册只是覆盖（无害），但 `on` / `subscribe` 是**累积**的：
// `mcpService.onServerLog` 返回的解绑函数被丢弃、`mainWindow.on('maximize')` 按窗口闭包挂载。
// 任何第二次调用（macOS 激活重建主窗、将来加多窗口、dev 下模块重求值）都会让日志事件被重复
// 转发、旧窗口闭包随监听一起被内存持有。两处各自收口：全局订阅只接一次并被登记，
// 窗口监听按窗口实例记账（WeakSet，同一窗口不重复挂）。
let mcpLogUnsubscribe: (() => void) | null = null

const wiredWindowListeners = new WeakSet<BrowserWindow>()

function wireMainWindowListeners(mainWindow: BrowserWindow): void {
  if (wiredWindowListeners.has(mainWindow)) return
  wiredWindowListeners.add(mainWindow)

  // Send maximized state changes to renderer（回调捕获本次传入的窗口；窗口销毁后不再 send）
  mainWindow.on('maximize', () => {
    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send(IpcChannel.Windows_MaximizedChanged, true)
  })

  mainWindow.on('unmaximize', () => {
    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send(IpcChannel.Windows_MaximizedChanged, false)
  })
}

export async function registerIpc(mainWindow: BrowserWindow, app: Electron.App) {
  wireMainWindowListeners(mainWindow)

  const notificationService = new NotificationService()

  const checkMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Main window does not exist or has been destroyed')
    }
  }

  ipcMain.handle(IpcChannel.App_Info, () => ({
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    filesPath: getFilesDir(),
    notesPath: getNotesDir(),
    configPath: getConfigDir(),
    appDataPath: app.getPath('userData'),
    resourcesPath: getResourcePath(),
    logsPath: logger.getLogsDir(),
    arch: arch(),
    isPortable: isWin && 'PORTABLE_EXECUTABLE_DIR' in process.env,
    installPath: path.dirname(app.getPath('exe'))
  }))

  ipcMain.handle(IpcChannel.App_Proxy, async (_, proxy: string, bypassRules?: string) => {
    let proxyConfig: ProxyConfig

    if (proxy === 'system') {
      // system proxy will use the system filter by themselves
      proxyConfig = { mode: 'system' }
    } else if (proxy) {
      proxyConfig = { mode: 'fixed_servers', proxyRules: proxy, proxyBypassRules: bypassRules }
    } else {
      proxyConfig = { mode: 'direct' }
    }

    await proxyManager.configureProxy(proxyConfig)
  })

  ipcMain.handle(IpcChannel.App_Reload, () => mainWindow.reload())
  ipcMain.handle(IpcChannel.App_Quit, () => app.quit())
  ipcMain.handle(IpcChannel.Open_Website, (_, url: string) => {
    if (!isSafeExternalUrl(url)) {
      logger.warn(`Blocked shell.openExternal for untrusted URL scheme: ${url}`)
      return
    }
    return shell.openExternal(url)
  })

  // language
  ipcMain.handle(IpcChannel.App_SetLanguage, (_, language) => {
    configManager.setLanguage(language)
  })

  // spell check
  ipcMain.handle(IpcChannel.App_SetEnableSpellCheck, (_, isEnable: boolean) => {
    // disable spell check for all webviews
    const webviews = webContents.getAllWebContents()
    webviews.forEach((webview) => {
      webview.session.setSpellCheckerEnabled(isEnable)
    })
  })

  // spell check languages
  ipcMain.handle(IpcChannel.App_SetSpellCheckLanguages, (_, languages: string[]) => {
    if (languages.length === 0) {
      return
    }
    const windows = BrowserWindow.getAllWindows()
    windows.forEach((window) => {
      window.webContents.session.setSpellCheckerLanguages(languages)
    })
    configManager.set('spellCheckLanguages', languages)
  })

  // launch on boot
  ipcMain.handle(IpcChannel.App_SetLaunchOnBoot, async (_, isLaunchOnBoot: boolean) => {
    await appService.setAppLaunchOnBoot(isLaunchOnBoot)
  })

  // launch to tray
  ipcMain.handle(IpcChannel.App_SetLaunchToTray, (_, isActive: boolean) => {
    configManager.setLaunchToTray(isActive)
  })

  // tray
  ipcMain.handle(IpcChannel.App_SetTray, (_, isActive: boolean) => {
    configManager.setTray(isActive)
  })

  // to tray on close
  ipcMain.handle(IpcChannel.App_SetTrayOnClose, (_, isActive: boolean) => {
    configManager.setTrayOnClose(isActive)
  })

  ipcMain.handle(IpcChannel.App_SetFullScreen, (_, value: boolean): void => {
    mainWindow.setFullScreen(value)
  })

  ipcMain.handle(IpcChannel.App_IsFullScreen, (): boolean => {
    return mainWindow.isFullScreen()
  })

  // Get System Fonts
  ipcMain.handle(IpcChannel.App_GetSystemFonts, async () => {
    try {
      const fonts = await fontList.getFonts()
      return fonts.map((font: string) => font.replace(/^"(.*)"$/, '$1')).filter((font: string) => font.length > 0)
    } catch (error) {
      logger.error('Failed to get system fonts:', error as Error)
      return []
    }
  })

  // Get IP Country
  ipcMain.handle(IpcChannel.App_GetIpCountry, async () => {
    return getIpCountry()
  })

  ipcMain.handle(IpcChannel.Config_Set, (_, key: string, value: any, isNotify: boolean = false) => {
    configManager.set(key, value, isNotify)
  })

  // theme
  ipcMain.handle(IpcChannel.App_SetTheme, (_, theme: ThemeMode) => {
    themeService.setTheme(theme)
  })

  ipcMain.handle(IpcChannel.App_HandleZoomFactor, (_, delta: number, reset: boolean = false) => {
    const windows = BrowserWindow.getAllWindows()
    handleZoomFactor(windows, delta, reset)
    return configManager.getZoomFactor()
  })

  // clear cache
  ipcMain.handle(IpcChannel.App_ClearCache, async () => {
    const sessions = [session.defaultSession, session.fromPartition('persist:webview')]

    try {
      await Promise.all(
        sessions.map(async (session) => {
          await session.clearCache()
          await session.clearStorageData({
            storages: ['cookies', 'filesystem', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
          })
        })
      )
      await fileManager.clearTemp()
      // do not clear logs for now
      // TODO clear logs
      // await fs.writeFileSync(log.transports.file.getFile().path, '')
      return { success: true }
    } catch (error: any) {
      logger.error('Failed to clear cache:', error)
      return { success: false, error: error.message }
    }
  })

  // get cache size
  ipcMain.handle(IpcChannel.App_GetCacheSize, async () => {
    const cachePath = getCacheDir()
    logger.info(`Calculating cache size for path: ${cachePath}`)

    try {
      const sizeInBytes = await calculateDirectorySize(cachePath)
      const sizeInMB = (sizeInBytes / (1024 * 1024)).toFixed(2)
      return `${sizeInMB}`
    } catch (error: any) {
      logger.error(`Failed to calculate cache size for ${cachePath}: ${error.message}`)
      return '0'
    }
  })

  let preventQuitListener: ((event: Electron.Event) => void) | null = null
  ipcMain.handle(IpcChannel.App_SetStopQuitApp, (_, stop: boolean = false, reason: string = '') => {
    if (stop) {
      // Only add listener if not already added
      if (!preventQuitListener) {
        preventQuitListener = (event: Electron.Event) => {
          event.preventDefault()
          void notificationService.sendNotification({
            title: reason,
            message: reason
          } as Notification)
        }
        app.on('before-quit', preventQuitListener)
      }
    } else {
      // Remove listener if it exists
      if (preventQuitListener) {
        app.removeListener('before-quit', preventQuitListener)
        preventQuitListener = null
      }
    }
  })

  // Select app data path
  ipcMain.handle(IpcChannel.App_Select, async (_, options: Electron.OpenDialogOptions) => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(options)
      if (canceled || filePaths.length === 0) {
        return null
      }
      return filePaths[0]
    } catch (error: any) {
      logger.error('Failed to select app data path:', error)
      return null
    }
  })

  ipcMain.handle(IpcChannel.App_HasWritePermission, async (_, filePath: string) => {
    const hasPermission = await hasWritePermission(filePath)
    return hasPermission
  })

  ipcMain.handle(IpcChannel.App_ResolvePath, async (_, filePath: string) => {
    return path.resolve(untildify(filePath))
  })

  // Check if a path is inside another path (proper parent-child relationship)
  ipcMain.handle(IpcChannel.App_IsPathInside, async (_, childPath: string, parentPath: string) => {
    return isPathInside(childPath, parentPath)
  })

  // Set app data path
  ipcMain.handle(IpcChannel.App_SetAppDataPath, async (_, filePath: string) => {
    updateAppDataConfig(filePath)
    app.setPath('userData', filePath)
  })

  ipcMain.handle(IpcChannel.App_GetDataPathFromArgs, () => {
    return process.argv
      .slice(1)
      .find((arg) => arg.startsWith('--new-data-path='))
      ?.split('--new-data-path=')[1]
  })

  ipcMain.handle(IpcChannel.App_FlushAppData, async () => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.session.flushStorageData()
      await w.webContents.session.cookies.flushStore()
      await w.webContents.session.closeAllConnections()
    }

    session.defaultSession.flushStorageData()
    await session.defaultSession.cookies.flushStore()
    await session.defaultSession.closeAllConnections()
  })

  ipcMain.handle(IpcChannel.App_IsNotEmptyDir, async (_, path: string) => {
    // 目录不存在时保持抛错语义（ipcMain.handle 会向渲染层透传 rejection），不得吞成"空"
    const entries = await fs.promises.readdir(path)
    return entries.length > 0
  })

  // Copy user data to new location
  ipcMain.handle(IpcChannel.App_Copy, async (_, oldPath: string, newPath: string, occupiedDirs: string[] = []) => {
    try {
      await fs.promises.cp(oldPath, newPath, {
        recursive: true,
        filter: (src) => {
          if (occupiedDirs.some((dir) => src.startsWith(path.resolve(dir)))) {
            return false
          }
          return true
        }
      })
      return { success: true }
    } catch (error: any) {
      logger.error('Failed to copy user data:', error)
      return { success: false, error: error.message }
    }
  })

  // Relaunch app
  ipcMain.handle(IpcChannel.App_RelaunchApp, (_, options?: Electron.RelaunchOptions) => {
    // Fix for .AppImage
    if (isLinux && process.env.APPIMAGE) {
      logger.info(`Relaunching app with options: ${process.env.APPIMAGE}`, options)
      // On Linux, we need to use the APPIMAGE environment variable to relaunch
      // https://github.com/electron-userland/electron-builder/issues/1727#issuecomment-769896927
      options = options || {}
      options.execPath = process.env.APPIMAGE
      options.args = options.args || []
      options.args.unshift('--appimage-extract-and-run')
    }

    if (isWin && isPortable) {
      options = options || {}
      options.execPath = process.env.PORTABLE_EXECUTABLE_FILE
      options.args = options.args || []
    }

    // 沙箱 runner 的 node 语义已改为 dsh-subprocess-local 补丁按子进程注入
    // （见 kernel/index.ts 的说明），内核不再设 ambient `ELECTRON_RUN_AS_NODE`。
    // 这里保留防御性剥除：若用户系统环境同名变量存在，`app.relaunch` 继承后重启的
    // 应用会以 **node** 启动而非 Electron 应用。
    delete process.env.ELECTRON_RUN_AS_NODE

    app.relaunch(options)
    app.exit(0)
  })

  // Reset all data (factory reset)
  ipcMain.handle(IpcChannel.App_ResetData, () => backupManager.resetData())

  // 应用更新：渲染层只发起动作，状态一律由主进程推送（App_Update_State）。
  ipcMain.handle(IpcChannel.App_Update_GetState, () => appUpdateService.getState())
  ipcMain.handle(IpcChannel.App_Update_GetPrefs, () => appUpdateService.getPrefs())
  ipcMain.handle(IpcChannel.App_Update_SetPrefs, (_, raw: unknown) => appUpdateService.setPrefs(parsePrefsPatch(raw)))
  ipcMain.handle(IpcChannel.App_Update_Check, (_, options?: { manual?: boolean }) =>
    appUpdateService.check({ manual: options?.manual === true })
  )
  ipcMain.handle(IpcChannel.App_Update_Download, () => appUpdateService.download())
  ipcMain.handle(IpcChannel.App_Update_Cancel, () => appUpdateService.cancelDownload())
  ipcMain.handle(IpcChannel.App_Update_Install, () => appUpdateService.install())

  // notification
  ipcMain.handle(IpcChannel.Notification_Send, async (_, notification: Notification) => {
    await notificationService.sendNotification(notification)
  })

  // zip
  ipcMain.handle(IpcChannel.Zip_Decompress, (_, text: Buffer) => decompress(text))

  // system
  ipcMain.handle(IpcChannel.System_GetDeviceType, getDeviceType)
  ipcMain.handle(IpcChannel.System_GetHostname, getHostname)

  ipcMain.handle(IpcChannel.System_ToggleDevTools, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    win && win.webContents.toggleDevTools()
  })

  // backup
  ipcMain.handle(IpcChannel.Backup_Backup, backupManager.backup.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_Restore, backupManager.restore.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_BackupToWebdav, backupManager.backupToWebdav.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_RestoreFromWebdav, backupManager.restoreFromWebdav.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_ListWebdavFiles, backupManager.listWebdavFiles.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_CheckConnection, backupManager.checkConnection.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_CreateDirectory, backupManager.createDirectory.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_DeleteWebdavFile, backupManager.deleteWebdavFile.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_BackupToLocalDir, backupManager.backupToLocalDir.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_RestoreFromLocalBackup, backupManager.restoreFromLocalBackup.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_ListLocalBackupFiles, backupManager.listLocalBackupFiles.bind(backupManager))
  ipcMain.handle(IpcChannel.Backup_DeleteLocalBackupFile, backupManager.deleteLocalBackupFile.bind(backupManager))

  // file
  ipcMain.handle(IpcChannel.File_Open, fileManager.open.bind(fileManager))
  ipcMain.handle(IpcChannel.File_OpenPath, fileManager.openPath.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Save, fileManager.save.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Select, fileManager.selectFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Upload, fileManager.uploadFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Clear, fileManager.clear.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Read, fileManager.readFile.bind(fileManager))
  // /⑥：区分「不存在」与「读失败」的读通道（渲染层播种自定义小应用要用）
  ipcMain.handle(IpcChannel.File_ReadById, fileManager.readFileById.bind(fileManager))
  ipcMain.handle(IpcChannel.File_ReadExternal, fileManager.readExternalFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Delete, fileManager.deleteFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_DeleteDir, fileManager.deleteDir.bind(fileManager))
  ipcMain.handle(IpcChannel.File_DeleteExternalFile, fileManager.deleteExternalFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_DeleteExternalDir, fileManager.deleteExternalDir.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Move, fileManager.moveFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_MoveDir, fileManager.moveDir.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Rename, fileManager.renameFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_RenameDir, fileManager.renameDir.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Get, fileManager.getFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_SelectFolder, fileManager.selectFolder.bind(fileManager))
  ipcMain.handle(IpcChannel.File_CreateTempFile, fileManager.createTempFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Mkdir, fileManager.mkdir.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Write, fileManager.writeFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_WriteWithId, fileManager.writeFileWithId.bind(fileManager))
  // 聊天页 generate_image 出图的内容寻址落盘（id 由渲染层按源串 sha256 给出）
  ipcMain.handle(IpcChannel.File_SaveGeneratedImage, fileManager.saveGeneratedImage.bind(fileManager))
  ipcMain.handle(IpcChannel.File_SaveImage, fileManager.saveImage.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Base64Image, fileManager.base64Image.bind(fileManager))
  ipcMain.handle(IpcChannel.File_SaveBase64Image, fileManager.saveBase64Image.bind(fileManager))
  ipcMain.handle(IpcChannel.File_SavePastedImage, fileManager.savePastedImage.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Base64File, fileManager.base64File.bind(fileManager))
  ipcMain.handle(IpcChannel.File_GetPdfInfo, fileManager.pdfPageCount.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Download, fileManager.downloadFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_Copy, fileManager.copyFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_BinaryImage, fileManager.binaryImage.bind(fileManager))
  ipcMain.handle(IpcChannel.File_OpenWithRelativePath, fileManager.openFileWithRelativePath.bind(fileManager))
  ipcMain.handle(IpcChannel.File_IsTextFile, fileManager.isTextFile.bind(fileManager))
  ipcMain.handle(IpcChannel.File_IsDirectory, fileManager.isDirectory.bind(fileManager))
  ipcMain.handle(IpcChannel.File_ListDirectory, fileManager.listDirectory.bind(fileManager))
  ipcMain.handle(IpcChannel.File_GetDirectoryStructure, fileManager.getDirectoryStructure.bind(fileManager))
  // 笔记（V1 原样）：FileStorage.validateNotesDirectory 一直在，补回这一层转发
  ipcMain.handle(IpcChannel.File_ValidateNotesDirectory, fileManager.validateNotesDirectory.bind(fileManager))
  ipcMain.handle(IpcChannel.File_CheckFileName, fileManager.fileNameGuard.bind(fileManager))
  ipcMain.handle(IpcChannel.File_StartWatcher, fileManager.startFileWatcher.bind(fileManager))
  ipcMain.handle(IpcChannel.File_StopWatcher, fileManager.stopFileWatcher.bind(fileManager))
  ipcMain.handle(IpcChannel.File_PauseWatcher, fileManager.pauseFileWatcher.bind(fileManager))
  ipcMain.handle(IpcChannel.File_ResumeWatcher, fileManager.resumeFileWatcher.bind(fileManager))
  ipcMain.handle(IpcChannel.File_BatchUploadMarkdown, fileManager.batchUploadMarkdownFiles.bind(fileManager))
  ipcMain.handle(IpcChannel.File_ShowInFolder, fileManager.showInFolder.bind(fileManager))

  // fs
  ipcMain.handle(IpcChannel.Fs_Read, FileService.readFile.bind(FileService))
  ipcMain.handle(IpcChannel.Fs_ReadText, FileService.readTextFileWithAutoEncoding.bind(FileService))

  // provider key 加密存储（K 线）
  ipcMain.handle(IpcChannel.ProviderKeys_GetAll, () => providerKeyStore.getAll())
  ipcMain.handle(IpcChannel.ProviderKeys_Set, (_e, providerId: string, apiKey: string) => {
    providerKeyStore.set(providerId, apiKey)
  })
  ipcMain.handle(IpcChannel.ProviderKeys_Remove, (_e, providerId: string) => {
    providerKeyStore.remove(providerId)
  })

  // export
  ipcMain.handle(IpcChannel.Export_Word, exportService.exportToWord.bind(exportService))

  // obsidian（V1 移植）：vault 枚举与目录结构只读查询。
  // 目录结构遍历改为异步 IO（千级笔记不再阻塞主进程消息循环），故 await。
  ipcMain.handle(IpcChannel.Obsidian_GetVaults, () => {
    return obsidianVaultService.getVaults()
  })
  ipcMain.handle(IpcChannel.Obsidian_GetFiles, async (_event, vaultName: string) => {
    if (typeof vaultName !== 'string' || vaultName.trim().length === 0) {
      return []
    }
    return await obsidianVaultService.getFilesByVaultName(vaultName)
  })

  // open path
  ipcMain.handle(IpcChannel.Open_Path, async (_, path: string) => {
    await shell.openPath(path)
  })

  // shortcuts
  ipcMain.handle(IpcChannel.Shortcuts_Update, (_, shortcuts: Shortcut[]) => {
    configManager.setShortcuts(shortcuts)
    // Refresh shortcuts registration
    if (mainWindow) {
      unregisterAllShortcuts()
      registerShortcuts(mainWindow)
      // 主窗隐藏在托盘/后台时永不获焦，registerShortcuts 的聚焦路径不会执行；
      // 全局键（show_app/mini_window）必须在配置落定后无条件补挂，
      // 否则开机自启+托盘常驻场景下快捷助手要等用户手动打开主界面才能呼出
      if (!mainWindow.isFocused()) {
        registerUniversalShortcuts()
      }
    }
  })

  // window
  ipcMain.handle(IpcChannel.Windows_SetMinimumSize, (_, width: number, height: number) => {
    checkMainWindow()
    mainWindow.setMinimumSize(width, height)
  })

  ipcMain.handle(IpcChannel.Windows_ResetMinimumSize, () => {
    checkMainWindow()

    mainWindow.setMinimumSize(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
    const [width, height] = mainWindow.getSize() ?? [MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT]
    if (width < MIN_WINDOW_WIDTH) {
      mainWindow.setSize(MIN_WINDOW_WIDTH, height)
    }
  })

  ipcMain.handle(IpcChannel.Windows_GetSize, () => {
    checkMainWindow()
    const [width, height] = mainWindow.getSize() ?? [MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT]
    return [width, height]
  })

  // Window Controls
  ipcMain.handle(IpcChannel.Windows_Minimize, () => {
    checkMainWindow()
    mainWindow.minimize()
  })

  ipcMain.handle(IpcChannel.Windows_Maximize, () => {
    checkMainWindow()
    mainWindow.maximize()
  })

  ipcMain.handle(IpcChannel.Windows_Unmaximize, () => {
    checkMainWindow()
    mainWindow.unmaximize()
  })

  ipcMain.handle(IpcChannel.Windows_Close, () => {
    checkMainWindow()
    mainWindow.close()
  })

  ipcMain.handle(IpcChannel.Windows_IsMaximized, () => {
    checkMainWindow()
    return mainWindow.isMaximized()
  })

  // Send maximized state changes to renderer：监听器在 registerIpc 入口按窗口记账挂载
  // （wireMainWindowListeners），此处不再重复挂。

  // VertexAI
  // mini window
  ipcMain.handle(IpcChannel.MiniWindow_Hide, () => windowService.hideMiniWindow())
  ipcMain.handle(IpcChannel.MiniWindow_Close, () => windowService.closeMiniWindow())
  ipcMain.handle(IpcChannel.MiniWindow_SetPin, (_, isPinned) => windowService.setPinMiniWindow(isPinned))

  // aes
  ipcMain.handle(IpcChannel.Aes_Decrypt, (_, encryptedData: string, iv: string, secretKey: string) =>
    decrypt(encryptedData, iv, secretKey)
  )

  // nutstore
  ipcMain.handle(IpcChannel.Nutstore_GetSsoUrl, NutstoreService.getNutstoreSSOUrl.bind(NutstoreService))
  ipcMain.handle(IpcChannel.Nutstore_DecryptToken, (_, token: string) => NutstoreService.decryptToken(token))
  ipcMain.handle(IpcChannel.Nutstore_GetDirectoryContents, (_, token: string, path: string) =>
    NutstoreService.getDirectoryContents(token, path)
  )

  // search window
  ipcMain.handle(IpcChannel.SearchWindow_OpenUrl, async (_, uid: string, url: string) => {
    return await searchService.openUrlInSearchWindow(uid, url)
  })
  // 刮取窗口显式关闭（上游 LocalSearchProvider finally 依赖；防按 uid 泄漏）
  ipcMain.handle(IpcChannel.SearchWindow_Close, (_, uid: string) => {
    return searchService.closeSearchWindow(uid)
  })

  // 知识库：薄转发直调 KnowledgeService（不变量1）；嵌入模型引用只含
  // providerId/modelId/dimensions，主进程自解析 apiHost/apiKey（不跨进程回传密钥）。
  ipcMain.handle(IpcChannel.KnowledgeBase_Create, (_, base: { id: string }) => knowledgeService.createBase(base))
  ipcMain.handle(IpcChannel.KnowledgeBase_Reset, (_, baseId: string) => knowledgeService.resetBase(baseId))
  ipcMain.handle(IpcChannel.KnowledgeBase_Delete, (_, baseId: string) => knowledgeService.deleteBase(baseId))
  ipcMain.handle(
    IpcChannel.KnowledgeBase_Add,
    (
      _,
      payload: {
        base: {
          id: string
          chunkSize?: number
          chunkOverlap?: number
          documentCount?: number
          preprocessProviderId?: string
        }
        item:
          | { kind: 'file'; baseId: string; itemId: string; filePath: string }
          | { kind: 'url'; baseId: string; itemId: string; url: string }
          | { kind: 'note'; baseId: string; itemId: string; text: string }
        embedding: { providerId: string; modelId: string; dimensions?: number }
      }
    ) => knowledgeService.addItem(payload.item, payload.base, payload.embedding)
  )
  ipcMain.handle(IpcChannel.KnowledgeBase_Remove, (_, payload: { baseId: string; uniqueIds: string[] }) =>
    knowledgeService.removeItem(payload.baseId, payload.uniqueIds)
  )
  ipcMain.handle(
    IpcChannel.KnowledgeBase_Search,
    (
      _,
      payload: {
        base: { id: string; chunkSize?: number; chunkOverlap?: number; documentCount?: number }
        embedding: { providerId: string; modelId: string; dimensions?: number }
        query: string
      }
    ) => knowledgeService.search(payload.base, payload.embedding, payload.query)
  )

  // 文档处理通道 local-paddle 条目（收编自 LocalModel_*）：下载生命周期薄转发。
  ipcMain.handle(IpcChannel.Preprocess_LocalPaddle_GetStatus, () => localPaddle.getStatus())
  ipcMain.handle(IpcChannel.Preprocess_LocalPaddle_Download, () => localPaddle.download())
  ipcMain.handle(IpcChannel.Preprocess_LocalPaddle_Cancel, () => localPaddle.cancel())
  ipcMain.handle(IpcChannel.Preprocess_LocalPaddle_Remove, () => localPaddle.remove())

  // 技能：薄转发直调 SkillService（磁盘 = 真相源；渲染层切片退为投影）。
  ipcMain.handle(IpcChannel.Skill_InstallFromZip, (_, zipFilePath: string) => skillService.installFromZip(zipFilePath))
  ipcMain.handle(IpcChannel.Skill_InstallFromDirectory, (_, directoryPath: string) =>
    skillService.installFromDirectory(directoryPath)
  )
  ipcMain.handle(IpcChannel.Skill_InstallFromUrl, (_, url: string) => skillService.installFromUrl(url))
  ipcMain.handle(IpcChannel.Skill_Uninstall, (_, folderName: string) => skillService.uninstall(folderName))
  ipcMain.handle(IpcChannel.Skill_List, () => skillService.list())

  // MCP 设置页通道（契约；补注册）：preload 桥、渲染层 mcpApi、MCPService 方法
  // 三层本已齐备，唯独主进程 handler 与日志事件转发缺失——设置页读版本/工具/日志一律报
  // "No handler registered for 'mcp:*'"（日志噪音 + 功能不可用）。服务实例按内核同款动态导入，
  // 避免在 app ready 前就把 MCP 客户端层实例化。
  {
    const { mcpService } = await import('./services/mcp/MCPService')
    const asServer = (value: unknown) => value as MCPServer
    const asOptionalServer = (value: unknown) => value as MCPServer | undefined

    ipcMain.handle(IpcChannel.Mcp_ListTools, (_, server) => mcpService.listTools(asServer(server)))
    ipcMain.handle(IpcChannel.Mcp_ListPrompts, (_, server) => mcpService.listPrompts(asServer(server)))
    ipcMain.handle(IpcChannel.Mcp_ListResources, (_, server) => mcpService.listResources(asServer(server)))
    ipcMain.handle(IpcChannel.Mcp_GetServerVersion, (_, server) => mcpService.getServerVersion(asServer(server)))
    ipcMain.handle(IpcChannel.Mcp_GetServerLogs, (_, server) => mcpService.getServerLogs(asOptionalServer(server)))
    ipcMain.handle(IpcChannel.Mcp_RestartServer, (_, server) => mcpService.restartServer(asServer(server)))
    ipcMain.handle(IpcChannel.Mcp_StopServer, (_, server) => mcpService.stopServer(asServer(server)))
    ipcMain.handle(IpcChannel.Mcp_RemoveServer, (_, server) => mcpService.removeServer(asServer(server)))
    ipcMain.handle(IpcChannel.Mcp_CheckConnectivity, (_, server) => mcpService.checkConnectivity(asServer(server)))
    // MCP 运行时依赖探测（v1）：命令名 → 可执行绝对路径 | null。命令名由
    // findCommandInShellEnv 内的白名单正则校验，非法名返回 null。
    // 注：真正 spawn 的通道（initTransport 的 server.command）
    // 现在也过 normalizeMcpCommand 校验——注入面不只这一处。
    ipcMain.handle(IpcChannel.Mcp_CheckCommand, async (_, command: string) => {
      const { findCommandInShellEnv, getInheritedEnv } = await import('./services/mcp/commandResolution')
      return findCommandInShellEnv(command, getInheritedEnv())
    })

    // DXT 扩展安装（自上游 Mcp_UploadDxt 移植）：上传内容落临时文件后交 DxtService
    // 解包校验。文件名过 basename 防穿越（createTempFile 直接拼接，不可透传原始名字）；
    // 失败如实回 { success:false, error }，不吞错。
    const { default: DxtService } = await import('./services/DxtService')
    const dxtService = new DxtService()
    ipcMain.handle(IpcChannel.Mcp_UploadDxt, async (event, fileBuffer: ArrayBuffer, fileName: string) => {
      try {
        const safeName = path.basename(typeof fileName === 'string' && fileName.length > 0 ? fileName : 'extension.dxt')
        const tempPath = await fileManager.createTempFile(event, safeName)
        await fileManager.writeFile(event, tempPath, Buffer.from(fileBuffer))
        return await dxtService.uploadDxt(tempPath)
      } catch (error) {
        logger.error('DXT upload error:', error as Error)
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to upload DXT file'
        }
      }
    })

    // 服务器日志事件（主 → 渲染）：MCPService 只维护回调注册表，转发由调用方接线。
    // 订阅只接一次；解绑函数登记下来（原来被丢弃，订阅只增不减）。
    // 目标窗口在**发送时**从 windowService 取（而非闭包捕获首次传入的窗口）——主窗可在运行期
    // 重建，被捕获的旧窗口只会让日志静默丢失。
    if (mcpLogUnsubscribe === null) {
      mcpLogUnsubscribe = mcpService.onServerLog((log) => {
        const target = windowService.getMainWindow()
        if (target && !target.isDestroyed()) {
          target.webContents.send(IpcChannel.Mcp_ServerLog, log)
        }
      })
    }
  }

  // webview
  ipcMain.handle(IpcChannel.Webview_SetOpenLinkExternal, (_, webviewId: number, isExternal: boolean) =>
    setOpenLinkExternal(webviewId, isExternal)
  )
  ipcMain.handle(IpcChannel.Webview_SetSpellCheckEnabled, (_, webviewId: number, isEnable: boolean) => {
    const webview = webContents.fromId(webviewId)
    if (!webview) return
    webview.session.setSpellCheckerEnabled(isEnable)
  })

  // Webview print and save handlers
  ipcMain.handle(IpcChannel.Webview_PrintToPDF, async (_, webviewId: number) => {
    const { printWebviewToPDF } = await import('./services/WebviewService')
    return await printWebviewToPDF(webviewId)
  })

  ipcMain.handle(IpcChannel.Webview_SaveAsHTML, async (_, webviewId: number) => {
    const { saveWebviewAsHTML } = await import('./services/WebviewService')
    return await saveWebviewAsHTML(webviewId)
  })

  // store sync
  storeSyncService.registerIpcHandler()

  ipcMain.handle(IpcChannel.App_QuoteToMain, (_, text: string) => windowService.quoteToMainWindow(text))

  ipcMain.handle(IpcChannel.App_SetDisableHardwareAcceleration, (_, isDisable: boolean) => {
    configManager.setDisableHardwareAcceleration(isDisable)
  })
  ipcMain.handle(IpcChannel.App_SetUseSystemTitleBar, (_, isActive: boolean) => {
    configManager.setUseSystemTitleBar(isActive)
  })
  ipcMain.handle(IpcChannel.TRACE_SAVE_DATA, (_, topicId: string) => saveSpans(topicId))
  ipcMain.handle(IpcChannel.TRACE_GET_DATA, (_, topicId: string, traceId: string, modelName?: string) =>
    getSpans(topicId, traceId, modelName)
  )
  ipcMain.handle(IpcChannel.TRACE_SAVE_ENTITY, (_, entity: SpanEntity) => saveEntity(entity))
  ipcMain.handle(IpcChannel.TRACE_BIND_TOPIC, (_, topicId: string, traceId: string) => bindTopic(traceId, topicId))
  ipcMain.handle(IpcChannel.TRACE_CLEAN_TOPIC, (_, topicId: string, traceId?: string) => cleanTopic(topicId, traceId))
  ipcMain.handle(IpcChannel.TRACE_TOKEN_USAGE, (_, spanId: string, usage: TokenUsage) => tokenUsage(spanId, usage))
  ipcMain.handle(IpcChannel.TRACE_CLEAN_HISTORY, (_, topicId: string, traceId: string, modelName?: string) =>
    cleanHistoryTrace(topicId, traceId, modelName)
  )
  ipcMain.handle(
    IpcChannel.TRACE_OPEN_WINDOW,
    (_, topicId: string, traceId: string, autoOpen?: boolean, modelName?: string) =>
      openTraceWindow(topicId, traceId, autoOpen, modelName)
  )
  ipcMain.handle(IpcChannel.TRACE_SET_TITLE, (_, title: string) => setTraceWindowTitle(title))
  ipcMain.handle(IpcChannel.TRACE_ADD_END_MESSAGE, (_, spanId: string, modelName: string, message: string) =>
    addEndMessage(spanId, modelName, message)
  )
  ipcMain.handle(IpcChannel.TRACE_CLEAN_LOCAL_DATA, () => cleanLocalData())
  ipcMain.handle(
    IpcChannel.TRACE_ADD_STREAM_MESSAGE,
    (_, spanId: string, modelName: string, context: string, msg: any) =>
      addStreamMessage(spanId, modelName, context, msg)
  )

  ipcMain.handle(IpcChannel.App_GetDiskInfo, async (_, directoryPath: string) => {
    try {
      const diskSpace = await checkDiskSpace(directoryPath) // { free, size } in bytes
      logger.debug('disk space', diskSpace)
      const { free, size } = diskSpace
      return {
        free,
        size
      }
    } catch (error) {
      logger.error('check disk space error', error as Error)
      return null
    }
  })

  // ExternalApps
  ipcMain.handle(IpcChannel.ExternalApps_DetectInstalled, () => externalAppsService.detectInstalledApps())

  ipcMain.handle(IpcChannel.APP_CrashRenderProcess, () => {
    mainWindow.webContents.forcefullyCrashRenderer()
  })

  // Analytics
  ipcMain.handle(IpcChannel.Analytics_TrackTokenUsage, (_, data: TokenUsageData) =>
    analyticsService.trackTokenUsage(data)
  )

  // 编码助手：受管 DeepSeek Harness Web UI 的生命周期（非内核通道 → 本文件）。
  ipcMain.handle(IpcChannel.CodeCli_DeepseekHarness_Start, (_, input) =>
    deepSeekHarnessService.start(input as Parameters<typeof deepSeekHarnessService.start>[0])
  )
  // 修复：stop 原样透传 void → IPC 回 undefined → 渲染层读 result.success 炸
  // （hermes 侧同位 handler 是 {success} 包裹形状，此处对齐）。
  ipcMain.handle(IpcChannel.CodeCli_DeepseekHarness_Stop, async () => {
    try {
      await deepSeekHarnessService.stop()
      return { success: true as const }
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : 'Failed to stop DeepSeek Harness'
      }
    }
  })
  // 渲染层订阅缝（useCodeCliStatus）的"立即拉当前值"通道（载荷同 Status 广播）。
  ipcMain.handle(IpcChannel.CodeCli_DeepseekHarness_GetStatus, () => deepSeekHarnessService.getStatus())
  // 重置编码助手数据：入参只收一个布尔，路径全部主进程从 paths.ts 派生（渲染层不传路径）。
  ipcMain.handle(IpcChannel.CodeCli_DeepseekHarness_Reset, async (_, input) => {
    const keepSessions = (input as { keepSessions?: unknown } | undefined)?.keepSessions === true
    try {
      await deepSeekHarnessService.resetData(keepSessions)
      return { success: true as const }
    } catch (error) {
      return {
        success: false as const,
        message: error instanceof Error ? error.message : 'Failed to reset DeepSeek Harness data'
      }
    }
  })
  // 启动自愈开关：带 { enabled } 即写并返回生效值；省参即读（默认开）。
  ipcMain.handle(IpcChannel.CodeCli_DeepseekHarness_AutoHeal, async (_, input) => {
    const enabled = (input as { enabled?: unknown } | undefined)?.enabled
    if (typeof enabled !== 'boolean') {
      return { autoHeal: await deepSeekHarnessService.getAutoHealEnabled() }
    }
    return { autoHeal: await deepSeekHarnessService.setAutoHealEnabled(enabled) }
  })

  // 编码助手（收尾）：Hermes Dashboard 生命周期 + code_cli 配置读写。
  // 非内核通道 → 本文件；V2 的 zod 路由层（hermes_dashboard.* / code_cli.*）不搬，
  // start/stop 的 Result 与错误包装逐字照抄 V2 ipc/handlers/hermesDashboard.ts。
  ipcMain.handle(IpcChannel.CodeCli_HermesDashboard_Start, async () => {
    try {
      return await hermesDashboardService.start()
    } catch (error) {
      return {
        success: false,
        reason: 'startup_failed',
        message: redactSecretText(error instanceof Error ? error.message : 'Failed to start Hermes Dashboard')
      }
    }
  })
  ipcMain.handle(IpcChannel.CodeCli_HermesDashboard_Stop, async () => {
    try {
      await hermesDashboardService.stop()
      return { success: true }
    } catch (error) {
      return {
        success: false,
        message: redactSecretText(error instanceof Error ? error.message : 'Failed to stop Hermes Dashboard')
      }
    }
  })
  // 同 DeepseekHarness_GetStatus。
  ipcMain.handle(IpcChannel.CodeCli_HermesDashboard_GetStatus, () => hermesDashboardService.getStatus())
  // Non-ENOENT read errors propagate to the renderer's error model by design.
  // 读通道载荷是 `{ targets: [...] }`（V2 形状，渲染层 cliConfig/file.ts 同形）。
  // 断言搬进 services/codeCli/configPayload.ts（可单测）——此前把它当裸数组断言，渲染层
  // 按 V2 发对象，于是每次读配置都炸在这行，且被渲染层 catch 成"连接态 null"。
  ipcMain.handle(IpcChannel.CodeCli_ReadConfig, async (_, payload: unknown) => {
    return { files: await readCliConfigFiles(parseCliConfigReadInput(payload)) }
  })
  // fork 缝：V2 的写入互斥链是 handler → CodeCliService.writeConfigFiles →（cliTool==='hermes'）
  // HermesDashboardService.writeConfigFiles（operationMutex + 运行态判定）；fork 无 CodeCliService
  // 壳，该分支原样内联在此。入参断言见 services/codeCli/configPayload.ts（V2 zod schema 的手写等价）。
  ipcMain.handle(IpcChannel.CodeCli_WriteConfig, async (_, payload: unknown) => {
    try {
      const { cliTool, files } = parseCliConfigWriteInput(payload)
      if (cliTool === CodeCli.HERMES) {
        await hermesDashboardService.writeConfigFiles(() => writeCliConfigFiles(cliTool, files))
      } else {
        await writeCliConfigFiles(cliTool, files)
      }
      return { success: true as const }
    } catch (error) {
      return { success: false as const, message: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // 编码助手：portable 受管 CLI 安装器（装卸/快照/最新版本）。
  // 结果对象语义（{success}|{removed}）在 BinaryManager 内部完成清洗与日志；入参走
  // 白名单（parseBinaryToolName，见文件尾 parseCliConfig* 同款手写断言风格）。
  ipcMain.handle(IpcChannel.CodeCli_Binary_Install, (_, name: unknown, targetVersion: unknown) => {
    return binaryManager.installTool(parseBinaryToolName(name), parseInstallTargetVersion(targetVersion))
  })
  ipcMain.handle(IpcChannel.CodeCli_Binary_Remove, (_, name: unknown) => {
    return binaryManager.removeTool(parseBinaryToolName(name))
  })
  // 入参改用预设表（原为硬编码 ['dsh','hermes']—— 加入 paper-agent 后这份
  // 字面量就已过期，只因 getToolSnapshots 当前忽略入参才没暴露成真 bug）。
  ipcMain.handle(IpcChannel.CodeCli_Binary_Snapshots, () => binaryManager.getToolSnapshots(BINARY_TOOL_NAMES))
  ipcMain.handle(IpcChannel.CodeCli_Binary_LatestVersions, () => binaryManager.getLatestVersions())
  // 手动检查更新（三个工具页共用；source 型只在此时触 GitHub——纯手动策略）。
  ipcMain.handle(IpcChannel.CodeCli_Binary_CheckUpdates, (_, name: unknown) => {
    return binaryManager.checkUpdates(parseBinaryToolName(name))
  })

  // Paper-Agent（源码型受管工具）Web UI 生命周期。形状照 dsh/hermes 两处：
  // start 直接透传 Result（含 reason 分态），stop 包 {success}，getStatus 供订阅初值。
  ipcMain.handle(IpcChannel.CodeCli_PaperAgent_Start, async () => {
    try {
      return await paperAgentService.start()
    } catch (error) {
      return {
        success: false as const,
        reason: 'startup_failed' as const,
        message: redactSecretText(error instanceof Error ? error.message : 'Failed to start Paper-Agent')
      }
    }
  })
  ipcMain.handle(IpcChannel.CodeCli_PaperAgent_Stop, async () => {
    try {
      await paperAgentService.stop()
      return { success: true as const }
    } catch (error) {
      return {
        success: false as const,
        message: redactSecretText(error instanceof Error ? error.message : 'Failed to stop Paper-Agent')
      }
    }
  })
  ipcMain.handle(IpcChannel.CodeCli_PaperAgent_GetStatus, () => paperAgentService.getStatus())

  // 编码助手：统一网关生命周期 + 配置同步（非内核通道 → 本文件）。
  // 结果对象语义照 V2 @shared/types/apiGateway（ApiGatewayStatusResult /
  // ApiGatewayStopResult）；SyncGatewayConfig 为 {enabled?, port?, host?} 部分更新，
  // 先 ConfigManager 持久化再收敛（V2 #18521 语义，缝注见 ApiGatewayService.syncConfig）。
  ipcMain.handle(IpcChannel.CodeCli_ApiGateway_Start, async () => {
    try {
      await apiGatewayService.start()
      return { success: true as const }
    } catch (error) {
      return {
        success: false as const,
        error: error instanceof Error ? error.message : 'Failed to start API Gateway'
      }
    }
  })
  ipcMain.handle(IpcChannel.CodeCli_ApiGateway_Stop, async () => {
    try {
      const outcome = await apiGatewayService.stop()
      return { success: true as const, outcome }
    } catch (error) {
      return {
        success: false as const,
        error: error instanceof Error ? error.message : 'Failed to stop API Gateway'
      }
    }
  })
  ipcMain.handle(IpcChannel.CodeCli_ApiGateway_Restart, async () => {
    try {
      await apiGatewayService.restart()
      return { success: true as const }
    } catch (error) {
      return {
        success: false as const,
        error: error instanceof Error ? error.message : 'Failed to restart API Gateway'
      }
    }
  })
  ipcMain.handle(IpcChannel.CodeCli_ApiGateway_LanSetEnabled, async (_, enabled: unknown) => {
    try {
      await apiGatewayService.setLanEnabled(parseLanEnabled(enabled))
      return { success: true as const }
    } catch (error) {
      return {
        success: false as const,
        error: error instanceof Error ? error.message : 'Failed to update API Gateway LAN access'
      }
    }
  })
  ipcMain.handle(IpcChannel.CodeCli_SyncGatewayConfig, async (_, payload: unknown) => {
    try {
      await apiGatewayService.syncConfig(parseGatewayConfigPartial(payload))
      return { success: true as const }
    } catch (error) {
      return {
        success: false as const,
        error: error instanceof Error ? error.message : 'Failed to sync API Gateway config'
      }
    }
  })
  // 立即拉当前运行态。fork 缝：publishRunningState 的载荷构造为私有，此处按其
  // 语义（running && config.enabled && config.host === '0.0.0.0'）以公开查询面
  // （isRunning/getCurrentConfig）等价重建；port 为配置端口（运行期即绑定端口）。
  ipcMain.handle(IpcChannel.CodeCli_ApiGateway_GetStatus, () => {
    const running = apiGatewayService.isRunning()
    const config = apiGatewayService.getCurrentConfig()
    const lanRunning = running && config.enabled && config.host === '0.0.0.0'
    return { running, ...(lanRunning ? { lanRunning, port: config.port } : {}) }
  })

  // 网关配置读取——渲染层合成网关 provider（卡片/模型选择）与 hermes 配置草稿
  // （.env 的 CHERRY_HERMES_API_KEY）的数据源。apiKey 只读不生成（V2 语义：网关从未
  // 启动过则为 null；生成发生在 start 流程内）。
  ipcMain.handle(IpcChannel.CodeCli_ApiGateway_GetConfig, () => {
    const config = apiGatewayService.getCurrentConfig()
    return {
      host: config.host,
      port: config.port,
      apiKey: configManager.getApiGatewayApiKey() ?? null,
      running: apiGatewayService.isRunning()
    }
  })
}

// fork 缝：code_cli 配置读写通道的入参断言已抽到 services/codeCli/configPayload.ts
// （V2 zod schema 的手写等价：target 白名单 = CLI_CONFIG_TARGET_IDS、read 去重首现保留、
// write 内容上限 1MB；V2 的 delete 臂 codex-auth 不随裁剪保留）。抽出的理由是**可单测**：
// 载荷形状错配（渲染层发 `{ targets }`、主进程按裸数组断言）此前在类型检查、静态检查、全部
// 单测下全绿，只在真机运行时报 `targets must be an array`，且被渲染层 catch 成"连接态 null"。

// binary install/remove/check-updates 的工具名白名单（来自 shared 预设表：
// 'dsh' | 'hermes' | 'paper-agent'，含源码型工具）。
function parseBinaryToolName(value: unknown): BinaryToolName {
  if (!isBinaryToolName(value)) {
    throw new Error(`Invalid binary tool name: ${String(value)}`)
  }
  return value
}

/**
 * 安装目标版本（可选）——渲染层从"检查更新"结论里带过来，主进程据此钉 spec。
 * 只做形状与长度校验：它是 registry 版本串或短 SHA，不是路径/命令（不进 shell 拼接，
 * 由 cross-spawn 逐参传递）。
 */
function parseInstallTargetVersion(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > 64 || /[\s/\\]/.test(value)) {
    throw new Error(`Invalid binary target version: ${String(value)}`)
  }
  return value
}

// 网关 IPC 入参的手写断言（V2 zod schema 的等价裁剪，风格同 parseCliConfig*）。
function parseLanEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Error('Invalid api_gateway.lan_set_enabled input: enabled must be a boolean')
  }
  return value
}

function parseGatewayConfigPartial(value: unknown): { enabled?: boolean; port?: number; host?: string } {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid sync_gateway_config input')
  }
  const { enabled, port, host } = value as Record<string, unknown>
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new Error('Invalid sync_gateway_config input: enabled must be a boolean')
  }
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('Invalid sync_gateway_config input: port must be an integer in [1, 65535]')
  }
  if (host !== undefined && host !== '127.0.0.1' && host !== '0.0.0.0') {
    throw new Error('Invalid sync_gateway_config input: host must be "127.0.0.1" or "0.0.0.0"')
  }
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(host !== undefined ? { host } : {})
  }
}

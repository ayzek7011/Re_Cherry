import '@renderer/assets/styles/index.css'
import '@renderer/assets/styles/tailwind.css'
import '@ant-design/v5-patch-for-react-19'

import KeyvStorage from '@kangfenmao/keyv-storage'
import { loggerService } from '@logger'
import { initI18n } from '@renderer/i18n'
import FileManager from '@renderer/services/FileManager'
import storeSyncService from '@renderer/services/StoreSyncService'
import { persistor } from '@renderer/store'
import { createRoot } from 'react-dom/client'

import MiniWindowApp from './MiniWindowApp'
import { configureMiniWindowStoreRole } from './miniWindowStoreRole'

loggerService.initWindowSource('MiniWindow')

/**
 * This function is required for model API
 *    eg. BaseProviders.ts
 *  Although the coupling is too strong, we have no choice but to load it
 *  In multi-window handling, decoupling is needed
 */
function initKeyv() {
  window.keyv = new KeyvStorage()
  void window.keyv.init()
}
initKeyv()

// 小窗只读 + 只收（不与主窗口争抢同一个 localStorage persistor）。必须在任何渲染之前执行：
// persistStore 的 rehydrate 是异步的，这里同步 pause 之后本窗口不会有任何回写。
configureMiniWindowStoreRole(persistor, storeSyncService)

// 路径地基（问题2候选1）：mini 窗口此前从不拉 getAppInfo，runtime.filesPath 永远是 ''，
// 小窗里所有图片/文件路径重建全坏。与主窗口共用 FileManager.syncRuntimePaths 单点引导。
void FileManager.syncRuntimePaths()

//subscribe to store sync
storeSyncService.subscribe()

const root = createRoot(document.getElementById('root') as HTMLElement)
// i18n 懒语言包（问题5 #4）：与主窗口一致，首帧渲染等 initI18n 装载完启动语言。
void initI18n().then(() => root.render(<MiniWindowApp />))

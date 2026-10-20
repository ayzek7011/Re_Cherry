import { loggerService } from '@logger'
import store from '@renderer/store'
import { setOpenedKeepAliveMinapps } from '@renderer/store/runtime'
import { setPinnedTabs } from '@renderer/store/settings'
import {
  closeOtherTabs as closeOtherTabsAction,
  HOME_TAB_ID,
  removeTab,
  restorePinnedTabs as restorePinnedTabsAction,
  setActiveTab,
  toggleTabPin
} from '@renderer/store/tabs'
import type { MinAppType } from '@renderer/types'
import { clearWebviewState } from '@renderer/utils/webviewStateManager'
import type { LRUCache } from 'lru-cache'

import NavigationService from './NavigationService'

const logger = loggerService.withContext('TabsService')

/** 固定集合的持久化投影（顺序 = 标签条顺序）。 */
const pinnedProjection = (tabs: { id: string; path: string; isPinned?: boolean }[]): { id: string; path: string }[] =>
  tabs.filter((tab) => tab.isPinned === true).map(({ id, path }) => ({ id, path }))

class TabsService {
  private minAppsCache: LRUCache<string, MinAppType> | null = null

  /**
   * Sets the reference to the mini-apps LRU cache used for managing mini-app lifecycle and cleanup.
   * This method is required to integrate TabsService with the mini-apps cache system, allowing TabsService
   * to perform cache cleanup when tabs associated with mini-apps are closed. The cache instance is typically
   * provided by the mini-app popup system and enables TabsService to maintain cache consistency and prevent
   * stale data.
   * @param cache The LRUCache instance containing mini-app data, provided by useMinappPopup.
   */
  public setMinAppsCache(cache: LRUCache<string, MinAppType>) {
    this.minAppsCache = cache
    logger.debug('Mini-apps cache reference set in TabsService')
  }

  /**
   * 关闭指定的标签页
   * @param tabId 要关闭的标签页ID
   * @returns 是否成功关闭
   */
  public closeTab(tabId: string): boolean {
    // （用户裁决「关闭标签页即停」）：code-mate 受管 Web UI 的标签页关闭时，
    // 对应的受管进程（dsh/hermes dashboard）一并停止。必须在 tab 查找之前做——
    // LRU disposeAfter 触发时标签页可能已不存在（早退会跳过清理）。
    this.stopCodeMateToolIfMinappTab(tabId)

    const state = store.getState()
    const tabs = state.tabs.tabs
    const activeTabId = state.tabs.activeTabId

    const tabToClose = tabs.find((tab) => tab.id === tabId)
    if (!tabToClose) {
      logger.warn(`Tab with id ${tabId} not found`)
      return false
    }

    // 如果只有一个标签页，不允许关闭
    if (tabs.length === 1) {
      logger.warn('Cannot close the last tab')
      return false
    }

    // 如果关闭的是当前激活的标签页，需要切换到其他标签页
    if (tabId === activeTabId) {
      const remainingTabs = tabs.filter((tab) => tab.id !== tabId)
      const lastTab = remainingTabs[remainingTabs.length - 1]

      store.dispatch(setActiveTab(lastTab.id))

      // 使用 NavigationService 导航到新的标签页
      if (NavigationService.navigate) {
        NavigationService.navigate(lastTab.path)
      } else {
        logger.warn('Navigation service not ready, will navigate on next render')
        setTimeout(() => {
          if (NavigationService.navigate) {
            NavigationService.navigate(lastTab.path)
          }
        }, 100)
      }
    }

    // Clean up mini-app cache if this is a mini-app tab
    this.cleanupMinAppCache(tabId)

    // 使用 Redux action 移除标签页
    store.dispatch(removeTab(tabId))
    // 关掉的若是固定标签页，持久化集合要跟着收（否则重启会把它复活）
    this.syncPinnedTabs()

    logger.info(`Tab ${tabId} closed successfully`)
    return true
  }

  /**
   * Clean up mini-app cache and WebView state when tab is closed
   * @param tabId The tab ID to clean up
   */
  private cleanupMinAppCache(tabId: string) {
    // Check if this is a mini-app tab (format: /apps/{appId})
    const tabs = store.getState().tabs.tabs
    const tab = tabs.find((t) => t.id === tabId)

    if (tab && tab.path.startsWith('/apps/')) {
      const appId = tab.path.replace('/apps/', '')

      if (this.minAppsCache && this.minAppsCache.has(appId)) {
        logger.debug(`Cleaning up mini-app cache for app: ${appId}`)

        // Remove from LRU cache - this will trigger disposeAfter callback
        this.minAppsCache.delete(appId)

        // Clear WebView state
        clearWebviewState(appId)

        logger.info(`Mini-app ${appId} removed from cache due to tab closure`)
      }
    }
  }

  /**
   * （用户裁决「关闭标签页即停」）：code-mate 受管 Web UI 的标签页关闭时，
   * 对应的受管进程一并停止（dsh web / hermes dashboard 都是随标签生亡的瞬态服务）。
   * 经 IPC 走主进程服务；stop 对已停服务是幂等空操作。同时把应用从打开集合摘除，
   * 侧栏磁贴与启动台条目随标签关闭一并消失。
   */
  private stopCodeMateToolIfMinappTab(tabId: string): void {
    if (!tabId.startsWith('apps:code-mate-')) return
    const appId = tabId.slice('apps:'.length)
    const codeCli = window.api?.codeCli
    if (!codeCli) return
    const stop =
      appId === 'code-mate-deepseek-harness'
        ? codeCli.deepseekHarness.stop()
        : appId === 'code-mate-hermes'
          ? codeCli.hermesDashboard.stop()
          : appId === 'code-mate-paper-agent'
            ? codeCli.paperAgent.stop()
            : undefined
    if (!stop) return
    logger.info(`code-mate: stopping ${appId} because its tab was closed`)
    void stop.catch((error) => logger.warn(`Failed to stop code-mate tool ${appId} on tab close`, error as Error))
    const opened = store.getState().runtime.openedKeepAliveMinapps
    if (opened.some((item) => item.id === appId)) {
      store.dispatch(setOpenedKeepAliveMinapps(opened.filter((item) => item.id !== appId)))
    }
  }

  /**
   * 固定/取消固定某个标签页（V2 `pinTab`/`unpinTab`：固定区/普通区各自追加到末尾）。
   * @returns 是否成功切换
   */
  public togglePin(tabId: string): boolean {
    const tab = store.getState().tabs.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) {
      logger.warn(`Tab with id ${tabId} not found`)
      return false
    }

    store.dispatch(toggleTabPin(tabId))
    this.syncPinnedTabs()
    return true
  }

  /**
   * 关闭其他标签页：**固定标签页豁免**（V2 同），目标标签页本身保留。
   * 若当前激活的标签页被关掉，则切到目标标签页并导航过去。
   */
  public closeOtherTabs(tabId: string): boolean {
    const state = store.getState()
    const target = state.tabs.tabs.find((tab) => tab.id === tabId)
    if (!target) {
      logger.warn(`Tab with id ${tabId} not found`)
      return false
    }

    // 关页即停链对批量关闭同样生效：reducer 只做集合过滤，不会触发 closeTab 的
    // 停机/清理路径——先对将被移除的每个标签补调（stop 对 code-mate 之外的 id 是
    // 幂等空操作，cleanupMinAppCache 对非 /apps/ 标签同样），再交给 reducer。
    const removed = state.tabs.tabs.filter((tab) => tab.id !== tabId && tab.isPinned !== true && tab.id !== HOME_TAB_ID)
    for (const tab of removed) {
      this.stopCodeMateToolIfMinappTab(tab.id)
      this.cleanupMinAppCache(tab.id)
    }

    store.dispatch(closeOtherTabsAction(tabId))
    this.syncPinnedTabs()

    const nextActiveId = store.getState().tabs.activeTabId
    if (nextActiveId !== state.tabs.activeTabId) {
      const nextActive = store.getState().tabs.tabs.find((tab) => tab.id === nextActiveId)
      if (nextActive && NavigationService.navigate) {
        NavigationService.navigate(nextActive.path)
      }
    }

    logger.info(`Closed other tabs, kept ${tabId}${target.isPinned ? ' (pinned)' : ''}`)
    return true
  }

  /**
   * 把 tabs 切片里的固定集合镜像进**已持久化**的 settings：
   * `tabs` 在 persist `blacklist` 里，固定标签页要跨重启保留只能走这里；值未变则不派发。
   */
  private syncPinnedTabs(): void {
    const pinned = pinnedProjection(store.getState().tabs.tabs)
    const current = store.getState().settings.pinnedTabs ?? []
    const unchanged =
      current.length === pinned.length &&
      current.every((tab, index) => tab.id === pinned[index].id && tab.path === pinned[index].path)
    if (unchanged) return
    store.dispatch(setPinnedTabs(pinned))
  }

  /**
   * 启动恢复：把 settings 里的固定集合补回 tabs 切片（已在清单里的只补 `isPinned`）。
   * 幂等；无记录或无需变化时是空操作。
   */
  public restorePinnedTabs(): void {
    const saved = store.getState().settings.pinnedTabs ?? []
    if (saved.length === 0) return
    store.dispatch(restorePinnedTabsAction(saved))
    logger.info(`Restored ${saved.length} pinned tab(s) from settings`)
  }

  /**
   * 获取所有标签页
   */
  public getTabs() {
    return store.getState().tabs.tabs
  }

  /**
   * 获取当前激活的标签页ID
   */
  public getActiveTabId() {
    return store.getState().tabs.activeTabId
  }

  /**
   * 设置激活的标签页
   * @param tabId 标签页ID
   */
  public setActiveTab(tabId: string): boolean {
    const tabs = store.getState().tabs.tabs
    const tab = tabs.find((t) => t.id === tabId)

    if (!tab) {
      logger.warn(`Tab with id ${tabId} not found`)
      return false
    }

    store.dispatch(setActiveTab(tabId))

    // 导航到对应页面
    if (NavigationService.navigate) {
      NavigationService.navigate(tab.path)
    }

    return true
  }
}

export default new TabsService()

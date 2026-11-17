/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
import { loggerService } from '@logger'
import { nanoid } from '@reduxjs/toolkit'
import {
  DEFAULT_CONTEXTCOUNT,
  DEFAULT_STREAM_OPTIONS_INCLUDE_USAGE,
  DEFAULT_TEMPERATURE,
  isMac
} from '@renderer/config/constant'
import { allMinApps } from '@renderer/config/minapps'
import { isFunctionCallingModel, isNotSupportTextDeltaModel, qwenModel, SYSTEM_MODELS } from '@renderer/config/models'
import { defaultPreprocessProviders } from '@renderer/config/preprocessProviders'
import { SYSTEM_PROVIDERS } from '@renderer/config/providers'
import { DEFAULT_SIDEBAR_ICONS } from '@renderer/config/sidebar'
import { getModel } from '@renderer/hooks/useModel'
import i18n from '@renderer/i18n'
import { DEFAULT_ASSISTANT_SETTINGS } from '@renderer/services/AssistantService'
import type { Assistant, Model, Provider, ProviderApiOptions, WebSearchProvider } from '@renderer/types'
import { isBuiltinMCPServer, isSystemProvider, SystemProviderIds } from '@renderer/types'
import { getDefaultGroupName, getLeadingEmoji, uuid } from '@renderer/utils'
import {
  isSupportArrayContentProvider,
  isSupportDeveloperRoleProvider,
  isSupportStreamOptionsProvider
} from '@renderer/utils/provider'
import { defaultByPassRules } from '@shared/config/constant'
import { isEmpty } from 'lodash-es'
import { createMigrate } from 'redux-persist'

import type { RootState } from '.'
import { DEFAULT_TOOL_ORDER, DEFAULT_TOOL_ORDER_BY_SCOPE } from './inputTools'
import { initialState as llmInitialState, moveProvider } from './llm'
import { initialState as settingsInitialState } from './settings'
import { initialState as shortcutsInitialState } from './shortcuts'
// WebSearch 切片**没有**被删除（只是把执行机制换成内核工具），真正的默认
// provider 表就在 websearch 切片里。此前这里放了一个 `any[] = []` 的空桩，导致下面
// 8 处补种调用（'77'/'96?'/'98?'/'139'/'201'）全部静默 no-op：老用户持久化的
// `websearch.providers` 数组永远缺这些默认条目。方向安全（websearch 切片不 import migrate），
// 与上面 llm/settings/shortcuts 的 initialState 导入同形。
import { defaultWebSearchProviders } from './websearch'

const logger = loggerService.withContext('Migrate')

/**
 * 迁移层纪律（**未闭环，登记在案**）：
 *
 * ## 失败语义（写分支前必须知道的两件事）
 *
 * 1. **失败的分支保留旧 state**：每个分支的 `catch` 只记 error 并 `return state`，
 *    没有 rethrow。所以该次迁移对这份状态**没有生效**。
 * 2. **版本照常推进**：`createMigrate` 不检查返回值。只要 `migrate(state, version)` 正常
 *    resolve，redux-persist 就把 `_persist.version` 写成 `store/index.ts` 的 `version`
 *    （当前 229），而该分支**下次启动不会再跑**。
 *
 * 两条合起来的结论：
 *
 * > **一个分支只运行一次。跑失败 = 这次迁移永久丢失，
 * >  且 `_persist.version` 已推进到最高键，此后无法通过再次启动自愈。**
 *
 * 因此每个分支必须写成「只跑一次也安全」：
 * - 允许失败即返回原 state 的分支只做**加法/幂等改写**（补种缺省项、去重、修字段），
 *   因为下次启动它不再跑；绝不能让「没跑成」在当前进程留下半成品状态。
 * - 不可幂等、必须成功的迁移不要放进这条链（它没有重试机制）。
 * - 失败与「迁移成功但无事可做」只差一条日志，所以**每个 catch 必须带自己的 key**
 *   （`logger.error('migrate <key> error')`），否则事后无法判断哪一支丢失了。
 *
 * ## 为什么不 rethrow
 *
 * `createMigrate` 返回的 Promise 一旦 reject，redux-persist 的 `_rehydrate` 会拒绝，
 * rehydrate 流程中断——对老用户是「启动即丢整份持久化态」，比"丢掉一支迁移"更糟。
 * 在把「迁移失败」升级为「启动失败」之前，需要先给出可回滚的落盘策略（备份 + 明确用户提示），
 * 那是独立一轮的工作。因此本文件把该缺口显式登记，而不是在 catch 里假装成功。
 *
 * ## 本轮计数（复核，可复现：按 `^ '\d+':` 数分支头、按 `catch (` 数 catch）
 *
 * | 项 | before | after |
 * |----|--------|-------|
 * | 迁移分支数 | 213 | 213（未增删） |
 * | 最高键 | `'229'` | `'229'`（= `store/index.ts` 的 `version: 229`） |
 * | `catch` 数 | 204 | 213 |
 * | 带 `logger.error('migrate <key> error')` 面包屑 | 112 | 213（**0 静默**） |
 * | 无 try/catch 的分支（异常直接冒泡 = 中断 rehydrate） | 9（`'34'`/`'44'`/`'45'`/`'46'`/`'51'`/`'65'`/`'111'`/`'137'`/`'152'`） | **0** |
 *
 * 两点取证：
 * 1. `'159'` 的 catch 曾把面包屑写成 `158`（同一日志里出现两次 158），已改为自己的键。
 * 2. 「无保护分支会中断 rehydrate」不是推断：`node_modules/redux-persist/lib/createMigrate.js:39-47`
 *    把 `migrationKeys.reduce(...)`（逐支调用 `migrations[versionKey](state)`）整体包在
 *    `try { … } catch (err) { return Promise.reject(err) }` 里——分支同步抛出 ⇒
 *    `migrate()` 返回 rejected Promise ⇒ `_rehydrate` 拒绝 ⇒ 本次 rehydrate 中断
 *    （老用户启动即丢整份持久化态）。这 9 支已全部补齐 try/catch：失败只记日志并保留旧 state，
 *    与其他 204 支同语义。
 *
 * 已核对、无需硬抛的分支：这 9 支都是「无副作用占位」或「给 settings 补一个标量默认值」
 * （`'45'` 写 `enableTopicNaming`、`'51'` 清 `topicNamingPrompt`），不产生任何后续分支**依赖的
 * 输入形状**。因此它们的失败可以（也应当）吞掉：吞掉的后果最多是某个默认值没补上，远小于
 * 「整份持久化丢失」。没有任何一支需要「失败即中断」。
 *
 * 后续若要真正闭环，必须与 `store/index.ts` 的 `version` 一起改（两者恒等），
 * 例如新增一个 > 229 的「迁移失败对账」键并在 `store/index.ts` 挂失败哨兵。
 */

// remove logo base64 data to reduce the size of the state
function removeMiniAppIconsFromState(state: RootState) {
  if (state.minapps) {
    state.minapps.enabled = state.minapps.enabled.map((app) => ({
      ...app,
      logo: undefined
    }))
    state.minapps.disabled = state.minapps.disabled.map((app) => ({
      ...app,
      logo: undefined
    }))
    state.minapps.pinned = state.minapps.pinned.map((app) => ({
      ...app,
      logo: undefined
    }))
  }
}

function removeMiniAppFromState(state: RootState, id: string) {
  if (state.minapps) {
    state.minapps.pinned = state.minapps.pinned.filter((app) => app.id !== id)
    state.minapps.enabled = state.minapps.enabled.filter((app) => app.id !== id)
    state.minapps.disabled = state.minapps.disabled.filter((app) => app.id !== id)
  }
}

function addMiniApp(state: RootState, id: string) {
  if (state.minapps) {
    const app = allMinApps.find((app) => app.id === id)
    if (app) {
      if (!state.minapps.enabled.find((app) => app.id === id)) {
        // `{ ...app }` 副本是必需的——`allMinApps` 是 `config/minapps.ts` 的模块表，
        // push 同一引用会让持久化状态与配置模板共用元素（同文件 removeMiniAppIconsFromState
        // 早已用 `map((app) => ({ ...app, logo: undefined }))` 克隆，addMiniApp 是漏网的那半）。
        state.minapps.enabled.push({ ...app })
      }
    }
  }
}

/** 把默认表的 provider **克隆**进 state（models 数组与元素一并克隆）。
 *  `SYSTEM_PROVIDERS` / `SYSTEM_PROVIDERS_CONFIG` 的值是 `config/providers.ts` 的模块单例；
 *  同一迁移链里后面的分支会就地改写 provider（`provider.anthropicApiHost = …`、
 *  `provider.type = …`），共享引用会让改写落到模块默认表上，被 `store/llm.ts` 的 initialState
 * 继承（同 ；websearch 侧 addWebSearchProvider 已用 `{ ...provider }`）。 */
function cloneProvider(provider: Provider): Provider {
  return {
    ...provider,
    models: Array.isArray(provider.models) ? provider.models.map((model) => ({ ...model })) : provider.models
  }
}

// add provider to state
function addProvider(state: RootState, id: string) {
  if (!state.llm.providers.find((p) => p.id === id)) {
    const _provider = SYSTEM_PROVIDERS.find((p) => p.id === id)
    if (_provider) {
      state.llm.providers.push(cloneProvider(_provider))
    }
  }
}

// Fix missing provider
function fixMissingProvider(state: RootState) {
  SYSTEM_PROVIDERS.forEach((p) => {
    if (!state.llm.providers.find((provider) => provider.id === p.id)) {
      state.llm.providers.push(cloneProvider(p))
    }
  })
}

function updateProvider(state: RootState, id: string, provider: Partial<Provider>) {
  if (state.llm.providers) {
    const index = state.llm.providers.findIndex((p) => p.id === id)
    if (index !== -1) {
      state.llm.providers[index] = {
        ...state.llm.providers[index],
        ...provider
      }
    }
  }
}

/** 按 id 把默认 websearch provider 补进持久化数组（老用户数组里没有这些条目）。
 *  `{ ...provider }` 副本是必需的：默认表与 `store/websearch.ts` 的 initialState 是同一批对象，
 *  就地 push 同一引用会让 Redux/migrate 的后续就地改写污染模块级默认表。 */
function addWebSearchProvider(state: RootState, id: string) {
  if ((state as any).websearch && (state as any).websearch.providers) {
    if (!(state as any).websearch.providers.find((p) => p.id === id)) {
      const provider = defaultWebSearchProviders.find((p) => p.id === id)
      if (provider) {
        // Prevent mutating read only property of object
        // Otherwise, it will cause the error: Cannot assign to read only property 'apiKey' of object '#<Object>'
        ;(state as any).websearch.providers.push({ ...provider })
      }
    }
  }
}

function updateWebSearchProvider(state: RootState, provider: Partial<WebSearchProvider>) {
  if ((state as any).websearch && (state as any).websearch.providers) {
    const index = (state as any).websearch.providers.findIndex((p) => p.id === provider.id)
    if (index !== -1) {
      ;(state as any).websearch.providers[index] = {
        ...(state as any).websearch.providers[index],
        ...provider
      }
    }
  }
}

/**
 * Add shortcuts(ids from shortcutsInitialState) after the shortcut(afterId)
 * if afterId is 'first', add to the first
 * if afterId is 'last', add to the last
 */
function addShortcuts(state: RootState, ids: string[], afterId: string) {
  const defaultShortcuts = shortcutsInitialState.shortcuts

  // 确保 state.shortcuts 存在
  if (!state.shortcuts) {
    return
  }

  // 从 defaultShortcuts 中找到要添加的快捷键
  const shortcutsToAdd = defaultShortcuts.filter((shortcut) => ids.includes(shortcut.key))

  // 过滤掉已经存在的快捷键
  const existingKeys = state.shortcuts.shortcuts.map((s) => s.key)
  const newShortcuts = shortcutsToAdd.filter((shortcut) => !existingKeys.includes(shortcut.key))

  if (newShortcuts.length === 0) {
    return
  }

  if (afterId === 'first') {
    // 添加到最前面
    state.shortcuts.shortcuts.unshift(...newShortcuts)
  } else if (afterId === 'last') {
    // 添加到最后面
    state.shortcuts.shortcuts.push(...newShortcuts)
  } else {
    // 添加到指定快捷键后面
    const afterIndex = state.shortcuts.shortcuts.findIndex((shortcut) => shortcut.key === afterId)
    if (afterIndex !== -1) {
      state.shortcuts.shortcuts.splice(afterIndex + 1, 0, ...newShortcuts)
    } else {
      // 如果找不到指定的快捷键，则添加到最后
      state.shortcuts.shortcuts.push(...newShortcuts)
    }
  }
}

// add preprocess provider
function addPreprocessProviders(state: RootState, id: string) {
  if ((state as any).preprocess && (state as any).preprocess.providers) {
    if (!(state as any).preprocess.providers.find((p) => p.id === id)) {
      const provider = defaultPreprocessProviders.find((p) => p.id === id)
      if (provider) {
        ;(state as any).preprocess.providers.push({ ...provider })
      }
    }
  }
}

const migrateConfig = {
  '2': (state: RootState) => {
    try {
      addProvider(state, 'yi')
      return state
    } catch (error) {
      logger.error('migrate 2 error', error as Error)
      return state
    }
  },
  '3': (state: RootState) => {
    try {
      addProvider(state, 'zhipu')
      return state
    } catch (error) {
      logger.error('migrate 3 error', error as Error)
      return state
    }
  },
  '4': (state: RootState) => {
    try {
      addProvider(state, 'ollama')
      return state
    } catch (error) {
      logger.error('migrate 4 error', error as Error)
      return state
    }
  },
  '5': (state: RootState) => {
    try {
      addProvider(state, 'moonshot')
      return state
    } catch (error) {
      logger.error('migrate 5 error', error as Error)
      return state
    }
  },
  '6': (state: RootState) => {
    try {
      addProvider(state, 'openrouter')
      return state
    } catch (error) {
      logger.error('migrate 6 error', error as Error)
      return state
    }
  },
  '7': (state: RootState) => {
    try {
      return {
        ...state,
        settings: {
          ...state.settings,
          language: navigator.language
        }
      }
    } catch (error) {
      logger.error('migrate 7 error', error as Error)
      return state
    }
  },
  '8': (state: RootState) => {
    try {
      const fixAssistantName = (assistant: Assistant) => {
        // 2025/07/25 这俩键早没了，从远古版本迁移包出错的
        if (isEmpty(assistant.name)) {
          assistant.name = i18n.t('chat.default.name')
        }

        assistant.topics = assistant.topics.map((topic) => {
          if (isEmpty(topic.name)) {
            topic.name = i18n.t('chat.default.topic.name')
          }
          return topic
        })

        return assistant
      }

      return {
        ...state,
        assistants: {
          ...state.assistants,
          defaultAssistant: fixAssistantName(state.assistants.defaultAssistant),
          assistants: state.assistants.assistants.map((assistant) => fixAssistantName(assistant))
        }
      }
    } catch (error) {
      logger.error('migrate 8 error', error as Error)
      return state
    }
  },
  '9': (state: RootState) => {
    try {
      return {
        ...state,
        llm: {
          ...state.llm,
          providers: state.llm.providers.map((provider) => {
            if (provider.id === 'zhipu' && provider.models[0] && provider.models[0].id === 'llama3-70b-8192') {
              provider.models = SYSTEM_MODELS.zhipu
            }
            return provider
          })
        }
      }
    } catch (error) {
      logger.error('migrate 9 error', error as Error)
      return state
    }
  },
  '10': (state: RootState) => {
    try {
      addProvider(state, 'baichuan')
      return state
    } catch (error) {
      logger.error('migrate 10 error', error as Error)
      return state
    }
  },
  '11': (state: RootState) => {
    try {
      addProvider(state, 'dashscope')
      addProvider(state, 'anthropic')
      return state
    } catch (error) {
      logger.error('migrate 11 error', error as Error)
      return state
    }
  },
  '12': (state: RootState) => {
    try {
      addProvider(state, 'aihubmix')
      return state
    } catch (error) {
      logger.error('migrate 12 error', error as Error)
      return state
    }
  },
  '13': (state: RootState) => {
    try {
      return {
        ...state,
        assistants: {
          ...state.assistants,
          defaultAssistant: {
            ...state.assistants.defaultAssistant,
            name: ['Default Assistant', '默认助手'].includes(state.assistants.defaultAssistant.name)
              ? i18n.t('settings.assistant.label')
              : state.assistants.defaultAssistant.name
          }
        }
      }
    } catch (error) {
      logger.error('migrate 13 error', error as Error)
      return state
    }
  },
  '14': (state: RootState) => {
    try {
      return {
        ...state,
        settings: {
          ...state.settings,
          showAssistants: true,
          proxyUrl: undefined
        }
      }
    } catch (error) {
      logger.error('migrate 14 error', error as Error)
      return state
    }
  },
  '15': (state: RootState) => {
    try {
      return {
        ...state,
        settings: {
          ...state.settings,
          userName: '',
          showMessageDivider: true
        }
      }
    } catch (error) {
      logger.error('migrate 15 error', error as Error)
      return state
    }
  },
  '16': (state: RootState) => {
    try {
      return {
        ...state,
        settings: {
          ...state.settings,
          messageFont: 'system',
          showInputEstimatedTokens: false
        }
      }
    } catch (error) {
      logger.error('migrate 16 error', error as Error)
      return state
    }
  },
  '17': (state: RootState) => {
    try {
      return {
        ...state,
        settings: {
          ...state.settings,
          theme: 'auto'
        }
      }
    } catch (error) {
      logger.error('migrate 17 error', error as Error)
      return state
    }
  },
  '19': (state: RootState) => {
    try {
      return {
        ...state,
        agents: {
          agents: []
        },
        llm: {
          ...state.llm,
          settings: {
            ollama: {
              keepAliveTime: 5
            }
          }
        }
      }
    } catch (error) {
      logger.error('migrate 19 error', error as Error)
      return state
    }
  },
  '20': (state: RootState) => {
    try {
      return {
        ...state,
        settings: {
          ...state.settings,
          fontSize: 14
        }
      }
    } catch (error) {
      logger.error('migrate 20 error', error as Error)
      return state
    }
  },
  '21': (state: RootState) => {
    try {
      addProvider(state, 'gemini')
      addProvider(state, 'stepfun')
      addProvider(state, 'doubao')
      return state
    } catch (error) {
      logger.error('migrate 21 error', error as Error)
      return state
    }
  },
  '22': (state: RootState) => {
    try {
      addProvider(state, 'minimax')
      return state
    } catch (error) {
      logger.error('migrate 22 error', error as Error)
      return state
    }
  },
  '23': (state: RootState) => {
    try {
      return {
        ...state,
        settings: {
          ...state.settings,
          showTopics: true,
          windowStyle: 'transparent'
        }
      }
    } catch (error) {
      logger.error('migrate 23 error', error as Error)
      return state
    }
  },
  '24': (state: RootState) => {
    try {
      return {
        ...state,
        assistants: {
          ...state.assistants,
          assistants: state.assistants.assistants.map((assistant) => ({
            ...assistant,
            topics: assistant.topics.map((topic) => ({
              ...topic,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }))
          }))
        },
        settings: {
          ...state.settings,
          topicPosition: 'right'
        }
      }
    } catch (error) {
      logger.error('migrate 24 error', error as Error)
      return state
    }
  },
  '25': (state: RootState) => {
    try {
      addProvider(state, 'github')
      return state
    } catch (error) {
      logger.error('migrate 25 error', error as Error)
      return state
    }
  },
  '26': (state: RootState) => {
    try {
      addProvider(state, 'ocoolai')
      return state
    } catch (error) {
      logger.error('migrate 26 error', error as Error)
      return state
    }
  },
  '27': (state: RootState) => {
    try {
      return {
        ...state,
        settings: {
          ...state.settings,
          renderInputMessageAsMarkdown: true
        }
      }
    } catch (error) {
      logger.error('migrate 27 error', error as Error)
      return state
    }
  },
  '28': (state: RootState) => {
    try {
      addProvider(state, 'together')
      addProvider(state, 'fireworks')
      addProvider(state, 'zhinao')
      addProvider(state, 'hunyuan')
      addProvider(state, 'nvidia')
      return state
    } catch (error) {
      logger.error('migrate 28 error', error as Error)
      return state
    }
  },
  '29': (state: RootState) => {
    try {
      return {
        ...state,
        assistants: {
          ...state.assistants,
          assistants: state.assistants.assistants.map((assistant) => {
            assistant.topics = assistant.topics.map((topic) => ({
              ...topic,
              assistantId: assistant.id
            }))
            return assistant
          })
        }
      }
    } catch (error) {
      logger.error('migrate 29 error', error as Error)
      return state
    }
  },
  '30': (state: RootState) => {
    try {
      addProvider(state, 'azure-openai')
      return state
    } catch (error) {
      logger.error('migrate 30 error', error as Error)
      return state
    }
  },
  '31': (state: RootState) => {
    try {
      return {
        ...state,
        llm: {
          ...state.llm,
          providers: state.llm.providers.map((provider) => {
            if (provider.id === 'azure-openai') {
              provider.models = provider.models.map((model) => ({
                ...model,
                provider: 'azure-openai'
              }))
            }
            return provider
          })
        }
      }
    } catch (error) {
      logger.error('migrate 31 error', error as Error)
      return state
    }
  },
  '32': (state: RootState) => {
    try {
      addProvider(state, 'hunyuan')
      return state
    } catch (error) {
      logger.error('migrate 32 error', error as Error)
      return state
    }
  },
  '33': (state: RootState) => {
    try {
      state.assistants.defaultAssistant.type = 'assistant'

      return {
        ...state,
        assistants: {
          ...state.assistants,
          assistants: [...state.assistants.assistants].map((assistant) => {
            // @ts-ignore eslint-disable-next-line
            delete assistant.group
            return {
              ...assistant,
              id: assistant.id.length === 36 ? assistant.id : uuid(),
              type: assistant.type === 'system' ? assistant.type : 'assistant'
            }
          })
        }
      }
    } catch (error) {
      logger.error('migrate 33 error', error as Error)
      return state
    }
  },
  '34': (state: RootState) => {
    // Dexie 已废弃 + 旧数据政策：该版本原为旧话题补 assistantId（读写 Dexie），置空保留版本号
    // 补齐：空分支也包 try/catch，让「无保护分支」归零；这里没有失败面，行为逐字不变
    try {
      return state
    } catch (error) {
      logger.error('migrate 34 error', error as Error)
      return state
    }
  },
  '35': (state: RootState) => {
    try {
      state.settings.mathEngine = 'KaTeX'
      return state
    } catch (error) {
      logger.error('migrate 35 error', error as Error)
      return state
    }
  },
  '36': (state: RootState) => {
    try {
      state.settings.topicPosition = 'left'
      return state
    } catch (error) {
      logger.error('migrate 36 error', error as Error)
      return state
    }
  },
  '37': (state: RootState) => {
    try {
      state.settings.messageStyle = 'plain'
      return state
    } catch (error) {
      logger.error('migrate 37 error', error as Error)
      return state
    }
  },
  '38': (state: RootState) => {
    try {
      addProvider(state, 'grok')
      addProvider(state, 'hyperbolic')
      addProvider(state, 'mistral')
      return state
    } catch (error) {
      logger.error('migrate 38 error', error as Error)
      return state
    }
  },
  '39': (state: RootState) => {
    try {
      // @ts-ignore eslint-disable-next-line
      state.settings.codeStyle = 'auto'
      return state
    } catch (error) {
      logger.error('migrate 39 error', error as Error)
      return state
    }
  },
  '40': (state: RootState) => {
    try {
      state.settings.tray = true
      return state
    } catch (error) {
      logger.error('migrate 40 error', error as Error)
      return state
    }
  },
  '41': (state: RootState) => {
    try {
      state.llm.providers.forEach((provider) => {
        if (provider.id === 'gemini') {
          provider.type = 'gemini'
        } else if (provider.id === 'anthropic') {
          provider.type = 'anthropic'
        } else {
          provider.type = 'openai'
        }
      })
      return state
    } catch (error) {
      logger.error('migrate 41 error', error as Error)
      return state
    }
  },
  '42': (state: RootState) => {
    try {
      state.settings.proxyMode = state.settings.proxyUrl ? 'custom' : 'none'
      return state
    } catch (error) {
      logger.error('migrate 42 error', error as Error)
      return state
    }
  },
  '43': (state: RootState) => {
    try {
      if (state.settings.proxyMode === 'none') {
        state.settings.proxyMode = 'system'
      }
      return state
    } catch (error) {
      logger.error('migrate 43 error', error as Error)
      return state
    }
  },
  '44': (state: RootState) => {
    // 补齐：空的占位分支（只保留版本号）。包 try/catch 让「无保护分支」归零，
    // 分支体逐字不变——这里没有失败面。
    try {
      return state
    } catch (error) {
      logger.error('migrate 44 error', error as Error)
      return state
    }
  },
  '45': (state: RootState) => {
    try {
      state.settings.enableTopicNaming = true
      return state
    } catch (error) {
      logger.error('migrate 45 error', error as Error)
      return state
    }
  },
  '46': (state: RootState) => {
    // 补齐：空的占位分支（只保留版本号）。包 try/catch 让「无保护分支」归零，
    // 分支体逐字不变——这里没有失败面。
    try {
      return state
    } catch (error) {
      logger.error('migrate 46 error', error as Error)
      return state
    }
  },
  '47': (state: RootState) => {
    try {
      state.llm.providers.forEach((provider) => {
        provider.models.forEach((model) => {
          model.group = getDefaultGroupName(model.id)
        })
      })
      return state
    } catch (error) {
      logger.error('migrate 47 error', error as Error)
      return state
    }
  },
  '48': (state: RootState) => {
    try {
      if (state.shortcuts) {
        state.shortcuts.shortcuts.forEach((shortcut) => {
          shortcut.system = shortcut.key !== 'new_topic'
        })
        state.shortcuts.shortcuts.push({
          key: 'toggle_show_assistants',
          shortcut: [isMac ? 'Command' : 'Ctrl', '['],
          editable: true,
          enabled: true,
          system: false
        })
        state.shortcuts.shortcuts.push({
          key: 'toggle_show_topics',
          shortcut: [isMac ? 'Command' : 'Ctrl', ']'],
          editable: true,
          enabled: true,
          system: false
        })
      }
      return state
    } catch (error) {
      logger.error('migrate 48 error', error as Error)
      return state
    }
  },
  '49': (state: RootState) => {
    try {
      state.settings.pasteLongTextThreshold = 1500
      if (state.shortcuts) {
        state.shortcuts.shortcuts = [
          ...state.shortcuts.shortcuts,
          {
            key: 'copy_last_message',
            shortcut: [isMac ? 'Command' : 'Ctrl', 'Shift', 'C'],
            editable: true,
            enabled: false,
            system: false
          }
        ]
      }
      return state
    } catch (error) {
      logger.error('migrate 49 error', error as Error)
      return state
    }
  },
  '50': (state: RootState) => {
    try {
      addProvider(state, 'jina')
      return state
    } catch (error) {
      logger.error('migrate 50 error', error as Error)
      return state
    }
  },
  '51': (state: RootState) => {
    try {
      state.settings.topicNamingPrompt = ''
      return state
    } catch (error) {
      logger.error('migrate 51 error', error as Error)
      return state
    }
  },
  '54': (state: RootState) => {
    try {
      if (state.shortcuts) {
        state.shortcuts.shortcuts.push({
          key: 'search_message',
          shortcut: [isMac ? 'Command' : 'Ctrl', 'F'],
          editable: true,
          enabled: true,
          system: false
        })
      }
      state.settings.sidebarIcons = {
        visible: DEFAULT_SIDEBAR_ICONS,
        disabled: []
      }
      return state
    } catch (error) {
      logger.error('migrate 54 error', error as Error)
      return state
    }
  },
  '55': (state: RootState) => {
    try {
      if (!state.settings.sidebarIcons) {
        state.settings.sidebarIcons = {
          visible: DEFAULT_SIDEBAR_ICONS,
          disabled: []
        }
      }
      return state
    } catch (error) {
      logger.error('migrate 55 error', error as Error)
      return state
    }
  },
  '57': (state: RootState) => {
    try {
      if (state.shortcuts) {
        state.shortcuts.shortcuts.push({
          key: 'mini_window',
          shortcut: [isMac ? 'Command' : 'Ctrl', 'E'],
          editable: true,
          enabled: false,
          system: true
        })
      }

      state.llm.providers.forEach((provider) => {
        if (provider.id === 'qwenlm') {
          // @ts-ignore eslint-disable-next-line
          provider.type = 'qwenlm'
        }
      })

      state.settings.enableQuickAssistant = false
      state.settings.clickTrayToShowQuickAssistant = true

      return state
    } catch (error) {
      logger.error('migrate 57 error', error as Error)
      return state
    }
  },
  '58': (state: RootState) => {
    try {
      if (state.shortcuts) {
        state.shortcuts.shortcuts.push(
          {
            key: 'clear_topic',
            shortcut: [isMac ? 'Command' : 'Ctrl', 'L'],
            editable: true,
            enabled: true,
            system: false
          },
          {
            key: 'toggle_new_context',
            shortcut: [isMac ? 'Command' : 'Ctrl', 'R'],
            editable: true,
            enabled: true,
            system: false
          }
        )
      }
      return state
    } catch (error) {
      logger.error('migrate 58 error', error as Error)
      return state
    }
  },
  '59': (state: RootState) => {
    try {
      addMiniApp(state, 'flowith')
      return state
    } catch (error) {
      logger.error('migrate 59 error', error as Error)
      return state
    }
  },
  '60': (state: RootState) => {
    try {
      state.settings.multiModelMessageStyle = 'fold'
      return state
    } catch (error) {
      logger.error('migrate 60 error', error as Error)
      return state
    }
  },
  '61': (state: RootState) => {
    try {
      state.llm.providers.forEach((provider) => {
        if (provider.id === 'qwenlm') {
          // @ts-ignore eslint-disable-next-line
          provider.type = 'qwenlm'
        }
      })
      return state
    } catch (error) {
      logger.error('migrate 61 error', error as Error)
      return state
    }
  },
  '62': (state: RootState) => {
    try {
      state.llm.providers.forEach((provider) => {
        if (provider.id === 'azure-openai') {
          provider.type = 'azure-openai'
        }
      })
      return state
    } catch (error) {
      logger.error('migrate 62 error', error as Error)
      return state
    }
  },
  '63': (state: RootState) => {
    try {
      addMiniApp(state, '3mintop')
      return state
    } catch (error) {
      logger.error('migrate 63 error', error as Error)
      return state
    }
  },
  '64': (state: RootState) => {
    try {
      state.llm.providers = state.llm.providers.filter((provider) => provider.id !== 'qwenlm')
      addProvider(state, 'baidu-cloud')
      return state
    } catch (error) {
      logger.error('migrate 64 error', error as Error)
      return state
    }
  },
  '65': (state: RootState) => {
    // 补齐：空的占位分支（只保留版本号）。包 try/catch 让「无保护分支」归零，
    // 分支体逐字不变——这里没有失败面。
    try {
      return state
    } catch (error) {
      logger.error('migrate 65 error', error as Error)
      return state
    }
  },
  '66': (state: RootState) => {
    try {
      addProvider(state, 'gitee-ai')
      addProvider(state, 'ppio')
      addMiniApp(state, 'aistudio')
      state.llm.providers = state.llm.providers.filter((provider) => provider.id !== 'graphrag-kylin-mountain')

      return state
    } catch (error) {
      logger.error('migrate 66 error', error as Error)
      return state
    }
  },
  '67': (state: RootState) => {
    try {
      addMiniApp(state, 'xiaoyi')
      addProvider(state, 'modelscope')
      addProvider(state, 'lmstudio')
      addProvider(state, 'perplexity')
      addProvider(state, 'infini')
      addProvider(state, 'dmxapi')

      state.llm.settings.lmstudio = {
        keepAliveTime: 5
      }

      return state
    } catch (error) {
      logger.error('migrate 67 error', error as Error)
      return state
    }
  },
  '68': (state: RootState) => {
    try {
      addMiniApp(state, 'notebooklm')
      addProvider(state, 'modelscope')
      addProvider(state, 'lmstudio')
      return state
    } catch (error) {
      logger.error('migrate 68 error', error as Error)
      return state
    }
  },
  '69': (state: RootState) => {
    try {
      addMiniApp(state, 'coze')
      state.settings.gridColumns = 2
      state.settings.gridPopoverTrigger = 'hover'
      return state
    } catch (error) {
      logger.error('migrate 69 error', error as Error)
      return state
    }
  },
  '70': (state: RootState) => {
    try {
      state.llm.providers.forEach((provider) => {
        if (provider.id === 'dmxapi') {
          provider.apiHost = 'https://www.dmxapi.cn'
        }
      })
      return state
    } catch (error) {
      logger.error('migrate 70 error', error as Error)
      return state
    }
  },
  '71': (state: RootState) => {
    try {
      const appIds = ['dify', 'wpslingxi', 'lechat', 'abacus', 'lambdachat', 'baidu-ai-search']

      if (state.minapps) {
        appIds.forEach((id) => {
          const app = allMinApps.find((app) => app.id === id)
          if (app) {
            // 同类：不 push `config/minapps` 的模块对象（addMiniApp 已改克隆，此处同步）。
            state.minapps.enabled.push({ ...app })
          }
        })
        // remove zhihu-zhiada
        state.minapps.enabled = state.minapps.enabled.filter((app) => app.id !== 'zhihu-zhiada')
        state.minapps.disabled = state.minapps.disabled.filter((app) => app.id !== 'zhihu-zhiada')
      }

      state.settings.thoughtAutoCollapse = true

      return state
    } catch (error) {
      logger.error('migrate 71 error', error as Error)
      return state
    }
  },
  '72': (state: RootState) => {
    try {
      addMiniApp(state, 'monica')

      // remove duplicate lmstudio providers
      const emptyLmStudioProviderIndex = state.llm.providers.findLastIndex(
        (provider) => provider.id === 'lmstudio' && provider.models.length === 0
      )

      if (emptyLmStudioProviderIndex !== -1) {
        state.llm.providers.splice(emptyLmStudioProviderIndex, 1)
      }

      return state
    } catch (error) {
      logger.error('migrate 72 error', error as Error)
      return state
    }
  },
  '73': (state: RootState) => {
    try {
      const ws73 = (state as any).websearch
      if (ws73) {
        ws73.searchWithTime = true
        ws73.maxResults = 5
        ws73.excludeDomains = []
      }

      addProvider(state, 'lmstudio')
      addProvider(state, 'o3')
      state.llm.providers = moveProvider(state.llm.providers, 'o3', 2)

      state.assistants.assistants.forEach((assistant) => {
        const leadingEmoji = getLeadingEmoji(assistant.name)
        if (leadingEmoji) {
          assistant.emoji = leadingEmoji
          assistant.name = assistant.name.replace(leadingEmoji, '').trim()
        }
      })

      const defaultAssistantEmoji = getLeadingEmoji(state.assistants.defaultAssistant.name)

      if (defaultAssistantEmoji) {
        state.assistants.defaultAssistant.emoji = defaultAssistantEmoji
        state.assistants.defaultAssistant.name = state.assistants.defaultAssistant.name
          .replace(defaultAssistantEmoji, '')
          .trim()
      }

      return state
    } catch (error) {
      logger.error('migrate 73 error', error as Error)
      return state
    }
  },
  '74': (state: RootState) => {
    try {
      addProvider(state, 'xirang')
      return state
    } catch (error) {
      logger.error('migrate 74 error', error as Error)
      return state
    }
  },
  '75': (state: RootState) => {
    try {
      addMiniApp(state, 'you')
      addMiniApp(state, 'cici')
      addMiniApp(state, 'zhihu')
      return state
    } catch (error) {
      logger.error('migrate 75 error', error as Error)
      return state
    }
  },
  '76': (state: RootState) => {
    try {
      addProvider(state, 'tencent-cloud-ti')
      return state
    } catch (error) {
      logger.error('migrate 76 error', error as Error)
      return state
    }
  },
  '77': (state: RootState) => {
    try {
      addWebSearchProvider(state, 'searxng')
      addWebSearchProvider(state, 'exa')
      if ((state as any).websearch) {
        ;(state as any).websearch.providers.forEach((p) => {
          // @ts-ignore eslint-disable-next-line
          delete p.enabled
        })
      }
      return state
    } catch (error) {
      logger.error('migrate 77 error', error as Error)
      return state
    }
  },
  '78': (state: RootState) => {
    try {
      state.llm.providers = moveProvider(state.llm.providers, 'ppio', 9)
      state.llm.providers = moveProvider(state.llm.providers, 'infini', 10)
      removeMiniAppIconsFromState(state)
      return state
    } catch (error) {
      logger.error('migrate 78 error', error as Error)
      return state
    }
  },
  '79': (state: RootState) => {
    try {
      addProvider(state, 'gpustack')
      return state
    } catch (error) {
      logger.error('migrate 79 error', error as Error)
      return state
    }
  },
  '80': (state: RootState) => {
    try {
      addProvider(state, 'alayanew')
      state.llm.providers = moveProvider(state.llm.providers, 'alayanew', 10)
      return state
    } catch (error) {
      logger.error('migrate 80 error', error as Error)
      return state
    }
  },
  '81': (state: RootState) => {
    try {
      addProvider(state, 'copilot')
      return state
    } catch (error) {
      logger.error('migrate 81 error', error as Error)
      return state
    }
  },
  '82': (state: RootState) => {
    try {
      const runtimeState = state.runtime as any
      if (runtimeState?.webdavSync) {
        state.backup = state.backup || {}
        state.backup = {
          ...state.backup,
          webdavSync: {
            lastSyncTime: runtimeState.webdavSync.lastSyncTime || null,
            syncing: runtimeState.webdavSync.syncing || false,
            lastSyncError: runtimeState.webdavSync.lastSyncError || null
          }
        }
        delete runtimeState.webdavSync
      }
      return state
    } catch (error) {
      logger.error('migrate 82 error', error as Error)
      return state
    }
  },
  '83': (state: RootState) => {
    try {
      state.settings.messageNavigation = 'buttons'
      state.settings.launchOnBoot = false
      state.settings.launchToTray = false
      state.settings.trayOnClose = true
      return state
    } catch (error) {
      logger.error('migrate 83 error', error as Error)
      return state
    }
  },
  '84': (state: RootState) => {
    try {
      addProvider(state, 'voyageai')
      return state
    } catch (error) {
      logger.error('migrate 84 error', error as Error)
      return state
    }
  },
  '85': (state: RootState) => {
    try {
      // @ts-ignore eslint-disable-next-line
      state.settings.autoCheckUpdate = !state.settings.manualUpdateCheck
      // @ts-ignore eslint-disable-next-line
      delete state.settings.manualUpdateCheck
      state.settings.gridPopoverTrigger = 'click'
      return state
    } catch (error) {
      logger.error('migrate 85 error', error as Error)
      return state
    }
  },
  '86': (state: RootState) => {
    try {
      if ((state as any).mcp?.servers) {
        ;(state as any).mcp.servers = (state as any).mcp.servers.map((server) => ({
          ...server,
          id: nanoid()
        }))
      }
    } catch (error) {
      logger.error('migrate 86 error', error as Error)
      return state
    }
    return state
  },
  '87': (state: RootState) => {
    try {
      state.settings.maxKeepAliveMinapps = 3
      state.settings.showOpenedMinappsInSidebar = true
      return state
    } catch (error) {
      logger.error('migrate 87 error', error as Error)
      return state
    }
  },
  '88': (state: RootState) => {
    try {
      // MCP subsystem removed; migration '88' is a no-op.
      void (state as any)
      return state
    } catch (error) {
      logger.error('migrate 88 error', error as Error)
      return state
    }
  },
  '89': (state: RootState) => {
    try {
      removeMiniAppFromState(state, 'aistudio')
      return state
    } catch (error) {
      logger.error('migrate 89 error', error as Error)
      return state
    }
  },
  '90': (state: RootState) => {
    try {
      state.settings.enableDataCollection = true
      return state
    } catch (error) {
      logger.error('migrate 90 error', error as Error)
      return state
    }
  },
  '91': (state: RootState) => {
    try {
      // @ts-ignore eslint-disable-next-line
      state.settings.codeCacheable = false
      // @ts-ignore eslint-disable-next-line
      state.settings.codeCacheMaxSize = 1000
      // @ts-ignore eslint-disable-next-line
      state.settings.codeCacheTTL = 15
      // @ts-ignore eslint-disable-next-line
      state.settings.codeCacheThreshold = 2
      addProvider(state, 'qiniu')
      return state
    } catch (error) {
      logger.error('migrate 91 error', error as Error)
      return state
    }
  },
  '92': (state: RootState) => {
    try {
      addMiniApp(state, 'dangbei')
      state.llm.providers = moveProvider(state.llm.providers, 'qiniu', 12)
      return state
    } catch (error) {
      logger.error('migrate 92 error', error as Error)
      return state
    }
  },
  '93': (state: RootState) => {
    try {
      if (!state?.settings?.exportMenuOptions) {
        state.settings.exportMenuOptions = settingsInitialState.exportMenuOptions
        return state
      }
      return state
    } catch (error) {
      logger.error('migrate 93 error', error as Error)
      return state
    }
  },
  '94': (state: RootState) => {
    try {
      state.settings.enableQuickPanelTriggers = false
      return state
    } catch (error) {
      logger.error('migrate 94 error', error as Error)
      return state
    }
  },
  '95': (state: RootState) => {
    try {
      addWebSearchProvider(state, 'local-google')
      addWebSearchProvider(state, 'local-bing')
      addWebSearchProvider(state, 'local-baidu')

      if ((state as any).websearch) {
        if (isEmpty((state as any).websearch.subscribeSources)) {
          ;(state as any).websearch.subscribeSources = []
        }
      }

      const qiniuProvider = state.llm.providers.find((provider) => provider.id === 'qiniu')
      if (qiniuProvider && isEmpty(qiniuProvider.models)) {
        qiniuProvider.models = SYSTEM_MODELS.qiniu
      }
      return state
    } catch (error) {
      logger.error('migrate 95 error', error as Error)
      return state
    }
  },
  '96': (state: RootState) => {
    try {
      // 全局 assistantIconType（模型图标/emoji/不显示三挡）已移除，改由助手级设置与标识单路径；
      // 这里只清理更早的 showAssistantIcon 旧字段。
      // @ts-ignore eslint-disable-next-line
      delete state.settings.showAssistantIcon
      return state
    } catch (error) {
      logger.error('migrate 96 error', error as Error)
      return state
    }
  },
  '97': (state: RootState) => {
    try {
      addMiniApp(state, 'zai')
      state.settings.webdavMaxBackups = 0
      if ((state as any).websearch && (state as any).websearch.providers) {
        ;(state as any).websearch.providers.forEach((provider) => {
          provider.basicAuthUsername = ''
          provider.basicAuthPassword = ''
        })
      }
      return state
    } catch (error) {
      logger.error('migrate 97 error', error as Error)
      return state
    }
  },
  '98': (state: RootState) => {
    try {
      state.llm.providers.forEach((provider) => {
        if (provider.type === 'openai' && provider.id !== 'openai') {
          // @ts-ignore eslint-disable-next-line
          provider.type = 'openai-compatible'
        }
      })
      return state
    } catch (error) {
      logger.error('migrate 98 error', error as Error)
      return state
    }
  },
  '99': (state: RootState) => {
    try {
      state.settings.showPrompt = true

      addWebSearchProvider(state, 'bocha')

      updateWebSearchProvider(state, {
        id: 'exa',
        apiHost: 'https://api.exa.ai'
      })

      updateWebSearchProvider(state, {
        id: 'tavily',
        apiHost: 'https://api.tavily.com'
      })

      // Remove basic auth fields from exa and tavily
      if ((state as any).websearch?.providers) {
        ;(state as any).websearch.providers = (state as any).websearch.providers.map((provider) => {
          if (provider.id === 'exa' || provider.id === 'tavily') {
            // oxlint-disable-next-line @typescript-eslint/no-unused-vars
            const { basicAuthUsername, basicAuthPassword, ...rest } = provider
            return rest
          }
          return provider
        })
      }
      return state
    } catch (error) {
      logger.error('migrate 99 error', error as Error)
      return state
    }
  },
  '100': (state: RootState) => {
    try {
      state.llm.providers.forEach((provider) => {
        // @ts-ignore eslint-disable-next-line
        if (['openai-compatible', 'openai'].includes(provider.type)) {
          provider.type = 'openai'
        }
        if (provider.id === 'openai') {
          provider.type = 'openai-response'
        }
      })
      state.assistants.assistants.forEach((assistant) => {
        assistant.knowledgeRecognition = 'off'
      })
      return state
    } catch (error) {
      logger.error('migrate 100 error', error as Error)
      return state
    }
  },
  '101': (state: RootState) => {
    try {
      state.assistants.assistants.forEach((assistant) => {
        if (assistant.settings) {
          // @ts-ignore eslint-disable-next-line
          if (assistant.settings.enableToolUse) {
            // @ts-ignore eslint-disable-next-line
            assistant.settings.toolUseMode = assistant.settings.enableToolUse ? 'function' : 'prompt'
            // @ts-ignore eslint-disable-next-line
            delete assistant.settings.enableToolUse
          }
        }
      })
      if (state.shortcuts) {
        state.shortcuts.shortcuts.push({
          key: 'exit_fullscreen',
          shortcut: ['Escape'],
          editable: false,
          enabled: true,
          system: true
        })
      }
      return state
    } catch (error) {
      logger.error('migrate 101 error', error as Error)
      return state
    }
  },
  '102': (state: RootState) => {
    try {
      state.settings.openAI = {
        // @ts-expect-error it's a removed type. migrated on 177
        summaryText: 'off',
        serviceTier: 'auto',
        verbosity: 'medium'
      }

      state.settings.codeExecution = {
        enabled: false,
        timeoutMinutes: 1
      }
      state.settings.codeEditor = {
        enabled: false,
        themeLight: 'auto',
        themeDark: 'auto',
        highlightActiveLine: false,
        foldGutter: false,
        autocompletion: true,
        keymap: false
      }
      // @ts-ignore eslint-disable-next-line
      state.settings.codePreview = {
        themeLight: 'auto',
        themeDark: 'auto'
      }

      // @ts-ignore eslint-disable-next-line
      if (state.settings.codeStyle) {
        // @ts-ignore eslint-disable-next-line
        state.settings.codePreview.themeLight = state.settings.codeStyle
        // @ts-ignore eslint-disable-next-line
        state.settings.codePreview.themeDark = state.settings.codeStyle
      }

      // @ts-ignore eslint-disable-next-line
      delete state.settings.codeStyle
      // @ts-ignore eslint-disable-next-line
      delete state.settings.codeCacheable
      // @ts-ignore eslint-disable-next-line
      delete state.settings.codeCacheMaxSize
      // @ts-ignore eslint-disable-next-line
      delete state.settings.codeCacheTTL
      // @ts-ignore eslint-disable-next-line
      delete state.settings.codeCacheThreshold
      return state
    } catch (error) {
      logger.error('migrate 102 error', error as Error)
      return state
    }
  },
  '103': (state: RootState) => {
    try {
      if (state.shortcuts) {
        if (!state.shortcuts.shortcuts.find((shortcut) => shortcut.key === 'search_message_in_chat')) {
          state.shortcuts.shortcuts.push({
            key: 'search_message_in_chat',
            shortcut: [isMac ? 'Command' : 'Ctrl', 'F'],
            editable: true,
            enabled: true,
            system: false
          })
        }
        const searchMessageShortcut = state.shortcuts.shortcuts.find((shortcut) => shortcut.key === 'search_message')
        const targetShortcut = [isMac ? 'Command' : 'Ctrl', 'F']
        if (
          searchMessageShortcut &&
          Array.isArray(searchMessageShortcut.shortcut) &&
          searchMessageShortcut.shortcut.length === targetShortcut.length &&
          searchMessageShortcut.shortcut.every((v, i) => v === targetShortcut[i])
        ) {
          searchMessageShortcut.shortcut = [isMac ? 'Command' : 'Ctrl', 'Shift', 'F']
        }
      }
      return state
    } catch (error) {
      logger.error('migrate 103 error', error as Error)
      return state
    }
  },
  '104': (state: RootState) => {
    try {
      addProvider(state, 'burncloud')
      state.llm.providers = moveProvider(state.llm.providers, 'burncloud', 10)
      return state
    } catch (error) {
      logger.error('migrate 104 error', error as Error)
      return state
    }
  },
  '105': (state: RootState) => {
    try {
      state.settings.notification = settingsInitialState.notification
      addMiniApp(state, 'google')
      if (!state.settings.openAI) {
        state.settings.openAI = {
          // @ts-expect-error it's a removed type. migrated on 177
          summaryText: 'off',
          serviceTier: 'auto',
          verbosity: 'medium'
        }
      }
      return state
    } catch (error) {
      logger.error('migrate 105 error', error as Error)
      return state
    }
  },
  '106': (state: RootState) => {
    try {
      addProvider(state, 'tokenflux')
      state.llm.providers = moveProvider(state.llm.providers, 'tokenflux', 15)
      return state
    } catch (error) {
      logger.error('migrate 106 error', error as Error)
      return state
    }
  },
  '108': (state: RootState) => {
    try {
      // @ts-ignore
      state.inputTools.toolOrder = DEFAULT_TOOL_ORDER
      state.inputTools.isCollapsed = false
      return state
    } catch (error) {
      logger.error('migrate 108 error', error as Error)
      return state
    }
  },
  '109': (state: RootState) => {
    try {
      state.settings.userTheme = settingsInitialState.userTheme
      return state
    } catch (error) {
      logger.error('migrate 109 error', error as Error)
      return state
    }
  },
  '110': (state: RootState) => {
    try {
      // settings.testPlan 随“测试计划/Beta 通道”功能移除，不再写入历史默认值
      return state
    } catch (error) {
      logger.error('migrate 110 error', error as Error)
      return state
    }
  },
  '111': (state: RootState) => {
    // 补齐：空的占位分支（只保留版本号）。包 try/catch 让「无保护分支」归零，
    // 分支体逐字不变——这里没有失败面。
    try {
      return state
    } catch (error) {
      logger.error('migrate 111 error', error as Error)
      return state
    }
  },
  '112': (state: RootState) => {
    try {
      addProvider(state, 'cephalon')
      addProvider(state, '302ai')
      addProvider(state, 'lanyun')
      state.llm.providers = moveProvider(state.llm.providers, 'cephalon', 13)
      state.llm.providers = moveProvider(state.llm.providers, '302ai', 14)
      state.llm.providers = moveProvider(state.llm.providers, 'lanyun', 15)
      return state
    } catch (error) {
      logger.error('migrate 112 error', error as Error)
      return state
    }
  },
  '113': (state: RootState) => {
    try {
      addProvider(state, 'vertexai')
      if (!state.llm.settings.vertexai) {
        state.llm.settings.vertexai = llmInitialState.settings.vertexai
      }
      updateProvider(state, 'gemini', {
        isVertex: false
      })
      updateProvider(state, 'vertexai', {
        isVertex: true
      })
      return state
    } catch (error) {
      logger.error('migrate 113 error', error as Error)
      return state
    }
  },
  '114': (state: RootState) => {
    try {
      if (state.settings && state.settings.exportMenuOptions) {
        if (typeof state.settings.exportMenuOptions.plain_text === 'undefined') {
          state.settings.exportMenuOptions.plain_text = true
        }
      }
      if (state.settings) {
        state.settings.enableSpellCheck = false
        state.settings.spellCheckLanguages = []
      }
      return state
    } catch (error) {
      logger.error('migrate 114 error', error as Error)
      return state
    }
  },
  '115': (state: RootState) => {
    try {
      state.assistants.assistants.forEach((assistant) => {
        if (!assistant.settings) {
          assistant.settings = {
            temperature: DEFAULT_TEMPERATURE,
            contextCount: DEFAULT_CONTEXTCOUNT,
            topP: 1,
            toolUseMode: 'prompt',
            customParameters: [],
            streamOutput: true,
            enableMaxTokens: false
          }
        }
      })
      return state
    } catch (error) {
      logger.error('migrate 115 error', error as Error)
      return state
    }
  },
  '116': (state: RootState) => {
    try {
      if ((state as any).websearch) {
        // migrate contentLimit to cutoffLimit
        // @ts-ignore eslint-disable-next-line
        if ((state as any).websearch.contentLimit) {
          ;(state as any).websearch.compressionConfig = {
            method: 'cutoff',
            cutoffUnit: 'char',
            // @ts-ignore eslint-disable-next-line
            cutoffLimit: (state as any).websearch.contentLimit
          }
        } else {
          ;(state as any).websearch.compressionConfig = {
            method: 'none',
            cutoffUnit: 'char'
          }
        }

        // @ts-ignore eslint-disable-next-line
        delete (state as any).websearch.contentLimit
      }
      // settings.testChannel 随测试通道功能移除，不再写入历史默认值

      return state
    } catch (error) {
      logger.error('migrate 116 error', error as Error)
      return state
    }
  },
  '117': (state: RootState) => {
    try {
      const ppioProvider = state.llm.providers.find((provider) => provider.id === 'ppio')
      const modelsToRemove = [
        'qwen/qwen-2.5-72b-instruct',
        'qwen/qwen2.5-32b-instruct',
        'meta-llama/llama-3.1-70b-instruct',
        'meta-llama/llama-3.1-8b-instruct',
        '01-ai/yi-1.5-34b-chat',
        '01-ai/yi-1.5-9b-chat',
        'thudm/glm-z1-32b-0414',
        'thudm/glm-z1-9b-0414'
      ]
      if (ppioProvider) {
        updateProvider(state, 'ppio', {
          models: [
            ...ppioProvider.models.filter((model) => !modelsToRemove.includes(model.id)),
            ...SYSTEM_MODELS.ppio.filter(
              (systemModel) => !ppioProvider.models.some((existingModel) => existingModel.id === systemModel.id)
            )
          ],
          apiHost: 'https://api.ppinfra.com/v3/openai/'
        })
      }
      state.assistants.assistants.forEach((assistant) => {
        if (assistant.settings && assistant.settings.streamOutput === undefined) {
          assistant.settings = {
            ...assistant.settings,
            streamOutput: true
          }
        }
      })
      return state
    } catch (error) {
      logger.error('migrate 117 error', error as Error)
      return state
    }
  },
  '118': (state: RootState) => {
    try {
      addProvider(state, 'ph8')
      state.llm.providers = moveProvider(state.llm.providers, 'ph8', 14)

      if (!state.settings.userId) {
        state.settings.userId = uuid()
      }

      state.llm.providers.forEach((provider) => {
        if (provider.id === 'mistral') {
          provider.type = 'mistral'
        }
      })

      return state
    } catch (error) {
      logger.error('migrate 118 error', error as Error)
      return state
    }
  },
  '119': (state: RootState) => {
    try {
      addProvider(state, 'new-api')
      state.llm.providers = moveProvider(state.llm.providers, 'new-api', 16)
      state.settings.disableHardwareAcceleration = false
      // migrate to enable memory feature on sidebar
      if (state.settings && state.settings.sidebarIcons) {
        // Check if 'memory' is not already in visible icons
        if (!state.settings.sidebarIcons.visible.includes('memory' as any)) {
          state.settings.sidebarIcons.visible = [...state.settings.sidebarIcons.visible, 'memory' as any]
        }
      }
      return state
    } catch (error) {
      logger.error('migrate 119 error', error as Error)
      return state
    }
  },
  '120': (state: RootState) => {
    try {
      // migrate to remove memory feature from sidebar (moved to settings)
      if (state.settings && state.settings.sidebarIcons) {
        // Remove 'memory' from visible icons if present
        state.settings.sidebarIcons.visible = state.settings.sidebarIcons.visible.filter(
          (icon) => icon !== ('memory' as any)
        )
        // Remove 'memory' from disabled icons if present
        state.settings.sidebarIcons.disabled = state.settings.sidebarIcons.disabled.filter(
          (icon) => icon !== ('memory' as any)
        )
      }

      if (!state.settings.s3) {
        state.settings.s3 = settingsInitialState.s3
      }

      state.llm.providers.forEach((provider) => {
        if (provider.id === 'azure-openai') {
          provider.type = 'azure-openai'
        }
      })

      state.settings.localBackupMaxBackups = 0
      state.settings.localBackupSkipBackupFile = false
      state.settings.localBackupDir = ''
      state.settings.localBackupAutoSync = false
      state.settings.localBackupSyncInterval = 0
      return state
    } catch (error) {
      logger.error('migrate 120 error', error as Error)
      return state
    }
  },
  '121': (state: RootState) => {
    try {
      const { toolOrder } = state.inputTools
      const urlContextKey = 'url_context'
      // @ts-ignore
      if (!toolOrder.visible.includes(urlContextKey)) {
        // @ts-ignore
        const webSearchIndex = toolOrder.visible.indexOf('web_search')
        // @ts-ignore
        const knowledgeBaseIndex = toolOrder.visible.indexOf('knowledge_base')
        if (webSearchIndex !== -1) {
          // @ts-ignore
          toolOrder.visible.splice(webSearchIndex, 0, urlContextKey)
        } else if (knowledgeBaseIndex !== -1) {
          // @ts-ignore
          toolOrder.visible.splice(knowledgeBaseIndex, 0, urlContextKey)
        } else {
          // @ts-ignore
          toolOrder.visible.push(urlContextKey)
        }
      }

      for (const assistant of state.assistants.assistants) {
        if (assistant.settings?.toolUseMode === 'prompt' && isFunctionCallingModel(assistant.model)) {
          assistant.settings.toolUseMode = 'function'
        }
      }

      if (state.settings && typeof state.settings.webdavDisableStream === 'undefined') {
        state.settings.webdavDisableStream = false
      }

      return state
    } catch (error) {
      logger.error('migrate 121 error', error as Error)
      return state
    }
  },
  '122': (state: RootState) => {
    try {
      state.settings.navbarPosition = 'left'
      return state
    } catch (error) {
      logger.error('migrate 122 error', error as Error)
      return state
    }
  },

  '123': (state: RootState) => {
    try {
      state.llm.providers.forEach((provider) => {
        provider.models.forEach((model) => {
          if (model.type && Array.isArray(model.type)) {
            model.capabilities = model.type.map((t) => ({
              type: t,
              isUserSelected: true
            }))
            delete model.type
          }
        })
      })

      const lanyunProvider = state.llm.providers.find((provider) => provider.id === 'lanyun')
      if (lanyunProvider && lanyunProvider.models.length === 0) {
        updateProvider(state, 'lanyun', { models: SYSTEM_MODELS.lanyun })
      }

      return state
    } catch (error) {
      logger.error('migrate 123 error', error as Error)
      return state
    }
  }, // 1.5.4
  '124': (state: RootState) => {
    try {
      state.assistants.assistants.forEach((assistant) => {
        if (assistant.settings && !assistant.settings.toolUseMode) {
          assistant.settings.toolUseMode = 'prompt'
        }
      })

      const updateModelTextDelta = (model?: Model) => {
        if (model) {
          model.supported_text_delta = true
          if (isNotSupportTextDeltaModel(model)) {
            model.supported_text_delta = false
          }
        }
      }

      state.llm.providers.forEach((provider) => {
        provider.models.forEach((model) => {
          updateModelTextDelta(model)
        })
      })
      state.assistants.assistants.forEach((assistant) => {
        updateModelTextDelta(assistant.defaultModel)
        updateModelTextDelta(assistant.model)
      })

      updateModelTextDelta(state.llm.defaultModel)
      updateModelTextDelta(state.llm.topicNamingModel)

      if (state.assistants.defaultAssistant.model) {
        updateModelTextDelta(state.assistants.defaultAssistant.model)
        updateModelTextDelta(state.assistants.defaultAssistant.defaultModel)
      }

      addProvider(state, 'aws-bedrock')

      // llm.settings.awsBedrock 随 aws-bedrock provider 移除，不再写入历史默认值

      return state
    } catch (error) {
      logger.error('migrate 124 error', error as Error)
      return state
    }
  },
  '125': (state: RootState) => {
    try {
      // settings.apiServer 随 apiServer 后端移除，不再写入历史默认值
      return state
    } catch (error) {
      logger.error('migrate 125 error', error as Error)
      return state
    }
  },
  '126': (state: RootState) => {
    try {
      ;(state as any).knowledge?.bases?.forEach((base) => {
        // @ts-ignore eslint-disable-next-line
        if (base.preprocessOrOcrProvider) {
          // @ts-ignore eslint-disable-next-line
          base.preprocessProvider = base.preprocessOrOcrProvider
          // @ts-ignore eslint-disable-next-line
          delete base.preprocessOrOcrProvider
          // @ts-ignore eslint-disable-next-line
          if (base.preprocessProvider.type === 'ocr') {
            // @ts-ignore eslint-disable-next-line
            delete base.preprocessProvider
          }
        }
      })
      return state
    } catch (error) {
      logger.error('migrate 126 error', error as Error)
      return state
    }
  },
  '127': (state: RootState) => {
    try {
      addProvider(state, 'poe')

      // 迁移api选项设置
      state.llm.providers.forEach((provider) => {
        // 新字段默认支持
        const changes = {
          isNotSupportArrayContent: false,
          isNotSupportDeveloperRole: false,
          isNotSupportStreamOptions: false
        }
        if (!isSupportArrayContentProvider(provider) || provider.isNotSupportArrayContent) {
          // 原本开启了兼容模式的provider不受影响
          changes.isNotSupportArrayContent = true
        }
        if (!isSupportDeveloperRoleProvider(provider)) {
          changes.isNotSupportDeveloperRole = true
        }
        if (!isSupportStreamOptionsProvider(provider)) {
          changes.isNotSupportStreamOptions = true
        }
        updateProvider(state, provider.id, changes)
      })

      // 迁移以前删除掉的内置提供商
      for (const provider of state.llm.providers) {
        if (provider.isSystem && !isSystemProvider(provider)) {
          updateProvider(state, provider.id, { isSystem: false })
        }
      }

      if (!state.settings.proxyBypassRules) {
        state.settings.proxyBypassRules = defaultByPassRules
      }
      return state
    } catch (error) {
      logger.error('migrate 127 error', error as Error)
      return state
    }
  },
  '128': (state: RootState) => {
    try {
      // 迁移 service tier 设置
      const openai = state.llm.providers.find((provider) => provider.id === SystemProviderIds.openai)
      const serviceTier = state.settings.openAI.serviceTier
      if (openai) {
        openai.serviceTier = serviceTier
      }

      // @ts-ignore eslint-disable-next-line
      if (state.settings.codePreview) {
        // @ts-ignore eslint-disable-next-line
        state.settings.codeViewer = state.settings.codePreview
      } else {
        state.settings.codeViewer = {
          themeLight: 'auto',
          themeDark: 'auto'
        }
      }

      return state
    } catch (error) {
      logger.error('migrate 128 error', error as Error)
      return state
    }
  },
  '129': (state: RootState) => {
    try {
      // 聚合 api options
      state.llm.providers.forEach((p) => {
        if (isSystemProvider(p)) {
          updateProvider(state, p.id, { apiOptions: undefined })
        } else {
          const changes: ProviderApiOptions = {
            isNotSupportArrayContent: p.isNotSupportArrayContent,
            isNotSupportServiceTier: p.isNotSupportServiceTier,
            isNotSupportDeveloperRole: p.isNotSupportDeveloperRole,
            isNotSupportStreamOptions: p.isNotSupportStreamOptions
          }
          updateProvider(state, p.id, { apiOptions: changes })
        }
      })
      return state
    } catch (error) {
      logger.error('migrate 129 error', error as Error)
      return state
    }
  },
  '130': (state: RootState) => {
    try {
      if (state.settings && state.settings.openAI && !state.settings.openAI.verbosity) {
        state.settings.openAI.verbosity = 'medium'
      }
      // 为 nutstore 添加备份数量限制的默认值
      if (state.nutstore && state.nutstore.nutstoreMaxBackups === undefined) {
        state.nutstore.nutstoreMaxBackups = 0
      }
      return state
    } catch (error) {
      logger.error('migrate 130 error', error as Error)
      return state
    }
  },
  '131': (state: RootState) => {
    try {
      state.settings.mathEnableSingleDollar = true
      return state
    } catch (error) {
      logger.error('migrate 131 error', error as Error)
      return state
    }
  },
  '132': (state: RootState) => {
    try {
      state.llm.providers.forEach((p) => {
        // 如果原本是undefined则不做改动，静默从默认支持改为默认不支持
        if (p.apiOptions?.isNotSupportDeveloperRole) {
          p.apiOptions.isSupportDeveloperRole = !p.apiOptions.isNotSupportDeveloperRole
        }
        if (p.apiOptions?.isNotSupportServiceTier) {
          p.apiOptions.isSupportServiceTier = !p.apiOptions.isNotSupportServiceTier
        }
      })
      return state
    } catch (error) {
      logger.error('migrate 132 error', error as Error)
      return state
    }
  },
  '133': (state: RootState) => {
    try {
      ;(state as any).settings?.sidebarIcons?.visible?.push('code_tools')
      if ((state as any).codeTools) {
        ;(state as any).codeTools.environmentVariables = {
          'qwen-code': '',
          'claude-code': '',
          'gemini-cli': ''
        }
      }
      return state
    } catch (error) {
      logger.error('migrate 133 error', error as Error)
      return state
    }
  },
  '134': (state: RootState) => {
    try {
      state.llm.quickModel = state.llm.topicNamingModel

      return state
    } catch (error) {
      logger.error('migrate 134 error', error as Error)
      return state
    }
  },
  '135': (state: RootState) => {
    try {
      if (!state.assistants.defaultAssistant.settings) {
        state.assistants.defaultAssistant.settings = DEFAULT_ASSISTANT_SETTINGS
      } else if (!state.assistants.defaultAssistant.settings.toolUseMode) {
        state.assistants.defaultAssistant.settings.toolUseMode = 'prompt'
      }
      return state
    } catch (error) {
      logger.error('migrate 135 error', error as Error)
      return state
    }
  },
  '136': (state: RootState) => {
    try {
      state.settings.sidebarIcons.visible = [...new Set(state.settings.sidebarIcons.visible)].filter((icon) =>
        DEFAULT_SIDEBAR_ICONS.includes(icon)
      )
      state.settings.sidebarIcons.disabled = [...new Set(state.settings.sidebarIcons.disabled)].filter((icon) =>
        DEFAULT_SIDEBAR_ICONS.includes(icon)
      )
      return state
    } catch (error) {
      logger.error('migrate 136 error', error as Error)
      return state
    }
  },
  '137': (state: RootState) => {
    // 补齐：空的占位分支（只保留版本号）。包 try/catch 让「无保护分支」归零，
    // 分支体逐字不变——这里没有失败面。
    try {
      return state
    } catch (error) {
      logger.error('migrate 137 error', error as Error)
      return state
    }
  },
  '138': (state: RootState) => {
    try {
      return state
    } catch (error) {
      logger.error('migrate 138 error', error as Error)
      return state
    }
  },
  '139': (state: RootState) => {
    try {
      const zhipuProvider = state.llm.providers.find((p) => p.id === 'zhipu')

      if (zhipuProvider) {
        // Update zhipu model list
        if (!zhipuProvider.enabled) {
          zhipuProvider.models = SYSTEM_MODELS.zhipu
        }

        // Update zhipu model list
        if (zhipuProvider.models.length === 0) {
          zhipuProvider.models = SYSTEM_MODELS.zhipu
        }

        // Add zhipu web search provider
        addWebSearchProvider(state, 'zhipu')

        // Update zhipu web search provider api key
        if (zhipuProvider.apiKey) {
          ;(state as any)?.websearch?.providers.forEach((provider) => {
            if (provider.id === 'zhipu') {
              provider.apiKey = zhipuProvider.apiKey
            }
          })
        }
      }

      return state
    } catch (error) {
      logger.error('migrate 139 error', error as Error)
      return state
    }
  },
  '141': (state: RootState) => {
    try {
      if (state.settings && state.settings.sidebarIcons) {
        // Check if 'notes' as any is not already in visible icons
        if (!state.settings.sidebarIcons.visible.includes('notes' as any)) {
          state.settings.sidebarIcons.visible = [...state.settings.sidebarIcons.visible, 'notes' as any]
        }
      }
      return state
    } catch (error) {
      logger.error('migrate 141 error', error as Error)
      return state
    }
  },
  '142': (state: RootState) => {
    try {
      // Initialize notes settings if not present
      if (!(state as any).note) {
        ;(state as any).note = { notesPath: '', showWorkspace: false } as any
      }
      return state
    } catch (error) {
      logger.error('migrate 142 error', error as Error)
      return state
    }
  },
  '143': (state: RootState) => {
    try {
      addMiniApp(state, 'longcat')
      return state
    } catch (error) {
      logger.error('migrate 143 error', error as Error)
      return state
    }
  },
  '144': (state: RootState) => {
    try {
      if (state.settings) {
        state.settings.confirmDeleteMessage = settingsInitialState.confirmDeleteMessage
        state.settings.confirmRegenerateMessage = settingsInitialState.confirmRegenerateMessage
      }
      return state
    } catch (error) {
      logger.error('migrate 144 error', error as Error)
      return state
    }
  },
  '145': (state: RootState) => {
    try {
      if (state.settings) {
        if (state.settings.showMessageOutline === undefined || state.settings.showMessageOutline === null) {
          state.settings.showMessageOutline = false
        }
      }
      return state
    } catch (error) {
      logger.error('migrate 145 error', error as Error)
      return state
    }
  },
  '146': (state: RootState) => {
    try {
      // Migrate showWorkspace from settings to note store
      if (state.settings && (state as any).note) {
        const showWorkspaceValue = (state.settings as any)?.showWorkspace
        if (showWorkspaceValue !== undefined) {
          // @ts-ignore eslint-disable-next-line
          ;(state as any).note.settings.showWorkspace = showWorkspaceValue
          // Remove from settings
          delete (state.settings as any).showWorkspace
          // @ts-ignore eslint-disable-next-line
        } else if ((state as any).note.settings.showWorkspace === undefined) {
          // Set default value if not exists
          // @ts-ignore eslint-disable-next-line
          ;(state as any).note.settings.showWorkspace = true
        }
      }
      return state
    } catch (error) {
      logger.error('migrate 146 error', error as Error)
      return state
    }
  },
  '147': (state: RootState) => {
    try {
      ;(state as any).knowledge?.bases?.forEach((base) => {
        if (base.framework) {
          delete base.framework
        }
      })
      return state
    } catch (error) {
      logger.error('migrate 147 error', error as Error)
      return state
    }
  },
  '148': (state: RootState) => {
    try {
      return state
    } catch (error) {
      logger.error('migrate 148 error', error as Error)
      return state
    }
  },
  '149': (state: RootState) => {
    try {
      ;(state as any).knowledge?.bases?.forEach((base) => {
        if (base.framework) {
          delete base.framework
        }
      })
      return state
    } catch (error) {
      logger.error('migrate 149 error', error as Error)
      return state
    }
  },
  '150': (state: RootState) => {
    try {
      addShortcuts(state, ['rename_topic'], 'new_topic')
      addShortcuts(state, ['edit_last_user_message'], 'copy_last_message')
      return state
    } catch (error) {
      logger.error('migrate 150 error', error as Error)
      return state
    }
  },
  '151': (state: RootState) => {
    try {
      if (state.settings) {
        state.settings.codeFancyBlock = true
      }
      return state
    } catch (error) {
      logger.error('migrate 151 error', error as Error)
      return state
    }
  },
  '152': (state: RootState) => {
    // 补齐：空的占位分支（只保留版本号）。包 try/catch 让「无保护分支」归零，
    // 分支体逐字不变——这里没有失败面。
    try {
      return state
    } catch (error) {
      logger.error('migrate 152 error', error as Error)
      return state
    }
  },
  '153': (state: RootState) => {
    try {
      if ((state as any).note.settings) {
        ;(state as any).note.settings.fontSize = 12 as any
        ;(state as any).note.settings.showTableOfContents = false as any
      }
      return state
    } catch (error) {
      logger.error('migrate 153 error', error as Error)
      return state
    }
  },
  '154': (state: RootState) => {
    try {
      if (state.settings.userTheme) {
        state.settings.userTheme.userFontFamily = settingsInitialState.userTheme.userFontFamily
        state.settings.userTheme.userCodeFontFamily = settingsInitialState.userTheme.userCodeFontFamily
      }
      return state
    } catch (error) {
      logger.error('migrate 154 error', error as Error)
      return state
    }
  },
  '155': (state: RootState) => {
    try {
      ;(state as any).knowledge?.bases?.forEach((base) => {
        if (base.framework) {
          delete base.framework
        }
      })
      return state
    } catch (error) {
      logger.error('migrate 155 error', error as Error)
      return state
    }
  },
  '156': (state: RootState) => {
    try {
      state.llm.providers.forEach((provider) => {
        if (provider.id === SystemProviderIds.anthropic) {
          if (provider.apiHost.endsWith('/')) {
            provider.apiHost = provider.apiHost.slice(0, -1)
          }
        }
      })
      return state
    } catch (error) {
      logger.error('migrate 156 error', error as Error)
      return state
    }
  },
  '157': (state: RootState) => {
    try {
      addProvider(state, 'aionly')
      state.llm.providers = moveProvider(state.llm.providers, 'aionly', 10)

      return state
    } catch (error) {
      logger.error('migrate 157 error', error as Error)
      return state
    }
  },
  '158': (state: RootState) => {
    try {
      addProvider(state, 'longcat')
      return state
    } catch (error) {
      logger.error('migrate 158 error', error as Error)
      return state
    }
  },
  '159': (state: RootState) => {
    try {
      addProvider(state, 'ovms')
      fixMissingProvider(state)
      return state
    } catch (error) {
      logger.error('migrate 159 error', error as Error)
      return state
    }
  },
  '161': (state: RootState) => {
    try {
      removeMiniAppFromState(state, 'nm-search')
      removeMiniAppFromState(state, 'hika')
      removeMiniAppFromState(state, 'hugging-chat')
      return state
    } catch (error) {
      logger.error('migrate 161 error', error as Error)
      return state
    }
  },
  '167': (state: RootState) => {
    try {
      addProvider(state, 'huggingface')
      return state
    } catch (error) {
      logger.error('migrate 167 error', error as Error)
      return state
    }
  },
  '168': (state: RootState) => {
    try {
      addPreprocessProviders(state, 'open-mineru')
      return state
    } catch (error) {
      logger.error('migrate 168 error', error as Error)
      return state
    }
  },
  '169': (state: RootState) => {
    try {
      if ((state as any).mcp?.servers) {
        ;(state as any).mcp.servers = (state as any).mcp.servers.map((server) => {
          const inferredSource = isBuiltinMCPServer(server) ? 'builtin' : 'unknown'
          return {
            ...server,
            installSource: inferredSource
          }
        })
      }
      return state
    } catch (error) {
      logger.error('migrate 169 error', error as Error)
      return state
    }
  },
  '170': (state: RootState) => {
    try {
      addProvider(state, 'sophnet')
      state.llm.providers = moveProvider(state.llm.providers, 'sophnet', 17)
      return state
    } catch (error) {
      logger.error('migrate 170 error', error as Error)
      return state
    }
  },
  '171': (state: RootState) => {
    try {
      // Ensure aws-bedrock provider exists
      addProvider(state, 'aws-bedrock')

      // llm.settings.awsBedrock 随 aws-bedrock provider 移除，不再写入历史默认值
      return state
    } catch (error) {
      logger.error('migrate 171 error', error as Error)
      return state
    }
  },
  '172': (state: RootState) => {
    try {
      // Add ling and huggingchat mini apps
      addMiniApp(state, 'ling')
      addMiniApp(state, 'huggingchat')

      // Migrate sidebar icons
      if (state.settings.sidebarIcons) {
        // Sidebar icons are already validated and normalized by the default migration
      }

      // Migrate llm providers
      state.llm.providers.forEach((provider) => {
        if (provider.id === SystemProviderIds['new-api'] && provider.type !== 'new-api') {
          provider.type = 'new-api'
        }

        switch (provider.id) {
          case 'deepseek':
            provider.anthropicApiHost = 'https://api.deepseek.com/anthropic'
            break
          case 'moonshot':
            provider.anthropicApiHost = 'https://api.moonshot.cn/anthropic'
            break
          case 'zhipu':
            provider.anthropicApiHost = 'https://open.bigmodel.cn/api/anthropic'
            break
          case 'dashscope':
            provider.anthropicApiHost = 'https://dashscope.aliyuncs.com/apps/anthropic'
            break
          case 'modelscope':
            provider.anthropicApiHost = 'https://api-inference.modelscope.cn'
            break
          case 'aihubmix':
            provider.anthropicApiHost = 'https://aihubmix.com'
            break
          case 'new-api':
            provider.anthropicApiHost = provider.apiHost
            break
          case 'grok':
            provider.anthropicApiHost = 'https://api.x.ai'
            break
          case 'longcat':
            provider.anthropicApiHost = 'https://api.longcat.chat/anthropic'
            break
        }
      })
      return state
    } catch (error) {
      logger.error('migrate 172 error', error as Error)
      return state
    }
  },
  '173': (state: RootState) => {
    try {
      // Migrate toolOrder from global state to scope-based state
      if (state.inputTools && !state.inputTools.sessionToolOrder) {
        state.inputTools.sessionToolOrder = DEFAULT_TOOL_ORDER_BY_SCOPE.session
      }
      return state
    } catch (error) {
      logger.error('migrate 173 error', error as Error)
      return state
    }
  },
  '174': (state: RootState) => {
    try {
      addProvider(state, SystemProviderIds.longcat)

      addProvider(state, 'gateway')
      addProvider(state, 'cerebras')
      state.llm.providers.forEach((provider) => {
        if (provider.id === SystemProviderIds.minimax) {
          provider.anthropicApiHost = 'https://api.minimaxi.com/anthropic'
        }
      })
      return state
    } catch (error) {
      logger.error('migrate 174 error', error as Error)
      return state
    }
  },
  '175': (state: RootState) => {
    try {
      state.assistants.assistants.forEach((assistant) => {
        // @ts-ignore
        if (assistant.settings?.reasoning_effort === 'off') {
          // @ts-ignore
          assistant.settings.reasoning_effort = 'none'
        }
        // @ts-ignore
        if (assistant.settings?.reasoning_effort_cache === 'off') {
          // @ts-ignore
          assistant.settings.reasoning_effort_cache = 'none'
        }
      })
      logger.info('migrate 175 success')
      return state
    } catch (error) {
      logger.error('migrate 175 error', error as Error)
      return state
    }
  },
  '176': (state: RootState) => {
    try {
      state.llm.providers.forEach((provider) => {
        if (provider.id === SystemProviderIds.qiniu) {
          provider.anthropicApiHost = 'https://api.qnaigc.com'
        }
        if (provider.id === SystemProviderIds.longcat) {
          provider.anthropicApiHost = 'https://api.longcat.chat/anthropic'
        }
      })
      return state
    } catch (error) {
      logger.error('migrate 176 error', error as Error)
      return state
    }
  },
  '177': (state: RootState) => {
    try {
      // @ts-expect-error it's a removed type
      if (state.settings.openAI.summaryText === 'off') {
        state.settings.openAI.summaryText = 'auto'
      }
      logger.info('migrate 177 success')
      return state
    } catch (error) {
      logger.error('migrate 177 error', error as Error)
      return state
    }
  },
  '178': (state: RootState) => {
    try {
      const groq = state.llm.providers.find((p) => p.id === SystemProviderIds.groq)
      if (groq) {
        groq.verbosity = undefined
      }
      logger.info('migrate 178 success')
      return state
    } catch (error) {
      logger.error('migrate 178 error', error as Error)
      return state
    }
  },
  '179': (state: RootState) => {
    try {
      state.llm.providers.forEach((provider) => {
        switch (provider.id) {
          case SystemProviderIds.silicon:
            provider.anthropicApiHost = 'https://api.siliconflow.cn'
            break
          case SystemProviderIds.qiniu:
            provider.anthropicApiHost = 'https://api.qnaigc.com'
            break
          case SystemProviderIds.dmxapi:
            provider.anthropicApiHost = provider.apiHost
            break
        }
      })
      logger.info('migrate 179 success')
      return state
    } catch (error) {
      logger.error('migrate 179 error', error as Error)
      return state
    }
  },
  '181': (state: RootState) => {
    try {
      state.llm.providers.forEach((provider) => {
        if (provider.id === 'ai-gateway') {
          provider.id = SystemProviderIds.gateway
        }
        // Also update model.provider references to avoid orphaned models
        provider.models?.forEach((model) => {
          if (model.provider === 'ai-gateway') {
            model.provider = SystemProviderIds.gateway
          }
        })
        // @ts-ignore
        if (provider.type === 'ai-gateway') {
          provider.type = 'gateway'
        }
      })
      logger.info('migrate 181 success')
      return state
    } catch (error) {
      logger.error('migrate 181 error', error as Error)
      return state
    }
  },
  '182': (state: RootState) => {
    try {
      // Initialize streamOptions in settings.openAI if not exists
      if (!state.settings.openAI.streamOptions) {
        state.settings.openAI.streamOptions = {
          includeUsage: DEFAULT_STREAM_OPTIONS_INCLUDE_USAGE
        }
      }
      logger.info('migrate 182 success')
      return state
    } catch (error) {
      logger.error('migrate 182 error', error as Error)
      return state
    }
  },
  '183': (state: RootState) => {
    try {
      state.llm.providers = moveProvider(state.llm.providers, SystemProviderIds.poe, 10)
      logger.info('migrate 183 success')
      return state
    } catch (error) {
      logger.error('migrate 183 error', error as Error)
      return state
    }
  },
  '184': (state: RootState) => {
    try {
      // Add exa-mcp (free) web search provider if not exists
      const exaMcpExists = (state as any).websearch.providers.some((p) => p.id === 'exa-mcp')
      if (!exaMcpExists) {
        // Find the index of 'exa' provider to insert after it
        const exaIndex = (state as any).websearch.providers.findIndex((p) => p.id === 'exa')
        const newProvider = {
          id: 'exa-mcp' as const,
          name: 'ExaMCP',
          apiHost: 'https://mcp.exa.ai/mcp'
        }
        if (exaIndex !== -1) {
          ;(state as any).websearch.providers.splice(exaIndex + 1, 0, newProvider)
        } else {
          ;(state as any).websearch.providers.push(newProvider)
        }
      }
      logger.info('migrate 184 success')
      return state
    } catch (error) {
      logger.error('migrate 184 error', error as Error)
      return state
    }
  },
  '185': (state: RootState) => {
    try {
      // Reset toolUseMode to function for default assistant
      if (state.assistants.defaultAssistant.settings?.toolUseMode) {
        state.assistants.defaultAssistant.settings.toolUseMode = 'function'
      }
      // Reset toolUseMode to function for assistants
      state.assistants.assistants.forEach((assistant) => {
        if (assistant.settings?.toolUseMode === 'prompt') {
          if (assistant.model && isFunctionCallingModel(assistant.model)) {
            assistant.settings.toolUseMode = 'function'
          }
        }
      })
      logger.info('migrate 185 success')
      return state
    } catch (error) {
      logger.error('migrate 185 error', error as Error)
      return state
    }
  },
  '186': (state: RootState) => {
    try {
      // settings.apiServer 随 apiServer 后端移除，不再写回 host
      // @ts-expect-error
      if (state.settings.openAI.summaryText === 'undefined') {
        state.settings.openAI.summaryText = undefined
      }
      // @ts-expect-error
      if (state.settings.openAI.verbosity === 'undefined') {
        state.settings.openAI.verbosity = undefined
      }
      state.llm.providers.forEach((provider) => {
        if (provider.id === SystemProviderIds.ollama) {
          provider.type = 'ollama'
        }
      })
      logger.info('migrate 186 success')
      return state
    } catch (error) {
      logger.error('migrate 186 error', error as Error)
      return state
    }
  },
  '187': (state: RootState) => {
    try {
      state.assistants.assistants.forEach((assistant) => {
        if (assistant.settings && assistant.settings.reasoning_effort === undefined) {
          assistant.settings.reasoning_effort = 'default'
        }
      })
      addProvider(state, 'mimo')
      logger.info('migrate 187 success')
      return state
    } catch (error) {
      logger.error('migrate 187 error', error as Error)
      return state
    }
  },
  // 1.7.7
  '188': (state: RootState) => {
    try {
      state.llm.providers.forEach((provider) => {
        if (provider.id === SystemProviderIds.openrouter) {
          provider.anthropicApiHost = 'https://openrouter.ai/api'
        }
      })
      logger.info('migrate 188 success')
      return state
    } catch (error) {
      logger.error('migrate 188 error', error as Error)
      return state
    }
  },
  // 1.7.7
  '189': (state: RootState) => {
    try {
      // @ts-ignore 全局记忆已于 整体废弃（见 migrate 228）：历史分支保留可达性，
      // 通道不再存在时走本分支 try/catch 的既定失败路径，状态原样返回。
      void window.api.memory?.migrateMemoryDb()
      // @ts-ignore
      const memoryLlmApiClient = state?.memory?.memoryConfig?.llmApiClient
      // @ts-ignore
      const memoryEmbeddingApiClient = state?.memory?.memoryConfig?.embedderApiClient

      // @ts-ignore
      if (memoryLlmApiClient) {
        // @ts-ignore
        state.memory.memoryConfig.llmModel = getModel(memoryLlmApiClient.model, memoryLlmApiClient.provider)
        // @ts-ignore
        delete state.memory.memoryConfig.llmApiClient
      }

      // @ts-ignore
      if (memoryEmbeddingApiClient) {
        // @ts-ignore
        state.memory.memoryConfig.embeddingModel = getModel(
          memoryEmbeddingApiClient.model,
          memoryEmbeddingApiClient.provider
        )
        // @ts-ignore
        delete state.memory.memoryConfig.embedderApiClient
      }
      return state
    } catch (error) {
      logger.error('migrate 189 error', error as Error)
      return state
    }
  },
  // 1.7.8
  '190': (state: RootState) => {
    try {
      state.llm.providers.forEach((provider) => {
        if (provider.id === SystemProviderIds.ollama) {
          provider.type = 'ollama'
        }
      })
      logger.info('migrate 190 success')
      return state
    } catch (error) {
      logger.error('migrate 190 error', error as Error)
      return state
    }
  },
  '191': (state: RootState) => {
    try {
      state.llm.providers.forEach((provider) => {
        if (provider.id === 'tokenflux') {
          provider.apiHost = 'https://api.tokenflux.ai/openai/v1'
          provider.anthropicApiHost = 'https://api.tokenflux.ai/anthropic'
        }
      })
      logger.info('migrate 191 success')
      return state
    } catch (error) {
      logger.error('migrate 191 error', error as Error)
      return state
    }
  },
  '192': (state: RootState) => {
    try {
      state.llm.providers.forEach((provider) => {
        if (provider.id === '302ai') {
          provider.anthropicApiHost = 'https://api.302.ai'
        }
      })
      state.settings.readClipboardAtStartup = false
      logger.info('migrate 192 success')
      return state
    } catch (error) {
      logger.error('migrate 192 error', error as Error)
      return state
    }
  },
  '193': (state: RootState) => {
    try {
      addPreprocessProviders(state, 'paddleocr')
      logger.info('migrate 193 success')
      return state
    } catch (error) {
      logger.error('migrate 193 error', error as Error)
      return state
    }
  },
  '194': (state: RootState) => {
    try {
      const GLM_4_5_FLASH_MODEL = 'glm-4.5-flash'
      if (state.llm.defaultModel?.provider === 'cherryai' && state.llm.defaultModel?.id === GLM_4_5_FLASH_MODEL) {
        state.llm.defaultModel = qwenModel
      }
      if (state.llm.quickModel?.provider === 'cherryai' && state.llm.quickModel?.id === GLM_4_5_FLASH_MODEL) {
        state.llm.quickModel = qwenModel
      }
      state.assistants.assistants.forEach((assistant) => {
        if (assistant.model?.provider === 'cherryai' && assistant.model?.id === GLM_4_5_FLASH_MODEL) {
          assistant.model = qwenModel
        }
        if (assistant.defaultModel?.provider === 'cherryai' && assistant.defaultModel?.id === GLM_4_5_FLASH_MODEL) {
          assistant.defaultModel = qwenModel
        }
      })
      // Initialize mini app region filter setting
      state.settings.minAppRegion ??= 'auto'
      return state
    } catch (error) {
      logger.error('migrate 194 error', error as Error)
      return state
    }
  },
  '195': (state: RootState) => {
    try {
      if (state.settings && state.settings.sidebarIcons) {
        // Add 'openclaw' to visible icons if not already present
        if (!(state.settings.sidebarIcons.visible as string[]).includes('openclaw')) {
          state.settings.sidebarIcons.visible = [...state.settings.sidebarIcons.visible, 'openclaw' as any]
        }
      }
      logger.info('migrate 195 success')
      return state
    } catch (error) {
      logger.error('migrate 195 error', error as Error)
      return state
    }
  },
  '196': (state: RootState) => {
    try {
      logger.info('migrate 196 success')
      return state
    } catch (error) {
      logger.error('migrate 196 error', error as Error)
      return state
    }
  },
  '197': (state: RootState) => {
    try {
      if ((state as any).openclaw?.gatewayPort === 18789) {
        ;(state as any).openclaw.gatewayPort = 18790
      }
      logger.info('migrate 197 success')
      return state
    } catch (error) {
      logger.error('migrate 197 error', error as Error)
      return state
    }
  },
  '198': (state: RootState) => {
    try {
      state.llm.providers.forEach((provider) => {
        if (provider.id === 'minimax') {
          provider.models = SYSTEM_MODELS['minimax']
          provider.apiHost = 'https://api.minimaxi.com/v1/'
        }
      })
      return state
    } catch (error) {
      logger.error('migrate 198 error', error as Error)
      return state
    }
  },
  '199': (state: RootState) => {
    try {
      addShortcuts(state, ['select_model'], 'toggle_new_context')
      return state
    } catch (error) {
      logger.error('migrate 199 error', error as Error)
      return state
    }
  },
  '200': (state: RootState) => {
    try {
      state.llm.providers.forEach((provider) => {
        if (provider.type === 'ollama') {
          provider.anthropicApiHost = provider.apiHost || 'http://localhost:11434'
        }
      })

      // Migrate minimax app id to hailuo
      if (state.minapps) {
        const lists: Array<'enabled' | 'disabled' | 'pinned'> = ['enabled', 'disabled', 'pinned']
        lists.forEach((list) => {
          state.minapps[list] = state.minapps[list].map((app) =>
            app.id === 'minimax' ? { ...app, id: 'hailuo' } : app
          )
        })
      }
      // Add new MiniMax Agent apps
      addMiniApp(state, 'minimax-agent')
      addMiniApp(state, 'minimax-agent-global')
      addMiniApp(state, 'ima')
      // Add new providers: minimax-global and zai
      addProvider(state, 'minimax-global')
      addProvider(state, 'zai')
      // Update grok provider type to openai-response
      state.llm.providers.forEach((provider) => {
        if (provider.id === SystemProviderIds.grok) {
          provider.type = 'openai-response'
        }
      })

      return state
    } catch (error) {
      logger.error('migrate 200 error', error as Error)
      return state
    }
  },
  '201': (state: RootState) => {
    try {
      addWebSearchProvider(state, 'querit')
      return state
    } catch (error) {
      logger.error('migrate 201 error', error as Error)
      return state
    }
  },
  '202': (state: RootState) => {
    try {
      const filesystemServer = (state as any).mcp?.servers?.find((s: any) => s.name === '@cherry/filesystem')
      if (filesystemServer && filesystemServer.disabledAutoApproveTools === undefined) {
        filesystemServer.disabledAutoApproveTools = ['write', 'edit', 'delete']
      }
      return state
    } catch (error) {
      logger.error('migrate 202 error', error as Error)
      return state
    }
  },
  '204': (state: RootState) => {
    try {
      if (state.llm.defaultModel?.provider === 'cherryai') {
        state.llm.defaultModel = qwenModel
      }
      if (state.llm.quickModel?.provider === 'cherryai') {
        state.llm.quickModel = qwenModel
      }
      state.assistants.assistants.forEach((assistant) => {
        if (assistant.model?.provider === 'cherryai') {
          assistant.model = qwenModel
        }
        if (assistant.defaultModel?.provider === 'cherryai') {
          assistant.defaultModel = qwenModel
        }
      })
      logger.info('migrate 204 success')
      return state
    } catch (error) {
      logger.error('migrate 204 error', error as Error)
      return state
    }
  },
  '205': (state: RootState) => {
    try {
      localStorage.setItem('onboarding-completed', 'true')

      // Add anthropicApiHost to lmstudio and ollama providers for CodeTools compatibility
      state.llm.providers.forEach((provider) => {
        if (provider.id === 'lmstudio' && !provider.anthropicApiHost) {
          provider.anthropicApiHost = 'http://localhost:1234'
        }
        if (provider.id === 'ollama' && !provider.anthropicApiHost) {
          provider.anthropicApiHost = provider.apiHost || 'http://localhost:11434'
        }
      })

      logger.info('migrate 205 success')
      return state
    } catch (error) {
      logger.error('migrate 205 error', error as Error)
      return state
    }
  },
  '206': (state: RootState) => {
    try {
      const { sessionToolOrder } = state.inputTools
      const permissionModeKey = 'permission_mode'
      if (
        sessionToolOrder &&
        !sessionToolOrder?.visible?.includes(permissionModeKey) &&
        !sessionToolOrder?.hidden?.includes(permissionModeKey)
      ) {
        const createSessionIndex = sessionToolOrder.visible.indexOf('create_session')
        if (createSessionIndex !== -1) {
          sessionToolOrder.visible.splice(createSessionIndex + 1, 0, permissionModeKey)
        } else {
          sessionToolOrder.visible.unshift(permissionModeKey)
        }
      }
      logger.info('migrate 206 success')
      return state
    } catch (error) {
      logger.error('migrate 206 error', error as Error)
      return state
    }
  },
  '207': (state: RootState) => {
    try {
      state.llm.providers.forEach((provider) => {
        if (provider.id === 'stepfun' && !provider.anthropicApiHost) {
          provider.anthropicApiHost = 'https://api.stepfun.com'
        }
      })

      logger.info('migrate 207 success')
      return state
    } catch (error) {
      logger.error('migrate 207 error', error as Error)
      return state
    }
  },
  '208': (state: RootState) => {
    try {
      state.settings.enableDataCollection = true
      logger.info('migrate 208 success')
      return state
    } catch (error) {
      logger.error('migrate 208 error', error as Error)
      return state
    }
  },
  '209': (state: RootState) => {
    try {
      // v2-trim: purge sidebar icons and tabs for removed subsystems
      // 白名单必须与 DEFAULT_SIDEBAR_ICONS 同源。这里原本硬编码
      // ['assistants','minapp','files']，把当时**仍在发行**的图标（notes 等）一起从
      // visible/disabled 里剥掉——'141' 排在 209 之前早已跑过，此后再没有任何分支补
      // 'notes'，升级账号的笔记入口永久消失（新装默认表里却有它）。本分支只允许删
      // "已移除子系统"的图标，不删在售图标；'229' 负责把已经跑过旧 209 的账号对账回来。
      const VALID_SIDEBAR_ICONS = DEFAULT_SIDEBAR_ICONS
      if (state.settings?.sidebarIcons) {
        state.settings.sidebarIcons.visible = state.settings.sidebarIcons.visible.filter((icon) =>
          (VALID_SIDEBAR_ICONS as readonly string[]).includes(icon)
        )
        state.settings.sidebarIcons.disabled = state.settings.sidebarIcons.disabled.filter((icon) =>
          (VALID_SIDEBAR_ICONS as readonly string[]).includes(icon)
        )
        if (!state.settings.sidebarIcons.visible.includes('assistants')) {
          state.settings.sidebarIcons.visible = ['assistants', ...state.settings.sidebarIcons.visible]
        }
      }

      if (state.tabs?.tabs) {
        const isValidTab = (tab: { id: string; path?: string }): boolean =>
          tab.id === 'home' ||
          tab.id === 'files' ||
          tab.id === 'settings' ||
          tab.id === 'apps' ||
          tab.id.startsWith('apps:')
        state.tabs.tabs = state.tabs.tabs.filter(isValidTab)
        if (!state.tabs.tabs.some((tab) => tab.id === 'home')) {
          state.tabs.tabs.unshift({ id: 'home', path: '/' })
        }
        if (!state.tabs.tabs.some((tab) => tab.id === state.tabs.activeTabId)) {
          state.tabs.activeTabId = 'home'
        }
      }

      logger.info('migrate 209 success')
      return state
    } catch (error) {
      logger.error('migrate 209 error', error as Error)
      return state
    }
  },
  '210': (state: RootState) => {
    try {
      // 快捷助手独立配置：模型 + 提示词（不依赖 Assistant 对象）
      if (state.llm.quickAssistantModel === undefined) {
        state.llm.quickAssistantModel = state.llm.quickModel
      }
      if (typeof state.settings.quickAssistantPrompt !== 'string') {
        state.settings.quickAssistantPrompt = ''
      }
      return state
    } catch (error) {
      logger.error('migrate 210 error', error as Error)
      return state
    }
  },
  '211': (state: RootState) => {
    try {
      // 快捷助手两个开关默认改为关（快捷键 + 设置页启用）
      const miniShortcut = state.shortcuts?.shortcuts?.find((s) => s.key === 'mini_window')
      if (miniShortcut) {
        miniShortcut.enabled = false
      }
      state.settings.enableQuickAssistant = false
      return state
    } catch (error) {
      logger.error('migrate 211 error', error as Error)
      return state
    }
  },
  '212': (state: RootState) => {
    try {
      // 启动后读取剪切板默认改为关闭
      state.settings.readClipboardAtStartup = false
      return state
    } catch (error) {
      logger.error('migrate 212 error', error as Error)
      return state
    }
  },
  '213': (state: RootState) => {
    try {
      // 移除内核不支持协议族的全部历史行——
      // ① 系统提供商预设（id = gemini/azure-openai/vertexai/aws-bedrock，SystemProviderIdSchema 同步删除）；
      // ② 历史遗留的自定义 provider（id 为随机值但 type 属不可路由协议：内核 PROTOCOL_BY_TYPE 无映射，
      //    留着只会静默失败）。type 级枚举本身保留（migrate 历史依赖其存在）。
      const REMOVED_PROVIDER_TYPES = new Set(['gemini', 'azure-openai', 'vertexai', 'aws-bedrock', 'vertex-anthropic'])
      const REMOVED_SYSTEM_PROVIDER_IDS = new Set(['gemini', 'azure-openai', 'vertexai', 'aws-bedrock'])
      state.llm.providers = state.llm.providers.filter(
        (provider) => !REMOVED_SYSTEM_PROVIDER_IDS.has(provider.id) && !REMOVED_PROVIDER_TYPES.has(provider.type)
      )
      return state
    } catch (error) {
      logger.error('migrate 213 error', error as Error)
      return state
    }
  },
  '214': (state: RootState) => {
    try {
      // 识图通道补全：llm 切片新增 imageDescriberModel（转述模型）字段。
      // 旧持久化态没有此字段；显式落 undefined = 通道关闭。rehydrate 后 reducer 照常可写。
      if (state.llm !== undefined) {
        state.llm.imageDescriberModel = undefined
      }
      return state
    } catch (error) {
      logger.error('migrate 214 error', error as Error)
      return state
    }
  },
  '215': (state: RootState) => {
    try {
      // 关停上游遥测。历史来源有三处会把 data collection 置为开——
      // 早期迁移（'208' 等）、渲染层缺省值、以及隐私政策更新弹卡对 '20260531' 版的一次性强制重置；
      // 一旦为开，主进程 config 也会被推成开。这里把存量状态一次性翻为关，使设置页显示与实际一致
      // （服务层另有硬性关闭，见 AnalyticsService 的 FORK_ANALYTICS_ENABLED）。
      if (state.settings !== undefined && state.settings.enableDataCollection === true) {
        state.settings.enableDataCollection = false
        logger.info('migrate 215 success: data collection disabled in this fork')
      }
      // 预设系统整链移除，清掉持久化里的死键（无写入方，留着只会一直跟着用户数据走）
      if (state.assistants !== undefined) {
        delete (state.assistants as unknown as Record<string, unknown>).presets
      }
      return state
    } catch (error) {
      logger.error('migrate 215 error', error as Error)
      return state
    }
  },
  '216': (state: RootState) => {
    try {
      // 加回四功能的状态切片（websearch / mcp / knowledge / skills）。
      // 全部是新增顶层切片，旧持久化态缺 key 时由 reducer initialState 缺省合并，无需变换；
      // 本分支仅作为版本推进的显式记账，不做任何字段改写。
      return state
    } catch (error) {
      logger.error('migrate 216 error', error as Error)
      return state
    }
  },
  '217': (state: RootState) => {
    try {
      // knowledge 侧栏图标回归。旧持久化态里 sidebarIcons.visible 是存量
      // 快照，不含 'knowledge'，必须补位，否则老用户看不到知识库入口（DEFAULT_SIDEBAR_ICONS
      // 只作用于全新安装）。disabled 列表不动（用户显式停用的语义不受升级影响）。
      const visible = state.settings?.sidebarIcons?.visible
      if (Array.isArray(visible) && !visible.includes('knowledge')) {
        visible.push('knowledge')
      }
      return state
    } catch (error) {
      logger.error('migrate 217 error', error as Error)
      return state
    }
  },
  '218': (state: RootState) => {
    try {
      // LocalPaddle：preprocess.providers 是持久化数组，回水时整体覆盖
      // initialState——新增的默认条目（local-paddle）永远不会出现在老安装的下拉里。
      // 按 id 合并补缺：用户已改的 apiKey/apiHost 保留，缺失的默认条目追加
      //（defaultProvider 不动——用户的选择不被升级改写）。
      const providers = state.preprocess?.providers
      if (Array.isArray(providers)) {
        const missing = defaultPreprocessProviders.filter((d) => !providers.some((p) => p?.id === d.id))
        if (missing.length > 0) {
          state.preprocess = { ...state.preprocess, providers: [...providers, ...missing] }
        }
      }
      return state
    } catch (error) {
      logger.error('migrate 218 error', error as Error)
      return state
    }
  },
  '220': (state: RootState) => {
    try {
      // +4：翻译页与绘画页回归。四件事：
      // ① llm 切片新增 translateModel（翻译模型）字段——旧持久化态没有此字段，
      //    显式落 undefined = 未配置（照 '214' imageDescriberModel 先例）。
      // ② llm 切片新增 paintingModel（绘画模型）字段，同上。
      // ③ translate 侧栏图标补位（照 '217' knowledge 先例——存量 sidebarIcons.visible
      //    快照不含新图标，不补位老用户看不到入口）。
      // ④ paintings 侧栏图标补位，同上。
      if (state.llm !== undefined) {
        state.llm.translateModel = undefined
        state.llm.paintingModel = undefined
      }
      const visible = state.settings?.sidebarIcons?.visible
      if (Array.isArray(visible)) {
        if (!visible.includes('translate')) {
          visible.push('translate')
        }
        if (!visible.includes('paintings')) {
          visible.push('paintings')
        }
      }
      return state
    } catch (error) {
      logger.error('migrate 220 error', error as Error)
      return state
    }
  },
  '221': (state: RootState) => {
    try {
      // 内置小程序按用户裁决裁剪（59 → 12）+ 新增 3 个（scnet/ark/openrouter）。
      // ① 清掉被移除的 47 个内置应用的持久化残留（enabled/disabled/pinned 三列表），
      //    否则 getAllApps 的 mapApps 找不到模板数据、旧对象原样透出成幽灵磁贴。
      //    （用户自建 Custom 应用不在内置 id 表里，不受影响。）
      // ② 补入 3 个新增应用，保证老用户无需手动启用即可见。
      const REMOVED_BUILTIN_MINAPPS = [
        'gemini',
        'yi',
        'zhipu',
        'baichuan',
        'stepfun',
        'cici',
        'hailuo',
        'minimax-agent',
        'minimax-agent-global',
        'ima',
        'groq',
        'anthropic',
        'google',
        'baidu-ai-chat',
        'baidu-ai-search',
        'tencent-yuanbao',
        'sensetime-chat',
        'spark-desk',
        'metaso',
        'poe',
        'devv',
        'tiangong-ai',
        'Felo',
        'bolt',
        'nm',
        'thinkany',
        'genspark',
        'grok',
        'grok-x',
        'qwenlm',
        'flowith',
        '3mintop',
        'aistudio',
        'xiaoyi',
        'coze',
        'dify',
        'wpslingxi',
        'lechat',
        'abacus',
        'lambdachat',
        'monica',
        'you',
        'zhihu',
        'dangbei',
        'n8n',
        'longcat',
        'ling'
      ]
      REMOVED_BUILTIN_MINAPPS.forEach((id) => removeMiniAppFromState(state, id))
      addMiniApp(state, 'scnet')
      addMiniApp(state, 'ark')
      addMiniApp(state, 'openrouter')
      return state
    } catch (error) {
      logger.error('migrate 221 error', error as Error)
      return state
    }
  },
  '222': (state: RootState) => {
    try {
      // 编码助手：侧栏图标补位（照 '220' translate/paintings 先例——
      // 存量 sidebarIcons.visible 快照不含新图标，不补位老用户看不到入口）。
      const visible = state.settings?.sidebarIcons?.visible
      if (Array.isArray(visible) && !visible.includes('code')) {
        visible.push('code')
      }
      return state
    } catch (error) {
      logger.error('migrate 222 error', error as Error)
      return state
    }
  },
  '223': (state: RootState) => {
    try {
      // 编码助手：codeCliConfigs 字段回填（真机事故修复——redux-persist 的
      // settings 切片整片来自存量持久化，initialState 的新字段对老用户是 undefined，
      // useCodeCli 读 configs[toolId] 直接 TypeError。照 '220' 显式落字段先例）。
      if (state.settings) {
        state.settings.codeCliConfigs = state.settings.codeCliConfigs ?? {}
      }
      return state
    } catch (error) {
      logger.error('migrate 223 error', error as Error)
      return state
    }
  },
  '224': (state: RootState) => {
    try {
      // v0.4 验收轮：preprocess 切片与默认表对账重播种——旧持久化数组缺新默认条目
      // （如 local-paddle 是后加的）或条目 name 缺失/为空时，设置页下拉出现空选项。
      // 缺失条目补入（照 addPreprocessProviders 先例），空白 name 按默认表回填；
      // 用户已配置的 apiKey/apiHost 原样保留。
      if (state.preprocess && Array.isArray(state.preprocess.providers)) {
        for (const provider of state.preprocess.providers) {
          if (!provider.name || provider.name.trim().length === 0) {
            provider.name = defaultPreprocessProviders.find((p) => p.id === provider.id)?.name ?? provider.name
          }
        }
        for (const provider of defaultPreprocessProviders) {
          if (!state.preprocess.providers.find((p) => p.id === provider.id)) {
            state.preprocess.providers.push({ ...provider })
          }
        }
      }
      return state
    } catch (error) {
      logger.error('migrate 224 error', error as Error)
      return state
    }
  },
  '225': (state: RootState) => {
    try {
      // 视觉模型文档处理：preprocess 默认表新增 vision-model 条目——
      // providers 是持久化数组，redux-persist 回水整体覆盖 initialState，新增默认
      // 条目只对全新安装生效（migrate 218 local-paddle / 224 同一坑），故按 id 补缺。
      // 条目缺失即补；用户已改的 apiKey/apiHost/visionModel 原样保留，defaultProvider 不动。
      if (state.preprocess && Array.isArray(state.preprocess.providers)) {
        for (const provider of defaultPreprocessProviders) {
          if (!state.preprocess.providers.find((p) => p.id === provider.id)) {
            state.preprocess.providers.push({ ...provider })
          }
        }
      }
      return state
    } catch (error) {
      logger.error('migrate 225 error', error as Error)
      return state
    }
  },
  '226': (state: RootState) => {
    try {
      // 翻译页偏好项回补：settings 新增三键——持久化切片回水整体覆盖
      // initialState（migrate 218/224/225 同一坑），旧用户无新键，逐一补缺省。
      if (state.settings) {
        if (state.settings.translateAutoCopy === undefined) state.settings.translateAutoCopy = false
        if (state.settings.translateCustomPrompt === undefined) state.settings.translateCustomPrompt = ''
        if (state.settings.translateCustomLanguages === undefined) state.settings.translateCustomLanguages = []
      }
      return state
    } catch (error) {
      logger.error('migrate 226 error', error as Error)
      return state
    }
  },
  '227': (state: RootState) => {
    try {
      // Obsidian 集成移植：settings 新增 defaultObsidianVault——持久化切片回水
      // 整体覆盖 initialState（migrate 218/224/225/226 同一坑），旧用户无新键，补缺省 null。
      if (state.settings && state.settings.defaultObsidianVault === undefined) {
        state.settings.defaultObsidianVault = null
      }
      return state
    } catch (error) {
      logger.error('migrate 227 error', error as Error)
      return state
    }
  },
  '228': (state: RootState) => {
    try {
      // 用户裁决：全局记忆（V1 遗产：libsql 记忆库 + 工具制召回）整体废弃——
      // 工具制召回存在「模型不调工具就看不见记忆」的结构性缺陷；仅保留 V2 式
      // 文件记忆（work-mode memory 工具，FACT.md 每轮注入上下文）。持久化切片
      // memory 随之移除，旧存档的 memory 键在此显式清除（combineReducers 本也会
      // 丢弃未知键，storage 残留随下次 flush 自愈）。
      if ('memory' in state) delete (state as Record<string, unknown>).memory
      return state
    } catch (error) {
      logger.error('migrate 228 error', error as Error)
      return state
    }
  },
  '229': (state: RootState) => {
    try {
      // 侧栏图标对账：'209'（v2-trim）曾把 sidebarIcons 白名单硬编码成
      // ['assistants','minapp','files']。**本分支要修的老账号正是已经跑过 '209' 的那批**：
      // 迁移链不重跑，209 之后才补位的图标（'217' knowledge / '220' translate+paintings /
      // '222' code / '141' notes）里，只有 '141' 排在 209 之前，所以那批账号按下述顺序
      // 收尾：209 砍到 3 项 → 217 补 knowledge → 220 补 translate/paintings → 222 补 code
      // → 'notes' 无任何后续分支补回，永久丢失。209 新分支（同批改动）挡住了尚未跑 209 的
      // 账号，本分支负责把已跑过的账号收敛到同一形态：`visible` 按 DEFAULT_SIDEBAR_ICONS
      // 对账补缺，`disabled` 原样保留（用户显式隐藏的选择优先，不重新点亮）。
      const sidebarIcons = state.settings?.sidebarIcons
      if (sidebarIcons) {
        const visible = Array.isArray(sidebarIcons.visible) ? sidebarIcons.visible : []
        const disabled = Array.isArray(sidebarIcons.disabled) ? sidebarIcons.disabled : []
        const hidden = new Set<string>(disabled)
        const missingDefaults = DEFAULT_SIDEBAR_ICONS.filter((icon) => !visible.includes(icon) && !hidden.has(icon))
        if (missingDefaults.length > 0 || !Array.isArray(sidebarIcons.visible)) {
          sidebarIcons.visible = [...visible, ...missingDefaults]
        }
        if (!Array.isArray(sidebarIcons.disabled)) {
          sidebarIcons.disabled = disabled
        }
      }

      // settings.pinnedTabs 回填：pinnedTabs 是后加的持久化字段，`tabs` 切片在 persist
      // blacklist 里，固定标签页跨重启只能靠 settings 这个键。老账号的持久化 settings 里没有
      // 这个键（redux-persist 整片回水覆盖 initialState，initialState 永不到达老用户），
      // 于是 restorePinnedTabs 的 `?? []` 把"字段缺失"静默呈现成"用户没固定过标签页"。
      // 照 '226'/'227' 先例显式落字段。
      if (state.settings && state.settings.pinnedTabs === undefined) {
        state.settings.pinnedTabs = []
      }
      return state
    } catch (error) {
      logger.error('migrate 229 error', error as Error)
      return state
    }
  }
}

// 注意：添加新迁移时，记得同时更新 persistReducer
// file://./index.ts

const migrate = createMigrate(migrateConfig as any)

export default migrate

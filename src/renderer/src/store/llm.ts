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
import type { PayloadAction } from '@reduxjs/toolkit'
import { createSlice } from '@reduxjs/toolkit'
import { isLocalAi } from '@renderer/config/env'
import { SYSTEM_MODELS } from '@renderer/config/models'
import { INITIAL_STATE_EXCLUDED_PROVIDER_IDS, SYSTEM_PROVIDERS_CONFIG } from '@renderer/config/providers'
import type { Model, Provider } from '@renderer/types'
import { omit, uniqBy } from 'lodash-es'

type LlmSettings = {
  ollama: {
    keepAliveTime: number
  }
  lmstudio: {
    keepAliveTime: number
  }
  gpustack: {
    keepAliveTime: number
  }
  vertexai: {
    serviceAccount: {
      privateKey: string
      clientEmail: string
    }
    projectId: string
    location: string
  }
}

export interface LlmState {
  providers: Provider[]
  defaultModel: Model
  /** @deprecated */
  topicNamingModel: Model
  quickModel: Model
  quickAssistantModel: Model | undefined
  /** 转述模型（识图通道补全）：主模型无视觉时描述图片的视觉模型；undefined = 通道关闭。 */
  imageDescriberModel: Model | undefined
  /** 转述提示词：'' = 内置默认（@shared/config/imageDescriber）。 */
  imageDescriberPrompt: string
  /** 翻译模型（翻译页）：undefined = 未配置（翻译时明错提示）。 */
  translateModel: Model | undefined
  /** 绘画模型（绘画页）：undefined = 未配置（生成时明错提示）。 */
  paintingModel: Model | undefined
  settings: LlmSettings
}

export const initialState: LlmState = {
  defaultModel: SYSTEM_MODELS.defaultModel[0],
  topicNamingModel: SYSTEM_MODELS.defaultModel[1],
  quickModel: SYSTEM_MODELS.defaultModel[1],
  quickAssistantModel: undefined,
  imageDescriberModel: undefined,
  imageDescriberPrompt: '',
  translateModel: undefined,
  paintingModel: undefined,
  // `SYSTEM_PROVIDERS_CONFIG` 的值是 `config/providers.ts` 的模块级单例对象。
  // migrate 分支会就地改写 provider（`provider.anthropicApiHost = …`、`provider.type = …`），
  // 把同一批引用交给 state 就等于把模块默认表交给迁移去改。此处按 （websearch）同形克隆，
  // models 数组一并克隆（迁移会整表替换 `provider.models = SYSTEM_MODELS.x`，但 reducer 的
  // `provider.models[i] = …` 是就地写，数组共享仍会串到默认表）。
  providers: Object.values(omit(SYSTEM_PROVIDERS_CONFIG, INITIAL_STATE_EXCLUDED_PROVIDER_IDS)).map((provider) => ({
    ...provider,
    models: Array.isArray(provider.models) ? provider.models.map((model) => ({ ...model })) : provider.models
  })),
  settings: {
    ollama: {
      keepAliveTime: 0
    },
    lmstudio: {
      keepAliveTime: 0
    },
    gpustack: {
      keepAliveTime: 0
    },
    vertexai: {
      serviceAccount: {
        privateKey: '',
        clientEmail: ''
      },
      projectId: '',
      location: ''
    }
  }
}

// 由于 isLocalAi 目前总是为false，该函数暂未被使用
// 需要投入使用时，应当保证返回值类型满足 LlmState 要求，而不是使用类型断言
const getIntegratedInitialState = () => {
  const model = JSON.parse(import.meta.env.VITE_RENDERER_INTEGRATED_MODEL)

  return {
    defaultModel: model,
    quickModel: model,
    providers: [
      {
        id: 'ollama',
        name: 'Ollama',
        apiKey: 'ollama',
        apiHost: 'http://localhost:15537/v1/',
        models: [model],
        isSystem: true,
        enabled: true
      }
    ],
    settings: {
      ollama: {
        keepAliveTime: 3600
      },
      lmstudio: {
        keepAliveTime: 3600
      },
      gpustack: {
        keepAliveTime: 3600
      }
    }
  } as LlmState
}

/**
 * 把 provider `id` 移到 **1-based 目标位置** `position`（结果数组里 `newProviders[position - 1]`
 * 就是被移动的那个 provider）。
 *
 * 定本：`splice` 在**已移除自己**的数组上按 `position - 1` 插入，结果数组的
 * `newProviders[position - 1]` 就是被移动的 provider——这正是「1-based 目标位置」的字面
 * 语义，被移者在目标之前或之后都成立（见 `store/__tests__/moveProvider.test.ts`）。
 * 审计曾疑「移除后偏移一位」，那是把语义读成了「按**移除前**的下标插入」；按该读法实现
 * 会把调用方给的 1-based 位置整体前移一格。迁移的 15 个调用点（'73' '78' '80' '92'
 * '104' '106' '112'×3 '118' '119' '157' '170' '183'）的可见结果均以本语义为准，
 * 故本次只补文档与顺序断言，不改行为。
 */
export const moveProvider = (providers: Provider[], id: string, position: number) => {
  const index = providers.findIndex((p) => p.id === id)
  if (index === -1) return providers

  const provider = providers[index]
  const newProviders = [...providers]
  newProviders.splice(index, 1)
  newProviders.splice(position - 1, 0, provider)
  return newProviders
}

const llmSlice = createSlice({
  name: 'llm',
  initialState: isLocalAi ? getIntegratedInitialState() : initialState,
  reducers: {
    updateProvider: (state, action: PayloadAction<Partial<Provider> & { id: string }>) => {
      const index = state.providers.findIndex((p) => p.id === action.payload.id)
      if (index !== -1) {
        Object.assign(state.providers[index], action.payload)
      }
    },
    updateProviders: (state, action: PayloadAction<Provider[]>) => {
      state.providers = action.payload
    },
    addProvider: (state, action: PayloadAction<Provider>) => {
      state.providers.unshift(action.payload)
    },
    removeProvider: (state, action: PayloadAction<Provider>) => {
      const providerIndex = state.providers.findIndex((p) => p.id === action.payload.id)
      if (providerIndex !== -1) {
        state.providers.splice(providerIndex, 1)
      }
    },
    addModel: (state, action: PayloadAction<{ providerId: string; model: Model }>) => {
      state.providers = state.providers.map((p) =>
        p.id === action.payload.providerId
          ? {
              ...p,
              models: uniqBy(p.models.concat(action.payload.model), 'id'),
              enabled: true
            }
          : p
      )
    },
    removeModel: (state, action: PayloadAction<{ providerId: string; model: Model }>) => {
      state.providers = state.providers.map((p) =>
        p.id === action.payload.providerId
          ? {
              ...p,
              models: p.models.filter((m) => m.id !== action.payload.model.id)
            }
          : p
      )
    },
    setDefaultModel: (state, action: PayloadAction<{ model: Model }>) => {
      state.defaultModel = action.payload.model
    },
    setQuickModel: (state, action: PayloadAction<{ model: Model }>) => {
      state.quickModel = action.payload.model
    },

    setQuickAssistantModel: (state, action: PayloadAction<{ model: Model | undefined }>) => {
      state.quickAssistantModel = action.payload.model
    },

    // 转述模型（识图通道补全）：undefined = 关闭（纯文本主模型收到图片时
    // 只剩 wire 占位文本，与 现状完全一致——门禁回收到未启用态）。
    setImageDescriberModel: (state, action: PayloadAction<{ model: Model | undefined }>) => {
      state.imageDescriberModel = action.payload.model
    },
    // 转述提示词（转述模型设置弹窗）：'' = 内置默认（@shared/config/imageDescriber）。
    setImageDescriberPrompt: (state, action: PayloadAction<string>) => {
      state.imageDescriberPrompt = action.payload
    },
    // 翻译模型（翻译页）：undefined = 未配置。
    setTranslateModel: (state, action: PayloadAction<{ model: Model | undefined }>) => {
      state.translateModel = action.payload.model
    },
    // 绘画模型（绘画页）：undefined = 未配置。
    setPaintingModel: (state, action: PayloadAction<{ model: Model | undefined }>) => {
      state.paintingModel = action.payload.model
    },
    setOllamaKeepAliveTime: (state, action: PayloadAction<number>) => {
      state.settings.ollama.keepAliveTime = action.payload
    },
    setLMStudioKeepAliveTime: (state, action: PayloadAction<number>) => {
      state.settings.lmstudio.keepAliveTime = action.payload
    },
    setGPUStackKeepAliveTime: (state, action: PayloadAction<number>) => {
      state.settings.gpustack.keepAliveTime = action.payload
    },
    updateModel: (
      state,
      action: PayloadAction<{
        providerId: string
        model: Model
      }>
    ) => {
      const provider = state.providers.find((p) => p.id === action.payload.providerId)
      if (provider) {
        const modelIndex = provider.models.findIndex((m) => m.id === action.payload.model.id)
        if (modelIndex !== -1) {
          provider.models[modelIndex] = action.payload.model
        }
      }
    }
  }
})

export const {
  updateProvider,
  updateProviders,
  addProvider,
  removeProvider,
  addModel,
  removeModel,
  setDefaultModel,
  setQuickModel,
  setQuickAssistantModel,
  setImageDescriberModel,
  setImageDescriberPrompt,
  setTranslateModel,
  setPaintingModel,
  setOllamaKeepAliveTime,
  setLMStudioKeepAliveTime,
  setGPUStackKeepAliveTime,
  updateModel
} = llmSlice.actions

export default llmSlice.reducer

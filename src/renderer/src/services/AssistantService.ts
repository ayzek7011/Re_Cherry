import { DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE } from '@renderer/config/constant'
import { getStoreProviders } from '@renderer/hooks/useStore'
import i18n from '@renderer/i18n'
import store from '@renderer/store'
import type { Assistant, AssistantSettings, AssistantWorkModeConfig, Provider, Topic } from '@renderer/types'
import { WORK_MODE_APPROVAL_TIERS } from '@shared/config/workMode'
import { v4 as uuid } from 'uuid'

import { getProviderByModel } from './ProviderService'

/**
 * Default assistant settings configuration template.
 *
 * **Important**: This defines the DEFAULT VALUES for assistant settings, NOT the current settings
 * of the default assistant. To get the actual settings of the default assistant, use `getDefaultAssistantSettings()`.
 *
 * Provides sensible defaults for all assistant settings with a focus on minimal parameter usage:
 * - **Temperature disabled**: Use provider defaults by default
 * - **MaxTokens disabled**: Use provider defaults by default
 * - **TopP disabled**: Use provider defaults by default
 * - **Streaming enabled**: Provides real-time response for better UX
 */
export const DEFAULT_ASSISTANT_SETTINGS = {
  maxTokens: DEFAULT_MAX_TOKENS,
  enableMaxTokens: false,
  temperature: DEFAULT_TEMPERATURE,
  enableTemperature: false,
  topP: 1,
  enableTopP: false,
  streamOutput: true,
  defaultModel: undefined,
  customParameters: [],
  reasoning_effort: 'default',
  reasoning_effort_cache: undefined,
  qwenThinkMode: undefined,
  // It would gracefully fallback to prompt if not supported by model.
  toolUseMode: 'function',
  maxToolCalls: 20,
  enableMaxToolCalls: true,
  messageIdentity: 'model'
} as const satisfies AssistantSettings

/**
 * 工作模式的助手级默认值：默认关闭，审批档位取最保守的"每次询问"（只读沙箱 + 逐调用审批）。
 * 见 packages/shared/config/workMode.ts 的三档词汇表。
 */
export const DEFAULT_ASSISTANT_WORK_MODE: AssistantWorkModeConfig = {
  defaultEnabled: false,
  approval: WORK_MODE_APPROVAL_TIERS[0]
}

/**
 * Creates a temporary default assistant instance.
 *
 * **Important**: This creates a NEW temporary assistant instance with DEFAULT_ASSISTANT_SETTINGS,
 * NOT the actual default assistant from Redux store. This is used as a template for creating
 * new assistants or as a fallback when no assistant is specified.
 *
 * To get the actual default assistant from Redux store (with current user settings), use:
 * ```typescript
 * const defaultAssistant = store.getState().assistants.defaultAssistant
 * ```
 *
 * @returns New temporary assistant instance with default settings
 */
export function getDefaultAssistant(): Assistant {
  return {
    id: 'default',
    name: i18n.t('chat.default.name'),
    emoji: '😀',
    prompt: '',
    topics: [getDefaultTopic('default')],
    messages: [],
    type: 'assistant',
    regularPhrases: [], // Added regularPhrases
    settings: DEFAULT_ASSISTANT_SETTINGS,
    workMode: { ...DEFAULT_ASSISTANT_WORK_MODE }
  }
}

export function getDefaultTopic(assistantId: string): Topic {
  return {
    id: uuid(),
    assistantId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    name: i18n.t('chat.default.topic.name'),
    messages: [],
    isNameManuallyEdited: false
  }
}

/**
 * 默认 provider = 默认模型所属的 provider。
 *
 * `getProviderByModel` 现在如实返回 `undefined`，本函数也不再回落到清单中的
 * **任意** provider（旧行为是 `defaultProvider || providers[0]`）。那会把「默认模型的
 * provider 已被删除」伪装成「找到了」，并把请求发到「外来 model.id + 别的 provider」上。
 * 需要回落的地方在**调用点**显式写（见 `hooks/useProvider.ts`、`MessagesService.checkRateLimit`）。
 */
export function getDefaultProvider(): Provider | undefined {
  return getProviderByModel(getDefaultModel())
}

export function getDefaultModel() {
  return store.getState().llm.defaultModel
}

export function getQuickModel() {
  return store.getState().llm.quickModel
}

/**
 * 助手当前使用的 provider。
 *
 * 显式回落顺序：助手模型所属 provider → 默认模型所属 provider。
 * 两级都查不到（助手未选模型、且默认 provider 不可用）时返回 `undefined`。
 * 调用方必须显式处理，不得假定一定拿到 provider。
 */
export function getAssistantProvider(assistant: Assistant): Provider | undefined {
  const providers = getStoreProviders()
  return providers.find((p) => p.id === assistant.model?.provider) ?? getDefaultProvider()
}

/**
 * 按模型解析 provider（三值契约）。
 *
 * 本函数不再有第二份实现：唯一实现在 `ProviderService.getProviderByModel`（纯查表），
 * 此处只做转发，返回值与它逐字一致：
 * - 命中 `model.provider` ⇒ 该 `Provider`；
 * - 未命中（provider 未配置、已被删除，或 `model` 为空）⇒ `undefined`，调用方**必须**显式处理。
 *
 * 旧实现找不到时静默回落到 `defaultProvider || providers[0]`，调用方无法区分
 * 「没有」与「有」。需要回落默认 provider 的地方，现在在调用点显式写。
 */
export { getProviderByModel }

/**
 * Retrieves and normalizes assistant settings with special transformation handling.
 *
 * **Special Transformations:**
 * 1. **Max Tokens**: Only returns a value when `enableMaxTokens` is true, otherwise returns `undefined`
 * 2. **Max Tokens Validation**: Ensures maxTokens > 0, falls back to `DEFAULT_MAX_TOKENS` if invalid
 * 3. **Fallback Defaults**: Applies system defaults for all undefined/missing settings
 *
 * @param assistant - The assistant instance to extract settings from
 * @returns Normalized assistant settings with all transformations applied
 */
export const getAssistantSettings = (assistant: Assistant): AssistantSettings => {
  const getAssistantMaxTokens = () => {
    if (assistant.settings?.enableMaxTokens) {
      const maxTokens = assistant.settings.maxTokens
      if (typeof maxTokens === 'number') {
        return maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS
      }
      return DEFAULT_MAX_TOKENS
    }
    return undefined
  }

  return {
    temperature: assistant?.settings?.temperature ?? DEFAULT_TEMPERATURE,
    enableTemperature: assistant?.settings?.enableTemperature ?? DEFAULT_ASSISTANT_SETTINGS.enableTemperature,
    topP: assistant?.settings?.topP ?? DEFAULT_ASSISTANT_SETTINGS.topP,
    enableTopP: assistant?.settings?.enableTopP ?? DEFAULT_ASSISTANT_SETTINGS.enableTopP,
    enableMaxTokens: assistant?.settings?.enableMaxTokens ?? DEFAULT_ASSISTANT_SETTINGS.enableMaxTokens,
    maxTokens: getAssistantMaxTokens(),
    streamOutput: assistant?.settings?.streamOutput ?? DEFAULT_ASSISTANT_SETTINGS.streamOutput,
    toolUseMode: assistant?.settings?.toolUseMode ?? DEFAULT_ASSISTANT_SETTINGS.toolUseMode,
    maxToolCalls: assistant?.settings?.maxToolCalls ?? DEFAULT_ASSISTANT_SETTINGS.maxToolCalls,
    enableMaxToolCalls: assistant?.settings?.enableMaxToolCalls ?? DEFAULT_ASSISTANT_SETTINGS.enableMaxToolCalls,
    defaultModel: assistant?.defaultModel ?? DEFAULT_ASSISTANT_SETTINGS.defaultModel,
    reasoning_effort: assistant?.settings?.reasoning_effort ?? DEFAULT_ASSISTANT_SETTINGS.reasoning_effort,
    customParameters: assistant?.settings?.customParameters ?? DEFAULT_ASSISTANT_SETTINGS.customParameters
  }
}

export function getAssistantById(id: string) {
  const assistants = store.getState().assistants.assistants
  return assistants.find((a) => a.id === id)
}

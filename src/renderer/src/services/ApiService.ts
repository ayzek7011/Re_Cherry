/**
 * 职责：提供原子化的、无状态的API调用函数
 * dsh 内核替换后：聊天/摘要/生成/健康检查全部走内核，本文件只保留
 * 图像生成（保留功能）、模型列表与 key 轮换等薄封装。
 */
import { loggerService } from '@logger'
import { isEmbeddingModel } from '@renderer/config/models'
import { getStoreSetting } from '@renderer/hooks/useSettings'
import i18n from '@renderer/i18n'
import { getEmbeddingDimensions } from '@renderer/services/embedding'
import { lightComplete } from '@renderer/services/lightLlm'
import type { Assistant, Model, Provider } from '@renderer/types'
import { isSystemProvider } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { formatApiHost, getDefaultGroupName, removeSpecialCharactersForTopicName } from '@renderer/utils'
import { getErrorMessage } from '@renderer/utils/error'
import { purifyMarkdownImages } from '@renderer/utils/markdown'
import { findFileBlocks, findImageBlocks, getMainTextContent } from '@renderer/utils/messageUtils/find'
import { containsSupportedVariables, replacePromptVariables } from '@renderer/utils/prompt'
import {
  isAnthropicProvider,
  isOllamaProvider,
  NOT_SUPPORT_API_KEY_PROVIDER_TYPES,
  NOT_SUPPORT_API_KEY_PROVIDERS
} from '@renderer/utils/provider'
import { isEmpty, takeRight } from 'lodash-es'

import {
  // getAssistantProvider,
  // getAssistantSettings,
  getDefaultAssistant,
  getDefaultModel,
  getProviderByModel,
  getQuickModel
} from './AssistantService'

const logger = loggerService.withContext('ApiService')

/**
 * 从消息中收集图像（用于图像编辑）
 * 收集用户消息中上传的图像和助手消息中生成的图像
 *
 * 识图/图像批次预置实现（复核九勘察、案底遗留节登记）：当前消息路径未接线，
 * 待识图批次启用（渲染层图片引用随 sendToKernel 的收集层）。
 */
export async function collectImagesFromMessages(userMessage: Message, assistantMessage?: Message): Promise<string[]> {
  const images: string[] = []

  // 收集用户消息中的图像
  const userImageBlocks = findImageBlocks(userMessage)
  for (const block of userImageBlocks) {
    if (block.file) {
      const { data } = await window.api.file.base64Image(block.file.name)
      images.push(data)
    }
  }

  // 收集助手消息中的图像（用于继续编辑生成的图像）
  if (assistantMessage) {
    const assistantImageBlocks = findImageBlocks(assistantMessage)
    for (const block of assistantImageBlocks) {
      if (block.file) {
        try {
          const { data } = await window.api.file.base64Image(block.file.name)
          images.push(data)
        } catch (error) {
          logger.error('Failed to load assistant image file, image will be excluded:', {
            fileName: block.file.name,
            error: error as Error
          })
        }
      } else if (block.url) {
        images.push(block.url)
      }
    }
  }

  return images
}

/** OpenAI 兼容图像生成：POST {apiHost}/images/generations。识图/图像批次预置（未接线）。 */
export async function generateImages(
  provider: Provider,
  model: string,
  prompt: string,
  imageSize: string,
  batchSize: number
): Promise<string[]> {
  const response = await fetch(`${provider.apiHost}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
    },
    body: JSON.stringify({ model, prompt, size: imageSize, n: batchSize })
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Image generation failed (${response.status}): ${detail.slice(0, 200)}`)
  }
  const data = (await response.json()) as { data?: { b64_json?: string; url?: string }[] }
  return (data.data ?? []).map((item) => item.b64_json ?? item.url ?? '').filter(Boolean)
}

/** OpenAI 兼容图像编辑：POST {apiHost}/images/edits（multipart，逐张编辑）。识图/图像批次预置（未接线）。 */
export async function editImages(
  provider: Provider,
  model: string,
  prompt: string,
  inputImages: string[],
  imageSize: string
): Promise<string[]> {
  const results: string[] = []
  for (const dataUrl of inputImages) {
    const blob = await (await fetch(dataUrl)).blob()
    const form = new FormData()
    form.append('model', model)
    form.append('prompt', prompt)
    form.append('size', imageSize)
    form.append('image', blob, `image.${blob.type.split('/')[1] ?? 'png'}`)
    const response = await fetch(`${provider.apiHost}/images/edits`, {
      method: 'POST',
      headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {},
      body: form
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Image edit failed (${response.status}): ${detail.slice(0, 200)}`)
    }
    const data = (await response.json()) as { data?: { b64_json?: string; url?: string }[] }
    results.push(...(data.data ?? []).map((item) => item.b64_json ?? item.url ?? '').filter(Boolean))
  }
  return results
}

export async function fetchMessagesSummary({
  messages
}: {
  messages: Message[]
}): Promise<{ text: string | null; error?: string }> {
  let prompt = getStoreSetting('topicNamingPrompt') || i18n.t('prompts.title')
  const model = getQuickModel()

  if (prompt && containsSupportedVariables(prompt)) {
    prompt = await replacePromptVariables(prompt, model.name)
  }

  // 总结上下文总是取最后5条消息
  const contextMessages = takeRight(messages, 5)
  const provider = getProviderByModel(model)

  // provider 查不到时**不**回落到清单里的任意 provider。回落会把请求发到
  // 「外来 model.id + 别的 provider」的组合上，用户只看到误导性的报错。此处如实失败。
  if (!provider) {
    logger.warn('fetchMessagesSummary: no provider for model', { modelId: model?.id, providerId: model?.provider })
    return { text: null, error: i18n.t('error.provider_not_found') }
  }

  if (!hasApiKey(provider)) {
    return { text: null, error: i18n.t('error.no_api_key') }
  }

  const conversation = JSON.stringify(
    contextMessages.map((message) => {
      const structredMessage = {
        role: message.role,
        mainText: purifyMarkdownImages(getMainTextContent(message))
      }

      // 让LLM知道消息中包含的文件，但只提供文件名
      const fileBlocks = findFileBlocks(message)
      let fileList: Array<string> = []
      if (fileBlocks.length && fileBlocks.length > 0) {
        fileList = fileBlocks.map((fileBlock) => fileBlock.file.origin_name)
      }
      return {
        ...structredMessage,
        files: fileList.length > 0 ? fileList : undefined
      }
    })
  )

  try {
    // 轻量内核：话题命名 = 一次性 completion（无 session 残留；思考缺省 off）
    const { text } = await lightComplete({
      provider: provider.id,
      model: model.id,
      system: prompt,
      messages: [{ role: 'user', text: conversation }],
      maxTokens: 128,
      source: 'cherry-topic-naming'
    })

    const result = removeSpecialCharactersForTopicName(text)
    return result ? { text: result } : { text: null, error: i18n.t('error.no_response') }
  } catch (error: unknown) {
    return { text: null, error: getErrorMessage(error) }
  }
}

/**
 * 单条笔记的标题/摘要（笔记移植，②薄适配）。
 *
 * V1 走 `AiProvider.completions`（老消息管线）；fork 统一走轻量内核一次性 completion
 * ——与话题命名同一条路：无 session 残留、思考缺省 off。失败/无 key 一律返回 null
 * （笔记的"AI 摘要"是可选增强，不该把错误抛到笔记页）。
 */
export async function fetchNoteSummary({
  content,
  assistant
}: {
  content: string
  assistant?: Assistant
}): Promise<string | null> {
  let prompt = getStoreSetting('topicNamingPrompt') || i18n.t('prompts.title')
  const resolvedAssistant = assistant || getDefaultAssistant()
  const model = getQuickModel() || resolvedAssistant.model || getDefaultModel()

  if (prompt && containsSupportedVariables(prompt)) {
    prompt = await replacePromptVariables(prompt, model.name)
  }

  const provider = getProviderByModel(model)

  // 查不到 provider 就如实失败。本函数用 `null` 表达失败，调用方
  // `useNotesEditing.handleAutoRename` 已对 `null` 弹 `notes.auto_rename.failed`，
  // 因此失败对用户可见；不静默回落到别的 provider 去猜。
  if (!provider) {
    logger.warn('fetchNoteSummary: no provider for model', { modelId: model?.id, providerId: model?.provider })
    return null
  }

  if (!hasApiKey(provider)) return null

  // V1 同口径：只取前 2000 字符、剥离图片引用
  const purifiedContent = purifyMarkdownImages(content.substring(0, 2000))

  try {
    const { text } = await lightComplete({
      provider: provider.id,
      model: model.id,
      system: prompt,
      messages: [{ role: 'user', text: purifiedContent }],
      maxTokens: 128,
      source: 'cherry-note-summary'
    })
    return removeSpecialCharactersForTopicName(text) || null
  } catch (error) {
    logger.warn('fetchNoteSummary failed', error as Error)
    return null
  }
}

/**
 * 一次性生成（搜索编排 / 记忆 / 错误诊断等）。
 *
 * 结果形状与 `fetchMessagesSummary` 对齐——`{ text: null, error }` 表达调用失败，
 * 而不是折叠成 `''`。旧实现把 401 / 超时 / 网络错都压成空字符串，调用方（错误诊断）只能把
 * 它读成"模型返回空"，真实原因只剩一行 warn。
 */
export async function fetchGenerate({
  prompt,
  content,
  model
}: {
  prompt: string
  content: string
  model?: Model
}): Promise<{ text: string | null; error?: string }> {
  if (!model) {
    model = getDefaultModel()
  }
  const provider = getProviderByModel(model)

  // provider 缺失是**调用失败**，不是「模型返回空」。回落到清单第一项会让
  // 诊断/搜索编排拿到一个与 model.id 不匹配的 provider，错误原因完全误导。
  if (!provider) {
    logger.warn('fetchGenerate: no provider for model', { modelId: model.id, providerId: model.provider })
    return { text: null, error: i18n.t('error.provider_not_found') }
  }

  if (!hasApiKey(provider)) {
    return { text: null, error: i18n.t('error.no_api_key') }
  }

  try {
    // 轻量内核：搜索编排/记忆/错误诊断等一次性生成（思考缺省 off）
    const { text } = await lightComplete({
      provider: provider.id,
      model: model.id,
      system: prompt,
      messages: [{ role: 'user', text: content }],
      source: 'cherry-generate'
    })
    const result = text?.trim() ?? ''
    return result ? { text: result } : { text: null, error: i18n.t('error.no_response') }
  } catch (error: unknown) {
    logger.warn('fetchGenerate failed via kernel', error as Error)
    return { text: null, error: getErrorMessage(error) }
  }
}

export function hasApiKey(provider: Provider) {
  if (!provider) return false
  if (
    (isSystemProvider(provider) && NOT_SUPPORT_API_KEY_PROVIDERS.includes(provider.id)) ||
    NOT_SUPPORT_API_KEY_PROVIDER_TYPES.includes(provider.type)
  )
    return true
  return !isEmpty(provider.apiKey)
}

/**
 * Get rotated API key for providers that support multiple keys
 * Returns empty string for providers that don't require API keys
 */
export function getRotatedApiKey(provider: Provider): string {
  // Handle providers that don't require API keys
  if (!provider.apiKey || provider.apiKey.trim() === '') {
    return ''
  }

  const keys = provider.apiKey
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)

  if (keys.length === 0) {
    return ''
  }

  const keyName = `provider:${provider.id}:last_used_key`

  // If only one key, return it directly
  if (keys.length === 1) {
    return keys[0]
  }

  const lastUsedKey = window.keyv.get(keyName)
  if (!lastUsedKey) {
    window.keyv.set(keyName, keys[0])
    return keys[0]
  }

  const currentIndex = keys.indexOf(lastUsedKey)

  // Log when the last used key is no longer in the list
  if (currentIndex === -1) {
    logger.debug('Last used API key no longer found in provider keys, falling back to first key', {
      providerId: provider.id,
      lastUsedKey: lastUsedKey.substring(0, 8) + '...' // Only log first 8 chars for security
    })
  }

  const nextIndex = (currentIndex + 1) % keys.length
  const nextKey = keys[nextIndex]
  window.keyv.set(keyName, nextKey)

  return nextKey
}

/** OpenAI 兼容 /models 响应解析失败时携带的用户可读原因（动态服务端文本）。 */
export interface ProviderModelListResult {
  models: Model[]
  ok: boolean
  error?: string
}

/** 不提供在线模型列表的协议族（返回显式错误而非静默静态回退）。 */
// copilot 在 RC 配置中是 type 'openai'（走 OAuth），不在此列；真不支持列表的是下列协议族。
const UNLISTABLE_PROVIDER_TYPES = new Set<string>([
  'gemini',
  'azure-openai',
  'vertexai',
  'aws-bedrock',
  'vertex-anthropic'
])

function httpErrorMessage(response: Response): string {
  const status = response.status
  if (response.status === 401 || response.status === 403) {
    return status + ' unauthorized'
  }
  if (response.status === 404) {
    return '404 not found (check apiHost and whether the endpoint exposes a model list)'
  }
  return String(status)
}

async function readErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text()
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
    if (typeof parsed === 'object') {
      const msg = parsed.error
        ? typeof parsed.error === 'string'
          ? parsed.error
          : parsed.error.message
        : parsed.message
      if (msg && typeof msg === 'string' && msg.trim()) {
        return msg.trim().slice(0, 300)
      }
    }
    return text.slice(0, 300) || undefined
  } catch {
    return undefined
  }
}

/**
 * 拉取模型行的默认分组（对齐 CS 上游 listModels 的 defaultGroup 规则）：
 * - 系统商：取模型 id 首个 '/' 前的组织前缀（如 silicon 的 deepseek-ai/Qwen/BAAI）；无 '/' 则用 provider.id；
 * - 自建商（isSystem === false）：走 getDefaultGroupName 启发式（按 /、空格、:、-、_ 拆前缀）。
 */
function defaultModelGroup(modelId: string, provider: Provider): string {
  if (provider.isSystem === false) {
    return getDefaultGroupName(modelId, provider.id)
  }
  const parts = modelId.split('/')
  return parts.length > 1 ? parts[0] : provider.id
}

/**
 * 拉取 provider 模型列表。
 *
 * 策略分派（参考 CS 上游 listModels 的协议差异）：
 * - anthropic：GET {base}/v1/models，x-api-key + anthropic-version 头
 * - ollama：GET {base}/api/tags（返回 { models: [{ name, model }] }）
 * - 其余 openai 兼容（openai/openai-response/new-api/gateway/mistral 及多数系统商）：
 *   GET {base}/models，base 经 formatApiHost 规范化（自动补 /v1、去尾斜杠与 '#'）
 * - gemini/azure-openai/vertexai/aws-bedrock/vertex-anthropic/copilot：显式不支持
 *
 * 失败不再静默回退静态列表：返回 { ok: false, error } 由调用方展示；
 * SYSTEM_MODELS 静态目录的'补齐展示'由 UI 层合并，与本函数解耦。
 */
export async function fetchProviderModelList(provider: Provider): Promise<ProviderModelListResult> {
  const fallbackError = (e: unknown): ProviderModelListResult => {
    logger.error('Failed to fetch models from provider', {
      providerId: provider.id,
      providerName: provider.name,
      error: e instanceof Error ? e.message : String(e)
    })
    return { models: [], ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  if (UNLISTABLE_PROVIDER_TYPES.has(provider.type)) {
    return {
      models: [],
      ok: false,
      error: 'provider type "' + provider.type + '" does not expose a model list endpoint'
    }
  }

  const apiHost = provider.apiHost
  if (!apiHost) {
    return { models: [], ok: false, error: 'apiHost is not configured' }
  }

  try {
    // Anthropic 官方/兼容端点：/v1/models，专用鉴权头，返回 { data: [{id, display_name}] }
    if (isAnthropicProvider(provider) || provider.type === 'anthropic') {
      const baseUrl = formatApiHost(apiHost)
      const headers: Record<string, string> = {
        'x-api-key': provider.apiKey ?? '',
        'anthropic-version': '2023-06-01'
      }
      const response = await fetch(baseUrl + '/models?limit=1000', { headers })
      if (!response.ok) {
        return { models: [], ok: false, error: 'List models failed (' + httpErrorMessage(response) + ')' }
      }
      const data = (await response.json()) as { data?: { id: string; display_name?: string }[] }
      const models = (data.data ?? []).map((item) => ({
        id: item.id,
        name: item.display_name || item.id,
        provider: provider.id,
        group: defaultModelGroup(item.id, provider)
      }))
      return { models, ok: true }
    }

    // Ollama 本地服务：/api/tags，返回 { models: [{ name, model }] }
    if (isOllamaProvider(provider)) {
      const baseUrl = formatApiHost(apiHost)
        .replace(/\/v1$/, '')
        .replace(/\/api$/, '')
      const response = await fetch(baseUrl + '/api/tags')
      if (!response.ok) {
        return { models: [], ok: false, error: 'List models failed (' + httpErrorMessage(response) + ')' }
      }
      const data = (await response.json()) as { models?: { name: string; model?: string }[] }
      const models = (data.models ?? []).map((item) => ({
        id: item.model || item.name,
        name: item.name,
        provider: provider.id,
        group: defaultModelGroup(item.name, provider)
      }))
      return { models, ok: true }
    }

    // OpenAI 兼容端点：GET {base}/models
    const baseUrl = formatApiHost(apiHost)
    const response = await fetch(baseUrl + '/models', {
      headers: provider.apiKey ? { Authorization: 'Bearer ' + provider.apiKey } : {}
    })
    if (!response.ok) {
      const detail = await readErrorDetail(response)
      return { models: [], ok: false, error: detail ?? 'List models failed (' + httpErrorMessage(response) + ')' }
    }
    const data = (await response.json()) as { data?: { id: string; owned_by?: string }[] }
    const models = (data.data ?? []).map((item) => ({
      id: item.id,
      name: item.id,
      provider: provider.id,
      group: defaultModelGroup(item.id, provider)
    }))
    return { models, ok: true }
  } catch (error) {
    return fallbackError(error)
  }
}

export function checkApiProvider(provider: Provider): void {
  const isExcludedProvider =
    (isSystemProvider(provider) && NOT_SUPPORT_API_KEY_PROVIDERS.includes(provider.id)) ||
    NOT_SUPPORT_API_KEY_PROVIDER_TYPES.includes(provider.type)

  if (!isExcludedProvider) {
    if (!provider.apiKey) {
      window.toast.error(i18n.t('message.error.enter.api.label'))
      throw new Error(i18n.t('message.error.enter.api.label'))
    }
  }

  if (!provider.apiHost && provider.type !== 'vertexai') {
    window.toast.error(i18n.t('message.error.enter.api.host'))
    throw new Error(i18n.t('message.error.enter.api.host'))
  }

  if (isEmpty(provider.models)) {
    window.toast.error(i18n.t('message.error.enter.model'))
    throw new Error(i18n.t('message.error.enter.model'))
  }
}

/**
 * Validates that a provider/model pair is working by sending a minimal request.
 * @param provider - The provider configuration to test.
 * @param model - The model to use for the validation request (chat or embeddings).
 * @param timeout - Maximum time (ms) to wait for the request to complete. Defaults to 15000 ms.
 * @throws {Error} If the request fails or times out, indicating the API is not usable.
 */
export async function checkApi(provider: Provider, model: Model, timeout = 15000): Promise<void> {
  checkApiProvider(provider)

  if (isEmbeddingModel(model)) {
    logger.info('checkApi: embedding model detected, calling getEmbeddingDimensions', { modelId: model.id })
    const timerPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
    await Promise.race([getEmbeddingDimensions(provider, model), timerPromise])
    return
  }

  // 轻量内核：健康检查 = 一次性 completion 的 'hi' ping（思考缺省 off）
  const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
  await Promise.race([
    lightComplete({
      provider: provider.id,
      model: model.id,
      messages: [{ role: 'user', text: 'hi' }],
      maxTokens: 16,
      source: 'cherry-api-check'
    }),
    timeoutPromise
  ])
}

export async function checkModel(provider: Provider, model: Model, timeout = 15000): Promise<{ latency: number }> {
  const startTime = performance.now()
  await checkApi(provider, model, timeout)
  return { latency: performance.now() - startTime }
}

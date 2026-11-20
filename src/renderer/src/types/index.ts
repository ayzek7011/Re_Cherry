import type { LanguageModelV3Source } from '@ai-sdk/provider'
import type { WebSearchResultBlock } from '@anthropic-ai/sdk/resources'
import type OpenAI from '@cherrystudio/openai'
import type { GroundingMetadata } from '@google/genai'
import type { WorkModeApprovalTier } from '@shared/config/workMode'
import type { CSSProperties } from 'react'

export * from './file'
export * from './note'

import * as z from 'zod'

import type { KnowledgeBase, KnowledgeReference } from './knowledge'
import type { MCPConfigSample, MCPServerInstallSource, McpServerType } from './mcp'
import type { Message } from './newMessage'
import type { BaseTool, MCPTool } from './tool'

export * from './agent'
export * from './knowledge'
export * from './mcp'
export * from './notification'
export * from './provider'
export * from './serialize'
export * from './skill'

export type McpMode = 'disabled' | 'auto' | 'manual'

/**
 * 工作模式的助手级默认配置（Step 0 数据层；Step 5 起在智能体设置的"基础/权限模式"页编辑）。
 * 话题各自的开关状态跟话题走（Topic.workMode，随 redux-persist 持久化），未拨过的新话题取这里的 defaultEnabled 播种。
 */
export type AssistantWorkModeConfig = {
  /** 新话题的初始开关状态。 */
  defaultEnabled: boolean
  /** 工作目录＝沙箱允许读写的边界；空 = 未设置（Step 3 接入真工具时生效）。 */
  workingDir?: string
  /** 审批档位（dsh 权限预设名，与沙箱模式 1:1，见 @shared/config/workMode）。 */
  approval: WorkModeApprovalTier
}

export type Assistant = {
  id: string
  name: string
  prompt: string
  knowledge_bases?: KnowledgeBase[]
  topics: Topic[]
  type: string
  emoji?: string
  description?: string
  model?: Model
  defaultModel?: Model
  // This field should be considered as not Partial and not optional in v2
  settings?: Partial<AssistantSettings>
  messages?: AssistantMessage[]
  /** enableWebSearch 代表使用模型内置网络搜索功能 */
  enableWebSearch?: boolean
  webSearchProviderId?: WebSearchProvider['id']
  // enableUrlContext 是 Gemini/Anthropic 的特有功能
  enableUrlContext?: boolean
  enableGenerateImage?: boolean
  /** MCP mode: 'disabled' (no MCP), 'auto' (hub server only), 'manual' (user selects servers) */
  mcpMode?: McpMode
  mcpServers?: MCPServer[]
  knowledgeRecognition?: 'off' | 'on'
  regularPhrases?: QuickPhrase[] // Added for regular phrase
  tags?: string[] // 助手标签
  /** 工作模式默认配置（新话题开关的播种来源；工作目录与审批档位的助手级默认值）。 */
  workMode?: AssistantWorkModeConfig
  /**
   * 内置工具开关（稀疏 map，缺省 = 开，默认全开；工具页"内置工具"区编辑）。
   * 内置工具 = 未开启工作模式也可用的模型工具（见 @shared/config/agentTools），
   * 随发送参数进内核按开关挂载，拨动下一轮生效。
   */
  builtinTools?: Record<string, boolean>
  /**
   * 外置工具开关（稀疏 map，缺省 = 开，默认全开；工具页"外置工具"区编辑）。
   * 外置工具 = 工作模式开启时才挂载的文件/命令工具（见 @shared/config/agentTools），
   * 随发送参数进内核按开关挂载，拨动下一轮生效。
   */
  externalTools?: Record<string, boolean>
  /**
   * 按助手启用的技能（skill folderName 列表；技能系统 加回）。
   * 仅 UI 状态持久化，触发机制 接线。
   */
  enabledSkills?: string[]
}

/**
 * Get the effective MCP mode for an assistant with backward compatibility.
 * Legacy assistants without mcpMode default based on mcpServers presence.
 */
export function getEffectiveMcpMode(assistant: Assistant): McpMode {
  if (assistant.mcpMode) return assistant.mcpMode
  return (assistant.mcpServers?.length ?? 0) > 0 ? 'manual' : 'disabled'
}

export type AssistantsSortType = 'tags' | 'list'

export type AssistantMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type AssistantSettingCustomParameters = {
  name: string
  value: string | number | boolean | object
  type: 'string' | 'number' | 'boolean' | 'json'
}

const ThinkModelTypes = [
  'default',
  'o',
  'openai_deep_research',
  'gpt5',
  'gpt5_1',
  'gpt5_codex',
  'gpt5_1_codex',
  'gpt5_1_codex_max',
  'gpt5_2_codex',
  'gpt5_2',
  'gpt5pro',
  'gpt52pro',
  'gpt_oss',
  'grok',
  'grok4_fast',
  'grok_4_3',
  'gemini2_flash',
  'gemini2_pro',
  'gemini3_flash',
  'gemini3_pro',
  'gemini3_1_pro',
  'gemma4_hosted',
  'qwen',
  'qwen_thinking',
  'doubao',
  'doubao_no_auto',
  'doubao_after_251015',
  'mimo',
  'hunyuan',
  'zhipu',
  'perplexity',
  'deepseek_hybrid',
  'deepseek_v4',
  'kimi_k2_5',
  'claude',
  'claude46',
  'mistral'
] as const

/** If the model's reasoning effort could be controlled, or its reasoning behavior could be turned on/off.
 * It's basically based on OpenAI's reasoning effort, but we have adapted it for other models.
 *
 * Possible options:
 * - 'none': Disable reasoning for the model. (inherit from OpenAI)
 *            It's also used as "off" when the reasoning behavior of the model only could be set to "on" and "off".
 * - 'minimal': Enable minimal reasoning effort for the model. (inherit from OpenAI, only for few models, such as GPT-5.)
 * - 'low': Enable low reasoning effort for the model. (inherit from OpenAI)
 * - 'medium': Enable medium reasoning effort for the model. (inherit from OpenAI)
 * - 'high': Enable high reasoning effort for the model. (inherit from OpenAI)
 * - 'xhigh': Enable extra high reasoning effort for the model. (inherit from OpenAI)
 * - 'auto': Automatically determine the reasoning effort based on the model's capabilities.
 *            For some providers, it's same with 'default'.
 *            It's also used as "on" when the reasoning behavior of the model only could be set to "on" and "off".
 * - 'default': Depend on default behavior. It means we would not set any reasoning related settings when calling API.
 */
export type ReasoningEffortOption = NonNullable<OpenAI.ReasoningEffort> | 'max' | 'auto' | 'default'
export type ThinkingOption = ReasoningEffortOption
export type ThinkingModelType = (typeof ThinkModelTypes)[number]
export type ThinkingOptionConfig = Record<ThinkingModelType, ThinkingOption[]>
export type ReasoningEffortConfig = Record<ThinkingModelType, ReasoningEffortOption[]>
export type EffortRatio = Record<ReasoningEffortOption, number>

export function isThinkModelType(type: string): type is ThinkingModelType {
  return ThinkModelTypes.some((t) => t === type)
}

export const EFFORT_RATIO: EffortRatio = {
  // 'default' is not expected to be used.
  default: 0,
  none: 0.01,
  minimal: 0.05,
  low: 0.05,
  medium: 0.5,
  high: 0.8,
  xhigh: 0.9,
  max: 1,
  auto: 2
}

export type AssistantSettings = {
  maxTokens?: number
  enableMaxTokens?: boolean
  temperature: number
  enableTemperature?: boolean
  topP: number
  enableTopP?: boolean
  streamOutput: boolean
  defaultModel?: Model
  customParameters?: AssistantSettingCustomParameters[]
  reasoning_effort: ReasoningEffortOption
  /**
   * Preserve the effective reasoning effort (not 'default') from the last use of a thinking model which supports thinking control,
   * and restore it when switching back from a non-thinking or fixed reasoning model.
   * FIXME: It should be managed by external cache service instead of being stored in the assistant
   */
  reasoning_effort_cache?: ReasoningEffortOption
  qwenThinkMode?: boolean
  toolUseMode: 'function' | 'prompt'
  maxToolCalls?: number
  enableMaxToolCalls?: boolean
  /**
   * 对话页头部显示挡位（助手级，默认 'model'）：
   * 'model' = 原版模型头像 + 模型名；'assistant' = 助手标识 + 助手名，模型名进时间戳右侧。
   */
  messageIdentity?: 'model' | 'assistant'
}

export type Usage = OpenAI.Completions.CompletionUsage & {
  thoughts_tokens?: number
  // OpenRouter specific fields
  cost?: number
}

export type Metrics = {
  completion_tokens: number
  time_completion_millsec: number
  time_first_token_millsec?: number
  time_thinking_millsec?: number
}

export enum TopicType {
  Chat = 'chat',
  Session = 'session'
}

export type Topic = {
  id: string
  type?: TopicType
  assistantId: string
  name: string
  createdAt: string
  updatedAt: string
  messages: Message[]
  pinned?: boolean
  prompt?: string
  isNameManuallyEdited?: boolean
  /** 分支血缘：有值 = 由内核 fork 创建的分支子话题（值为父话题 id）；侧栏/话题列表只显示根（无此字段）。 */
  parentTopicId?: string
  /** 家族浏览记忆（记在根话题行上）：该分支家族最后浏览的成员 topic id；缺省 = 看主分支；指向的分支被删时自然落回根。 */
  lastViewedBranchId?: string
  /** 分支意图：regenerate = 对模型回复重新生成（应共享原用户节点、长新回复节点）；resend = 对用户消息重发/编辑重发（新开用户节点）；parallel = 切换模型回答的隐藏旁答子会话（旁答经家族投影并进主视图卡片组，不进侧栏/分叉图/页码）。 */
  branchKind?: 'resend' | 'regenerate' | 'parallel'
  /** 工作模式开关的渲染层镜像（权威在内核话题注册表；缺省 = 关）。 */
  workMode?: boolean
}

export type User = {
  id: string
  name: string
  avatar: string
  email: string
}

/**
 * 模型能力类型。`image_generation` 对应 V2 的 `MODEL_CAPABILITY.IMAGE_GENERATION`
 * （`cherry-studio v2/packages/provider-registry/src/schemas/enums.ts`），由
 * `isGenerateImageModel` 读取；用户可在「编辑模型」里手选覆盖（`isUserSelected`）。
 */
export type ModelType =
  | 'text'
  | 'vision'
  | 'embedding'
  | 'reasoning'
  | 'function_calling'
  | 'web_search'
  | 'rerank'
  | 'image_generation'

export type ModelTag = Exclude<ModelType, 'text'> | 'free'

// "image-generation" is also openai endpoint, but specifically for image generation.
export const EndPointTypeSchema = z.enum([
  'openai',
  'openai-response',
  'anthropic',
  'gemini',
  'image-generation',
  'jina-rerank'
])
export type EndpointType = z.infer<typeof EndPointTypeSchema>

export type ModelPricing = {
  input_per_million_tokens: number
  output_per_million_tokens: number
  currencySymbol?: string
}

export type ModelCapability = {
  type: ModelType
  /**
   * 是否为用户手动选择，如果为true，则表示用户手动选择了该类型，否则表示用户手动禁止了该模型；如果为undefined，则表示使用默认值
   * Is it manually selected by the user? If true, it means the user manually selected this type; otherwise, it means the user  * manually disabled the model.
   */
  isUserSelected?: boolean
}

export type Model = {
  id: string
  provider: string
  name: string
  group: string
  owned_by?: string
  description?: string
  capabilities?: ModelCapability[]
  /**
   * @deprecated
   */
  type?: ModelType[]
  pricing?: ModelPricing
  endpoint_type?: EndpointType
  supported_endpoint_types?: EndpointType[]
  supported_text_delta?: boolean
}

export type MinAppType = {
  id: string
  name: string
  /** i18n key for translatable names */
  nameKey?: string
  /** Regions where this app is available. If includes 'Global', shown to international users. */
  supportedRegions?: MinAppRegion[]
  logo?: string
  url: string
  // FIXME: It should be `bordered`
  bodered?: boolean
  background?: string
  style?: CSSProperties
  addTime?: string
  type?: 'Custom' | 'Default' // Added the 'type' property
}

/** Region types for miniapps visibility */
export type MinAppRegion = 'CN' | 'Global'

export type MinAppRegionFilter = 'auto' | MinAppRegion

export enum ThemeMode {
  light = 'light',
  dark = 'dark',
  system = 'system'
}

/** 有限的UI语言（i18n 收敛为 zh-CN / en-US，其余语言包已删） */
export type LanguageVarious = 'zh-CN' | 'en-US'

export type CodeStyleVarious = 'auto' | string

export type WebDavConfig = {
  webdavHost: string
  webdavUser?: string
  webdavPass?: string
  webdavPath?: string
  fileName?: string
  skipBackupFile?: boolean
  disableStream?: boolean
}

export type AppInfo = {
  version: string
  isPackaged: boolean
  appPath: string
  configPath: string
  appDataPath: string
  resourcesPath: string
  filesPath: string
  logsPath: string
  arch: string
  isPortable: boolean
  installPath: string
}

export interface Shortcut {
  key: string
  shortcut: string[]
  editable: boolean
  enabled: boolean
  system: boolean
}

// `ProcessingStatus` 的定义唯一化在 `./knowledge`（`KnowledgeItem.processingStatus` 的归属类型），
// 这里原先另有一份逐字重复的本地声明——本地声明会遮蔽 barrel 导出，任一边增删状态都会让
// `@renderer/types` 消费方与 `KnowledgeItem` 静默分叉。现改为再导出同一份。
export type { ProcessingStatus } from './knowledge'

export type GenerateImageResponse = {
  type: 'url' | 'base64'
  images: string[]
}

export type SidebarIcon = 'assistants' | 'minapp' | 'files' | 'knowledge' | 'translate' | 'paintings' | 'notes' | 'code'

export type { PaintingParams, PaintingRecord } from './painting'
export type { MessageTranslationRecord, TranslateLanguageSelection, TranslateRecord } from './translate'
export type { UsageRecord } from './usage'

export type ExternalToolResult = {
  mcpTools?: MCPTool[]
  toolUse?: MCPToolResponse[]
  webSearch?: WebSearchResponse
  knowledge?: KnowledgeReference[]
}

export const WebSearchProviderIds = {
  zhipu: 'zhipu',
  tavily: 'tavily',
  searxng: 'searxng',
  exa: 'exa',
  'exa-mcp': 'exa-mcp',
  bocha: 'bocha',
  querit: 'querit',
  'local-google': 'local-google',
  'local-bing': 'local-bing',
  'local-baidu': 'local-baidu'
} as const

export type WebSearchProviderId = keyof typeof WebSearchProviderIds

export const isWebSearchProviderId = (id: string): id is WebSearchProviderId => {
  return Object.hasOwn(WebSearchProviderIds, id)
}

export type WebSearchProvider = {
  id: WebSearchProviderId
  name: string
  apiKey?: string
  apiHost?: string
  engines?: string[]
  url?: string
  basicAuthUsername?: string
  basicAuthPassword?: string
  usingBrowser?: boolean
  topicId?: string
  allowedTools?: string[]
  parentSpanId?: string
  modelName?: string
}

export type WebSearchProviderResult = {
  title: string
  content: string
  url: string
}

export type WebSearchProviderResponse = {
  query?: string
  results: WebSearchProviderResult[]
  /** 压缩摘要（WebSearchService.applyCompression 实际生效时附加；none/未压缩无此字段）。
   * web_search 工具据此在结果文本里向用户报告压缩启用状态与前后条数。 */
  compression?: { method: string; before: number; after: number; error?: string }
}

export type AISDKWebSearchResult = Omit<Extract<LanguageModelV3Source, { sourceType: 'url' }>, 'sourceType'>

export type WebSearchResults =
  | WebSearchProviderResponse
  | GroundingMetadata
  | OpenAI.Chat.Completions.ChatCompletionMessage.Annotation.URLCitation[]
  | OpenAI.Responses.ResponseOutputText.URLCitation[]
  | WebSearchResultBlock[]
  | AISDKWebSearchResult[]
  | any[]

export const WEB_SEARCH_SOURCE = {
  WEBSEARCH: 'websearch',
  OPENAI: 'openai',
  OPENAI_RESPONSE: 'openai-response',
  OPENROUTER: 'openrouter',
  ANTHROPIC: 'anthropic',
  GEMINI: 'gemini',
  PERPLEXITY: 'perplexity',
  QWEN: 'qwen',
  HUNYUAN: 'hunyuan',
  ZHIPU: 'zhipu',
  GROK: 'grok',
  AISDK: 'ai-sdk'
} as const

export const WebSearchSourceSchema = z.enum(objectValues(WEB_SEARCH_SOURCE))

export type WebSearchSource = z.infer<typeof WebSearchSourceSchema>

export type WebSearchResponse = {
  results?: WebSearchResults
  source: WebSearchSource
}

export type WebSearchPhase = 'default' | 'fetch_complete' | 'rag' | 'rag_complete' | 'rag_failed' | 'cutoff'

export type WebSearchStatus = {
  phase: WebSearchPhase
  countBefore?: number
  countAfter?: number
}

// TODO: 把 mcp 相关类型定义迁移到独立文件中
export interface MCPServer {
  id: string // internal id
  name: string // mcp name, generally as unique key
  type?: McpServerType | 'inMemory'
  description?: string
  baseUrl?: string
  command?: string
  registryUrl?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string> // Custom headers to be sent with requests to this server
  provider?: string // Provider name for this server like ModelScope, Higress, etc.
  providerUrl?: string // URL of the MCP server in provider's website or documentation
  logoUrl?: string // URL of the MCP server's logo
  tags?: string[] // List of tags associated with this server
  longRunning?: boolean // Whether the server is long running
  timeout?: number // Timeout in seconds for requests to this server, default is 60 seconds
  dxtVersion?: string // Version of the DXT package
  dxtPath?: string // Path where the DXT package was extracted
  reference?: string // Reference link for the server, e.g., documentation or homepage
  searchKey?: string
  configSample?: MCPConfigSample
  /** List of tool names that are disabled for this server */
  disabledTools?: string[]
  /** Whether to auto-approve tools for this server */
  disabledAutoApproveTools?: string[]

  /** 用于标记内置 MCP 是否需要配置 */
  shouldConfig?: boolean
  /** 用于标记服务器是否运行中 */
  isActive: boolean
  /** 标记 MCP 安装来源，例如 builtin/manual/protocol */
  installSource?: MCPServerInstallSource
  /** 指示用户是否已信任该 MCP */
  isTrusted?: boolean
  /** 首次标记为信任的时间戳 */
  trustedAt?: number
  /** 安装时间戳 */
  installedAt?: number
}

export type BuiltinMCPServer = MCPServer & {
  type: 'inMemory'
  name: BuiltinMCPServerName
}

export const isBuiltinMCPServer = (server: MCPServer): server is BuiltinMCPServer => {
  return server.type === 'inMemory' && isBuiltinMCPServerName(server.name)
}

export const BuiltinMCPServerNames = {
  flomo: '@cherry/flomo',
  mcpAutoInstall: '@cherry/mcp-auto-install',
  memory: '@cherry/memory',
  sequentialThinking: '@cherry/sequentialthinking',
  braveSearch: '@cherry/brave-search',
  fetch: '@cherry/fetch',
  filesystem: '@cherry/filesystem',
  difyKnowledge: '@cherry/dify-knowledge',
  python: '@cherry/python',
  didiMCP: '@cherry/didi-mcp',
  browser: '@cherry/browser',
  nowledgeMem: '@cherry/nowledge-mem',
  hub: '@cherry/hub'
} as const

export type BuiltinMCPServerName = (typeof BuiltinMCPServerNames)[keyof typeof BuiltinMCPServerNames]

export const BuiltinMCPServerNamesArray = Object.values(BuiltinMCPServerNames)

export const isBuiltinMCPServerName = (name: string): name is BuiltinMCPServerName => {
  return BuiltinMCPServerNamesArray.some((n) => n === name)
}

export interface MCPPromptArguments {
  name: string
  description?: string
  required?: boolean
}

export interface MCPPrompt {
  id: string
  name: string
  description?: string
  arguments?: MCPPromptArguments[]
  serverId: string
  serverName: string
}

export interface MCPConfig {
  servers: MCPServer[]
  isUvInstalled: boolean
  isBunInstalled: boolean
}

export type MCPToolResponseStatus = 'pending' | 'streaming' | 'cancelled' | 'invoking' | 'done' | 'error'

interface BaseToolResponse {
  id: string // unique id
  tool: BaseTool | MCPTool
  arguments: Record<string, unknown> | Record<string, unknown>[] | string | undefined
  status: MCPToolResponseStatus
  response?: any
  // Streaming arguments support
  partialArguments?: string // Accumulated partial JSON string during streaming
}

export interface ToolUseResponse extends BaseToolResponse {
  toolUseId: string
}

export interface ToolCallResponse extends BaseToolResponse {
  // gemini tool call id might be undefined
  toolCallId?: string
}

// export type MCPToolResponse = ToolUseResponse | ToolCallResponse
export interface MCPToolResponse extends Omit<ToolUseResponse | ToolCallResponse, 'tool'> {
  tool: MCPTool
  toolCallId?: string
  toolUseId?: string
  parentToolUseId?: string
}

export interface NormalToolResponse extends Omit<ToolCallResponse, 'tool'> {
  tool: BaseTool
  toolCallId: string
  parentToolUseId?: string
}

export interface MCPToolResultContent {
  type: 'text' | 'image' | 'audio' | 'resource'
  text?: string
  data?: string
  mimeType?: string
  resource?: {
    uri?: string
    text?: string
    mimeType?: string
    blob?: string
  }
}

export interface MCPCallToolResponse {
  content: MCPToolResultContent[]
  structuredContent?: unknown
  isError?: boolean
}

export interface MCPResource {
  serverId: string
  serverName: string
  uri: string
  name: string
  description?: string
  mimeType?: string
  size?: number
  text?: string
  blob?: string
}

export interface QuickPhrase {
  id: string
  title: string
  content: string
  createdAt: number
  updatedAt: number
  order?: number
}

export interface Citation {
  number: number
  url: string
  title?: string
  hostname?: string
  content?: string
  showFavicon?: boolean
  type?: string
  metadata?: Record<string, any>
}

export type MathEngine = 'KaTeX' | 'MathJax' | 'none'

export interface StoreSyncAction {
  type: string
  payload: any
  meta?: {
    fromSync?: boolean
    source?: string
  }
}

export type S3Config = {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  root?: string
  fileName?: string
  skipBackupFile: boolean
  autoSync: boolean
  syncInterval: number
  maxBackups: number
}

export type { Message } from './newMessage'
export * from './tool'

export type EditorView = 'preview' | 'source' | 'read' // 实时,源码,预览
// ========================================================================

/**
 * 获取对象的所有键名，并保持类型安全
 * @param obj - 要获取键名的对象
 * @returns 对象的所有键名数组，类型为对象键名的联合类型
 * @example
 * ```ts
 * const obj = { foo: 1, bar: 'hello' };
 * const keys = objectKeys(obj); // ['foo', 'bar']
 * ```
 */
export function objectKeys<T extends object>(obj: T): (keyof T)[] {
  return Object.keys(obj) as (keyof T)[]
}

/**
 * 将对象转换为键值对数组，保持类型安全
 * @template T - 对象类型
 * @param obj - 要转换的对象
 * @returns 键值对数组，每个元素是一个包含键和值的元组
 * @example
 * const obj = { name: 'John', age: 30 };
 * const entries = objectEntries(obj); // [['name', 'John'], ['age', 30]]
 */
export function objectEntries<T extends object>(obj: T): [keyof T, T[keyof T]][] {
  return Object.entries(obj) as [keyof T, T[keyof T]][]
}

/**
 * 将对象转换为键值对数组，提供更严格的类型检查
 * @template T - 对象类型，键必须是string、number或symbol，值可以是任意类型
 * @param obj - 要转换的对象
 * @returns 键值对数组，每个元素是一个包含键和值的元组，类型完全对应原对象的键值类型
 * @example
 * const obj = { name: 'John', age: 30 };
 * const entries = objectEntriesStrict(obj); // [['name', string], ['age', number]]
 */
export function objectEntriesStrict<T extends Record<string | number | symbol, unknown>>(
  obj: T
): { [K in keyof T]: [K, T[K]] }[keyof T][] {
  return Object.entries(obj) as { [K in keyof T]: [K, T[K]] }[keyof T][]
}

/**
 * 获取对象所有值的类型安全版本
 * @template T - 对象类型
 * @param obj - 要获取值的对象
 * @returns 对象值组成的数组
 * @example
 * const obj = { a: 1, b: 2 } as const;
 * const values = objectValues(obj); // (1 | 2)[]
 */
export function objectValues<T extends Record<string, unknown>>(obj: T): T[keyof T][] {
  return Object.values(obj) as T[keyof T][]
}

/**
 * 表示一个对象类型，该对象至少包含类型T中指定的所有键，这些键的值类型为U
 * 同时也允许包含其他任意string类型的键，这些键的值类型也必须是U
 * @template T - 必需包含的键的字面量字符串联合类型
 * @template U - 所有键对应值的类型
 * @example
 * type Example = AtLeast<'a' | 'b', number>;
 * // 结果类型允许:
 * const obj1: Example = { a: 1, b: 2 };           // 只包含必需的键
 * const obj2: Example = { a: 1, b: 2, c: 3 };     // 包含额外的键
 */
export type AtLeast<T extends string, U> = {
  [K in T]: U
} & {
  [key: string]: U
}

/**
 * 从对象中移除指定的属性键，返回新对象
 * @template T - 源对象类型
 * @template K - 要移除的属性键类型，必须是T的键
 * @param obj - 源对象
 * @param keys - 要移除的属性键列表
 * @returns 移除指定属性后的新对象
 * @example
 * ```ts
 * const obj = { a: 1, b: 2, c: 3 };
 * const result = strip(obj, ['a', 'b']);
 * // result = { c: 3 }
 * ```
 */
export function strip<T, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
  const result = { ...obj }
  for (const key of keys) {
    delete (result as any)[key] // 类型上 Omit 已保证安全
  }
  return result
}

/**
 * Makes specified properties required while keeping others as is
 * @template T - The object type to modify
 * @template K - Keys of T that should be required
 * @example
 * type User = {
 *   name?: string;
 *   age?: number;
 * }
 *
 * type UserWithName = RequireSome<User, 'name'>
 * // Result: { name: string; age?: number; }
 */
export type RequireSome<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>

export type HexColor = string

/**
 * 检查字符串是否为有效的十六进制颜色值
 * @param value 待检查的字符串
 */
export const isHexColor = (value: string): value is HexColor => {
  return /^#([0-9A-F]{3}){1,2}$/i.test(value)
}

// More specific than NonNullable
// `NotUndefined` 仍被 `types/aiCoreTypes.ts` 使用，保留；同族的 `NotNull` 在
// 复核中确认全仓零消费，已删除。
export type NotUndefined<T> = Exclude<T, undefined>

import { loggerService } from '@logger'
import {
  DEFAULT_LANGUAGES,
  DEFAULT_THEMES,
  getHighlighter,
  loadLanguageIfNeeded,
  loadThemeIfNeeded,
  resolveLanguageRegistrations,
  resolveThemeRegistrations
} from '@renderer/utils/shiki'
import { LRUCache } from 'lru-cache'
import type { HighlighterGeneric, ThemedToken } from 'shiki/core'

import type { ShikiStreamTokenizerOptions } from './ShikiStreamTokenizer'
import { ShikiStreamTokenizer } from './ShikiStreamTokenizer'

const logger = loggerService.withContext('ShikiStreamService')

const SERVICE_CONFIG = {
  // LRU 缓存配置
  TOKENIZER_CACHE: {
    MAX_SIZE: 100, // 最大缓存数量
    TTL: 1000 * 60 * 30 // 30 分钟过期时间（毫秒）
  },

  // 降级策略配置
  DEGRADATION_CACHE: {
    MAX_SIZE: 500, // 最大记录数量
    TTL: 1000 * 60 * 60 * 12, // 12 小时自动过期（毫秒）
    /** 降级冷却：worker 失败后只把该 callerId 钉在主线程这么久，到期后重新尝试 worker。
     *  此前是一次失败即"永久降级"（存活到 12 小时 TTL），一次超时就让该块所有后续 delta
     * 全在主线程 tokenize，与每帧重解析叠加成"单条消息越流越卡"。 */
    COOLDOWN: 1000 * 60 * 5
  },

  // Worker 初始化配置
  WORKER: {
    MAX_INIT_RETRY: 2, // 最大初始化重试次数
    /** 空闲回收窗口：无 pending 请求且无新请求达该时长 ⇒ terminate worker。
     *  只有代码块高亮会创建 worker；用户看完代码块后它不该常驻到窗口关闭。
     *  重建成本由 MAX_INIT_RETRY + 惰性 init 承担（下次高亮自动重建）。 */
    IDLE_TERMINATE_MS: 60_000,
    REQUEST_TIMEOUT: {
      INIT: 5000, // 初始化操作超时时间（毫秒）
      HIGHLIGHT: 30000, // 高亮操作超时时间（毫秒）
      DEFAULT: 10000 // 默认超时时间（毫秒）
    }
  }
}

export type ShikiPreProperties = {
  class: string
  style: string
  tabindex: number
}

/**
 * 代码 chunk 高亮结果
 *
 * @param lines 所有高亮行（包括稳定和不稳定）
 * @param recall 需要撤回的行数，-1 表示撤回所有行
 */
export interface HighlightChunkResult {
  lines: ThemedToken[][]
  recall: number
}

/**
 * Shiki 代码高亮服务
 *
 * - 支持流式代码高亮。
 * - 优先使用 Worker 处理高亮请求。
 */
class ShikiStreamService {
  // 主线程 highlighter 和 tokenizers
  private highlighter: HighlighterGeneric<any, any> | null = null

  // 保存以 callerId-language-theme 为键的 tokenizer map
  private tokenizerCache = new LRUCache<string, ShikiStreamTokenizer>({
    max: SERVICE_CONFIG.TOKENIZER_CACHE.MAX_SIZE,
    ttl: SERVICE_CONFIG.TOKENIZER_CACHE.TTL,
    updateAgeOnGet: true,
    dispose: (value) => {
      if (value) value.clear()
    }
  })

  // 缓存每个 callerId 对应的已处理内容
  private codeCache = new LRUCache<string, string>({
    max: SERVICE_CONFIG.TOKENIZER_CACHE.MAX_SIZE,
    ttl: SERVICE_CONFIG.TOKENIZER_CACHE.TTL,
    updateAgeOnGet: true
  })

  // Worker 相关资源
  private worker: Worker | null = null
  private workerInitPromise: Promise<void> | null = null
  private workerInitRetryCount: number = 0
  private pendingRequests = new Map<
    number,
    {
      resolve: (value: any) => void
      reject: (reason?: any) => void
    }
  >()
  private requestId = 0
  /** 空闲回收定时器。null = 未排程。 */
  private workerIdleTimer: ReturnType<typeof setTimeout> | null = null
  /** 重建 worker 时重放的初始化表（与 initWorker 入参一致；worker 侧自建 highlighter——
   *  highlighter 对象经 postMessage 不可结构化克隆，且 worker 的代价面是 `import('shiki')`
   *  的语言/主题加载，不是这份字符串表）。 */
  private workerLanguages: readonly string[] = DEFAULT_LANGUAGES
  private workerThemes: readonly string[] = DEFAULT_THEMES

  // 降级策略相关变量，用于记录调用 worker 失败过的 callerId 及其冷却截止时间
  private workerDegradationCache = new LRUCache<string, number>({
    max: SERVICE_CONFIG.DEGRADATION_CACHE.MAX_SIZE,
    ttl: SERVICE_CONFIG.DEGRADATION_CACHE.TTL
  })

  constructor() {
    // 延迟初始化
  }

  /**
   * 判断是否正在使用 Worker 高亮。外部不要依赖这个方法来判断。
   */
  public hasWorkerHighlighter(): boolean {
    return !!this.worker && !this.workerInitPromise
  }

  /**
   * 判断是否正在使用主线程高亮。外部不要依赖这个方法来判断。
   */
  public hasMainHighlighter(): boolean {
    return !!this.highlighter
  }

  /**
   * 初始化 Worker
   */
  private async initWorker(): Promise<void> {
    if (typeof Worker === 'undefined') return
    if (this.workerInitPromise) return this.workerInitPromise
    if (this.worker) return

    if (this.workerInitRetryCount >= SERVICE_CONFIG.WORKER.MAX_INIT_RETRY) {
      logger.debug('ShikiStream worker initialization failed too many times, stop trying')
      return
    }

    this.workerInitPromise = (async () => {
      try {
        // 动态导入 worker
        const WorkerModule = await import('../workers/shiki-stream.worker?worker')
        this.worker = new WorkerModule.default()

        // 设置消息处理器
        this.worker.onmessage = (event) => {
          const { id, type, result, error } = event.data

          // 资产请求：worker 不再自带 shiki 语言/主题表，改为按需向主线程索取。
          // 这条分支必须在 pendingRequests 查找**之前**：资产请求有它自己的 id 空间
          // （worker 侧独立自增），与 highlight/init 的请求 id 无关联。
          if (type === 'assets-request') {
            void this.handleWorkerAssetRequest(id, event.data.kind, event.data.name)
            return
          }

          // 查找对应的请求
          const pendingRequest = this.pendingRequests.get(id)
          if (!pendingRequest) return

          this.pendingRequests.delete(id)

          if (type === 'error') {
            pendingRequest.reject(new Error(error))
          } else if (type === 'init-result') {
            pendingRequest.resolve({ success: true })
            this.workerInitRetryCount = 0
          } else {
            pendingRequest.resolve(result)
          }
        }

        // 初始化 worker（语言/主题表随实例保留，空闲回收后重建时原样重放）。
        await this.sendWorkerMessage({
          type: 'init',
          languages: [...this.workerLanguages],
          themes: [...this.workerThemes]
        })
        this.workerInitRetryCount = 0
        // 创建后即排空闲回收（worker 生命周期 = 最后一次高亮 + IDLE_TERMINATE_MS）
        this.scheduleWorkerIdleTerminate()
      } catch (error) {
        // 初始化失败：与空闲回收同路径收尾（terminate + 清 pending），再记一次重试
        this.terminateWorker()
        this.workerInitRetryCount++
        throw error
      } finally {
        this.workerInitPromise = null
      }
    })()

    return this.workerInitPromise
  }

  /**
   * 应答 worker 的资产请求。
   *
   * worker 不再 `import('shiki')`（那会让它的独立模块图再编译一份 286 个语言 chunk 的语言表，
   * 产物重复 4.15 MB），改为向主线程索取语法/主题注册数据——这些数据是 JSON，可结构化克隆。
   *
   * 失败语义：解析失败回包 `error` ⇒ worker 侧 `requestAsset` reject ⇒ **原样上抛**（服务层
   * `highlightCodeChunk` 记 5 分钟降级并回落主线程，见 worker 侧 `highlightCodeChunk` 注释）；
   * 只有"语言解析成功但结果为空"（未知语言）才由 worker 退 `text`，主题解析失败仍回退
   * `one-light`（与主线程 `loadThemeIfNeeded` 同语义）。
   *
   * 注意：本方法**不**占用 `pendingRequests`、也不 `cancelWorkerIdleTerminate()`——这不是一次
   * worker 计算请求，而是一次本地解析 + 回包。回包在途期间若恰好发生空闲回收，worker 已被
   * terminate，postMessage 会抛错，这里吞掉即可（worker 已不在，无需应答）。
   */
  private async handleWorkerAssetRequest(id: number, kind: unknown, name: unknown): Promise<void> {
    const respond = (payload: { result?: unknown[]; error?: string }): void => {
      try {
        this.worker?.postMessage({ id, type: 'assets-result', ...payload })
      } catch (error) {
        logger.debug('Failed to respond to worker asset request (worker gone?):', error as Error)
      }
    }

    try {
      if (kind !== 'language' && kind !== 'theme') {
        throw new Error(`Unknown asset kind: ${String(kind)}`)
      }
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error(`Invalid asset name for ${kind}`)
      }
      const registrations =
        kind === 'language' ? await resolveLanguageRegistrations(name) : await resolveThemeRegistrations(name)
      if (registrations === null) {
        respond({ error: `Unknown ${kind}: ${name}` })
        return
      }
      respond({ result: registrations })
    } catch (error) {
      respond({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * 排程 worker 空闲回收。
   *
   * 语义：只在"无 pending 请求"时计时。任意请求入队即取消计时（`cancelWorkerIdleTerminate`），
   * 请求结算后（队列排空时）再排；到期若仍无 pending ⇒ `terminateWorker()`。高亮器引用
   * （`highlighter`）与 tokenizer/code 缓存都保留：回收的只是 worker 线程，下次高亮按
   * `initWorker` 惰性重建（worker 侧重放同一语言/主题表）。
   */
  private scheduleWorkerIdleTerminate(): void {
    this.cancelWorkerIdleTerminate()
    if (!this.worker) return
    this.workerIdleTimer = setTimeout(() => {
      this.workerIdleTimer = null
      if (this.pendingRequests.size > 0) {
        // 仍有在途请求：它们的结算路径会重新排程
        return
      }
      logger.debug('ShikiStream idle worker terminated')
      this.terminateWorker()
    }, SERVICE_CONFIG.WORKER.IDLE_TERMINATE_MS)
  }

  private cancelWorkerIdleTerminate(): void {
    if (this.workerIdleTimer !== null) {
      clearTimeout(this.workerIdleTimer)
      this.workerIdleTimer = null
    }
  }

  /**
   * 终结 worker 并结算其剩余请求。
   * terminate 后不会有任何回包，未结算的 Promise 必须显式 reject——否则调用方永久悬挂。
   */
  private terminateWorker(): void {
    this.cancelWorkerIdleTerminate()
    const worker = this.worker
    this.worker = null
    this.workerInitPromise = null
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error('ShikiStream worker terminated'))
    }
    this.pendingRequests.clear()
    this.requestId = 0
    try {
      worker?.terminate()
    } catch (error) {
      logger.warn('Failed to terminate shiki stream worker:', error as Error)
    }
  }

  /**
   * 向 Worker 发送消息并等待回复
   *
   * 结算只走 `settle`（一次结算 ⇒ clearTimeout + 从 pendingRequests 摘除）。
   * `postMessage` 抛错时此前调**原始 reject**：绕过 settled 门禁、不清定时器、不删条目，
   * 于是 postMessage 持续抛错时每个 delta 都留下一个存活到超时的条目 + 定时器，并在超时
   * 时二次触发降级标记。现统一走 settle。
   */
  private sendWorkerMessage(message: any): Promise<any> {
    if (!this.worker) {
      return Promise.reject(new Error('Worker not available'))
    }

    const id = this.requestId++
    // 请求在途期间不回收 worker
    this.cancelWorkerIdleTerminate()

    let settled = false
    // Promise executor 同步执行 ⇒ resolve/reject 在首次 settle 前一定已赋值。
    // 定时器句柄放在对象里（而不是 `let` 绑定）：`settle` 需要在定义处就能引用它，
    // 而绑定的唯一一次赋值在下方。
    let resolveRef!: (value: any) => void
    let rejectRef!: (reason?: any) => void
    const timer: { id?: ReturnType<typeof setTimeout> } = {}

    /** 一次结算：清定时器 + 摘条目 + 队列排空后再排空闲回收。 */
    const settle = (kind: 'resolve' | 'reject', value: unknown): void => {
      if (settled) return
      settled = true
      if (timer.id !== undefined) clearTimeout(timer.id)
      this.pendingRequests.delete(id)
      // 队列排空才重新计时（高频 delta 下不反复重建定时器）
      if (this.pendingRequests.size === 0) this.scheduleWorkerIdleTerminate()
      if (kind === 'resolve') {
        resolveRef(value)
      } else {
        rejectRef(value)
      }
    }

    const promise = new Promise((resolve, reject) => {
      resolveRef = resolve
      rejectRef = reject
    })

    this.pendingRequests.set(id, {
      resolve: (value: unknown) => settle('resolve', value),
      reject: (reason?: unknown) => settle('reject', reason)
    })

    // 根据操作类型设置不同的超时时间
    const getTimeoutForMessageType = (type: string): number => {
      switch (type) {
        case 'init':
          return SERVICE_CONFIG.WORKER.REQUEST_TIMEOUT.INIT
        case 'highlight':
          return SERVICE_CONFIG.WORKER.REQUEST_TIMEOUT.HIGHLIGHT
        case 'cleanup':
        case 'dispose':
        default:
          return SERVICE_CONFIG.WORKER.REQUEST_TIMEOUT.DEFAULT
      }
    }

    // 设置超时处理
    timer.id = setTimeout(() => {
      // 如果是高亮操作超时，说明代码块太长，记录callerId以便降级
      if (message.type === 'highlight' && message.callerId) {
        this.workerDegradationCache.set(message.callerId, Date.now() + SERVICE_CONFIG.DEGRADATION_CACHE.COOLDOWN)
        settle('reject', new Error(`Worker ${message.type} request timeout for callerId ${message.callerId}`))
      } else {
        settle('reject', new Error(`Worker ${message.type} request timeout`))
      }
    }, getTimeoutForMessageType(message.type))

    try {
      this.worker.postMessage({ id, ...message })
    } catch (error) {
      settle('reject', error instanceof Error ? error : new Error(String(error)))
    }

    return promise
  }

  /**
   * 确保 highlighter 已配置
   * @param language 语言
   * @param theme 主题
   */
  private async ensureHighlighterConfigured(
    language: string,
    theme: string
  ): Promise<{ loadedLanguage: string; loadedTheme: string }> {
    if (!this.highlighter) {
      this.highlighter = await getHighlighter()
    }

    const loadedLanguage = await loadLanguageIfNeeded(this.highlighter, language)
    const loadedTheme = await loadThemeIfNeeded(this.highlighter, theme)

    return { loadedLanguage, loadedTheme }
  }

  /**
   * 获取 Shiki 的 pre 标签属性
   *
   * 跑一个简单的 hast 结果，从中提取 properties 属性。
   * 如果有更加稳定的方法可以替换。
   * @param language 语言
   * @param theme 主题
   * @returns pre 标签属性
   */
  async getShikiPreProperties(language: string, theme: string): Promise<ShikiPreProperties> {
    const { loadedLanguage, loadedTheme } = await this.ensureHighlighterConfigured(language, theme)

    if (!this.highlighter) {
      throw new Error('Highlighter not initialized')
    }

    const hast = this.highlighter.codeToHast('1', {
      lang: loadedLanguage,
      theme: loadedTheme
    })

    // @ts-ignore hack
    return hast.children[0].properties as ShikiPreProperties
  }

  /**
   * 高亮流式输出的代码，调用方传入完整代码内容，得到增量高亮结果。
   *
   * - 检测当前内容与上次处理内容的差异。
   * - 如果是末尾追加，只传输增量部分（此时性能最好，如遇性能问题，考虑检查这里的逻辑）。
   * - 如果不是追加，重置 tokenizer 并处理完整内容。
   *
   * 调用者需要自行处理撤回。
   * @param code 完整代码内容
   * @param language 语言
   * @param theme 主题
   * @param callerId 调用者ID
   * @returns 高亮结果，recall 为 -1 表示撤回所有行
   */
  async highlightStreamingCode(
    code: string,
    language: string,
    theme: string,
    callerId: string
  ): Promise<HighlightChunkResult> {
    const cacheKey = `${callerId}-${language}-${theme}`
    const lastContent = this.codeCache.get(cacheKey) || ''

    let isAppend = false

    if (code.length === lastContent.length) {
      // 内容没有变化，返回空结果
      if (code === lastContent) {
        return { lines: [], recall: 0 }
      }
    } else if (code.length > lastContent.length) {
      // 长度增加，可能是追加
      isAppend = code.startsWith(lastContent)
    }

    try {
      let result: HighlightChunkResult

      if (isAppend) {
        // 流式追加，只传输增量
        const chunk = code.slice(lastContent.length)
        result = await this.highlightCodeChunk(chunk, language, theme, callerId)
      } else {
        // 非追加变化，重置并处理完整内容
        this.cleanupTokenizers(callerId)
        this.codeCache.delete(cacheKey) // 清除缓存

        result = await this.highlightCodeChunk(code, language, theme, callerId)

        // 撤回所有行
        result = {
          ...result,
          recall: -1
        }
      }

      // 成功处理后更新缓存
      this.codeCache.set(cacheKey, code)
      return result
    } catch (error) {
      // 处理失败时不更新缓存，保持之前的状态
      logger.error('Failed to highlight streaming code:', error as Error)
      throw error
    }
  }

  /**
   * 高亮代码 chunk，返回本次高亮的所有 ThemedToken 行
   *
   * 优先使用 Worker 处理，失败时回退到主线程处理。
   * 调用者需要自行处理撤回。
   * @param chunk 代码内容
   * @param language 语言
   * @param theme 主题
   * @param callerId 调用者ID，用于标识不同的组件实例
   * @returns ThemedToken 行
   */
  /**
   * 该 callerId 当前是否处于 fallback 冷却期。
   *
   * 存的是"冷却截止时间戳"：到点即删条目 ⇒ 下次请求重新尝试 worker。过期条目由
   * LRUCache 的 TTL 兜底清理，但正常路径靠这里的惰性删除自愈。
   */
  private isDegraded(callerId: string): boolean {
    const until = this.workerDegradationCache.get(callerId)
    if (until === undefined) return false
    if (Date.now() >= until) {
      this.workerDegradationCache.delete(callerId)
      return false
    }
    return true
  }

  async highlightCodeChunk(
    chunk: string,
    language: string,
    theme: string,
    callerId: string
  ): Promise<HighlightChunkResult> {
    // 检查callerId是否处于降级冷却期
    if (this.isDegraded(callerId)) {
      return this.highlightWithMainThread(chunk, language, theme, callerId)
    }

    // 初始化 worker
    if (!this.worker) {
      try {
        await this.initWorker()
      } catch (error) {
        logger.warn('Failed to initialize worker, falling back to main thread:', error as Error)
      }
    }

    // 如果 Worker 可用，优先使用 Worker 处理
    if (this.hasWorkerHighlighter()) {
      try {
        const result = await this.sendWorkerMessage({
          type: 'highlight',
          callerId,
          chunk,
          language,
          theme
        })
        return result
      } catch (error) {
        // Worker 处理失败：记一次**有期限**的降级。此前写死 `true` 且 TTL 12 小时，
        // 等于"一次超时 ⇒ 该块此后所有 delta 都在主线程 tokenize"；现在冷却
        // DEGRADATION_CACHE.COOLDOWN 后自动重试 worker，超长代码块不再永久污染该 caller。
        this.workerDegradationCache.set(callerId, Date.now() + SERVICE_CONFIG.DEGRADATION_CACHE.COOLDOWN)
        logger.error(
          `Worker highlight failed for callerId ${callerId}, falling back to main thread for ` +
            `${SERVICE_CONFIG.DEGRADATION_CACHE.COOLDOWN}ms:`,
          error as Error
        )
      }
    }

    // 使用主线程处理
    return this.highlightWithMainThread(chunk, language, theme, callerId)
  }

  /**
   * 使用主线程处理代码高亮
   * @param chunk 代码内容
   * @param language 语言
   * @param theme 主题
   * @param callerId 调用者ID
   * @returns 高亮结果
   */
  private async highlightWithMainThread(
    chunk: string,
    language: string,
    theme: string,
    callerId: string
  ): Promise<HighlightChunkResult> {
    try {
      const tokenizer = await this.getStreamTokenizer(callerId, language, theme)

      const result = await tokenizer.enqueue(chunk)

      // 合并稳定和不稳定的行作为本次高亮的所有行
      return {
        lines: [...result.stable, ...result.unstable],
        recall: result.recall
      }
    } catch (error) {
      // 不得伪造「看起来合法」的高亮结果。旧实现把整段 chunk 塞进一行 token 并
      // `recall: 0` 返回，调用方（useCodeHighlight）既不撤回已渲染的 unstable 行、又把这行当
      // 正常高亮追加 → 代码被挤进一行且可能重复，而失败只落一条 error 日志、UI 无任何信号。
      // 现在原样上抛：调用方把该块降级为未高亮纯文本并给出可见提示（见 useCodeHighlight）。
      const failure = error instanceof Error ? error : new Error(String(error))
      logger.error('Failed to highlight code chunk:', failure)
      throw failure
    }
  }

  /**
   * 获取或创建 tokenizer
   * @param callerId 调用者ID
   * @param language 语言
   * @param theme 主题
   * @returns tokenizer 实例
   */
  private async getStreamTokenizer(callerId: string, language: string, theme: string): Promise<ShikiStreamTokenizer> {
    // 创建复合键
    const cacheKey = `${callerId}-${language}-${theme}`

    // 如果已存在，直接返回
    if (this.tokenizerCache.has(cacheKey)) {
      return this.tokenizerCache.get(cacheKey)!
    }

    // 确保 highlighter 已配置
    const { loadedLanguage, loadedTheme } = await this.ensureHighlighterConfigured(language, theme)

    if (!this.highlighter) {
      throw new Error('Highlighter not initialized')
    }

    // 创建新的 tokenizer
    const options: ShikiStreamTokenizerOptions = {
      highlighter: this.highlighter,
      lang: loadedLanguage,
      theme: loadedTheme
    }

    const tokenizer = new ShikiStreamTokenizer(options)
    this.tokenizerCache.set(cacheKey, tokenizer)

    return tokenizer
  }

  /**
   * 清理特定调用者的 tokenizers
   * @param callerId 调用者ID
   */
  cleanupTokenizers(callerId: string): void {
    // 先尝试清理 Worker 中的 tokenizers
    if (this.hasWorkerHighlighter()) {
      this.sendWorkerMessage({
        type: 'cleanup',
        callerId
      }).catch((error) => {
        logger.error('Failed to cleanup worker tokenizer:', error as Error)
      })
    }

    // 清理对应的内容缓存
    for (const key of this.codeCache.keys()) {
      if (key.startsWith(`${callerId}-`)) {
        this.codeCache.delete(key)
      }
    }

    // 再清理主线程中的 tokenizers，移除所有以 callerId 开头的缓存项
    for (const key of this.tokenizerCache.keys()) {
      if (key.startsWith(`${callerId}-`)) {
        this.tokenizerCache.delete(key)
      }
    }
  }

  /**
   * 销毁所有资源
   */
  dispose() {
    if (this.worker) {
      // 此前先 `postMessage({type:'dispose'})` 再 `terminateWorker()`——terminate 在同一
      // tick 终止线程，dispose 的回执永远到不了，反而由 terminateWorker 的显式 reject 触发上面的
      // `.catch` 打出一条虚假的 "Failed to dispose worker" warn（每次 dispose 一条假告警）。
      // teardown 的确定性由 terminateWorker() 独自提供：它 reject 全部在途请求（settle 会清掉
      // 各自的超时定时器，不再有 10s 定时器泄漏与滞后告警）并终止线程。
      this.terminateWorker()
    } else {
      this.cancelWorkerIdleTerminate()
      // 无 worker 也可能有残余条目（worker 半死时入队的请求）：同样结算，不留悬挂 Promise
      for (const pending of this.pendingRequests.values()) {
        pending.reject(new Error('ShikiStream worker disposed'))
      }
      this.pendingRequests.clear()
      this.requestId = 0
    }

    this.workerDegradationCache.clear()
    this.tokenizerCache.clear()
    this.codeCache.clear()

    // Don't dispose the highlighter directly since it's managed by AsyncInitializer
    // Just clear the reference
    this.highlighter = null
    this.workerInitPromise = null
    this.workerInitRetryCount = 0
  }
}

export const shikiStreamService = new ShikiStreamService()

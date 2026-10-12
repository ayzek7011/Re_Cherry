/**
 * worker 侧高亮失败语义回归测试。
 *
 * 缺陷原状（用户反馈"某些语言的代码块不高亮、反而渲染成一式两份"的根因）：
 * worker 用 `createJavaScriptRegexEngine()`（非 forgiving），部分语法的 Oniguruma 特性
 * 译不成 JS 正则，编译在首次 tokenize 时才发生并从 `enqueue` 冒出；旧 `highlightCodeChunk`
 * 的 catch 把**任何**错误吞成"成功"结果 `{ lines: [[{ content: 整段 chunk }]], recall: 0 }`：
 * useCodeHighlight 不撤回已渲染行、把这行当高亮追加，VirtualizedRow 第一行渲染整段原文
 * （`white-space: pre` 保留换行）、其后各行再渲染一遍 ⇒ 整块代码一式两份且无高亮。
 *
 * 修复后：错误原样上抛（与主线程 `highlightWithMainThread` 同语义，见 ShikiStreamService
 * 同名方法的注释），`self.onmessage` 外层 catch 回 `type:'error'` ⇒ 服务层记 5 分钟降级并
 * 整体回落主线程——主图 `import('shiki')` 是 Oniguruma wasm 引擎，能正常高亮这类语言。
 * 同时语言加载分层对齐主线程 `loadLanguageIfNeeded`：未知语言退 `text`，已知语言加载失败上抛。
 *
 * 另一同源缺陷（同被本文件锁死）：`loadTheme` 与 `loadLanguage` API 不对称，旧实现把主题
 * 注册数据**数组**整个传给 `loadTheme`，shiki 的 `normalizeTheme`（`{ ...rawTheme }`）把数组
 * 摊成 `{ 0: themeJson }` 丢掉 `name` ⇒ **静默不注册**，首次 tokenize 必抛
 * `Theme '…' not found`——任何语言的 worker 高亮都失败，再被假成功 catch 吞成"一式两份"。
 * 修复后 worker 取 `registrations[0]`（见第 4 例）。
 *
 * worker 代码跑在真实 Worker 线程里，单元测试进不去；这里经模块顶层挂的 `self.onmessage`
 * 直驱消息协议（renderer 测试项目是 jsdom，`self` 可用），`shiki/core`、js 引擎与
 * `ShikiStreamTokenizer` 换成本地桩。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const enqueueFailure = new Error('Simulated js-engine failure: cannot translate Oniguruma pattern')
const loadFailure = new Error('Simulated loadLanguage failure for an existing language')

// 记录 worker 调 loadTheme 的实参（见"theme 数组静默不注册"用例）
const loadThemeCalls = vi.hoisted(() => [] as unknown[])

// tokenizer 桩：'typescript' 首次 tokenize 抛错（模拟 js 引擎译不出该语法），其余语言原样返回
vi.mock('../../services/ShikiStreamTokenizer', () => ({
  ShikiStreamTokenizer: class {
    private lang: string
    constructor(options: { lang?: string }) {
      this.lang = options.lang ?? 'text'
    }
    async enqueue(chunk: string) {
      if (this.lang === 'typescript') {
        throw enqueueFailure
      }
      return {
        stable: [[{ content: chunk, color: '#000000', offset: 0 }]],
        unstable: [],
        recall: 0
      }
    }
    clear(): void {}
  }
}))

// shiki/core 桩：initHighlighter 只需要一个空壳 highlighter。
// `loadLanguage` 对名为 'explode-lang' 的注册数据抛错，用于锁定"已知语言加载失败必须上抛"。
vi.mock('shiki/core', () => ({
  createBundledHighlighter: () => async () => ({
    getLoadedLanguages: () => [],
    getLoadedThemes: () => [],
    loadLanguage: async (registrations: Array<{ name?: string }>) => {
      if (registrations[0]?.name === 'explode-lang') {
        throw loadFailure
      }
    },
    loadTheme: async (input: unknown) => {
      loadThemeCalls.push(input)
    },
    dispose: () => {}
  })
}))

vi.mock('shiki/dist/engine-javascript.mjs', () => ({
  createJavaScriptRegexEngine: () => ({})
}))

import '../shiki-stream.worker'

/** worker → 外界的回包（命令回包 + 资产请求）。 */
interface WorkerOutbound {
  id: number
  type: string
  result?: unknown
  error?: string
  kind?: string
  name?: string
}

const workerSelf = self as unknown as {
  onmessage: ((e: { data: unknown }) => Promise<void>) | null
  postMessage: (msg: WorkerOutbound) => void
}

const posted: WorkerOutbound[] = []
let originalPostMessage: typeof workerSelf.postMessage

const dispatch = (data: unknown): Promise<void> => {
  if (!workerSelf.onmessage) throw new Error('worker onmessage not installed')
  return workerSelf.onmessage({ data })
}

/**
 * 驱动一次 highlight 消息，并应答链上出现的所有资产请求（桩 highlighter 的已加载表恒为空，
 * 所以语言与主题各索要一次），返回 worker 对该请求的最终回包。
 */
async function runHighlight(id: number, language: string, chunk: string): Promise<WorkerOutbound> {
  posted.length = 0
  const pending = dispatch({
    id,
    type: 'highlight',
    callerId: `caller-${id}`,
    chunk,
    language,
    theme: 'one-light'
  })

  while (posted.some((m) => m.type === 'assets-request')) {
    const req = posted.find((m) => m.type === 'assets-request')
    if (!req) break
    posted.splice(posted.indexOf(req), 1)
    const unknownLanguage = req.kind === 'language' && req.name === 'ghost-lang'
    await dispatch({
      id: req.id,
      type: 'assets-result',
      result: unknownLanguage ? [] : [{ name: req.name, scopeName: 'source.test' }]
    })
    // 让资产回包后的链路推进到下一个资产请求或最终回包（微任务在一个宏任务内排空）
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  await pending
  const final = posted.find((m) => m.id === id)
  if (!final) throw new Error(`no final response for request ${id}: ${JSON.stringify(posted)}`)
  return final
}

describe('shiki-stream.worker failure semantics (never fabricate a highlight result)', () => {
  beforeAll(async () => {
    originalPostMessage = workerSelf.postMessage
    // 捕获 worker → 外界的全部 postMessage（回包与资产请求）
    workerSelf.postMessage = (msg) => {
      posted.push(msg)
    }
    await dispatch({ id: 0, type: 'init', languages: ['typescript'], themes: ['one-light'] })
    expect(posted.some((m) => m.type === 'init-result')).toBe(true)
  })

  afterAll(() => {
    workerSelf.postMessage = originalPostMessage
  })

  it('propagates a tokenizer failure as an error response instead of a fabricated success line', async () => {
    const resp = await runHighlight(2, 'typescript', 'const a = 1')

    expect(resp.type).toBe('error')
    expect(resp.error).toBe(enqueueFailure.message)
    // 绝不出现"整段 chunk 塞进一行"的假成功回包
    expect(posted.some((m) => m.type === 'highlight-result')).toBe(false)
  })

  it('propagates a loadLanguage failure for an existing language instead of degrading to text', async () => {
    const resp = await runHighlight(3, 'explode-lang', 'hello')

    expect(resp.type).toBe('error')
    expect(resp.error).toBe(loadFailure.message)
    expect(posted.some((m) => m.type === 'highlight-result')).toBe(false)
  })

  it('keeps the unknown-language fallback to text as a legitimate success with intact content', async () => {
    const resp = await runHighlight(4, 'ghost-lang', 'plain content')

    expect(resp.type).toBe('highlight-result')
    const result = resp.result as { lines: Array<Array<{ content: string }>>; recall: number }
    expect(result.recall).toBe(0)
    expect(result.lines[0][0].content).toBe('plain content')
  })

  it('passes loadTheme a single theme object, not the registrations array', async () => {
    // 旧实现把 `resolveThemeRegistrations` 的**数组**整个传给 `loadTheme`：shiki core 的
    // `normalizeTheme` 用 `{ ...rawTheme }` 展开，数组被摊成 `{ 0: themeJson }`，`name`
    // 丢失 ⇒ **静默不注册、不报错**，首次 tokenize 才抛 `Theme not found`（旧代码再吞成
    // 假成功 ⇒ 任何语言的 worker 高亮都变成"一式两份"）。`loadLanguage` 接受数组而
    // `loadTheme` 不接受，两者 API 不对称——这里锁定 worker 必须取 `registrations[0]`。
    loadThemeCalls.length = 0
    const resp = await runHighlight(5, 'python', 'x = 1')

    expect(resp.type).toBe('highlight-result')
    expect(loadThemeCalls.length).toBeGreaterThan(0)
    for (const input of loadThemeCalls) {
      expect(Array.isArray(input)).toBe(false)
      expect((input as { name?: string }).name).toBe('one-light')
    }
  })
})

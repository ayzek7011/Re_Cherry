import { loggerService } from '@logger'
import type { BundledLanguage, BundledTheme } from 'shiki/bundle/web'
import type { HighlighterGeneric, SpecialLanguage, ThemedToken } from 'shiki/core'

import { AsyncInitializer } from './asyncInitializer'

export const DEFAULT_LANGUAGES = ['text', 'javascript', 'typescript', 'python', 'java', 'markdown', 'json']
export const DEFAULT_THEMES = ['one-light', 'material-theme-darker']

const logger = loggerService.withContext('Shiki')

/**
 * Shiki 的 `FontStyle` 位域取值（`@shikijs/core` 的 `FontStyle` 枚举）。
 *
 * 为什么是本地字面量而不是 `import { FontStyle } from 'shiki/core'`：
 * `shiki/core` 是一个**值**导入 ⇒ rollup 把整个 `@shikijs/core` 实体（含 Oniguruma 主题解析、
 * EncodedTokenMetadata、hast 工具链，产物里 174KB 的 `dist-*.js`）折进**首屏静态导入闭包**，
 * 而这里只需要 4 个位。改成动态导入会把同步的 `getReactStyleFromToken` 变成 async，代价面
 * 远大于收益。位域是 TextMate 标准映射，不会随 shiki 小版本漂移。
 */
const FONT_STYLE_ITALIC = 1
const FONT_STYLE_BOLD = 2
const FONT_STYLE_UNDERLINE = 4
const FONT_STYLE_STRIKETHROUGH = 8

/**
 * 由 token 的 `color` / `bgColor` / `fontStyle` 位域推出 CSS 样式表。
 *
 * 与 `@shikijs/core` 的 `getTokenStyleObject` 逐字同形（只用于 `htmlStyle` 缺失的 token，
 * 例如 `codeToTokens` 的原始输出）。本地实现是为了不把 shiki core 值导入钉进首屏。
 */
function getTokenStyleObject(token: ThemedToken): Record<string, string> {
  const styles: Record<string, string> = {}
  if (token.color) styles.color = token.color
  if (token.bgColor) styles['background-color'] = token.bgColor
  if (token.fontStyle) {
    if (token.fontStyle & FONT_STYLE_ITALIC) styles['font-style'] = 'italic'
    if (token.fontStyle & FONT_STYLE_BOLD) styles['font-weight'] = 'bold'
    const decorations: string[] = []
    if (token.fontStyle & FONT_STYLE_UNDERLINE) decorations.push('underline')
    if (token.fontStyle & FONT_STYLE_STRIKETHROUGH) decorations.push('line-through')
    if (decorations.length) styles['text-decoration'] = decorations.join(' ')
  }
  return styles
}

/**
 * shiki 初始化器，避免并发问题
 */
const shikiInitializer = new AsyncInitializer(async () => {
  const shiki = await import('shiki')
  return shiki
})

/**
 * 获取 shiki package
 */
export async function getShiki() {
  return shikiInitializer.get()
}

/**
 * 把 `shiki` 的 `bundledLanguages` / `bundledThemes` 动态导入结果规范成注册数据数组。
 *
 * 为什么必须做这层归一：`shiki` 的 `langs.mjs` / `themes.mjs` 是 **CJS 产物经 Vite 转成 ESM**
 * 的形态，`bundledLanguages[lang]()` 在开发/测试环境返回的是**模块命名空间**
 * （实测 `{ default: [ {...} ] }`），而不是裸数组。直接把它交给
 * `highlighter.loadLanguage()` 会因为"不是 LanguageRegistration[]"而失败 ⇒ 语法加载静默退化成
 * `text`（高亮全丢颜色）。这里同时接受两种形态。
 */
function normalizeRegistrationResult(value: unknown): unknown[] | null {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value
  if (typeof value === 'object' && 'default' in (value as Record<string, unknown>)) {
    const inner = (value as Record<string, unknown>).default
    if (Array.isArray(inner)) return inner
    if (inner !== null && inner !== undefined) return [inner]
  }
  return [value]
}

/**
 * 解析语言语法注册数据。
 *
 * 用途：`shiki-stream.worker` 不再 `import('shiki')`——worker 是一份**独立的 rollup 模块图**，
 * 它自己 import shiki 会让 `bundledLanguages` 语言表在产物里再编译一份（实测重复 4.15 MB）。
 * 现在 worker 改为向主线程索取语法数据，主线程用本表解析后经 `postMessage` 下发
 * （语言注册数据是 JSON，可结构化克隆）。
 *
 * @param language 语言 id（`bundledLanguages` 的键；`text`/`ansi` 等特殊语言返回 `null`）
 * @returns 语言注册数据数组；未知语言返回 `null`（调用方按"加载失败"处理并回退 `text`）
 */
export async function resolveLanguageRegistrations(language: string): Promise<unknown[] | null> {
  const shiki = await getShiki()
  const importFn = (shiki.bundledLanguages as unknown as Record<string, (() => Promise<unknown>) | undefined>)[language]
  if (typeof importFn !== 'function') return null
  return normalizeRegistrationResult(await importFn())
}

/**
 * 解析主题注册数据（与 `resolveLanguageRegistrations` 同因同法）。
 *
 * `createHighlighterCore` / `loadTheme` 的 `ThemeInput` 需要 `name` 字段；`shiki` 的主题数据
 * 本身已带 `name`，这里在缺失时用键名补齐，兼容 CJS 互操作包装形态。
 *
 * @param theme 主题 id（`bundledThemes` 的键）
 * @returns 主题注册数据数组；未知主题返回 `null`
 */
export async function resolveThemeRegistrations(theme: string): Promise<unknown[] | null> {
  const shiki = await getShiki()
  const importFn = (shiki.bundledThemes as unknown as Record<string, (() => Promise<unknown>) | undefined>)[theme]
  if (typeof importFn !== 'function') return null
  const normalized = normalizeRegistrationResult(await importFn())
  if (normalized === null) return null
  return normalized.map((registration) =>
    registration !== null && typeof registration === 'object' && !('name' in registration)
      ? { name: theme, ...(registration as Record<string, unknown>) }
      : registration
  )
}

/**
 * shiki highlighter 初始化器，避免并发问题
 */
const highlighterInitializer = new AsyncInitializer(async (langs?: string[], themes?: string[]) => {
  const shiki = await getShiki()
  return shiki.createHighlighter({
    langs: langs || DEFAULT_LANGUAGES,
    themes: themes || DEFAULT_THEMES
  })
})

/**
 * 获取 shiki highlighter
 */
export async function getHighlighter(langs?: string[], themes?: string[]) {
  return highlighterInitializer.get(langs, themes)
}

/**
 * 加载语言
 * @param highlighter - shiki highlighter
 * @param language - 语言
 * @returns 实际加载的语言
 */
export async function loadLanguageIfNeeded(
  highlighter: HighlighterGeneric<any, any>,
  language: string
): Promise<string> {
  const shiki = await getShiki()

  let loadedLanguage = language
  if (!highlighter.getLoadedLanguages().includes(language)) {
    try {
      if (['text', 'ansi'].includes(language)) {
        await highlighter.loadLanguage(language as SpecialLanguage)
      } else {
        const languageImportFn = shiki.bundledLanguages[language]
        const langData = await languageImportFn()
        await highlighter.loadLanguage(langData)
      }
    } catch (error) {
      await highlighter.loadLanguage('text')
      loadedLanguage = 'text'
    }
  }

  return loadedLanguage
}

/**
 * 加载主题
 * @param highlighter - shiki highlighter
 * @param theme - 主题
 * @returns 实际加载的主题
 */
export async function loadThemeIfNeeded(highlighter: HighlighterGeneric<any, any>, theme: string): Promise<string> {
  const shiki = await getShiki()

  let loadedTheme = theme
  if (!highlighter.getLoadedThemes().includes(theme)) {
    try {
      const themeImportFn = shiki.bundledThemes[theme]
      const themeData = await themeImportFn()
      await highlighter.loadTheme(themeData)
    } catch (error) {
      // 回退到 one-light
      logger.debug(`Failed to load theme '${theme}', falling back to 'one-light':`, error as Error)
      const oneLightTheme = await shiki.bundledThemes['one-light']()
      await highlighter.loadTheme(oneLightTheme)
      loadedTheme = 'one-light'
    }
  }

  return loadedTheme
}

/**
 * 并行加载语言与主题，返回两者**实际加载成功**的 id。
 *
 * 直接消费 `codeToHtml` 的路径（如 CodeStyleProvider 的 `highlightCode`）必须把这里的
 * loaded id 传回 shiki，而不是原始入参：`loadLanguageIfNeeded` 对未知语言会静默降级到
 * `text`、`loadThemeIfNeeded` 对加载失败的主题会静默降级到 `one-light`，若仍把原始
 * language/theme 传给 `codeToHtml`，会因「该语言/主题未加载」直接 throw（上游已修、
 * 本仓曾遗漏的缺陷）。
 */
export async function loadLanguageAndThemeIfNeeded(
  highlighter: HighlighterGeneric<BundledLanguage, BundledTheme>,
  language: string,
  theme: string
): Promise<{ loadedLanguage: string; loadedTheme: string }> {
  const [loadedLanguage, loadedTheme] = await Promise.all([
    loadLanguageIfNeeded(highlighter, language),
    loadThemeIfNeeded(highlighter, theme)
  ])
  return { loadedLanguage, loadedTheme }
}

/**
 * Shiki token 样式转换为 React 样式对象
 *
 * @param token Shiki themed token
 * @returns React 样式对象
 */
export function getReactStyleFromToken(
  token: ThemedToken,
  options?: { isDarkTheme?: boolean }
): Record<string, string> {
  const style = token.htmlStyle || getTokenStyleObject(token)
  const reactStyle: Record<string, string> = {}
  for (const [key, value] of Object.entries(style)) {
    if (key === 'color' && !options?.isDarkTheme && ['white', '#fff', '#ffffff'].includes(value.toLowerCase())) {
      reactStyle.color = 'var(--color-text)'
      continue
    }

    switch (key) {
      case 'font-style':
        reactStyle.fontStyle = value
        break
      case 'font-weight':
        reactStyle.fontWeight = value
        break
      case 'background-color':
        reactStyle.backgroundColor = value
        break
      case 'text-decoration':
        reactStyle.textDecoration = value
        break
      default:
        reactStyle[key] = value
    }
  }
  return reactStyle
}

/**
 * 获取 markdown-it（**装配一次**的模块级单例）
 *
 * `mdInitializer` 是单例（`AsyncInitializer` 只跑一次工厂），而 `md.use()` 是**追加**
 * 语义。此前 `md.use(fromHighlighter(...))` 写在 `getMarkdownIt` 里，每次调用都往同一个
 * 实例再挂一份高亮插件（消费点 `CodeStyleProvider` 的 `shikiMarkdownIt` 按渲染调用），
 * 插件数、内存与单次 render 的 CPU 随调用次数线性增长且永不自愈。
 * 现在插件在工厂里装配一次，`getMarkdownIt` 只做「按 markdown 预加载语言 + 切换本轮主题
 * + 返回实例」；插件选项是同一个可变对象，主题在解析时读取。
 */
const markdownItOptions: { themes: Record<string, string>; defaultColor: string } = {
  themes: {
    'one-light': 'one-light',
    'material-theme-darker': 'material-theme-darker'
  },
  defaultColor: DEFAULT_THEMES[0]
}

const mdInitializer = new AsyncInitializer(async () => {
  const md = await import('markdown-it')
  const instance = md.default({
    linkify: true, // 自动转换 URL 为链接
    typographer: true // 启用印刷格式优化
  })

  const highlighter = await getHighlighter()
  const { fromHighlighter } = await import('@shikijs/markdown-it/core')

  instance.use(
    fromHighlighter(highlighter, {
      themes: markdownItOptions.themes,
      defaultColor: markdownItOptions.defaultColor,
      // 未知/未加载语言的围栏按纯文本渲染（与 CodeViewer 的 text 降级一致）。此前用
      // 'json'：未知名语言会被 json 语法错误上色（键/字符串的高亮），比单色更误导。
      // 'text' 在 DEFAULT_LANGUAGES 里预装，fallback 不会 throw（上游同款语义）。
      fallbackLanguage: 'text' as BundledLanguage
    })
  )

  return instance
})

/**
 * 获取 markdown-it 渲染器
 * @param theme - 主题
 * @param markdown
 */
export async function getMarkdownIt(theme: string, markdown: string) {
  const highlighter = await getHighlighter()
  await loadMarkdownLanguage(markdown, highlighter)

  let actualTheme = theme
  try {
    actualTheme = await loadThemeIfNeeded(highlighter, theme)
  } catch (error) {
    logger.debug(`Failed to load theme '${theme}', using 'one-light' as fallback:`, error as Error)
    actualTheme = 'one-light'
  }
  // 插件只注册一次：本轮生效的主题写进装配时的同一对象（`@shikijs/markdown-it`
  // 在每次解析时按 `themes` + `defaultColor` 取用），不再重复 `md.use()`。
  if (markdownItOptions.themes[actualTheme] === undefined) {
    markdownItOptions.themes[actualTheme] = actualTheme
  }
  markdownItOptions.defaultColor = actualTheme

  return mdInitializer.get()
}

/**
 * 加载markdown中所有代码块语言类型
 * @param markdown
 * @param highlighter
 */
async function loadMarkdownLanguage(markdown: string, highlighter: HighlighterGeneric<BundledLanguage, BundledTheme>) {
  const codeBlockRegex = /```(\w+)?/g
  let match: string[] | null
  while ((match = codeBlockRegex.exec(markdown)) !== null) {
    if (match[1]) {
      await loadLanguageIfNeeded(highlighter, match[1])
    }
  }
}

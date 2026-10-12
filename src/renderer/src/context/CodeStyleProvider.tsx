import { useTheme } from '@renderer/context/ThemeProvider'
import { useMermaid } from '@renderer/hooks/useMermaid'
import { useSettings } from '@renderer/hooks/useSettings'
import type { HighlightChunkResult, ShikiPreProperties } from '@renderer/services/ShikiStreamService'
import { shikiStreamService } from '@renderer/services/ShikiStreamService'
import { ThemeMode } from '@renderer/types'
import { getHighlighter, getMarkdownIt, loadLanguageAndThemeIfNeeded } from '@renderer/utils/shiki'
import * as cmThemes from '@uiw/codemirror-themes-all'
import type React from 'react'
import { createContext, type PropsWithChildren, use, useCallback, useEffect, useMemo } from 'react'
import { bundledThemesInfo } from 'shiki/bundle/web'
import type { BundledThemeInfo } from 'shiki/types'

/**
 * Shiki 主题元数据。
 *
 * 此前这里在 effect 里 `getShiki().then(({ bundledThemesInfo }) => ...)`：为了拿一份**静态可知**
 * 的主题 id / 明暗类型表，把整个 `shiki` 包（`utils/shiki.ts:17 await import('shiki')` → 含核心
 * 引擎与完整语言表）拉进首屏执行面。`bundledThemesInfo` 是 `shiki/dist/themes.mjs` 里的纯 JSON
 * 常量（约 9.5KB），从 `shiki/bundle/web` 直接**值导入**它不会带上核心或语言表，且类型自带。
 */
const shikiThemesInfo: BundledThemeInfo[] = bundledThemesInfo

interface CodeStyleContextType {
  highlightCodeChunk: (trunk: string, language: string, callerId: string) => Promise<HighlightChunkResult>
  highlightStreamingCode: (code: string, language: string, callerId: string) => Promise<HighlightChunkResult>
  cleanupTokenizers: (callerId: string) => void
  getShikiPreProperties: (language: string) => Promise<ShikiPreProperties>
  highlightCode: (code: string, language: string) => Promise<string>
  shikiMarkdownIt: (code: string) => Promise<string>
  themeNames: string[]
  activeShikiTheme: string
  isShikiThemeDark: boolean
  activeCmTheme: any
}

const defaultCodeStyleContext: CodeStyleContextType = {
  highlightCodeChunk: async () => ({ lines: [], recall: 0 }),
  highlightStreamingCode: async () => ({ lines: [], recall: 0 }),
  cleanupTokenizers: () => {},
  getShikiPreProperties: async () => ({ class: '', style: '', tabindex: 0 }),
  highlightCode: async () => '',
  shikiMarkdownIt: async () => '',
  themeNames: ['auto'],
  activeShikiTheme: 'auto',
  isShikiThemeDark: false,
  activeCmTheme: null
}

const CodeStyleContext = createContext<CodeStyleContextType>(defaultCodeStyleContext)

export const CodeStyleProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const { codeEditor, codeViewer } = useSettings()
  const { theme } = useTheme()
  useMermaid()

  // 获取支持的主题名称列表
  const themeNames = useMemo(() => {
    // CodeMirror 主题
    // 更保险的做法可能是硬编码主题列表
    if (codeEditor.enabled) {
      return ['auto', 'light', 'dark']
        .concat(Object.keys(cmThemes))
        .filter((item) => typeof cmThemes[item as keyof typeof cmThemes] !== 'function')
        .filter((item) => !/^(defaultSettings)/.test(item) && !/(Style)$/.test(item))
    }

    // Shiki 主题，取出所有 BundledThemeInfo 的 id 作为主题名。
    // 依赖数组只有 `codeEditor.enabled`：`shikiThemesInfo` 是模块级常量（不是 props/state），
    // 放进依赖数组会被 react-hooks 规则判为"不必要的依赖"（它不参与重渲染）。
    return ['auto', ...shikiThemesInfo.map((info) => info.id)]
  }, [codeEditor.enabled])

  // 获取当前使用的 Shiki 主题名称（只用于代码预览）
  const activeShikiTheme = useMemo(() => {
    const field = theme === ThemeMode.light ? 'themeLight' : 'themeDark'
    const codeStyle = codeViewer[field]
    if (!codeStyle || codeStyle === 'auto' || !themeNames.includes(codeStyle)) {
      return theme === ThemeMode.light ? 'one-light' : 'material-theme-darker'
    }
    return codeStyle
  }, [theme, codeViewer, themeNames])

  const isShikiThemeDark = useMemo(() => {
    const themeInfo = shikiThemesInfo.find((info) => info.id === activeShikiTheme)
    return themeInfo?.type === 'dark'
    // `shikiThemesInfo` 是模块级常量，不参与重渲染 ⇒ 不进依赖数组（同 `themeNames` 的说明）
  }, [activeShikiTheme])

  // 获取当前使用的 CodeMirror 主题对象（只用于编辑器）
  const activeCmTheme = useMemo(() => {
    const field = theme === ThemeMode.light ? 'themeLight' : 'themeDark'
    let themeName = codeEditor[field]
    if (!themeName || themeName === 'auto' || !themeNames.includes(themeName)) {
      themeName = theme === ThemeMode.light ? 'materialLight' : 'dark'
    }
    return cmThemes[themeName as keyof typeof cmThemes] || themeName
  }, [theme, codeEditor, themeNames])

  // 自定义 shiki 语言别名
  const languageAliases = useMemo(() => {
    return {
      bash: 'shell',
      'objective-c++': 'objective-cpp',
      svg: 'xml',
      vab: 'vb',
      graphviz: 'dot'
    } as Record<string, string>
  }, [])

  useEffect(() => {
    // 在组件卸载时清理 Worker
    return () => {
      shikiStreamService.dispose()
    }
  }, [])

  // 流式代码高亮，返回已高亮的 token lines
  const highlightCodeChunk = useCallback(
    async (trunk: string, language: string, callerId: string) => {
      const normalizedLang = languageAliases[language] || language.toLowerCase()
      return shikiStreamService.highlightCodeChunk(trunk, normalizedLang, activeShikiTheme, callerId)
    },
    [activeShikiTheme, languageAliases]
  )

  // 清理代码高亮资源
  const cleanupTokenizers = useCallback((callerId: string) => {
    shikiStreamService.cleanupTokenizers(callerId)
  }, [])

  // 高亮流式输出的代码
  const highlightStreamingCode = useCallback(
    async (fullContent: string, language: string, callerId: string) => {
      const normalizedLang = languageAliases[language] || language.toLowerCase()
      return shikiStreamService.highlightStreamingCode(fullContent, normalizedLang, activeShikiTheme, callerId)
    },
    [activeShikiTheme, languageAliases]
  )

  // 获取 Shiki pre 标签属性
  const getShikiPreProperties = useCallback(
    async (language: string) => {
      const normalizedLang = languageAliases[language] || language.toLowerCase()
      return shikiStreamService.getShikiPreProperties(normalizedLang, activeShikiTheme)
    },
    [activeShikiTheme, languageAliases]
  )

  const highlightCode = useCallback(
    async (code: string, language: string) => {
      const highlighter = await getHighlighter()
      // 必须把**实际加载成功**的 id 传给 codeToHtml：未知语言会被 loadLanguageIfNeeded
      // 降级为 text、失败主题被降级为 one-light，仍传原始入参会因「未加载」直接 throw
      //（上游已修、本仓曾遗漏，见 loadLanguageAndThemeIfNeeded 注释）。
      const { loadedLanguage, loadedTheme } = await loadLanguageAndThemeIfNeeded(
        highlighter,
        language,
        activeShikiTheme
      )
      return highlighter.codeToHtml(code, { lang: loadedLanguage, theme: loadedTheme })
    },
    [activeShikiTheme]
  )

  // 使用 Shiki 和 Markdown-it 渲染代码
  const shikiMarkdownIt = useCallback(
    async (code: string) => {
      const renderer = await getMarkdownIt(activeShikiTheme, code)
      if (!renderer) {
        return code
      }
      return renderer.render(code)
    },
    [activeShikiTheme]
  )

  const contextValue = useMemo(
    () => ({
      highlightCodeChunk,
      highlightStreamingCode,
      cleanupTokenizers,
      getShikiPreProperties,
      highlightCode,
      shikiMarkdownIt,
      themeNames,
      activeShikiTheme,
      isShikiThemeDark,
      activeCmTheme
    }),
    [
      highlightCodeChunk,
      highlightStreamingCode,
      cleanupTokenizers,
      getShikiPreProperties,
      highlightCode,
      shikiMarkdownIt,
      themeNames,
      activeShikiTheme,
      isShikiThemeDark,
      activeCmTheme
    ]
  )

  return <CodeStyleContext value={contextValue}>{children}</CodeStyleContext>
}

export const useCodeStyle = () => {
  const context = use(CodeStyleContext)
  if (!context) {
    throw new Error('useCodeStyle must be used within a CodeStyleProvider')
  }
  return context
}

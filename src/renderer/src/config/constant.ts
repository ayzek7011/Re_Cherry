export const DEFAULT_TEMPERATURE = 1.0
export const DEFAULT_MAX_TOKENS = 4096
export const DEFAULT_STREAM_OPTIONS_INCLUDE_USAGE = true
export const LATEST_PRIVACY_POLICY_VERSION = '20260531'

// Max tool calls validation constants
export const MIN_TOOL_CALLS = 1
export const MAX_TOOL_CALLS = 100

/**
 * 时序前提：本模块在**求值瞬间**读取 `window.electron.process` 并冻结下列常量。
 * preload 通过 `contextBridge.exposeInMainWorld('electron', electronAPI)`
 * （`src/preload/index.ts:629`，非隔离时 `:635` 直接赋值）先于渲染层脚本执行，
 * 因此 Electron 入口下这些值一定就绪。
 *
 * 代价与边界：任何**晚于**本模块求值才注入 `window.electron` 的宿主（测试桩、非 Electron
 * 入口、将来的 preload 时序调整）会让 `platform`/`isDev`/`isProd` 静默为 `undefined`
 * （`?.` 不报错），从而 `isMac`/`isWin`/`isDev` 整条分支走错。
 *
 * 为什么不做惰性化：这五个量是本模块导出给全仓的**值**（不是函数），
 * 渲染侧共 **24** 个文件按 `isMac ? … : …` 的方式直接比较；
 * 改成 `export const platform = () => …` 会要求全部 24 处改成调用式，
 * 因此不做惰性化：只有读 `app.getPath()` 的 **store** 才需要惰性构造。
 * 若将来确实需要惰性化，请连同调用点一起改，并保留旧名。
 */
export const platform = window.electron?.process?.platform
export const isMac = platform === 'darwin'
// `process.platform` 永远不产生 `'win64'`——64 位 Windows 上报的仍是 `'win32'`
// （`window.electron.process` 即 @electron-toolkit/preload 暴露的 `process` 对象）。
// 该比较恒假，主进程同义量（`src/main/constant.ts:2`）也只判 `'win32'`。
export const isWin = platform === 'win32'
export const isLinux = platform === 'linux'
export const isDev = window.electron?.process?.env?.NODE_ENV === 'development'
export const isProd = window.electron?.process?.env?.NODE_ENV === 'production'

export const SILICON_CLIENT_ID = 'SFaJLLq0y6CAMoyDm81aMu'
export const PPIO_CLIENT_ID = '37d0828c96b34936a600b62c'
export const PPIO_APP_SECRET = import.meta.env.RENDERER_VITE_PPIO_APP_SECRET || ''
export const TOKENFLUX_HOST = 'https://tokenflux.ai'

// Messages loading configuration
export const LOAD_MORE_COUNT = 20

export const DEFAULT_COLOR_PRIMARY = '#00b96b'
export const THEME_COLOR_PRESETS = [
  DEFAULT_COLOR_PRIMARY,
  '#FF5470', // Coral Pink
  '#14B8A6', // Teal
  '#6366F1', // Indigo
  '#8B5CF6', // Purple
  '#EC4899', // Pink
  '#3B82F6', // Blue
  '#F59E0B', // Amber
  '#6D28D9', // Violet
  '#0EA5E9', // Sky Blue
  '#0284C7' // Light Blue
]

export const DEFAULT_KNOWLEDGE_DOCUMENT_COUNT = 6
export const DEFAULT_KNOWLEDGE_THRESHOLD = 0.0
export const DEFAULT_WEBSEARCH_RAG_DOCUMENT_COUNT = 1

export const MAX_COLLAPSED_CODE_HEIGHT = 350

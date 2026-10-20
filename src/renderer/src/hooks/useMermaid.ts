import { useTheme } from '@renderer/context/ThemeProvider'
import { ThemeMode } from '@renderer/types'
import { useEffect, useState } from 'react'

// Mermaid 的模块级单点状态机。
//
// 为什么不能每个消费者各自 initialize（旧实现）：CodeStyleProvider 预加载 + N 个
// MermaidPreview 各自跑一遍 initialize——N+1 次全局副作用互相竞争，主题切换时各实例
// 的 forceRenderKey 各自 bump，渲染时用的主题不保证是哪个。这里收敛为模块级单飞：
// initialize 只在（模块已加载, 目标主题）组合实际变化时执行一次，代数（generation）
// 广播给全部订阅者，主题切换后所有挂载中的图用同一代数重渲染。

interface MermaidModuleState {
  mermaid: any | null
  isLoading: boolean
  error: string | null
  /** initialize 每成功一次 +1；订阅者据此重渲染。0 = 尚未完成过。 */
  generation: number
}

let state: MermaidModuleState = { mermaid: null, isLoading: true, error: null, generation: 0 }
let loadPromise: Promise<any> | null = null
/** 已完成 initialize 的主题（'dark' | 'default'）——只有换主题才需要再 initialize。 */
let initializedTheme: 'dark' | 'default' | null = null
/** initialize 串行链：并发调用同主题只跑一次（后者命中快路径直取）。 */
let initChain: Promise<any> = Promise.resolve()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function setState(patch: Partial<MermaidModuleState>): void {
  state = { ...state, ...patch }
  notify()
}

async function doInitialize(theme: 'dark' | 'default'): Promise<any> {
  // 快路径：同主题且模块在手（并发调用的后者会落到这里）。
  if (state.mermaid && initializedTheme === theme) return state.mermaid
  try {
    setState({ isLoading: true, error: null })
    // 动态导入单飞；失败要清掉 promise，下次调用才能重试（旧实现失败后 promise
    // 永远停留在 rejected，重载插件/恢复网络后不再尝试）。
    loadPromise ??= import('mermaid')
      .then((module) => module.default || module)
      .catch((error) => {
        loadPromise = null
        throw error
      })
    const mermaid = await loadPromise
    mermaid.initialize({ startOnLoad: false, theme })
    initializedTheme = theme
    state = { ...state, mermaid, isLoading: false, error: null, generation: state.generation + 1 }
    notify()
    return mermaid
  } catch (error) {
    setState({ isLoading: false, error: error instanceof Error ? error.message : 'Failed to initialize Mermaid' })
    throw error
  }
}

/** 取得完成 initialize 的 mermaid 实例（幂等；同主题并发只跑一次）。 */
export function ensureMermaid(theme: 'dark' | 'default'): Promise<any> {
  if (state.mermaid && initializedTheme === theme) return Promise.resolve(state.mermaid)
  initChain = initChain.catch(() => {}).then(() => doInitialize(theme))
  return initChain
}

export const useMermaid = () => {
  const { theme } = useTheme()
  // 订阅模块状态：initialize 的每次状态迁移（loading/完成/失败）都广播给全部消费者。
  const [, force] = useState(0)
  useEffect(() => {
    const listener = () => force((n) => n + 1)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  const targetTheme = theme === ThemeMode.dark ? 'dark' : 'default'
  useEffect(() => {
    // 失败经模块状态广播（error 字段），这里不重复上报。
    ensureMermaid(targetTheme).catch(() => {})
  }, [targetTheme])

  return {
    mermaid: state.mermaid,
    isLoading: state.isLoading,
    error: state.error,
    generation: state.generation
  }
}

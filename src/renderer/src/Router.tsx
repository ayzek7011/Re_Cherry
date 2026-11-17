import '@renderer/databases'

import { Skeleton } from 'antd'
import type { FC } from 'react'
import { lazy, Suspense, useMemo } from 'react'
import { HashRouter, Route, Routes } from 'react-router-dom'

import Sidebar from './components/app/Sidebar'
import { ErrorBoundary } from './components/ErrorBoundary'
import TabsContainer from './components/Tab/TabContainer'
import NavigationHandler from './handler/NavigationHandler'
import { useOnboardingState } from './hooks/useOnboardingState'
import { useNavbarPosition } from './hooks/useSettings'
// 首页（默认路由）保持静态导入：它就是首屏本身，懒加载只会换来一次不必要的空屏闪烁，
// 且其子树（消息/Markdown/输入栏）本来就必须在启动时可用。
import HomePage from './pages/home/HomePage'

// Onboarding 懒加载：静态链 OnboardingPage → WelcomePage → ProviderPopup → ProviderList →
// ModelNotesPopup → MarkdownEditor → rehype-katex 把 katex/ModelSettings/ProviderList 约 830KB
// 拖进首屏 eager 图，而 onboarding 只在首次安装前渲染一次（React.lazy 路由级分割先例见下）。

// v1 启动优化（包体实测：首屏 eager 约 21MB rendered）：其余页面路由级分割。
// 每个页面连同其专属重依赖（RichEditor/tiptap、CodeMirror、dnd、xyflow、各设置面板）
// 移出首屏 eager 图，首次进入该路由时才加载。首次进入有 Suspense 骨架兜底。
const FilesPage = lazy(() => import('./pages/files/FilesPage'))
const KnowledgePage = lazy(() => import('./pages/knowledge/KnowledgePage'))
const LaunchpadPage = lazy(() => import('./pages/launchpad/LaunchpadPage'))
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage'))
const TranslatePage = lazy(() => import('./pages/translate/TranslatePage'))
const PaintingPage = lazy(() => import('./pages/paintings/PaintingPage'))
const NotesPage = lazy(() => import('./pages/notes/NotesPage'))
const MinAppPage = lazy(() => import('./pages/apps/MinAppPage'))
const MinAppsPage = lazy(() => import('./pages/apps/MinAppsPage'))
const CodeCliPage = lazy(() => import('./pages/code/CodeCliPage'))
const OnboardingPage = lazy(() => import('./pages/onboarding').then((m) => ({ default: m.OnboardingPage })))

/** 路由懒加载占位：页面形状的骨架（不用空白屏；静默不可见是最差失败形态）。 */
const RouteLoadingFallback: FC = () => (
  <div style={{ padding: 24, width: '100%' }} role="status" aria-busy="true" aria-live="polite">
    <Skeleton active paragraph={{ rows: 6 }} />
  </div>
)

const Router: FC = () => {
  const { onboardingCompleted, completeOnboarding } = useOnboardingState()
  const { navbarPosition } = useNavbarPosition()

  const routes = useMemo(() => {
    return (
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route path="/launchpad" element={<LaunchpadPage />} />
          <Route path="/settings/*" element={<SettingsPage />} />
          <Route path="/translate" element={<TranslatePage />} />
          <Route path="/paintings" element={<PaintingPage />} />
          {/* 笔记复活（V1 原样） */}
          <Route path="/notes" element={<NotesPage />} />
          {/* 小程序页面（V1 原样：列表页 + 详情壳） */}
          <Route path="/apps/:appId" element={<MinAppPage />} />
          <Route path="/apps" element={<MinAppsPage />} />
          {/* 编码助手（Code Mate，V2 移植） */}
          <Route path="/code" element={<CodeCliPage />} />
        </Routes>
      </ErrorBoundary>
    )
  }, [])

  if (!onboardingCompleted) {
    return (
      <Suspense fallback={<RouteLoadingFallback />}>
        <OnboardingPage onComplete={completeOnboarding} />
      </Suspense>
    )
  }

  if (navbarPosition === 'left') {
    return (
      <HashRouter>
        <Sidebar />
        <Suspense fallback={<RouteLoadingFallback />}>{routes}</Suspense>
        <NavigationHandler />
      </HashRouter>
    )
  }

  return (
    <HashRouter>
      <NavigationHandler />
      <TabsContainer>
        <Suspense fallback={<RouteLoadingFallback />}>{routes}</Suspense>
      </TabsContainer>
    </HashRouter>
  )
}

export default Router

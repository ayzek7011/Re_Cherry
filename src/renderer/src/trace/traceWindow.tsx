import i18n, { changeAppLanguage, initI18n } from '@renderer/i18n'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { TraceIcon } from './pages/Component'
import { TracePage } from './pages/index'

const App = () => {
  const [traceId, setTraceId] = useState('')
  const [topicId, setTopicId] = useState('')
  const [modelName, setModelName] = useState<string | undefined>(undefined)
  const [reload, setReload] = useState(false)
  const [title, setTitle] = useState('Call Chain Window')

  useEffect(() => {
    const setTraceHandler = (data: { traceId?: string; topicId?: string; modelName?: string }) => {
      if (data?.traceId && data?.topicId) {
        setTraceId(data.traceId)
        setTopicId(data.topicId)
        setModelName(data.modelName)
        setReload(!reload)
      }
    }

    const setLangHandler = (data: { lang: string }) => {
      // 语言包按需装载后 changeLanguage 是异步的：等切换完成再取标题文案，
      // 否则 t() 读到的还是旧语言（原实现同步读 t 依赖了内联资源即时切换的巧合）。
      void changeAppLanguage(data.lang).then(() => {
        const newTitle = i18n.t('trace.traceWindow')
        if (newTitle !== title) {
          void window.api.trace.setTraceWindowTitle(i18n.t('trace.traceWindow'))
          setTitle(newTitle)
        }
      })
    }

    const removeTraceHandler = window.api.events.onTraceSelected(setTraceHandler)
    const removeLanguageHandler = window.api.events.onTraceLanguageChanged(setLangHandler)

    return () => {
      removeTraceHandler()
      removeLanguageHandler()
    }
  }, [title, reload, modelName, traceId, topicId])

  const handleFooterClick = () => {
    void window.api.shell.openExternal('https://www.aliyun.com/product/edas')
  }

  return (
    <>
      <header className="header">
        <div className="headerIcon">
          <TraceIcon color="#e74c3c" size={24} />
        </div>
        <div className="headerTitle">{title}</div>
      </header>
      <TracePage traceId={traceId} topicId={topicId} reload={reload} modelName={modelName} />
      <footer>
        <span onClick={handleFooterClick} className="footer-link">
          {i18n.t('trace.edasSupport')}
        </span>
      </footer>
    </>
  )
}

const root = createRoot(document.getElementById('root')!)
// i18n 懒语言包（问题5 #4）：首帧渲染等 initI18n 装载完启动语言。
void initI18n().then(() => root.render(<App />))

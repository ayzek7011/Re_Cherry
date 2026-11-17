import { loggerService } from '@logger'
import { nanoid } from '@reduxjs/toolkit'
import { useMermaid } from '@renderer/hooks/useMermaid'
import React, { memo, useCallback, useEffect, useRef, useState } from 'react'

import ImagePreviewLayout from './ImagePreviewLayout'
import { ShadowTransparentContainer } from './styles'
import type { BasicPreviewHandles, BasicPreviewProps } from './types'
import { renderSvgInShadowHost } from './utils'

const logger = loggerService.withContext('MermaidPreview')

/** 内容仍在增长期（流式）内的失败不显示错误：距上次内容变化不足该阈值时保持上一张图。 */
const STREAM_SETTLE_MS = 1500
/** 防抖：流式输出逐字变化，停顿后才渲染。 */
const RENDER_DEBOUNCE_MS = 400
/** 触发宽度重渲染的最小变化量（阈值内不折腾）。 */
const RESIZE_EPSILON = 16

/**
 * 预览 Mermaid 图表（shadow DOM 渲染）。
 *
 * 渲染管线（2026-10-20 重写，修复"渲染框在、内容看不见"）：
 * 1. **零宽不渲染**——mermaid 在零宽容器里测量会产出平移到画布外的图形（旧实现只对
 *    `translate(undefined, NaN)` 打过一个正则补丁），且 `width === 0 → return` 的静默
 *    跳过让框永远空白。现在零宽时搁置（pendingContent），**ResizeObserver** 在宽度
 *    出现的瞬间补渲染；折叠/展开、虚拟化复用、窗口还原都走这一条路。
 * 2. **宽度变化即重渲染**——旧实现没有任何宽度监听，窗口缩放/侧栏开合后图被裁剪。
 * 3. **每次渲染全新 diagramId**——复用 id 会与 mermaid 留在 body 里的临时节点冲突。
 * 4. **渲染纪元（epoch）**——流式期间多次触发渲染，只有最新一次允许写 shadow root，
 *    慢的旧渲染不得覆盖新结果。
 * 5. **失败分级**——内容仍在增长期（距上次变化 < STREAM_SETTLE_MS）的失败多半是语法
 *    中间态：保持上一张图、不闪错误块；稳定后的失败才显示错误。
 * 6. **主题代数**——useMermaid 的 generation 变化（含主题切换）后用当前内容重渲染。
 */
const MermaidPreview = ({
  children,
  enableToolbar = false,
  ref
}: BasicPreviewProps & { ref?: React.RefObject<BasicPreviewHandles | null> }) => {
  const { mermaid, isLoading: isLoadingMermaid, error: mermaidError, generation } = useMermaid()
  const containerRef = useRef<HTMLDivElement>(null)
  const [isRendering, setIsRendering] = useState(false)
  const [renderError, setRenderError] = useState<string | null>(null)

  const renderEpoch = useRef(0)
  const latestContent = useRef('')
  const lastContentChangeAt = useRef(0)
  /** 已成功渲染的容器宽度；0 = 尚无成功渲染。 */
  const renderedWidth = useRef(0)
  /** 已成功渲染的内容（同内容 + 同宽度不重复渲染）。 */
  const renderedContent = useRef<string | null>(null)
  /** 已渲染时的主题代数（主题切换后即便内容相同也要重渲染）。 */
  const renderedGeneration = useRef(0)
  /** 因容器无宽度而搁置的内容；宽度出现（ResizeObserver）后立即补渲染。 */
  const pendingContent = useRef<string | null>(null)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const renderNow = useCallback(
    async (content: string, measuredWidth?: number) => {
      const container = containerRef.current
      if (!container || !mermaid || !content) return

      // 宽度优先取 RO 回调的 contentRect（与触发时刻一致）；内容驱动的调用现测。
      const width = measuredWidth ?? container.clientWidth
      if (width <= 0) {
        pendingContent.current = content
        return
      }
      pendingContent.current = null

      // 幂等闸：同内容 + 同宽度 + 同主题代数 + 无搁置 → 本次调用无事可做（内容防抖与
      // RO 回调常常先后到达同一状态，重复渲染是纯浪费）。
      if (
        content === renderedContent.current &&
        width === renderedWidth.current &&
        generation === renderedGeneration.current
      ) {
        return
      }

      const epoch = ++renderEpoch.current
      setIsRendering(true)
      // 每次渲染全新 id：见组件头注第 3 条。
      const diagramId = `mermaid-viz-${nanoid(8)}`
      const measureEl = document.createElement('div')
      measureEl.style.position = 'absolute'
      measureEl.style.left = '-9999px'
      measureEl.style.top = '-9999px'
      measureEl.style.width = `${width}px`
      document.body.appendChild(measureEl)

      try {
        await mermaid.parse(content)
        const { svg } = await mermaid.render(diagramId, content, measureEl)
        if (epoch !== renderEpoch.current) {
          logger.debug('Discarded a stale mermaid render (superseded by a newer request)')
          return
        }
        renderSvgInShadowHost(svg, container)
        renderedWidth.current = width
        renderedContent.current = content
        renderedGeneration.current = generation
        setRenderError(null)
      } catch (error) {
        if (epoch !== renderEpoch.current) return
        const message = error instanceof Error ? error.message : 'Unknown rendering error'
        if (Date.now() - lastContentChangeAt.current < STREAM_SETTLE_MS) {
          logger.debug(`Mermaid render deferred while content is streaming: ${message}`)
        } else {
          logger.error('Failed to render mermaid diagram', error as Error)
          setRenderError(message)
        }
      } finally {
        document.body.removeChild(measureEl)
        if (epoch === renderEpoch.current) setIsRendering(false)
      }
    },
    [mermaid, generation]
  )

  // 内容变化 → 防抖渲染。lastContentChangeAt 供失败分级（流式中间态 vs 稳定态）。
  useEffect(() => {
    latestContent.current = children
    lastContentChangeAt.current = Date.now()
    if (!children) return
    // 同内容且无搁置 → 无事可做（宽度的变化由 ResizeObserver 负责）。
    if (children === renderedContent.current && pendingContent.current === null) return
    clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => void renderNow(latestContent.current), RENDER_DEBOUNCE_MS)
    return () => clearTimeout(debounceTimer.current)
  }, [children, renderNow])

  // 宽度出现/变化 → （重）渲染。ResizeObserver 在 observe 的瞬间也会回报一次当前
  // 尺寸，所以首挂载的真实布局宽度晚于内容 effect 时由这里兜住。
  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? container.clientWidth
      if (width <= 0) return
      const content = pendingContent.current ?? latestContent.current
      if (!content) return
      const widthChanged = renderedWidth.current === 0 || Math.abs(width - renderedWidth.current) > RESIZE_EPSILON
      if (pendingContent.current !== null || widthChanged) {
        void renderNow(content, width)
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [renderNow])

  // 主题代数变化（首次 initialize 完成 / 主题切换）→ 用新主题重渲染当前内容。
  useEffect(() => {
    if (generation > 0 && generation !== renderedGeneration.current && latestContent.current) {
      void renderNow(latestContent.current)
    }
  }, [generation, renderNow])

  useEffect(() => {
    return () => {
      clearTimeout(debounceTimer.current)
      // 失效在飞的渲染：卸载后其结果不得再写入 shadow root。
      renderEpoch.current += 1
    }
  }, [])

  return (
    <ImagePreviewLayout
      loading={isLoadingMermaid || isRendering}
      error={mermaidError || renderError}
      enableToolbar={enableToolbar}
      ref={ref}
      imageRef={containerRef}
      source="mermaid">
      <ShadowTransparentContainer ref={containerRef} className="mermaid special-preview" />
    </ImagePreviewLayout>
  )
}

export default memo(MermaidPreview)

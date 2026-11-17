import Scrollbar from '@renderer/components/Scrollbar'
import { cn } from '@renderer/utils'
import { throttle } from 'lodash-es'
import { ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

/**
 * 水平滚动容器
 * @param children 子元素
 * @param dependencies 依赖项
 * @param scrollDistance 滚动距离
 * @param className 类名
 * @param gap 间距
 * @param expandable 是否可展开
 */
export interface HorizontalScrollContainerProps {
  children: React.ReactNode
  dependencies?: readonly unknown[]
  scrollDistance?: number
  className?: string
  classNames?: {
    container?: string
    content?: string
  }
  gap?: string
  expandable?: boolean
}

const HorizontalScrollContainer: React.FC<HorizontalScrollContainerProps> = ({
  children,
  dependencies = [],
  scrollDistance = 200,
  className,
  classNames,
  gap = '8px',
  expandable = false
}) => {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScroll, setCanScroll] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [isScrolledToEnd, setIsScrolledToEnd] = useState(false)
  // 用 ref 记住上次的值，只在真的变化时 setState。否则每次 scroll 事件都要排队
  // 一次渲染，等 React 走到重新渲染阶段才发现值没变（bail out 发生在渲染期，不是入口）。
  const lastCanScrollRef = useRef(false)
  const lastAtEndRef = useRef(false)

  const handleScrollRight = (event: React.MouseEvent) => {
    scrollRef.current?.scrollBy({ left: scrollDistance, behavior: 'smooth' })
    event.stopPropagation()
  }

  const handleContainerClick = (e: React.MouseEvent) => {
    if (expandable) {
      // 确保不是点击了其他交互元素（如 tag 的关闭按钮）
      const target = e.target as HTMLElement
      if (!target.closest('[data-no-expand]')) {
        setIsExpanded(!isExpanded)
      }
    }
  }

  const checkScrollability = useCallback(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement) return

    const parentElement = scrollElement.parentElement
    const availableWidth = parentElement ? parentElement.clientWidth : scrollElement.clientWidth

    // 确保容器不会超出可用宽度
    // ≥4px 溢出才显示滚动能力。零迟滞硬阈值在相邻 reflow 期间高频翻转
    // （内容宽度在阈值上骑乘），是消息脚部横滚按钮反复消失重现的振荡源。
    const canScrollValue = scrollElement.scrollWidth > Math.min(availableWidth, scrollElement.clientWidth) + 4
    if (canScrollValue !== lastCanScrollRef.current) {
      lastCanScrollRef.current = canScrollValue
      setCanScroll(canScrollValue)
    }

    // 检查是否滚动到最右侧
    if (canScrollValue) {
      const isAtEnd = Math.abs(scrollElement.scrollLeft + scrollElement.clientWidth - scrollElement.scrollWidth) <= 1
      if (isAtEnd !== lastAtEndRef.current) {
        lastAtEndRef.current = isAtEnd
        setIsScrolledToEnd(isAtEnd)
      }
    } else if (lastAtEndRef.current) {
      lastAtEndRef.current = false
      setIsScrolledToEnd(false)
    }
  }, [])

  useEffect(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement) return

    // `handleScroll` 原本没有任何节流，每个 scroll 事件都同步读 clientWidth/scrollWidth
    // （强制 layout）并调用两次 setState。标签栏在首屏可见，一次横向拖动就是每帧一次强制 layout。
    const throttledCheck = throttle(checkScrollability, 100)
    checkScrollability()

    const resizeObserver = new ResizeObserver(() => checkScrollability())
    resizeObserver.observe(scrollElement)

    scrollElement.addEventListener('scroll', throttledCheck)
    window.addEventListener('resize', throttledCheck)

    return () => {
      resizeObserver.disconnect()
      scrollElement.removeEventListener('scroll', throttledCheck)
      window.removeEventListener('resize', throttledCheck)
      throttledCheck.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkScrollability, ...dependencies])

  return (
    <Container
      className={cn(className, classNames?.container)}
      $expandable={expandable}
      $disableHoverButton={isScrolledToEnd}
      onClick={expandable ? handleContainerClick : undefined}>
      <ScrollContent
        ref={scrollRef}
        $gap={gap}
        $isExpanded={isExpanded}
        $expandable={expandable}
        className={cn(classNames?.content)}>
        {children}
      </ScrollContent>
      {canScroll && !isExpanded && !isScrolledToEnd && (
        <ScrollButton
          className="scroll-right-button"
          role="button"
          tabIndex={0}
          aria-label={t('common.more')}
          onKeyDown={(event) => {
            // 溢出时这个按钮是「继续看后面的内容」的唯一显式入口，键盘必须可达。
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            scrollRef.current?.scrollBy({ left: scrollDistance, behavior: 'smooth' })
          }}
          onClick={handleScrollRight}>
          <ChevronRight size={14} />
        </ScrollButton>
      )}
    </Container>
  )
}

const Container = styled.div<{ $expandable?: boolean; $disableHoverButton?: boolean }>`
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 0;
  max-width: 100%;
  position: relative;
  cursor: ${(props) => (props.$expandable ? 'pointer' : 'default')};

  ${(props) =>
    !props.$disableHoverButton &&
    `
    &:hover {
      .scroll-right-button {
        opacity: 1;
      }
    }
  `}
`

const ScrollContent = styled(Scrollbar)<{
  $gap: string
  $isExpanded?: boolean
  $expandable?: boolean
}>`
  display: flex;
  overflow-x: ${(props) => (props.$expandable && props.$isExpanded ? 'hidden' : 'auto')};
  overflow-y: hidden;
  white-space: ${(props) => (props.$expandable && props.$isExpanded ? 'normal' : 'nowrap')};
  gap: ${(props) => props.$gap};
  flex-wrap: ${(props) => (props.$expandable && props.$isExpanded ? 'wrap' : 'nowrap')};

  &::-webkit-scrollbar {
    display: none;
  }
`

const ScrollButton = styled.div`
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 1;
  opacity: 0;
  transition: opacity 0.2s ease-in-out;
  cursor: pointer;
  background: var(--color-background);
  border-radius: 50%;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow:
    0 6px 16px 0 rgba(0, 0, 0, 0.08),
    0 3px 6px -4px rgba(0, 0, 0, 0.12),
    0 9px 28px 8px rgba(0, 0, 0, 0.05);
  color: var(--color-text-2);

  &:hover {
    color: var(--color-text);
    background: var(--color-list-item);
  }

  /* 键盘聚焦时必须显形（该按钮平时靠 hover 才出现）。 */
  &:focus-visible {
    opacity: 1;
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
`

export default HorizontalScrollContainer

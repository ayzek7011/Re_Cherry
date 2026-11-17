import { throttle } from 'lodash-es'
import { useEffect, useMemo, useRef } from 'react'

import { useTimer } from './useTimer'

/**
 * A custom hook that manages scroll position persistence for a container element
 * @param key - A unique identifier used to store/retrieve the scroll position
 * @returns An object containing:
 *  - containerRef: React ref for the scrollable container
 *  - handleScroll: Throttled scroll event handler that saves scroll position
 */
export default function useScrollPosition(key: string, throttleWait?: number) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollKey = useMemo(() => `scroll:${key}`, [key])
  const scrollKeyRef = useRef(scrollKey)
  const { setTimeoutTimer } = useTimer()

  useEffect(() => {
    scrollKeyRef.current = scrollKey
  }, [scrollKey])

  /**
   * throttle 必须按 `throttleWait` 记忆化。旧实现每次渲染都新建一个
   * throttled 函数，而 cleanup effect 依赖这个新函数 ⇒ 每次渲染都跑一次
   * `cancel()`，把尚未触发的 trailing 调用丢掉（流式期间消费方逐帧重渲染，
   * 「用户停下滚动」的那次保存被系统性取消）。经 ref 读取 key，记忆化不会
   * 捕获过期的 scrollKey。
   */
  const handleScroll = useMemo(
    () =>
      throttle(() => {
        const position = containerRef.current?.scrollTop ?? 0
        window.requestAnimationFrame(() => {
          window.keyv.set(scrollKeyRef.current, position)
        })
      }, throttleWait ?? 100),
    [throttleWait]
  )

  useEffect(() => {
    const scroll = () => containerRef.current?.scrollTo({ top: window.keyv.get(scrollKey) || 0 })
    scroll()
    setTimeoutTimer('scrollEffect', scroll, 50)
  }, [scrollKey, setTimeoutTimer])

  useEffect(() => {
    return () => handleScroll.cancel()
  }, [handleScroll])

  return { containerRef, handleScroll }
}

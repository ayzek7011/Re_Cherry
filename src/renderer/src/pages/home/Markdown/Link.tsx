/**
 * Markdown links 组件（V2 迁移件）。
 *
 * 引用链接 = href 里带 sup[data-citation] 子节点的链接。V2 加固：
 * - data-citation 只存编号，引用数据从 CitationRegistryContext 查（out-of-band）。
 * - 挂弹层前校验链接 href 与 registry 里的引用 URL 一致（防属性注入）。
 * 普通链接走 Hyperlink。
 */
import type { Citation } from '@renderer/types'
import { findCitationNumberInChildren } from '@renderer/utils/markdown'
import { omit } from 'lodash-es'
import React, { use, useMemo } from 'react'
import type { Node } from 'unist'

import { CitationRegistryContext } from './CitationRegistryContext'
import CitationTooltip from './CitationTooltip'
import Hyperlink from './Hyperlink'

/** 规范化 URL 比较（V2 hasSameUrl 简化版：忽略尾斜杠差异）。 */
function hasSameUrl(href: string | undefined, citationUrl: string): boolean {
  if (!href || !citationUrl) return false
  const normalize = (u: string) => u.replace(/\/+$/, '')
  return normalize(href) === normalize(citationUrl)
}

interface LinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  node?: Omit<Node, 'type'>
}

const Link: React.FC<LinkProps> = (props) => {
  const registry = use(CitationRegistryContext)

  const citationData = useMemo<{ citation: Citation; number: number } | null>(() => {
    if (!registry) return null
    const number = findCitationNumberInChildren(props.children)
    if (number === null) return null
    const citation = registry.get(number)
    return citation ? { citation, number } : null
  }, [registry, props.children])

  // 处理内部链接
  if (props.href?.startsWith('#')) {
    return <span className="link">{props.children}</span>
  }

  // 引用链接：registry 命中 + href 与引用 URL 一致才挂胶囊
  if (citationData && hasSameUrl(props.href, citationData.citation.url)) {
    return (
      <CitationTooltip citation={citationData.citation}>
        <a
          {...omit(props, ['node'])}
          href={props.href}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
        />
      </CitationTooltip>
    )
  }

  // 普通链接
  return (
    <Hyperlink href={props.href || ''}>
      <a {...omit(props, ['node'])} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} />
    </Hyperlink>
  )
}

export default Link

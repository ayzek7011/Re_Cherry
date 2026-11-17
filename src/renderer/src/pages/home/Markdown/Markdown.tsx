import 'katex/dist/katex.min.css'
import 'remark-github-blockquote-alert/alert.css'

import ImageViewer from '@renderer/components/ImageViewer'
import MarkdownShadowDOMRenderer from '@renderer/components/MarkdownShadowDOMRenderer'
import { useSetting } from '@renderer/hooks/useSettings'
import { useSmoothStream } from '@renderer/hooks/useSmoothStream'
import type {
  CompactMessageBlock,
  MainTextMessageBlock,
  ThinkingMessageBlock,
  TranslationMessageBlock
} from '@renderer/types/newMessage'
import { removeSvgEmptyLines } from '@renderer/utils/formats'
import { processLatexBrackets } from '@renderer/utils/markdown'
import { isEmpty } from 'lodash-es'
import { type FC, memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkGfm from 'remark-gfm'
import remarkAlert from 'remark-github-blockquote-alert'
import remarkMath from 'remark-math'
import type { Pluggable } from 'unified'

import { type CitationRegistry, CitationRegistryContext } from './CitationRegistryContext'
import CitationSup from './CitationSup'
import CodeBlock from './CodeBlock'
import Link from './Link'
import MarkdownSvgRenderer from './MarkdownSvgRenderer'
import rehypeHeadingIds from './plugins/rehypeHeadingIds'
import rehypeScalableSvg from './plugins/rehypeScalableSvg'
import remarkDisableConstructs from './plugins/remarkDisableConstructs'
import { remarkHtmlArtifact, transformMarkdownOutsideHtmlArtifacts } from './plugins/remarkHtmlArtifact'
import { scanStandaloneHtmlArtifact } from './standaloneHtmlArtifact'
import Table from './Table'

/** V2 移植：内联 HTML 工件预览模式——流式期间 generating，落定后 ready。 */
export type InlineHtmlPreviewMode = 'generating' | 'ready'

/**
 * 数学渲染插件按引擎懒加载。
 *
 * MathJax 自 v1 首轮起懒加载；KaTeX 自 起同样懒加载——它此前是顶层
 * 静态导入，实测把约 573KB 的 KaTeX 引擎钉进首屏 store chunk（而同一引擎另有一份懒副本）。
 * 两个引擎共用同一套异步接线：插件就绪前该引擎的公式按原文渲染，就绪后由 state 更新重渲染；
 * 加载结果模块级缓存（跨消息块只付一次解析成本）。
 *
 * 续：KaTeX 的**两个 contrib**（`copy-tex` 复制公式为 LaTeX 源码、`mhchem` 化学式扩展）
 * 此前仍是本文件的顶层副作用导入，而它们是 `katex` 包的消费者 ⇒ 整份 KaTeX 实体（产物里
 * 443KB 的 `katex-*.js`）照样被钉在首屏静态导入闭包里。现在两个 contrib 与引擎插件一起
 * 在同一段动态导入里加载，且 contrib **先于**插件就绪（它们往 katex 实例注册宏/钩子，
 * 必须在第一次渲染前执行完）。
 */
let mathjaxPluginPromise: Promise<Pluggable> | null = null
function loadMathjaxPlugin(): Promise<Pluggable> {
  mathjaxPluginPromise ??= import('rehype-mathjax').then(
    // @ts-ignore rehype-mathjax 无类型声明（与旧静态导入同）
    (mod) => mod.default as unknown as Pluggable
  )
  return mathjaxPluginPromise
}

let katexPluginPromise: Promise<Pluggable> | null = null
function loadKatexPlugin(): Promise<Pluggable> {
  katexPluginPromise ??= (async () => {
    // 顺序有语义：contrib 注册到 katex 实例上，必须早于任何 rehype-katex 渲染。
    await import('katex/dist/contrib/copy-tex')
    await import('katex/dist/contrib/mhchem')
    const mod = await import('rehype-katex')
    return mod.default as unknown as Pluggable
  })()
  return katexPluginPromise
}

const ALLOWED_ELEMENTS =
  /<(style|p|div|span|b|i|strong|em|ul|ol|li|table|tr|td|th|thead|tbody|h[1-6]|blockquote|pre|code|br|hr|svg|path|circle|rect|line|polyline|polygon|text|g|defs|title|desc|tspan|sub|sup|details|summary)/i
const DISALLOWED_ELEMENTS = ['iframe', 'script']

// ---------------------------------------------------------------------------
// 流式尾块切分：稳定前缀 + 增长尾部。
//
// 此前流式期每帧把**累积全文**交给一个 ReactMarkdown：unified 管线（remark-gfm / alert /
// cjk-friendly / math → remark-rehype → rehype-raw/scalableSvg/headingIds/katex → React 元素）
// 对整条消息重跑一次，成本随消息长度线性增长（40KB 正文 × 60fps ≈ 每秒 2.4MB 文本重解析）。
//
// 修法：把文本切成 `stablePrefix`（最后一个"已闭合块边界"之前的部分）+ `tail`（仍在增长
// 的尾块）。前缀的 React 元素按**源字符串**缓存在组件实例上复用（前缀不变 ⇒ 命中 ⇒ 整条
// 管线不跑），只有尾块每帧重解析 ⇒ 成本从 O(全文) 降到 O(尾块)。
//
// 为什么用"元素缓存"而不是把前缀渲染成 HTML：前缀里的 CodeBlock/MarkdownShadowDOMRenderer
// 依赖活的 React children（portal + 上下文），序列化成 HTML 会破坏它们。缓存元素则保持
// 单实例语义：内容落定（`status === 'success'`）时不切分，整条消息仍由**一个** ReactMarkdown
// 渲染，与改动前逐字节一致。
// ---------------------------------------------------------------------------

/** 前缀切片信息（诊断/测试用：证明"同一稳定前缀不被重复解析"）。 */
export const markdownPrefixStats = {
  /** 已渲染过的、互不相同的稳定前缀数量（每次管线执行 +1）。 */
  prefixRenders: 0,
  /** 命中缓存而复用的次数（未执行管线）。 */
  prefixReuses: 0,
  /** 最近一次实际用于渲染的前缀（未切分时为 ''）。 */
  activePrefix: '',
  /** 最近一次渲染的尾块（与 `activePrefix` 同帧，用于断言 prefix + tail === 全文）。 */
  activeTail: '',
  /** 最近一次渲染的完整 markdown 文本（与 activePrefix/activeTail 同帧）。 */
  previewedContent: '',
  /** 一次性握手位：本次渲染即将跑管线的前缀（测试桩消费后清空，用于区分前缀/尾块）。 */
  lastPrefix: '',
  reset(): void {
    markdownPrefixStats.prefixRenders = 0
    markdownPrefixStats.prefixReuses = 0
    markdownPrefixStats.activePrefix = ''
    markdownPrefixStats.activeTail = ''
    markdownPrefixStats.previewedContent = ''
    markdownPrefixStats.lastPrefix = ''
  }
}

/** 切分结果：`prefix` 为空 = 不切分（整段走原来的单实例路径）。 */
export interface MarkdownSplit {
  prefix: string
  tail: string
}

/**
 * 稳定的最小前缀长度：太短的前缀切分没有收益（管线启动成本 > 重解析成本），
 * 且会让前缀缓存高频变化。
 */
const MIN_STABLE_PREFIX = 256

/**
 * 尾块的"保底长度"：切点从后往前取第一个满足该余量的块边界。
 *
 * 为什么要留余量：渲染帧提供的是半成品文本（如 `"Hello wor"`）。若用"最后一个空行"当切点，
 * 新段落刚出现第一个字符就会让前缀 key 变化、缓存失效。留一块的余量后，前缀只在"新块已长出
 * 一段内容"时前移；Markdown 是增量语法：一旦某行被空行封闭且后面已有新块，后续文本无法再
 * 改写它，故该前缀确实稳定（唯一例外是后面出现的引用式定义 `[r]: url`，属罕见形态）。
 */
const MIN_TAIL_BYTES = 64

/**
 * 切出"稳定前缀 + 尾块"。
 *
 * 切点规则（保守优先，宁可少切不可切错）：
 *  - 只在**空行**处切（围栏内的空行不算），切点之后不会改变切点之前的解析结果；
 *  - 取"最后一个满足 `text.length - cut >= MIN_TAIL_BYTES` 的空行边界"：余量让**刚出现
 *    半块**时仍留在尾块里，避免"新段落第一个字符到达就换前缀 key"的抖动；
 *  - 前缀必须是"自包含"的：围栏（``` ~~~）与 `$$` 数学块都必须已闭合，
 *    否则不切（未闭合的围栏会把后面的正文当代码，切开会让前缀渲染出错误的块）；
 *  - `tail` 从新块的第一个字符开始，因此**不可能**与上一行的 `---`/`===`/`|`
 *    组成新构造（那些构造都要求上一行紧邻且非空）。
 */
export function splitStablePrefix(text: string): MarkdownSplit {
  const none: MarkdownSplit = { prefix: '', tail: text }
  if (text.length < MIN_STABLE_PREFIX) return none

  let fenceChar = ''
  let fenceLen = 0
  let inMath = false
  /** 已见到的块边界（空行后的偏移），升序。 */
  const boundaries: number[] = []

  let lineStart = 0
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart)
    const lineEnd = nl === -1 ? text.length : nl
    const line = text.slice(lineStart, lineEnd)

    if (fenceLen > 0) {
      // 围栏内：只有同字符且不短于开启围栏的标记才闭合
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (close !== null && close[1][0] === fenceChar && close[1].length >= fenceLen) {
        fenceLen = 0
        fenceChar = ''
      }
    } else {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
      if (open !== null) {
        fenceChar = open[1][0]
        fenceLen = open[1].length
      } else if (/^ {0,3}\$\$\s*$/.test(line)) {
        inMath = !inMath
      } else if (line.trim() === '' && !inMath && nl !== -1) {
        boundaries.push(nl + 1)
      }
    }

    if (nl === -1) break
    lineStart = nl + 1
  }

  // 结束时仍未闭合 ⇒ 不切（前缀会被渲染成残缺块）
  if (fenceLen > 0 || inMath) return none

  // 从后往前找第一个"尾部余量足够"的边界
  let cut = -1
  for (let i = boundaries.length - 1; i >= 0; i--) {
    if (text.length - boundaries[i] >= MIN_TAIL_BYTES) {
      cut = boundaries[i]
      break
    }
  }
  if (cut < MIN_STABLE_PREFIX) return none

  return { prefix: text.slice(0, cut), tail: text.slice(cut) }
}

/**
 * 前缀元素缓存（组件实例级）：`source` 未变 ⇒ 复用上一次的 React 元素，
 * 整个 unified 管线不执行。
 */
interface PrefixCacheEntry {
  source: string
  node: ReactNode
}
/**
 * 缓存条数上限。前缀在流式期只增不减，实际只可能同时需要"当前 + 刚被替换掉的一两个"；
 * 留 3 条既覆盖块重试/编辑后回到旧前缀的场景，又避免把大量历史前缀的 React 元素
 * （含 CodeBlock/ImageViewer 实例）长期挂在内存里。
 */
const PREFIX_CACHE_MAX = 3

interface Props {
  // message: Message & { content: string }
  block: MainTextMessageBlock | ThinkingMessageBlock | CompactMessageBlock | TranslationMessageBlock
  // 可选的后处理函数，用于在流式渲染过程中处理文本（如引用标签转换）
  postProcess?: (text: string) => string
  /** 引用 registry（V2 迁移）：编号 → 引用数据，供 Link/CitationSup 查表挂胶囊。 */
  citationRegistry?: CitationRegistry
}

const Markdown: FC<Props> = ({ block, postProcess, citationRegistry }) => {
  const { t } = useTranslation()
  const mathEngine = useSetting('mathEngine')
  const mathEnableSingleDollar = useSetting('mathEnableSingleDollar')

  const isTrulyDone = 'status' in block && block.status === 'success'
  const [displayedContent, setDisplayedContent] = useState(postProcess ? postProcess(block.content) : block.content)
  const [isStreamDone, setIsStreamDone] = useState(isTrulyDone)
  // 当前数学引擎的 rehype 插件（懒加载；引擎为 none 时恒为 null）
  const [mathPlugin, setMathPlugin] = useState<Pluggable | null>(null)

  useEffect(() => {
    if (mathEngine === 'none') {
      setMathPlugin(null)
      return
    }
    // 切引擎时先清空，避免短暂沿用上一个引擎的插件渲染
    setMathPlugin(null)
    const load = mathEngine === 'KaTeX' ? loadKatexPlugin : mathEngine === 'MathJax' ? loadMathjaxPlugin : null
    if (load === null) return
    let cancelled = false
    void load().then((plugin) => {
      // 必须包成 updater：rehype 插件本身是函数，直接 setState(fn) 会被 React
      // 当成更新函数调用（存进去的是"以旧 state 调用插件的返回值"= undefined）。
      if (!cancelled) setMathPlugin(() => plugin)
    })
    return () => {
      cancelled = true
    }
  }, [mathEngine])

  const prevContentRef = useRef(block.content)
  const prevBlockIdRef = useRef(block.id)
  /** 稳定前缀元素缓存（实例级 LRU）：前缀源串未变即复用，管线不执行。 */
  const prefixCacheRef = useRef<Map<string, PrefixCacheEntry>>(new Map())

  const { addChunk, reset } = useSmoothStream({
    onUpdate: (rawText) => {
      // 如果提供了后处理函数就调用，否则直接使用原始文本
      const finalText = postProcess ? postProcess(rawText) : rawText
      setDisplayedContent(finalText)
    },
    streamDone: isStreamDone,
    initialText: block.content
  })

  useEffect(() => {
    const newContent = block.content || ''
    const oldContent = prevContentRef.current || ''

    const isDifferentBlock = block.id !== prevBlockIdRef.current

    const isContentReset = oldContent && newContent && !newContent.startsWith(oldContent)

    if (isDifferentBlock || isContentReset) {
      reset(newContent)
    } else {
      const delta = newContent.substring(oldContent.length)
      if (delta) {
        addChunk(delta)
      }
    }

    prevContentRef.current = newContent
    prevBlockIdRef.current = block.id

    // 更新 stream 状态
    const isStreaming = block.status === 'streaming'
    setIsStreamDone(!isStreaming)
  }, [block.content, block.id, block.status, addChunk, reset])

  // V2 移植：内联 HTML 预览模式推导（仅 assistant 内容块）。thinking/compact 块同为
  // assistant 内容，按 status 推导是可接受的近似（V2 由 MessagePartsRenderer 按角色门控）。
  const inlineHtmlPreviewMode = useMemo<InlineHtmlPreviewMode | undefined>(() => {
    if (!('status' in block)) return undefined
    if (block.status === 'success') return 'ready'
    if (block.status === 'streaming' || block.status === 'processing' || block.status === 'pending') {
      return 'generating'
    }
    return undefined
  }, [block])

  // V2 defense：显示层内容落后于 block.content（平滑流）时，ready 必须退回 generating，
  // 防止半流文本被当作完整工件送进安全门。
  const effectiveHtmlPreviewMode =
    inlineHtmlPreviewMode === 'ready' && displayedContent !== block.content ? 'generating' : inlineHtmlPreviewMode

  // 整条消息就是一个 HTML 工件时，跳过 Markdown 管线直接走 CodeBlock 渲染面。
  const standaloneArtifact = useMemo(
    () =>
      effectiveHtmlPreviewMode
        ? scanStandaloneHtmlArtifact(block.content, effectiveHtmlPreviewMode === 'generating')
        : undefined,
    [block.content, effectiveHtmlPreviewMode]
  )

  const remarkPlugins = useMemo(() => {
    const plugins = [
      [remarkGfm, { singleTilde: false }] as Pluggable,
      [remarkAlert] as Pluggable,
      remarkCjkFriendly,
      remarkDisableConstructs(['codeIndented'])
    ]
    if (effectiveHtmlPreviewMode) {
      plugins.push(remarkHtmlArtifact)
    }
    if (mathEngine !== 'none') {
      plugins.push([remarkMath, { singleDollarTextMath: mathEnableSingleDollar }])
    }
    return plugins
  }, [mathEngine, mathEnableSingleDollar, effectiveHtmlPreviewMode])

  const messageContent = useMemo(() => {
    if ('status' in block && block.status === 'paused' && isEmpty(block.content)) {
      return t('message.chat.completion.paused')
    }
    const transform = (source: string) => removeSvgEmptyLines(processLatexBrackets(source))
    if (!effectiveHtmlPreviewMode) {
      return transform(displayedContent)
    }
    // V2：>256KB 的流式内容跳过工件解析（解析成本），直接原样渲染。
    if (effectiveHtmlPreviewMode === 'generating' && block.content.length > 256 * 1024) {
      return transform(displayedContent)
    }
    return transformMarkdownOutsideHtmlArtifacts(displayedContent, transform)
  }, [block, displayedContent, t, effectiveHtmlPreviewMode])

  // 布尔化门控：插件数组依赖 messageContent 字符串会让 react-markdown 每个
  // 流式 tick 重建 unified 处理器管线；依赖布尔值则只在"是否含内联 HTML"翻转时重建
  const hasRawHtml = useMemo(() => ALLOWED_ELEMENTS.test(messageContent), [messageContent])
  const rehypePlugins = useMemo(() => {
    const plugins: Pluggable[] = []
    if (hasRawHtml) {
      plugins.push(rehypeRaw, rehypeScalableSvg)
    }
    plugins.push([rehypeHeadingIds, { prefix: `heading-${block.id}` }])
    if (mathPlugin !== null) {
      plugins.push(mathPlugin)
    }
    return plugins
  }, [mathEngine, mathPlugin, hasRawHtml, block.id])

  // 稳定引用：内联对象同样会让处理器管线逐帧重建
  const remarkRehypeOptions = useMemo(
    () => ({
      footnoteLabel: t('common.footnotes'),
      footnoteLabelTagName: 'h4' as const,
      footnoteBackContent: ' '
    }),
    [t]
  )

  const hasStyleTag = useMemo(() => /<style\b[^>]*>/i.test(messageContent), [messageContent])

  const components = useMemo(() => {
    const comps: Partial<Components> = {
      a: (props: any) => <Link {...props} />,
      sup: (props: any) => <CitationSup {...props} />,
      code: (props: any) => (
        <CodeBlock {...props} blockId={block.id} inlineHtmlPreviewMode={effectiveHtmlPreviewMode} />
      ),
      table: (props: any) => <Table {...props} blockId={block.id} />,
      img: (props: any) => <ImageViewer style={{ maxWidth: 500, maxHeight: 500 }} {...props} />,
      pre: (props: any) => <pre style={{ overflow: 'visible' }} {...props} />,
      p: (props) => {
        const hasImage = props?.node?.children?.some((child: any) => child.tagName === 'img')
        if (hasImage) return <div {...props} />
        return <p {...props} />
      },
      svg: MarkdownSvgRenderer
    }
    // 条件放 useMemo 内：之前在渲染体里对 memoized 对象做赋值，<style> 消失后
    // 残留的 style 覆盖永远不会被清除
    if (hasStyleTag) {
      comps.style = MarkdownShadowDOMRenderer as any
    }
    return comps
  }, [block.id, effectiveHtmlPreviewMode, hasStyleTag])

  // Hook 必须在任何早退分支之前调用（下方 standaloneArtifact 早退还直接 return 组件）。
  const urlTransform = useCallback((value: string) => {
    if (value.startsWith('data:image/png') || value.startsWith('data:image/jpeg')) return value
    return defaultUrlTransform(value)
  }, []) // V2 移植：整条消息是单个 HTML 工件时，绕过 Markdown 管线直渲染（文档/围栏双源）。
  // position 的 end 外推一个围栏长度，让 isOpenFenceBlock 恒判"已闭合"（V2 语境等价）。
  // 流式尾块切分：只在**落定前**切分；落定后整条消息由单一实例渲染，与改动前逐字节一致。
  //
  // 注意：流式中的 assistant 块必然带 `status !== 'success'` ⇒ `effectiveHtmlPreviewMode`
  // 恒为 `'generating'`，因此这里的判据**不能**要求"非工件预览模式"——否则切分在生产路径上
  // 永不生效（本轮实测踩过：只在测试里生效、真机不生效）。工件直渲染分支在其后用完整
  // `block.content` 判定，尾块切分不改变该判定结果。
  const allowSplit = !isTrulyDone

  // 切点由 `splitStablePrefix` 纯函数决定（尾部余量见 MIN_TAIL_BYTES）：前缀只在"上一块已
  // 闭合且尾部余量足够"时前移，故渲染帧的半成品文本不会造成缓存 key 抖动。
  const stablePrefix = allowSplit ? splitStablePrefix(messageContent).prefix : ''
  const split: MarkdownSplit = { prefix: stablePrefix, tail: messageContent.slice(stablePrefix.length) }
  markdownPrefixStats.activePrefix = split.prefix
  markdownPrefixStats.activeTail = split.tail
  markdownPrefixStats.previewedContent = messageContent

  let prefixNode: ReactNode = null
  if (split.prefix !== '') {
    const cache = prefixCacheRef.current
    const hit = cache.get(split.prefix)
    if (hit !== undefined) {
      markdownPrefixStats.prefixReuses += 1
      prefixNode = hit.node
    } else {
      markdownPrefixStats.prefixRenders += 1
      // 诊断/测试钩子：本次即将执行管线的前缀（测试桩消费后清空，用于区分前缀/尾块）
      markdownPrefixStats.lastPrefix = split.prefix
      const node = (
        <ReactMarkdown
          rehypePlugins={rehypePlugins}
          remarkPlugins={remarkPlugins}
          components={components}
          disallowedElements={DISALLOWED_ELEMENTS}
          urlTransform={urlTransform}
          remarkRehypeOptions={remarkRehypeOptions}>
          {split.prefix}
        </ReactMarkdown>
      )
      cache.set(split.prefix, { source: split.prefix, node })
      // 实例级 LRU：前缀只增不减，保留最近若干个即可（旧前缀不会再被命中）
      while (cache.size > PREFIX_CACHE_MAX) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
      }
      prefixNode = node
    }
  }
  if (standaloneArtifact) {
    const startOffset = standaloneArtifact.start.offset ?? 0
    const fenceEnd = {
      line: standaloneArtifact.start.line,
      column: standaloneArtifact.start.column + standaloneArtifact.html.length + 7,
      offset: startOffset + standaloneArtifact.html.length + 7
    }
    return (
      <div className="markdown">
        <CodeBlock
          className="language-html"
          inlineHtmlPreviewMode={effectiveHtmlPreviewMode}
          node={{ position: { start: standaloneArtifact.start, end: fenceEnd } } as any}
          blockId={block.id}
          isStreaming={effectiveHtmlPreviewMode === 'generating'}>
          {standaloneArtifact.html}
        </CodeBlock>
      </div>
    )
  }

  return (
    <div className="markdown">
      <CitationRegistryContext value={citationRegistry}>
        {prefixNode}
        <ReactMarkdown
          rehypePlugins={rehypePlugins}
          remarkPlugins={remarkPlugins}
          components={components}
          disallowedElements={DISALLOWED_ELEMENTS}
          urlTransform={urlTransform}
          remarkRehypeOptions={remarkRehypeOptions}>
          {split.tail}
        </ReactMarkdown>
      </CitationRegistryContext>
    </div>
  )
}

export default memo(Markdown)

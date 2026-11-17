/**
 * 文档处理系统服务（建立为知识库摄取；验收轮重构为同时服务聊天
 * 读文件）：fork MVP 自建（不移植 embedjs 全家，见 vectorStore/embeddings/
 * extractors/chunker 各文件头的裁剪说明）。
 *
 * 职责：库文件生命周期（create/reset/delete）、条目处理 FIFO（extract → chunk →
 * embed → 落库）、向量检索、嵌入路由解析（apiHost/apiKey 只进主进程内存）、
 * 以及 read_document 的每轮登记与文本抽取（原 DocumentService 已删——聊天
 * 读文件与知识库摄取共用同一 extractors 文档处理引擎，双入口单引擎）。
 * 并发闸：条目处理进程内串行 FIFO（上游 workload≤80MB/并发≤30 的简化——个人
 * 规模够用，重负载留+ 调整）；聊天读文件是交互路径，不进 FIFO。
 *
 * IPC 薄转发约定（不变量1）：ipc.ts 的 KnowledgeBase_* 处理器只做参数校验 + 直调本服务；
 * 对话检索走内核 knowledge_search 工具（web_search 同构），执行时进程内直调本服务。
 */
import { rm } from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { parsePdfWithProvider, preprocessChannel } from '@main/services/preprocess/preprocessChannel'
import { registerTopicWork } from '@main/services/topicWorkAbort'
import { getDataPath } from '@main/utils'

import { chunkText } from './chunker'
import { EmbeddingClient, type EmbeddingModelRef } from './embeddings'
import {
  type ExtractedContent,
  extractFromFile,
  extractFromNote,
  extractFromSitemap,
  extractFromUrl,
  extractFromVideoPair,
  listDirectoryFiles
} from './extractors'
import { BaseVectorStore } from './vectorStore'

const logger = loggerService.withContext('KnowledgeService')

/** fork logger 上下文只接受 Error | NullableObject：未知抛出物统一包成 Error。 */
function toLoggableError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** 嵌入模型引用（渲染层只上行 id，主进程自解析密钥）。 */
export interface KnowledgeEmbeddingRef {
  providerId: string
  modelId: string
  dimensions?: number
}

/** knowledge_search 工具的每轮登记单元（topics.sendMessage 随发送参数上行）。 */
export interface KnowledgeTurnBase {
  id: string
  chunkSize?: number
  chunkOverlap?: number
  documentCount?: number
  threshold?: number
  embedding: KnowledgeEmbeddingRef
  /** 可选重排模型引用（rerank 实装；配置后检索命中再经 lightRerank 精排）。 */
  rerank?: { providerId: string; modelId: string }
}

/** read_document 工具的每轮登记单元（topics.sendMessage 随发送参数上行）。 */
export interface TurnDocument {
  /** 展示名（origin_name）——模型按它引用。 */
  name: string
  /** 绝对路径（FileMetadata.path，主进程直读）。 */
  path: string
  ext?: string
}

export interface KnowledgeBaseRef {
  id: string
  chunkSize?: number
  chunkOverlap?: number
  documentCount?: number
  /**
   * 文档处理服务商 id（V2 对齐：配置即路由——配置了服务商的库所有 PDF 整本走
   * 该服务商解析，文本/扫描由服务商内部自判；未配置 = 纯文本层直取，无检测。
   * 配置本体经 Dsh_SyncPreprocess 投影进主进程内存）。
   */
  preprocessProviderId?: string
}

export type KnowledgeAddPayload =
  | { kind: 'file'; baseId: string; itemId: string; filePath: string }
  | { kind: 'url'; baseId: string; itemId: string; url: string }
  | { kind: 'note'; baseId: string; itemId: string; text: string }
  | { kind: 'sitemap'; baseId: string; itemId: string; url: string }
  | { kind: 'directory'; baseId: string; itemId: string; dirPath: string }
  | { kind: 'video'; baseId: string; itemId: string; videoPath: string; srtPath: string }

/**
 * read_document 空抽取出口的中性提示（V2 noExtractableTextNote 同形状，一句话
 * 事实：不指路、不教模型做事——ocr_document 同轮已挂载，何时用模型自行判断）。
 */
const NO_EXTRACTABLE_TEXT_NOTE =
  '(No extractable text — the document may be empty, scanned, or in an unreadable format.)'

export interface LoaderReturn {
  entriesAdded: number
  uniqueId: string
  uniqueIds: string[]
  loaderType: string
}

/** 工具传错文档名的报错：附上本轮有效名单（引号定边界），模型一次自纠不再盲猜。 */
function notAttachedError(nameOrPath: string, documents: TurnDocument[] | undefined): Error {
  const attached = (documents ?? []).map((doc) => `"${doc.name}"`).join(', ')
  return new Error(
    `document "${nameOrPath}" is not attached to this conversation turn (attached documents: ${attached})`
  )
}

export class KnowledgeService {
  private static instance: KnowledgeService | null = null

  private readonly stores = new Map<string, BaseVectorStore>()
  private readonly embeddings = new EmbeddingClient()
  /** 条目处理 FIFO（进程内串行；失败不堵塞后续条目）。 */
  private queue: Promise<unknown> = Promise.resolve()
  /** knowledge_search 的每轮登记（topics.sendMessage 写入；工具执行时按 topicId 反查）。 */
  private readonly turnBases = new Map<string, KnowledgeTurnBase[]>()
  /** read_document 的每轮登记（topics.sendMessage 写入；工具执行时按 topicId 反查）。 */
  private readonly turnDocuments = new Map<string, TurnDocument[]>()
  /**
   * 每轮登记表的 key 是 topicId，而话题只增不减——长会话用户会
   * 无限累积（每个 value 还持有绝对路径与知识库清单）。复刻 SpanCacheService 的做法：
   * Map 保持插入序，超限淘汰最早的 key（最老的回合早已完结，淘汰只影响历史回合的
   * 工具重放，该回合重放本就应重新登记）。
   */
  private static readonly MAX_TURN_TOPICS = 512

  static getInstance(): KnowledgeService {
    if (!KnowledgeService.instance) {
      KnowledgeService.instance = new KnowledgeService()
      logger.info('KnowledgeService initialized')
    }
    return KnowledgeService.instance
  }

  private constructor() {}

  private dataDir(): string {
    return getDataPath('KnowledgeBase')
  }

  /** 内核 provider 路由快照（Dsh_SyncProviders 载荷同步进来；apiHost/apiKey 解析用）。 */
  setProviders(providers: Array<{ id?: string; apiHost?: string; apiKey?: string }>): void {
    this.embeddings.setProviders(providers)
  }

  /**
   * 嵌入门（web_search RAG 压缩共用）：批量嵌入并返回与输入同序的归一化
   * 向量。路由/密钥解析全部走本服务的 EmbeddingClient（provider 快照 + 密钥兜底
   * ProviderKeyStore），调用方（webSearch 压缩）不持密钥。
   */
  embed(ref: EmbeddingModelRef, inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    return this.embeddings.embed(ref, inputs, signal)
  }

  /**
   * 每轮知识检索登记（topics.sendMessage 按发送参数写入；undefined = 本轮未启用，
   * knowledge_search 工具此时不该被调，执行侧防线拒答）。即设即覆盖；登记表有淘汰上限
   * （见 {@link MAX_TURN_TOPICS}）。
   */
  setTurnBases(topicId: string, bases: KnowledgeTurnBase[] | undefined): void {
    if (bases === undefined || bases.length === 0) {
      this.turnBases.delete(topicId)
    } else {
      this.turnBases.set(topicId, bases)
      this.evictOldestTurns(this.turnBases)
    }
  }

  getTurnBases(topicId: string): KnowledgeTurnBase[] | undefined {
    return this.turnBases.get(topicId)
  }

  // ===========================================================================
  // 聊天读文件（read_document；原 DocumentService 已并入——文档处理系统
  // 同时服务知识库摄取与聊天读文件，双入口单引擎）
  // ===========================================================================

  /**
   * read_document 的每轮登记（topics.sendMessage 按发送参数写入；undefined = 本轮
   * 无文档附件，工具执行侧防线拒答）。即设即覆盖；登记表有淘汰上限（与 turnBases 同形态）。
   */
  setTurnDocuments(topicId: string, documents: TurnDocument[] | undefined): void {
    if (documents === undefined || documents.length === 0) {
      this.turnDocuments.delete(topicId)
    } else {
      this.turnDocuments.set(topicId, documents)
      this.evictOldestTurns(this.turnDocuments)
    }
  }

  /** 插入序淘汰：Map 超限时删除最早的 key（SpanCacheService.setTopicId 同写法）。 */
  private evictOldestTurns(map: Map<string, unknown>): void {
    while (map.size > KnowledgeService.MAX_TURN_TOPICS) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  getTurnDocuments(topicId: string): TurnDocument[] | undefined {
    return this.turnDocuments.get(topicId)
  }

  /**
   * read_document 工具执行（2026-09-22 用户第二轮裁决：直读为中心）——全部格式
   * 走共用引擎（PDF 读文本层，V2 对齐：无扫描件检测；纯文本直读、.doc
   * word-extractor、docx/html 原生 Markdown 管线 mammoth+turndown、office 族
   * officeparser 文本、epub zip→Markdown——全程进程内，零 CLI/Python 前置）。
   * 空抽取不报错：返回中性提示作为工具结果（V2 noExtractableTextNote 同形状，
   * 2026-09-22 用户第六轮裁决）——空文件/扫描件/不可读二进制共用此出口，模型
   * 自行决定下一步（ocr_document 已在同轮挂载）。不做任何截断（同轮裁决：
   * 200k 上限删除，"已读不截断"）。
   * 不走条目处理 FIFO——聊天读文件是交互路径（模型在等结果），不排在批量摄取后面。
   */
  async readTurnDocument(
    topicId: string,
    nameOrPath: string,
    signal?: AbortSignal
  ): Promise<{ name: string; text: string }> {
    const documents = this.getTurnDocuments(topicId)
    const document = documents?.find((doc) => doc.name === nameOrPath || doc.path === nameOrPath)
    if (document === undefined) {
      throw notAttachedError(nameOrPath, documents)
    }
    const ext = path.extname(document.path).toLowerCase()
    // signal（暂停/中止）在 PDF 读取前检查（单次 pdfjs 调用内部不可中断，粒度见 extractors.extractPdf）。
    const text = (await extractFromFile(document.path, { signal })).text
    if (text.trim().length === 0) {
      logger.info(`document: "${document.name}" produced no extractable text (empty or scanned)`)
      return { name: document.name, text: NO_EXTRACTABLE_TEXT_NOTE }
    }
    logger.info(`document: processed "${document.name}" (${ext || 'unknown'} → ${text.length} chars)`)
    return { name: document.name, text }
  }

  /**
   * ocr_document 工具执行（2026-09-22 用户第三轮裁决：工具挂进文档处理通道）。
   * 按名反查本轮登记的文档，按本轮登记的文档处理服务商（messageThunk 上行
   * preprocess.defaultProvider）路由：LocalPaddle → 本地 OCR（utility 子进程），
   * 云端五家 → 云解析适配器。时间预算 8 分钟（用户原话"5 分钟上限我没反对
   * （只是您可以再放宽到 8 分钟，大书云解析也要点时间）"），页数/文本截断上限
   * 保持删除。未登记/未配置时如实报可行动错误，不静默降级（2026-09-22 用户裁决：
   * 删除 local-paddle 缺省兜底）。非 PDF 如实报错（通道只接 PDF）。
   */
  async ocrTurnDocument(
    topicId: string,
    nameOrPath: string,
    signal?: AbortSignal
  ): Promise<{ name: string; text: string }> {
    const documents = this.getTurnDocuments(topicId)
    const document = documents?.find((doc) => doc.name === nameOrPath || doc.path === nameOrPath)
    if (document === undefined) {
      throw notAttachedError(nameOrPath, documents)
    }
    return this.ocrDocumentAtPath(topicId, document.name, document.path, signal)
  }

  /**
   * documents_extract 外置工具的文档处理臂（2026-10-21 用户裁决）：按绝对路径走
   * 文档处理通道，与 ocrTurnDocument 共用同一内核（ocrDocumentAtPath）——附件线
   * 与磁盘线同权，不立第二套语义。服务商未登记/未配置/非 PDF 如实报可行动错误。
   */
  async processDocumentFromDisk(
    topicId: string,
    filePath: string,
    signal?: AbortSignal
  ): Promise<{ name: string; text: string }> {
    return this.ocrDocumentAtPath(topicId, path.basename(filePath), filePath, signal)
  }

  /**
   * documents_extract 外置工具的 markitdown 臂：按绝对路径抽取文档文本。与附件读
   * 共用同一 extractFromFile 引擎（pdf 文本层 / doc / docx / pptx / xlsx / odt 族 /
   * epub / html / 纯文本，未知扩展名按文本尝试）。空抽取返回中性提示（与
   * readTurnDocument 同出口，不静默成功）。
   */
  async readDocumentFromDisk(filePath: string, signal?: AbortSignal): Promise<{ name: string; text: string }> {
    const name = path.basename(filePath)
    const text = (await extractFromFile(filePath, { signal })).text
    if (text.trim().length === 0) {
      logger.info(`document: "${name}" produced no extractable text (empty or scanned)`)
      return { name, text: NO_EXTRACTABLE_TEXT_NOTE }
    }
    logger.info(`document: extracted ${text.length} chars from disk file "${name}"`)
    return { name, text }
  }

  /**
   * OCR 内核（附件登记臂与磁盘路径臂共用）：PDF-only、按本轮登记的文档处理服务商
   * 路由（preprocessChannel，发送时快照）、按话题中止源（topic stop 不断在途工具，
   * 暂停到达主进程时直接 abort）、单次 8 分钟预算。空 OCR 文本如实报错（页空白或
   * 不可读），不静默降级。
   */
  private async ocrDocumentAtPath(
    topicId: string,
    name: string,
    filePath: string,
    signal?: AbortSignal
  ): Promise<{ name: string; text: string }> {
    if (path.extname(filePath).toLowerCase() !== '.pdf') {
      throw new Error(`documents_extract/ocr_document only supports PDF documents; "${name}" is not a PDF`)
    }
    const providerId = preprocessChannel.getTurnProviderId(topicId)
    if (providerId === undefined) {
      throw new Error('no document-processing provider is registered for this turn (设置 → 文档处理 → 默认服务商)')
    }
    const config = preprocessChannel.getConfig(providerId)
    if (config === undefined) {
      throw new Error(`document-processing provider "${providerId}" is not configured yet (设置 → 文档处理)`)
    }
    logger.info(`document processing engaged for "${name}" via provider "${config.id}"`)
    // exec.signal（暂停/中止）与 8 分钟预算在 parsePdfWithProvider 内合并；
    // 打断走各执行缝的取消缝（local: cancel+部分缓存 / vision: HTTP abort+部分缓存）。
    //
    // 2026-10-01（真机取证）：内核的 topic stop **不会**中断在途工具——用户连按 5 次暂停，
    // `dshTopicStop` 每次都送达内核、`stop()` 返回后内核自己的 `isRunning` 仍为 true，
    // 随后那次 OCR 照常跑完（见 `services/topicWorkAbort.ts` 的模块注释）。故这里再加一条
    // **按话题**的中止源：暂停到达主进程时直接 abort 本次解析，不等内核。
    const workController = new AbortController()
    const unregisterWork = registerTopicWork(topicId, workController)
    const mergedSignal = signal === undefined ? workController.signal : AbortSignal.any([signal, workController.signal])
    try {
      const text = await parsePdfWithProvider(config, filePath, mergedSignal)
      if (text.trim().length === 0) {
        throw new Error(`document "${name}" produced no OCR text — pages may be blank or unreadable`)
      }
      logger.info(`document processing produced ${text.length} chars for "${name}" (${config.id})`)
      return { name, text }
    } finally {
      unregisterWork()
    }
  }

  private async openStore(baseId: string): Promise<BaseVectorStore> {
    const existing = this.stores.get(baseId)
    if (existing !== undefined) return existing
    const store = await BaseVectorStore.open(baseId, this.dataDir())
    this.stores.set(baseId, store)
    return store
  }

  // ===========================================================================
  // 库文件生命周期
  // ===========================================================================

  async createBase(base: KnowledgeBaseRef): Promise<void> {
    await this.openStore(base.id)
  }

  async resetBase(baseId: string): Promise<void> {
    const store = this.stores.get(baseId)
    if (store !== undefined) {
      await store.close()
      this.stores.delete(baseId)
    }
    // 此前丢弃了 `BaseVectorStore.open` 的返回值——新建的 LibSQL
    // 客户端无人引用、永不关闭，而下一次 addItem/search 因注册表里没有该 key 会**再开一个**，
    // 同一 vec.db 上并存两个句柄（Windows 上还会让后续 deleteBase 的 rm 撞占用）。
    this.stores.set(baseId, await BaseVectorStore.open(baseId, this.dataDir()))
    logger.info(`knowledge: reset base "${baseId}"`)
  }

  async deleteBase(baseId: string): Promise<void> {
    const store = this.stores.get(baseId)
    if (store !== undefined) {
      await store.close()
      this.stores.delete(baseId)
    }
    // 删除失败不抛：落盘残留不阻塞 UI 删除（上游 knowledge_pending_delete 同语义的
    // 简化——下次 reset/create 同名库会被重建覆盖）。
    await rm(BaseVectorStore.dbDir(this.dataDir(), baseId), { recursive: true, force: true }).catch((error) => {
      logger.warn(`knowledge: delete base dir failed for "${baseId}"`, error)
    })
    logger.info(`knowledge: deleted base "${baseId}"`)
  }

  // ===========================================================================
  // 条目处理（FIFO）
  // ===========================================================================

  async addItem(
    payload: KnowledgeAddPayload,
    base: KnowledgeBaseRef,
    embedding: KnowledgeEmbeddingRef,
    signal?: AbortSignal
  ): Promise<LoaderReturn> {
    const task = this.queue.then(() => this.processItem(payload, base, embedding, signal))
    // 失败不堵塞后续：吞掉 rejection 但把它作为该条目的结果抛回给本次调用方。
    this.queue = task.catch(() => undefined)
    return task
  }

  private async processItem(
    payload: KnowledgeAddPayload,
    base: KnowledgeBaseRef,
    embedding: KnowledgeEmbeddingRef,
    signal?: AbortSignal
  ): Promise<LoaderReturn> {
    try {
      // 文档集形态：file/url/note 单文档；sitemap/directory/video 多文档（v0.4 工程项
      // 三类条目接入处理链）。多文档按文档粒度分块入库（uniqueId 统一为 itemId——
      // removeItem 按 uniqueIds 删除即整条移除），单文档失败语义各异（见各分支）。
      let docs: Array<ExtractedContent>
      if (payload.kind === 'file') {
        // V2 对齐（2026-09-22 用户裁决）：配置即路由——库配置了文档处理服务商 →
        // 所有 PDF 整本走该服务商（文本/扫描由服务商内部自判，混合书整本处理）；
        // 未配置 → 纯文本层直取，无扫描件检测（空文本由下方统一报错）。
        // 摄取是后台 FIFO：无时间预算（Number.POSITIVE_INFINITY）。
        const isPdf = payload.filePath.toLowerCase().endsWith('.pdf')
        const config =
          isPdf && base.preprocessProviderId !== undefined
            ? preprocessChannel.getConfig(base.preprocessProviderId)
            : undefined
        if (isPdf && base.preprocessProviderId !== undefined && config === undefined) {
          throw new Error(
            `document-processing provider "${base.preprocessProviderId}" is not configured yet (设置 → 文档处理)`
          )
        }
        if (config !== undefined) {
          logger.info(
            `document processing engaged for "${payload.itemId}" via provider "${config.id}" (knowledge ingestion)`
          )
          const ocrText = await parsePdfWithProvider(config, payload.filePath, signal, {
            budgetMs: Number.POSITIVE_INFINITY
          })
          if (ocrText.trim().length === 0) {
            throw new Error(`document "${payload.itemId}" produced no text — pages may be blank or unreadable`)
          }
          docs = [{ text: ocrText, source: payload.itemId }]
        } else {
          docs = [await extractFromFile(payload.filePath)]
        }
      } else if (payload.kind === 'url') {
        docs = [await extractFromUrl(payload.url, signal)]
      } else if (payload.kind === 'note') {
        docs = [extractFromNote(payload.text, `note:${payload.itemId}`)]
      } else if (payload.kind === 'sitemap') {
        docs = await extractFromSitemap(payload.url, signal)
      } else if (payload.kind === 'directory') {
        const files = await listDirectoryFiles(payload.dirPath)
        if (files.length === 0) {
          throw new Error(`knowledge: directory "${payload.dirPath}" contains no ingestible files`)
        }
        logger.info(`knowledge: directory "${payload.dirPath}" -> ${files.length} file(s)`)
        docs = []
        // 单文件失败跳过不整链失败（V1 directoryTask 同语义）；全部失败时下方统一报错。
        for (const filePath of files) {
          try {
            docs.push(await extractFromFile(filePath))
          } catch (error) {
            logger.warn(`knowledge: directory file "${filePath}" failed, skipping:`, toLoggableError(error))
          }
        }
      } else if (payload.kind === 'video') {
        docs = await extractFromVideoPair(payload.videoPath, payload.srtPath)
      } else {
        throw new Error(`knowledge: unsupported payload kind "${String((payload as { kind?: string }).kind)}"`)
      }
      // 空文档跳过（多文档形态的正常形态）；全部为空才报错。
      docs = docs.filter((doc) => doc.text.trim().length > 0)
      if (docs.length === 0) {
        throw new Error('knowledge: no text extracted from item')
      }
      const store = await this.openStore(base.id)
      let totalChunks = 0
      for (const doc of docs) {
        const chunks = chunkText(doc.text, base.chunkSize, base.chunkOverlap)
        if (chunks.length === 0) {
          continue
        }
        const vectors = await this.embeddings.embed(
          embedding,
          chunks.map((chunk) => chunk.content),
          signal
        )
        await store.insert(
          chunks.map((chunk, index) => ({
            uniqueId: payload.itemId,
            content: chunk.content,
            metadata: { source: doc.source, index },
            vector: vectors[index]
          }))
        )
        totalChunks += chunks.length
      }
      if (totalChunks === 0) {
        throw new Error('knowledge: chunking produced no chunks')
      }
      logger.info(
        `knowledge: added item "${payload.itemId}" to base "${base.id}" (${docs.length} doc(s) / ${totalChunks} chunks)`
      )
      return {
        entriesAdded: totalChunks,
        uniqueId: payload.itemId,
        uniqueIds: [payload.itemId],
        loaderType: payload.kind
      }
    } catch (error) {
      logger.error(`knowledge: failed to add item "${payload.itemId}" to base "${base.id}"`, toLoggableError(error))
      throw error
    }
  }

  async removeItem(baseId: string, uniqueIds: string[]): Promise<void> {
    const store = await this.openStore(baseId)
    await store.deleteByUniqueIds(uniqueIds)
    logger.info(`knowledge: removed ${uniqueIds.length} uniqueId(s) from base "${baseId}"`)
  }

  // ===========================================================================
  // 检索
  // ===========================================================================

  /** 单库检索（top documentCount，调用方再做 threshold 过滤与多库合并）。 */
  async search(
    base: KnowledgeBaseRef,
    embedding: KnowledgeEmbeddingRef,
    query: string,
    signal?: AbortSignal
  ): Promise<Array<{ uniqueId: string; pageContent: string; score: number; metadata: Record<string, unknown> }>> {
    const store = await this.openStore(base.id)
    const [queryVector] = await this.embeddings.embed(embedding, [query], signal)
    const topK = Math.max(1, base.documentCount ?? 30)
    return store.search(queryVector, topK)
  }

  /**
   * knowledge_read 工具执行：按条目级标识读回摄取文本（chunk 拼接 +
   * overlap 去重由工具层做，本方法只负责围栏校验与存储读回）。baseId 必须在本轮
   * 登记清单内（执行侧防线，与 knowledge_search 同型）；未知 uniqueId 具名报错。
   */
  async readBaseDocument(
    topicId: string,
    baseId: string,
    uniqueId: string
  ): Promise<Array<{ content: string; source: string; index: number }>> {
    const bases = this.getTurnBases(topicId)
    const base = bases?.find((candidate) => candidate.id === baseId)
    if (base === undefined) {
      const known = (bases ?? []).map((candidate) => `"${candidate.id}"`).join(', ')
      throw new Error(`knowledge base "${baseId}" is not attached to this conversation turn (attached bases: ${known})`)
    }
    const store = await this.openStore(base.id)
    const chunks = await store.readByUniqueId(uniqueId)
    if (chunks.length === 0) {
      throw new Error(
        `document "${uniqueId}" not found in knowledge base "${baseId}" — pass the baseId and document id exactly as a knowledge_search result reports them`
      )
    }
    return chunks.map((chunk, index) => ({
      content: chunk.content,
      source: String(chunk.metadata?.source ?? uniqueId),
      index
    }))
  }
}

export const knowledgeService = KnowledgeService.getInstance()

/**
 * 自 CS_V1 移植（知识库 hooks；接真实处理链：extract → chunk → embed → 落库）。
 * fork 改动点：
 * - 不移植上游 KnowledgeQueue 全套：条目处理经 knowledgeBaseApi.add（主进程 FIFO 串行），
 *   状态机 pending → processing → completed/failed 直接回填 redux；
 * - file/url/note 三类进处理链；sitemap/directory/video 仅 redux 记录不处理（后置，
 *   交付注记有记）；笔记内容按 fork KnowledgeNoteItem 形状直接存于条目 content；
 * - 嵌入引用只含 {providerId, modelId, dimensions}，密钥主进程自解析（fork 偏离上游）。
 */
import { loggerService } from '@logger'
import i18n from '@renderer/i18n'
import FileManager from '@renderer/services/FileManager'
import { getEmbeddingRef, knowledgeBaseApi } from '@renderer/services/knowledgeBaseApi'
import type { RootState } from '@renderer/store'
import { useAppDispatch } from '@renderer/store'
import {
  addBase,
  addFiles as addFilesAction,
  addItem as addItemAction,
  clearAllProcessing,
  clearCompletedProcessing,
  deleteBase,
  removeItem as removeItemAction,
  renameBase,
  updateBase,
  updateBases,
  updateItem as updateItemAction,
  updateItemProcessingStatus,
  updateNotes
} from '@renderer/store/knowledge'
import type { FileMetadata, KnowledgeBase, KnowledgeItem, KnowledgeNoteItem, ProcessingStatus } from '@renderer/types'
import { isKnowledgeFileItem, isKnowledgeNoteItem, isKnowledgeVideoItem } from '@renderer/types'
import { cloneDeep } from 'lodash-es'
import { useCallback } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { v4 as uuidv4 } from 'uuid'

import { useAssistants } from './useAssistant'

const logger = loggerService.withContext('useKnowledge')
const t = i18n.t.bind(i18n)
/** 创建一个新知识库条目（file/url/note 预置 processingStatus='pending'，进处理链）。 */
const createKnowledgeItem = (
  type: KnowledgeItem['type'],
  content: KnowledgeItem['content'],
  overrides: Partial<KnowledgeItem> = {}
): KnowledgeItem => {
  const timestamp = Date.now()
  const queued = type === 'file' || type === 'url' || type === 'note'
  return {
    id: uuidv4(),
    type,
    content,
    created_at: timestamp,
    updated_at: timestamp,
    ...(queued ? { processingStatus: 'pending' as ProcessingStatus } : {}),
    ...overrides
  }
}

export const useKnowledge = (baseId: string) => {
  const dispatch = useAppDispatch()
  const base = useSelector((state: RootState) => state.knowledge.bases.find((b) => b.id === baseId))

  // 重命名知识库
  const renameKnowledgeBase = (name: string) => {
    dispatch(renameBase({ baseId, name }))
  }

  // 更新知识库
  const updateKnowledgeBase = (base: KnowledgeBase) => {
    dispatch(updateBase(base))
  }

  // 条目处理（主进程 FIFO；完成/失败回填 redux，嵌入引用只含 id）
  const enqueueItem = (item: KnowledgeItem, payload: Parameters<typeof knowledgeBaseApi.add>[0]['item']) => {
    if (!base) return
    const baseSnapshot = base
    dispatch(updateItemProcessingStatus({ baseId, itemId: item.id, status: 'processing' }))
    void knowledgeBaseApi
      .add({
        base: {
          id: baseSnapshot.id,
          chunkSize: baseSnapshot.chunkSize,
          chunkOverlap: baseSnapshot.chunkOverlap,
          documentCount: baseSnapshot.documentCount,
          // 文档处理服务商 id（V2 对齐：配置即路由——配置了服务商的库所有 PDF 整本
          // 走该服务商；主进程执行缝消费）。
          preprocessProviderId: baseSnapshot.preprocessProvider?.provider.id
        },
        item: payload,
        embedding: getEmbeddingRef(baseSnapshot)
      })
      .then((result) => {
        dispatch(
          updateItemAction({
            baseId,
            item: {
              ...item,
              uniqueId: result.uniqueId,
              uniqueIds: result.uniqueIds,
              processingStatus: 'completed',
              processingProgress: 1,
              processingError: undefined,
              updated_at: Date.now()
            }
          })
        )
      })
      .catch((error: unknown) => {
        dispatch(
          updateItemProcessingStatus({
            baseId,
            itemId: item.id,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error)
          })
        )
      })
  }

  // 批量添加文件
  const addFiles = (files: FileMetadata[]) => {
    const filesItems = files.map((file) => createKnowledgeItem('file', file))
    dispatch(addFilesAction({ baseId, items: filesItems }))
    for (const item of filesItems) {
      if (isKnowledgeFileItem(item)) {
        enqueueItem(item, { kind: 'file', baseId, itemId: item.id, filePath: item.content.path ?? '' })
      }
    }
  }

  // 添加笔记
  const addNote = async (content: string) => {
    const note = createKnowledgeItem('note', content)
    if (!isKnowledgeNoteItem(note)) {
      return
    }
    dispatch(updateNotes({ baseId, item: note }))
    enqueueItem(note, { kind: 'note', baseId, itemId: note.id, text: content })
  }

  // 添加URL
  const addUrl = (url: string) => {
    const item = createKnowledgeItem('url', url)
    dispatch(addItemAction({ baseId, item }))
    enqueueItem(item, { kind: 'url', baseId, itemId: item.id, url })
  }

  // 添加 Sitemap（v0.4 接入处理链：解析 → 逐页抓取 → 分块入库）
  const addSitemap = (url: string) => {
    const item = createKnowledgeItem('sitemap', url)
    dispatch(addItemAction({ baseId, item }))
    enqueueItem(item, { kind: 'sitemap', baseId, itemId: item.id, url })
  }

  // 添加目录（v0.4 接入处理链：递归枚举可摄取文件 → 逐文件抽取入库）
  const addDirectory = (path: string) => {
    const item = createKnowledgeItem('directory', path)
    dispatch(addItemAction({ baseId, item }))
    enqueueItem(item, { kind: 'directory', baseId, itemId: item.id, dirPath: path })
  }

  // add video support（v0.4 接入处理链：V1 预留契约——视频 + .srt 字幕对，
  // 字幕窗口文本入库；缺 .srt 时主进程如实报错，不静默成功）
  const addVideo = (files: FileMetadata[]) => {
    const item = createKnowledgeItem('video', files)
    dispatch(addItemAction({ baseId, item }))
    const videoFile = files.find((file) => !file.path.toLowerCase().endsWith('.srt')) ?? files[0]
    const srtFile = files.find((file) => file.path.toLowerCase().endsWith('.srt'))
    enqueueItem(item, {
      kind: 'video',
      baseId,
      itemId: item.id,
      videoPath: videoFile?.path ?? '',
      srtPath: srtFile?.path ?? ''
    })
  }

  // 更新笔记内容（fork：笔记正文在条目 content 上，纯 redux 更新）
  const updateNoteContent = async (noteId: string, content: string) => {
    const noteItem = base?.items.find((item) => item.id === noteId)
    if (noteItem) {
      dispatch(
        updateItemAction({
          baseId,
          item: { ...noteItem, content, updated_at: Date.now() }
        })
      )
    }
  }

  // 获取笔记内容（fork：直接取条目正文）
  const getNoteContent = async (noteId: string): Promise<KnowledgeNoteItem | undefined> => {
    const noteItem = base?.items.find((item) => item.id === noteId)
    return noteItem && isKnowledgeNoteItem(noteItem) ? noteItem : undefined
  }

  const updateItem = (item: KnowledgeItem) => {
    dispatch(updateItemAction({ baseId, item }))
  }

  /**
   * 移除项目（向量条目按 uniqueIds 整批删 + redux 移除 + 文件清理）。
   *
   * 删除纪律：**返回 `Promise<boolean>`**，乐观移除失败必须回滚并
   * 给出用户可见信号。旧实现是纯乐观写：redux 行先消失，向量库 `remove` 或文件清理一旦 reject，行不会
   * 恢复（刷新后条目仍不在列表里但向量还占着），而六个 onClick 调用点把 Promise 交给 React——失败只是
   * 一条未处理的 rejection，磁盘与 UI 都没有任何信号。
   *
   * @returns true = 已删除；false = 失败（redux 已回滚，已弹 toast.error）。
   */
  const removeItem = async (item: KnowledgeItem): Promise<boolean> => {
    // 回滚快照：整库行原样保存，失败时用 updateBase 精确还原（含数组位置与全部字段），
    // 避免用 addItem 之类的"重建型"动作在 file/note/video 上丢掉位置或改错时间戳。
    const baseSnapshot = base ? cloneDeep(base) : undefined

    dispatch(removeItemAction({ baseId, item }))

    const rollback = (message: string, error: unknown) => {
      logger.error(`Failed to remove knowledge item ${item.id}: ${message}`, error as Error)
      if (baseSnapshot) {
        dispatch(updateBase(baseSnapshot))
      }
      window.toast.error(t('knowledge.remove_failed'))
      return false
    }

    try {
      if (base && item?.uniqueIds && item.uniqueIds.length > 0) {
        await knowledgeBaseApi.remove(baseId, item.uniqueIds)
      } else if (base && item?.uniqueId) {
        await knowledgeBaseApi.remove(baseId, [item.uniqueId])
      }
    } catch (error) {
      return rollback('vector removal failed', error)
    }

    try {
      if (isKnowledgeFileItem(item) && typeof item.content === 'object' && !Array.isArray(item.content)) {
        const file = item.content
        // name: eg. text.pdf
        await FileManager.deleteFiles([file])
      } else if (isKnowledgeVideoItem(item)) {
        // video item has srt and video files
        await FileManager.deleteFiles(item.content)
      }
    } catch (error) {
      // 本地文件清理失败不回滚索引行：文件已从 redux 与向量库摘除，行本身没有可还原的语义；
      // 但失败不得静默——磁盘上会留下孤儿文件，必须让用户知道（「Never fail silently」）。
      logger.error('Failed to clean up knowledge item files', error as Error)
      window.toast.warning(t('knowledge.remove_file_cleanup_failed'))
    }

    return true
  }

  // 刷新项目（remove + 重新入队嵌入；处理中条目拒绝重刷）
  const refreshItem = async (item: KnowledgeItem) => {
    const status = getProcessingStatus(item.id)

    if (status === 'pending' || status === 'processing') {
      return
    }

    if (!base) {
      return
    }

    const uniqueIds = item?.uniqueIds ?? (item?.uniqueId ? [item.uniqueId] : [])
    if (uniqueIds.length > 0) {
      await knowledgeBaseApi.remove(baseId, uniqueIds)
    }

    // 重新入队（file/url/note 三类可处理；其余类型 后置，仅复位状态不处理）
    if (isKnowledgeFileItem(item)) {
      enqueueItem(
        { ...item, processingStatus: 'pending' },
        { kind: 'file', baseId, itemId: item.id, filePath: item.content.path ?? '' }
      )
    } else if (isKnowledgeNoteItem(item)) {
      enqueueItem(
        { ...item, processingStatus: 'pending' },
        { kind: 'note', baseId, itemId: item.id, text: item.content }
      )
    } else if (item.type === 'url' && typeof item.content === 'string') {
      enqueueItem({ ...item, processingStatus: 'pending' }, { kind: 'url', baseId, itemId: item.id, url: item.content })
    } else if (item.type === 'sitemap' && typeof item.content === 'string') {
      // v0.4 验收轮修正：三类新条目的刷新此前只删向量不再摄取（静默丢内容）。
      enqueueItem(
        { ...item, processingStatus: 'pending' },
        { kind: 'sitemap', baseId, itemId: item.id, url: item.content }
      )
    } else if (item.type === 'directory' && typeof item.content === 'string') {
      enqueueItem(
        { ...item, processingStatus: 'pending' },
        { kind: 'directory', baseId, itemId: item.id, dirPath: item.content }
      )
    } else if (item.type === 'video' && Array.isArray(item.content)) {
      const videoFile = item.content.find((file) => !file.path.toLowerCase().endsWith('.srt')) ?? item.content[0]
      const srtFile = item.content.find((file) => file.path.toLowerCase().endsWith('.srt'))
      enqueueItem(
        { ...item, processingStatus: 'pending' },
        {
          kind: 'video',
          baseId,
          itemId: item.id,
          videoPath: videoFile?.path ?? '',
          srtPath: srtFile?.path ?? ''
        }
      )
    }
  }

  // 更新处理状态
  const updateItemStatus = (itemId: string, status: ProcessingStatus, progress?: number, error?: string) => {
    dispatch(
      updateItemProcessingStatus({
        baseId,
        itemId,
        status,
        progress,
        error
      })
    )
  }

  // 获取特定项目的处理状态
  const getProcessingStatus = useCallback(
    (itemId: string) => {
      return base?.items.find((item) => item.id === itemId)?.processingStatus
    },
    [base?.items]
  )

  // 获取特定类型的所有处理项
  const getProcessingItemsByType = (type: 'file' | 'url' | 'note') => {
    return base?.items.filter((item) => item.type === type && item.processingStatus !== undefined) || []
  }

  // 清除已完成的项目
  const clearCompleted = () => {
    dispatch(clearCompletedProcessing({ baseId }))
  }

  // 清除所有处理状态
  const clearAll = () => {
    dispatch(clearAllProcessing({ baseId }))
  }

  // 迁移知识库（保留原知识库：条目按原内容纯复制，不触发重新处理）
  const migrateBase = async (newBase: KnowledgeBase) => {
    if (!base) return

    const timestamp = Date.now()
    const newName = `${newBase.name || base.name}-${timestamp}`

    const migratedBase: KnowledgeBase = {
      ...cloneDeep(base), // 深拷贝原始知识库
      ...newBase,
      id: newBase.id, // 确保使用新的ID
      name: newName,
      created_at: timestamp,
      updated_at: timestamp,
      items: []
    }

    dispatch(addBase(migratedBase))

    const files: FileMetadata[] = []

    // 遍历原知识库的 items，重新添加到新知识库
    for (const item of base.items) {
      switch (item.type) {
        case 'file':
          if (typeof item.content === 'object' && item.content !== null && 'path' in item.content) {
            files.push(item.content)
          }
          break
        case 'note':
          if (isKnowledgeNoteItem(item)) {
            dispatch(
              updateNotes({ baseId: newBase.id, item: createKnowledgeItem('note', item.content, { id: item.id }) })
            )
          } else {
            throw new Error(`Failed to migrate note item ${item.id}`)
          }
          break
        default:
          if (typeof item.content === 'string') {
            dispatch(addItemAction({ baseId: newBase.id, item: createKnowledgeItem(item.type, item.content) }))
          } else {
            throw new Error(`Not a valid item: ${JSON.stringify(item)}`)
          }
          break
      }
    }

    if (files.length > 0) {
      const filesItems = files.map((file) => createKnowledgeItem('file', file))
      dispatch(addFilesAction({ baseId: newBase.id, items: filesItems }))
    }
  }

  const fileItems = base?.items.filter((item) => item.type === 'file') || []
  const directoryItems = base?.items.filter((item) => item.type === 'directory') || []
  const urlItems = base?.items.filter((item) => item.type === 'url') || []
  const sitemapItems = base?.items.filter((item) => item.type === 'sitemap') || []
  const noteItems = base?.items.filter(isKnowledgeNoteItem) || []
  const videoItems = base?.items.filter((item) => item.type === 'video') || []

  return {
    base,
    fileItems,
    urlItems,
    sitemapItems,
    noteItems,
    videoItems,
    renameKnowledgeBase,
    updateKnowledgeBase,
    migrateBase,
    addFiles,
    addUrl,
    addSitemap,
    addNote,
    addVideo,
    updateNoteContent,
    getNoteContent,
    updateItem,
    updateItemStatus,
    refreshItem,
    getProcessingStatus,
    getProcessingItemsByType,
    clearCompleted,
    clearAll,
    removeItem,
    directoryItems,
    addDirectory
  }
}

export const useKnowledgeBases = () => {
  const dispatch = useDispatch()
  const bases = useSelector((state: RootState) => state.knowledge.bases)
  const { assistants, updateAssistants } = useAssistants()

  const addKnowledgeBase = (base: KnowledgeBase) => {
    dispatch(addBase(base))
    // 同步建向量库文件（LibSQL 单文件；失败仅日志——库文件在首次条目入队时也会惰性建）。
    void knowledgeBaseApi.create({ id: base.id }).catch(() => undefined)
  }

  const renameKnowledgeBase = (baseId: string, name: string) => {
    dispatch(renameBase({ baseId, name }))
  }

  /**
   * 删除知识库（整库）。
   *
   * 删除纪律：**返回 `Promise<boolean>`**，失败必须给出
   * 用户可见信号，且不得留下「界面已删、库还在」的分歧。
   *
   * 实现顺序是**先真实删除、后改投影**（而不是像 `removeItem` 那样乐观删+回滚）：整库删除的
   * IPC 由 `store/knowledge.ts` 的 `deleteBase` reducer 以 fire-and-forget 方式发起（越界文件，
   * 不可改），hook 若也乐观删并同时发起第二次 IPC，两次 `close()` 会并发打在同一句柄上——
   * 第二次失败会导致「删成功却回滚」的更坏结果。先 await 再 dispatch 时，reducer 那次调用落在
   * 已关闭的 store / 已删除的目录上（主进程 deleteBase 对它 force+catch，是幂等 no-op），
   * 因此失败路径不需要回滚：**失败时 redux 一行都没动**。
   *
   * @returns true = 已删除；false = 失败（redux 未变更，已弹 toast.error）。
   */
  const deleteKnowledgeBase = async (baseId: string): Promise<boolean> => {
    const base = bases.find((b) => b.id === baseId)
    if (!base) return false

    try {
      await knowledgeBaseApi.delete(baseId)
    } catch (error) {
      logger.error(`Failed to delete knowledge base ${baseId}`, error as Error)
      window.toast.error(t('knowledge.delete_base_failed', { defaultValue: 'Failed to delete the knowledge base.' }))
      return false
    }

    dispatch(deleteBase({ baseId }))

    // remove assistant knowledge_base
    // fork 分叉点：上游还会同步清理 assistant presets，fork 无 presets 状态
    const _assistants = assistants.map((assistant) => {
      if (assistant.knowledge_bases?.find((kb) => kb.id === baseId)) {
        return {
          ...assistant,
          knowledge_bases: assistant.knowledge_bases.filter((kb) => kb.id !== baseId)
        }
      }
      return assistant
    })

    updateAssistants(_assistants)
    return true
  }

  const updateKnowledgeBases = (bases: KnowledgeBase[]) => {
    dispatch(updateBases(bases))
  }

  return {
    bases,
    addKnowledgeBase,
    renameKnowledgeBase,
    deleteKnowledgeBase,
    updateKnowledgeBases
  }
}

import { ExclamationCircleOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import { DeleteIcon } from '@renderer/components/Icons'
import { DynamicVirtualList } from '@renderer/components/VirtualList'
import { handleDelete } from '@renderer/services/FileAction'
import FileManager from '@renderer/services/FileManager'
import { useAppSelector } from '@renderer/store'
import type { FileMetadata, FileType } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import { formatFileSize } from '@renderer/utils'
import { Col, Image, Row, Spin } from 'antd'
import { t } from 'i18next'
import { FileWarning } from 'lucide-react'
import React, { memo, useCallback, useEffect, useRef, useState } from 'react'
import styled from 'styled-components'

import FileItem from './FileItem'

const logger = loggerService.withContext('FileList')

interface FileItemProps {
  id: FileType | 'all' | string
  list: {
    key: FileType | 'all' | string
    file: React.ReactNode
    files?: FileMetadata[]
    count?: number
    size: string
    ext: string
    created_at: string
    actions: React.ReactNode
  }[]
  files?: FileMetadata[]
}

/** 图片网格每批渲染的张数。 */
const IMAGE_BATCH_SIZE = 24

/**
 * 图片分支是唯一会随使用量单调增长的数据面（AI 出图与上传图片都归 image），
 * 旧实现一次性为**全部**图片渲染 `Image` + `Spin` + 删除按钮 + 信息条四层节点，且 antd `Image`
 * 会为每张图挂 preview 监听——几百张图时首帧明显卡顿。
 *
 * 这里改成按需揭示：先渲染一批，列表底部的哨兵进入视口（含 300px 预取边距）时再追加一批。
 * 首批 DOM 恒定在 `IMAGE_BATCH_SIZE` 量级，滚动到哪渲染到哪。
 * 观察者能力缺失（非 Chromium 环境）时退回全量渲染——宁可慢，不得静默少显示。
 */
function useProgressiveReveal(total: number, batchSize: number) {
  const [visibleCount, setVisibleCount] = useState(() => Math.min(batchSize, total))
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setVisibleCount((current) => (current >= total ? total : Math.max(current, Math.min(batchSize, total))))
  }, [batchSize, total])

  useEffect(() => {
    if (visibleCount >= total) return

    const sentinel = sentinelRef.current
    if (!sentinel || typeof IntersectionObserver === 'undefined') {
      setVisibleCount(total)
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((current) => Math.min(current + batchSize, total))
        }
      },
      { rootMargin: '300px' }
    )
    observer.observe(sentinel)

    return () => observer.disconnect()
  }, [batchSize, total, visibleCount])

  return { visibleCount, sentinelRef }
}

const FileList: React.FC<FileItemProps> = ({ id, list, files }) => {
  const estimateSize = useCallback(() => 75, [])
  const imageCount = files?.length ?? 0
  const { visibleCount, sentinelRef } = useProgressiveReveal(imageCount, IMAGE_BATCH_SIZE)
  // 路径地基（问题2候选1）：订阅 filesPath，引导晚到时重渲染出真实 URL；
  // 未到位前保持 Spin（诚实加载态），不渲染注定裂图的 file:// URL。
  const filesPath = useAppSelector((state) => state.runtime.filesPath)
  // 加载失败的图停止转圈并给占位（问题2候选2）：无 onError 时坏 URL 会永远 Spin。
  const [failedIds, setFailedIds] = useState<Set<string>>(() => new Set())

  if (id === FILE_TYPE.IMAGE && imageCount > 0) {
    return (
      <div style={{ padding: 16, overflowY: 'auto' }}>
        <Image.PreviewGroup>
          <Row gutter={[16, 16]}>
            {files?.slice(0, visibleCount).map((file) => (
              <Col key={file.id} xs={24} sm={12} md={8} lg={4} xl={3}>
                <ImageWrapper>
                  {failedIds.has(file.id) ? (
                    <FailedPlaceholder>
                      <FileWarning size={28} />
                    </FailedPlaceholder>
                  ) : (
                    <>
                      <LoadingWrapper>
                        <Spin />
                      </LoadingWrapper>
                      {filesPath && (
                        <Image
                          src={FileManager.getFileUrl(file)}
                          style={{ height: '100%', objectFit: 'cover', cursor: 'pointer' }}
                          preview={{ mask: false }}
                          onLoad={(e) => {
                            const img = e.target as HTMLImageElement
                            img.parentElement?.classList.add('loaded')
                          }}
                          onError={() => {
                            // logger 必要：坏 URL 是"文件管理找不到"的直接现场（字节缺失/路径坏）。
                            logger.warn(
                              `FileList: image failed to load, id=${file.id} url=${FileManager.getFileUrl(file)}`
                            )
                            setFailedIds((prev) => {
                              const next = new Set(prev)
                              next.add(file.id)
                              return next
                            })
                          }}
                        />
                      )}
                    </>
                  )}
                  <ImageInfo>
                    <div>{formatFileSize(file.size)}</div>
                  </ImageInfo>
                  <DeleteButton
                    title={t('files.delete.title')}
                    onClick={(e) => {
                      e.stopPropagation()
                      window.modal.confirm({
                        title: t('files.delete.title'),
                        content: t('files.delete.content'),
                        okText: t('common.confirm'),
                        cancelText: t('common.cancel'),
                        centered: true,
                        onOk: () => {
                          // handleDelete 现在会 throw。`void` 只让 lint 闭嘴——拒绝会变成
                          // unhandled rejection（antd 的 ActionButton 在拒绝分支里 `Promise.reject(e)`，
                          // 无人接住）。用户可见信号由 handleDelete 统一给出，这里留取证行。
                          handleDelete(file.id, t).catch((error) => {
                            logger.warn(`Failed to delete file ${file.id}`, error as Error)
                          })
                        },
                        icon: <ExclamationCircleOutlined style={{ color: 'red' }} />
                      })
                    }}>
                    <DeleteIcon size={14} className="lucide-custom" />
                  </DeleteButton>
                </ImageWrapper>
              </Col>
            ))}
          </Row>
        </Image.PreviewGroup>
        {visibleCount < imageCount && <RevealSentinel ref={sentinelRef} data-testid="file-list-reveal-sentinel" />}
      </div>
    )
  }

  return (
    <DynamicVirtualList
      list={list}
      estimateSize={estimateSize}
      overscan={2}
      scrollerStyle={{
        padding: '0 16px 16px 16px'
      }}
      itemContainerStyle={{
        height: '75px',
        paddingTop: '12px'
      }}>
      {(item) => (
        <FileItem
          key={item.key}
          fileInfo={{
            name: item.file,
            ext: item.ext,
            extra: `${item.created_at} · ${item.count}${t('files.count')} · ${item.size}`,
            actions: item.actions
          }}
        />
      )}
    </DynamicVirtualList>
  )
}

const ImageWrapper = styled.div`
  position: relative;
  aspect-ratio: 1;
  overflow: hidden;
  border-radius: 8px;
  background-color: var(--color-background-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0.5px solid var(--color-border);

  .ant-image {
    height: 100%;
    width: 100%;
    opacity: 0;
    transition:
      opacity 0.3s ease,
      transform 0.3s ease;

    &.loaded {
      opacity: 1;
    }
  }

  &:hover {
    .ant-image.loaded {
      transform: scale(1.05);
    }

    div:last-child {
      opacity: 1;
    }
  }
`

const RevealSentinel = styled.div`
  height: 1px;
  width: 100%;
`

const LoadingWrapper = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--color-background-soft);
`

const FailedPlaceholder = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  background-color: var(--color-background-soft);
`

const ImageInfo = styled.div`
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: rgba(0, 0, 0, 0.6);
  color: white;
  padding: 5px 8px;
  opacity: 0;
  transition: opacity 0.3s ease;
  font-size: 12px;

  > div:first-child {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
`

const DeleteButton = styled.div`
  position: absolute;
  top: 8px;
  right: 8px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background-color: rgba(0, 0, 0, 0.6);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.3s ease;
  z-index: 1;

  &:hover {
    background-color: rgba(255, 0, 0, 0.8);
  }
`

export default memo(FileList)

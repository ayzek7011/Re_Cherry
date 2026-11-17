import ImageViewer from '@renderer/components/ImageViewer'
import FileManager from '@renderer/services/FileManager'
import { useAppSelector } from '@renderer/store'
import { type ImageMessageBlock, MessageBlockStatus } from '@renderer/types/newMessage'
import { Skeleton } from 'antd'
import React from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  block: ImageMessageBlock
  isSingle?: boolean
}

const ImageBlock: React.FC<Props> = ({ block, isSingle = false }) => {
  const { t } = useTranslation()
  // 订阅 filesPath：getFilePath 读的是 Redux 非响应式快照，memo 组件在路径晚到
  // （启动窗口 / mini 窗首次拉取）时不会重渲染，坏 file:// URL 会一直挂着。
  const filesPath = useAppSelector((state) => state.runtime.filesPath)

  // 待生成/生成中：骨架（原行为；PROCESSING 一并纳入——它是 createBaseMessageBlock 的默认状态）
  if (block.status === MessageBlockStatus.PENDING || block.status === MessageBlockStatus.PROCESSING) {
    return <Skeleton.Image active style={{ width: 200, height: 200 }} />
  }

  if (block.status === MessageBlockStatus.STREAMING || block.status === MessageBlockStatus.SUCCESS) {
    const images = block.metadata?.generateImageResponse?.images?.length
      ? block.metadata?.generateImageResponse?.images
      : block?.file && filesPath
        ? [`file://${FileManager.getFilePath(block?.file)}`]
        : block?.url
          ? [block.url]
          : []

    // 块建出来了却没有可取地址 —— 此前渲染成空 Container，表现就是"图凭空消失"。
    // 用户原话"就算不渲染也给我挂个啥占位符表示一下我发了个图"，统一给占位，绝不留白。
    if (images.length === 0) {
      return <Placeholder className="image-block-placeholder">{t('message.image.unavailable')}</Placeholder>
    }

    return (
      <Container>
        {images.map((src, index) => (
          <ImageViewer
            src={src}
            key={`image-${index}`}
            style={
              isSingle
                ? { maxWidth: 500, maxHeight: 'min(500px, 50vh)', padding: 0, borderRadius: 8 }
                : { width: 280, height: 280, objectFit: 'cover', padding: 0, borderRadius: 8 }
            }
          />
        ))}
      </Container>
    )
  }

  // 其余状态（ERROR / PAUSED / …）：占位符而不是 null —— 宁可显示"图片无法显示"，也不要静默消失
  return <Placeholder className="image-block-placeholder">{t('message.image.unavailable')}</Placeholder>
}

const Container = styled.div`
  display: block;
`

const Placeholder = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 160px;
  min-height: 72px;
  padding: 12px 16px;
  border: 1px dashed var(--color-border);
  border-radius: 8px;
  color: var(--color-text-secondary);
  font-size: 12px;
  user-select: none;
`

export default React.memo(ImageBlock)

/**
 * ImageBlock 的**渲染完备性**。
 *
 * 真机事故：快捷助手把用户粘贴的图建成了块，但没给 status ⇒ `createBaseMessageBlock` 的默认
 * 状态是 PROCESSING ⇒ 旧实现 `return null` ⇒ 聊天里"我发出去的图什么都不显示"（模型却能读到图）。
 * 这里钉住：SUCCESS 出图、PROCESSING/PENDING 出骨架、其余状态与"有块没地址"一律出占位符，
 * **任何状态都不允许渲染成空**。
 */
import { configureStore } from '@reduxjs/toolkit'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/components/ImageViewer', () => ({
  default: ({ src }: { src: string }) => <img src={src} alt="" />
}))
vi.mock('@renderer/services/FileManager', () => ({
  default: { getFilePath: (file: { id: string; ext: string }) => `/files/${file.id}${file.ext}` }
}))

import ImageBlock from '../ImageBlock'

// ImageBlock 订阅 runtime.filesPath（路径晚到重渲染），测试态给固定值即可。
const store = configureStore({ reducer: { runtime: () => ({ filesPath: 'C:\\userData\\Data\\Files' }) } })
const withStore = (ui: React.ReactElement) => <Provider store={store}>{ui}</Provider>

const baseBlock = {
  id: 'b1',
  messageId: 'm1',
  type: MessageBlockType.IMAGE,
  createdAt: '2026-09-24T00:00:00.000Z'
} as const

describe('ImageBlock', () => {
  it('SUCCESS + url：真的把图渲染出来（小窗粘贴图修复后的形态）', () => {
    const { container } = render(
      withStore(
        <ImageBlock
          block={{ ...baseBlock, status: MessageBlockStatus.SUCCESS, url: 'data:image/png;base64,aGVsbG8=' }}
        />
      )
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=')
    expect(container.querySelector('.image-block-placeholder')).toBeNull()
  })

  it('PROCESSING / PENDING：骨架（不渲染成空）', () => {
    for (const status of [MessageBlockStatus.PROCESSING, MessageBlockStatus.PENDING]) {
      const { container } = render(withStore(<ImageBlock block={{ ...baseBlock, status }} />))
      expect(container.querySelector('.ant-skeleton')).not.toBeNull()
    }
  })

  it('ERROR / PAUSED 等其余状态：出占位符而不是 null', () => {
    for (const status of [MessageBlockStatus.ERROR, MessageBlockStatus.PAUSED]) {
      const { container } = render(withStore(<ImageBlock block={{ ...baseBlock, status }} />))
      expect(container.querySelector('.image-block-placeholder')).not.toBeNull()
    }
  })

  it('SUCCESS 但拿不到任何地址：也出占位符（旧实现渲染空容器 ⇒ 图凭空消失）', () => {
    const { container } = render(withStore(<ImageBlock block={{ ...baseBlock, status: MessageBlockStatus.SUCCESS }} />))
    const placeholder = container.querySelector('.image-block-placeholder')
    expect(placeholder).not.toBeNull()
    // 文案由 i18n 提供（测试环境里可能是裸键），这里只要求"有文字"，不绑语言
    expect((placeholder?.textContent ?? '').trim().length).toBeGreaterThan(0)
  })
})

import '@renderer/i18n'

import type { Assistant } from '@renderer/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ToolsSettings from '../ToolsSettings'

/**
 * 工具页方形卡片的版式与交互契约（起：第一排 i18n 名 + 开关，第二排工具原版名，
 * 下面是介绍）。
 *
 * 断言锚点用**工具原版名**而不是本地化名：原版名是标识符、不随语言变，测试不会因为
 * 文案改动而碎；同时它顺带证明注册表 `TOOL_ORIGIN_NAMES` 十四张卡片全覆盖。
 */
const ORIGIN_NAMES = [
  'ask_user_question',
  'ocr_document',
  'generate_image',
  'read / write / move',
  'glob / grep',
  'str_replace_editor',
  'pwsh',
  'jobs',
  'move_to_trash',
  'save_attachment',
  'documents_extract',
  'memory',
  'todo_write',
  'goal'
]

const assistant = (overrides: Partial<Assistant> = {}): Assistant =>
  ({ id: 'a1', name: 't', ...overrides }) as unknown as Assistant

const setup = (overrides: Partial<Assistant> = {}) => {
  const updateAssistant = vi.fn()
  render(<ToolsSettings assistant={assistant(overrides)} updateAssistant={updateAssistant} />)
  return { updateAssistant }
}

/** 原版名所在的 span 的父节点就是卡片（ToolCard > Head + Origin + Description）。 */
const cardOf = (originName: string): HTMLElement => {
  const origin = screen.getByText(originName)
  const card = origin.parentElement
  if (!card) throw new Error(`card not found for ${originName}`)
  return card
}

describe('工具页方形卡片', () => {
  it('十四张卡片都有原版名、开关与介绍', () => {
    setup()

    for (const origin of ORIGIN_NAMES) {
      const card = cardOf(origin)
      expect(card.querySelector('[role="switch"]')).not.toBeNull()
      expect(card.querySelector('p')?.textContent?.trim()).toBeTruthy()
    }
  })

  it('点卡片本体即切换该工具（默认开 → 关）', () => {
    const { updateAssistant } = setup()

    fireEvent.click(cardOf('read / write / move'))

    expect(updateAssistant).toHaveBeenCalledWith({ externalTools: { fs: false } })
  })

  it('点开关只切一次——不连带触发卡片点击，否则等于连切两下回到原状', () => {
    const { updateAssistant } = setup()

    fireEvent.click(cardOf('read / write / move').querySelector('[role="switch"]') as HTMLElement)

    expect(updateAssistant).toHaveBeenCalledTimes(1)
    expect(updateAssistant).toHaveBeenCalledWith({ externalTools: { fs: false } })
  })

  it('生图卡片切助手字段，而不是 tools 开关映射', () => {
    const { updateAssistant } = setup()

    fireEvent.click(cardOf('generate_image'))

    expect(updateAssistant).toHaveBeenCalledWith({ enableGenerateImage: true })
  })

  it('已关掉的工具再点一次即打开（稀疏 map 缺省视为开）', () => {
    const { updateAssistant } = setup({ externalTools: { fs: false } })

    fireEvent.click(cardOf('read / write / move'))

    expect(updateAssistant).toHaveBeenCalledWith({ externalTools: { fs: true } })
  })
})

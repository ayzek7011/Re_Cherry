import '@renderer/i18n'

import i18n from '@renderer/i18n'
import type { Assistant } from '@renderer/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import ChatSettingsSection from '../ChatSettingsSection'

beforeAll(() => {
  // antd Slider/InputNumber 依赖 matchMedia（jsdom 未内置）
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
  })
})

/**
 * 采样参数的落库时机契约。
 *
 * 旧实现把写入排在 500ms/1000ms 的 `setTimeoutTimer` 上，而 `useTimer` 卸载时会
 * `clearAllTimers()`：改完参数立刻关弹窗 / 切 tab，界面看着改好了，写入却从未发生；
 * 「重置」也不清挂起的定时器，于是重置后旧值被反写。下面锁住修正后的语义。
 *
 * 用「温度」这组参数取值。开关/输入框的可见性由 `assistant.settings` 派生
 * （useMemo，不持有本地开关态），mock 的 updateAssistantSettings 不会回灌 props，
 * 所以直接用「预开启温度、关闭其它数字参数」的夹具，页内只剩温度一个数字框。
 */

const assistant = (settings: Assistant['settings'] = {}): Assistant =>
  ({
    id: 'a1',
    name: 'A',
    settings: {
      enableTemperature: true,
      enableTopP: false,
      enableMaxTokens: false,
      enableMaxToolCalls: false,
      ...settings
    }
  }) as unknown as Assistant

/**
 * 页内唯一数字框 = 温度（其余数字参数均被夹具关闭）。
 *
 * `EditableNumber` 非编辑态的 `InputNumber` 是 `visibility: hidden`（a11y 集合会把它
 * 排除掉），所以不能用 getByRole，改从标签定位结构后 querySelector 拿 input；
 * 随后 `input.focus()` 程序化进入编辑态（focus 不受 visibility/tabIndex 限制）。
 */
const temperatureInput = () => {
  const label = screen.getByText(i18n.t('chat.settings.temperature.label'))
  const settingRow = (label.parentElement?.parentElement ?? label.closest('div')) as HTMLElement
  const row = settingRow.nextElementSibling as HTMLElement
  return row.querySelector('input') as HTMLInputElement
}

/** 真实交互序列：先聚焦再输入（`EditableNumber` 以 focus/blur 成对驱动提交），失焦才提交。 */
const typeTemperature = (value: string) => {
  const input = temperatureInput()
  input.focus()
  fireEvent.change(input, { target: { value } })
  input.blur()
}

describe('采样参数的延迟写入', () => {
  it('卸载时把还没落库的挂起值 flush 掉（关弹窗 / 切 tab 不丢写）', () => {
    const updateAssistantSettings = vi.fn()
    const { unmount } = render(
      <ChatSettingsSection assistant={assistant()} updateAssistantSettings={updateAssistantSettings} />
    )

    typeTemperature('1.5')
    expect(updateAssistantSettings).not.toHaveBeenCalledWith({ temperature: 1.5 })

    unmount()

    expect(updateAssistantSettings).toHaveBeenCalledWith({ temperature: 1.5 })
  })

  it('没有挂起写入时不产生多余的采样参数写入', () => {
    const updateAssistantSettings = vi.fn()
    const { unmount } = render(
      <ChatSettingsSection assistant={assistant()} updateAssistantSettings={updateAssistantSettings} />
    )

    unmount()

    expect(updateAssistantSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({ temperature: expect.anything() })
    )
  })

  it('点「重置」清掉挂起的定时器，挂起值不会在重置后反写', () => {
    vi.useFakeTimers()
    try {
      const updateAssistantSettings = vi.fn()
      render(<ChatSettingsSection assistant={assistant()} updateAssistantSettings={updateAssistantSettings} />)

      typeTemperature('1.5')
      fireEvent.click(screen.getByRole('button', { name: /reset|重置/i }))

      const callsAfterReset = updateAssistantSettings.mock.calls.length
      vi.advanceTimersByTime(2000)

      expect(updateAssistantSettings.mock.calls.length).toBe(callsAfterReset)
      expect(updateAssistantSettings).not.toHaveBeenCalledWith({ temperature: 1.5 })
    } finally {
      vi.useRealTimers()
    }
  })
})

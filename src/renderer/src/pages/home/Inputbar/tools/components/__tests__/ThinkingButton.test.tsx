/**
 * ThinkingButton 契约测试（设计：思考档位与模型无关，常驻六项）。
 *
 * ⚠️ 教训（本文件 25 个用例整片失败的根因）：
 * 此前这里用 `vi.mock('@renderer/config/models', () => ({...}))` 把该模块**整体替换**，且漏掉了
 * `isReasoningModel` 导出；组件现在经由 `@renderer/utils/reasoningKernel` 间接 import 它，于是 vitest 抛
 * `[vitest] No "isReasoningModel" export is defined on the "@renderer/config/models" mock`，整片失败。
 * 因此：对本模块的 mock **必须**用 `importOriginal` 展开真实导出，只覆盖需要控制的判据，
 * 避免将来模块新增导出时再次整片失败。不要再写不带 importOriginal 的整体替换。
 *
 * ⚠️ `minimal` 分支目前不可达：
 * `src/renderer/src/utils/reasoningKernel.ts` 的 `REASONING_UI_OPTIONS` 只提供
 * none/auto/low/medium/high/max，组件里
 * 「isOpenAIWebSearchModel && isGPT5SeriesReasoningModel && enableWebSearch && option === 'minimal'
 *   → window.toast.warning」的分支（ThinkingButton.tsx:71-79）没有任何调用方会以 'minimal' 触发
 * `onThinkingChange`（面板列表里已无 minimal 项）。
 * 该分支目前不可达，若要保留覆盖率需让 UI 列表重新包含 minimal，或删除该分支。
 * 原用例 `should show warning when using minimal reasoning with web search` 已按此删除
 * （它本身也只是"什么都没做 + 断言未被调用"的空洞断言）。本文件改为断言面板列表**不含** 'minimal'。
 *
 * ⚠️ 第二个坑（用 importOriginal 之后才会遇到）：组件经由 @renderer/utils/reasoningKernel 间接依赖
 * isReasoningModel，而 importOriginal 会先求值真实的 config/models 模块图（→ store/thunk →
 * services/kernelChat → reasoningKernel）。若 reasoningKernel 第一次求值发生在那个图里，它会绑定到
 * **真实**的 isReasoningModel，本文件的 mock 控制点静默失效（非推理模型场景仍拿到六项档位）。
 * 因此本文件在 `../ThinkingButton` 之前显式 import reasoningKernel（见下方 import 注释），
 * 并由 'keeps the isReasoningModel control point effective' 用例把这件事钉住。
 */
import type { ToolQuickPanelApi } from '@renderer/pages/home/Inputbar/types'
import type { Assistant, Model, ThinkingOption } from '@renderer/types'
// ⚠️ 必须保持这句 import 在 `../ThinkingButton` 之前（相对导入天然排最后，排序工具不会破坏它）：
// 组件经由 @renderer/utils/reasoningKernel 间接使用 isReasoningModel。若 reasoningKernel 第一次被求值
// 发生在 config/models 的 importOriginal 模块图里（store/thunk → services/kernelChat 会拉它），
// 该实例会绑定到**真实**的 isReasoningModel，本文件的 isReasoningModel 控制点就会静默失效
// （现象：非推理模型场景仍然拿到六项档位）。先在这里求值，reasoningKernel 才会绑定到 mock。
import { reasoningOptionsForModel } from '@renderer/utils/reasoningKernel'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ThinkingButton from '../ThinkingButton'

// Core Hook mocks
const mockUseTranslation = vi.fn()
const mockUseQuickPanel = vi.fn()
const mockUseAssistant = vi.fn()

// Utility function mocks
const mockIsReasoningModel = vi.fn()
const mockIsFixedReasoningModel = vi.fn()
const mockIsGPT5SeriesReasoningModel = vi.fn()
const mockIsOpenAIWebSearchModel = vi.fn()
const mockIsDoubaoThinkingAutoModel = vi.fn()

// Global toast mock
const mockToastWarning = vi.fn()

// Mock react-i18next
// 同样 importOriginal 展开真实导出：config/models 的 mock 走真实模块后会拉起
// @renderer/utils → store/thunk 等链路，链路里的 src/renderer/src/i18n/index.ts 需要
// react-i18next 的 initReactI18next，整体替换会让该链路整片失败（同一类事故）。
// 注：不写 `importOriginal<typeof import('react-i18next')>()` 这种**内联 import() 类型注解**——
// oxlint 的 consistent-type-imports 判它为错（本项目已踩过两次）；而随手加 `as` 断言又会被
// no-unnecessary-type-assertion 判错（vitest 该泛型默认是 any）。直接展开即可。
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => mockUseTranslation()
}))

// Mock QuickPanel
vi.mock('@renderer/components/QuickPanel', () => ({
  useQuickPanel: () => mockUseQuickPanel(),
  QuickPanelReservedSymbol: {
    Thinking: 'thinking'
  }
}))

// Mock useAssistant
vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => mockUseAssistant()
}))

// Mock @renderer/config/models。
// 必须 importOriginal 展开真实导出（见文件头注释）：组件经由 @renderer/utils/reasoningKernel 间接依赖
// 本模块的 isReasoningModel；只覆盖需要控制的判据，其余一律用真实实现，
// 这样将来模块新增/改动导出时不会因为"mock 少了导出"而整片失败。
vi.mock('@renderer/config/models', async (importOriginal) => ({
  ...(await importOriginal()),
  isReasoningModel: (...args: any[]) => mockIsReasoningModel(...args),
  isFixedReasoningModel: (...args: any[]) => mockIsFixedReasoningModel(...args),
  isGPT5SeriesReasoningModel: (...args: any[]) => mockIsGPT5SeriesReasoningModel(...args),
  isOpenAIWebSearchModel: (...args: any[]) => mockIsOpenAIWebSearchModel(...args),
  isDoubaoThinkingAutoModel: (...args: any[]) => mockIsDoubaoThinkingAutoModel(...args)
}))

// Mock icon components
vi.mock('@renderer/components/Icons/SVGIcon', () => ({
  MdiLightbulbAutoOutline: ({ className }: any) => (
    <div data-testid="mdi-lightbulb-auto-outline" className={className}>
      AutoOutline
    </div>
  ),
  MdiLightbulbOn30: ({ className }: any) => (
    <div data-testid="mdi-lightbulb-on30" className={className}>
      On30
    </div>
  ),
  MdiLightbulbOn50: ({ className }: any) => (
    <div data-testid="mdi-lightbulb-on50" className={className}>
      On50
    </div>
  ),
  MdiLightbulbOn80: ({ className }: any) => (
    <div data-testid="mdi-lightbulb-on80" className={className}>
      On80
    </div>
  ),
  MdiLightbulbOn90: ({ className }: any) => (
    <div data-testid="mdi-lightbulb-on90" className={className}>
      On90
    </div>
  ),
  MdiLightbulbOn: ({ className }: any) => (
    <div data-testid="mdi-lightbulb-on" className={className}>
      On
    </div>
  ),
  MdiLightbulbOffOutline: ({ className }: any) => (
    <div data-testid="mdi-lightbulb-off-outline" className={className}>
      OffOutline
    </div>
  ),
  MdiLightbulbQuestion: ({ className }: any) => (
    <div data-testid="mdi-lightbulb-question" className={className}>
      Question
    </div>
  )
}))

// Mock ActionIconButton component
vi.mock('@renderer/components/Buttons', () => ({
  ActionIconButton: ({
    onClick,
    active,
    'aria-label': ariaLabel,
    'aria-pressed': ariaPressed,
    style,
    children
  }: any) => (
    <button
      type="button"
      data-testid="action-icon-button"
      onClick={onClick}
      data-active={active}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      style={style}>
      {children}
    </button>
  )
}))

// Mock Ant Design Tooltip
// 同样 importOriginal：真实模块链路会用到 antd 的其它导出（如 Button），整体替换会整片失败。
vi.mock('antd', async (importOriginal) => ({
  ...(await importOriginal()),
  Tooltip: ({ title, children, placement, mouseLeaveDelay, arrow }: any) => (
    <div
      data-testid="tooltip"
      data-title={title}
      data-placement={placement}
      data-mouse-leave-delay={mouseLeaveDelay}
      data-arrow={arrow}>
      {children}
    </div>
  )
}))

// Test data factory functions
const createModel = (overrides: Partial<Model> = {}): Model => ({
  id: 'gpt-5',
  provider: 'openai',
  name: 'GPT-5',
  group: 'openai',
  capabilities: [],
  ...overrides
})

const createAssistant = (overrides: Partial<Assistant> = {}): Assistant => ({
  id: 'assistant-1',
  name: 'Test Assistant',
  model: createModel(),
  prompt: '',
  knowledge_bases: [],
  topics: [],
  type: 'default',
  settings: {
    reasoning_effort: 'none',
    temperature: 0.7,
    streamOutput: true,
    toolUseMode: 'function' as const
  },
  enableWebSearch: false,
  enableUrlContext: false,
  enableGenerateImage: false,
  mcpMode: 'disabled' as const,
  mcpServers: [],
  knowledgeRecognition: 'off' as const,
  regularPhrases: [],
  tags: [],
  ...overrides
})

const createUseAssistantReturn = (overrides: any = {}) => ({
  assistant: createAssistant(),
  updateAssistantSettings: vi.fn(),
  ...overrides
})

const createUseQuickPanelReturn = (overrides: any = {}) => ({
  open: vi.fn(),
  close: vi.fn(),
  isVisible: false,
  symbol: '',
  ...overrides
})

const createUseTranslationReturn = (overrides: any = {}) => ({
  t: (key: string, params?: any) => {
    const translations: Record<string, string> = {
      'assistants.settings.reasoning_effort.label': 'Reasoning Effort',
      'assistants.settings.reasoning_effort.off': 'Off',
      'assistants.settings.reasoning_effort.minimal': 'Minimal',
      'assistants.settings.reasoning_effort.low': 'Low',
      'assistants.settings.reasoning_effort.medium': 'Medium',
      'assistants.settings.reasoning_effort.high': 'High',
      'assistants.settings.reasoning_effort.xhigh': 'Extra High',
      'assistants.settings.reasoning_effort.auto': 'Auto',
      'assistants.settings.reasoning_effort.default': 'Default',
      'assistants.settings.reasoning_effort.default_description': 'Default reasoning level',
      'assistants.settings.reasoning_effort.off_description': 'Turn off reasoning',
      'assistants.settings.reasoning_effort.minimal_description': 'Minimal reasoning',
      'assistants.settings.reasoning_effort.low_description': 'Low reasoning',
      'assistants.settings.reasoning_effort.medium_description': 'Medium reasoning',
      'assistants.settings.reasoning_effort.high_description': 'High reasoning',
      'assistants.settings.reasoning_effort.xhigh_description': 'Extra high reasoning',
      'assistants.settings.reasoning_effort.auto_description': 'Auto select reasoning level',
      'chat.input.thinking.label': 'Thinking',
      'common.close': 'Close',
      'chat.web_search.warning.openai': 'Cannot use minimal reasoning with web search'
    }
    const baseTranslation = translations[key] || key
    if (params) {
      return baseTranslation.replace(/\{(\w+)\}/g, (_match: string, paramName: string) => {
        return params[paramName] !== undefined ? String(params[paramName]) : _match
      })
    }
    return baseTranslation
  },
  i18n: { language: 'en' },
  ...overrides
})

const createQuickPanelApi = (): ToolQuickPanelApi => ({
  registerRootMenu: vi.fn(() => vi.fn()),
  registerTrigger: vi.fn(() => vi.fn())
})

// 档位列表已与模型无关（REASONING_UI_OPTIONS），因此这里只需要两个模型角色：
// 推理模型（可选档位 = 六项常驻）与固定推理模型（不响应点击）。
const modelPresets = {
  reasoning: () => createModel({ id: 'gpt-5', name: 'GPT-5' }),
  fixedReasoning: () => createModel({ id: 'claude-3.7-sonnet', name: 'Claude 3.7 Sonnet' })
}

// Render helper function
const renderComponent = (
  overrides: {
    model?: Model
    assistantId?: string
    quickPanelApi?: ToolQuickPanelApi
    useAssistantReturn?: ReturnType<typeof createUseAssistantReturn>
    useQuickPanelReturn?: ReturnType<typeof createUseQuickPanelReturn>
    useTranslationReturn?: ReturnType<typeof createUseTranslationReturn>
    /** 控制 reason 判定：false → supportedOptions 为空（等价"非推理模型"） */
    isReasoningModel?: boolean
    isFixedReasoning?: boolean
    isOpenAIWebSearchModel?: boolean
    isGPT5SeriesReasoningModel?: boolean
    isDoubaoThinkingAutoModel?: boolean
    /** 非受控模式：写入 assistant.settings.reasoning_effort */
    reasoningEffort?: ThinkingOption
    enableWebSearch?: boolean
    /** 受控模式：传入则组件走受控分支，不写 assistant settings */
    controlledEffort?: ThinkingOption
    onReasoningEffortChange?: (option: ThinkingOption) => void
  } = {}
) => {
  const {
    model = modelPresets.reasoning(),
    assistantId = 'assistant-1',
    quickPanelApi = createQuickPanelApi(),
    useAssistantReturn = createUseAssistantReturn(),
    useQuickPanelReturn = createUseQuickPanelReturn(),
    useTranslationReturn = createUseTranslationReturn(),
    isReasoningModel = true,
    isFixedReasoning = false,
    isOpenAIWebSearchModel = false,
    isGPT5SeriesReasoningModel = false,
    reasoningEffort,
    enableWebSearch = false,
    isDoubaoThinkingAutoModel = false,
    controlledEffort,
    onReasoningEffortChange
  } = overrides

  // Configure assistant with reasoning_effort：只在显式传入时覆盖，
  // 否则保留 useAssistantReturn 里的档位（含 undefined，用于覆盖组件自身的回落逻辑）
  const assistantWithSettings = {
    ...useAssistantReturn.assistant,
    settings: {
      ...useAssistantReturn.assistant.settings,
      ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort })
    },
    enableWebSearch
  }

  // Set up mock return values
  mockUseAssistant.mockReturnValue({
    ...useAssistantReturn,
    assistant: assistantWithSettings
  })
  mockUseQuickPanel.mockReturnValue(useQuickPanelReturn)
  mockUseTranslation.mockReturnValue(useTranslationReturn)
  mockIsReasoningModel.mockReturnValue(isReasoningModel)
  mockIsFixedReasoningModel.mockReturnValue(isFixedReasoning)
  mockIsOpenAIWebSearchModel.mockReturnValue(isOpenAIWebSearchModel)
  mockIsGPT5SeriesReasoningModel.mockReturnValue(isGPT5SeriesReasoningModel)
  mockIsDoubaoThinkingAutoModel.mockReturnValue(isDoubaoThinkingAutoModel)

  // Setup global toast mock（当前只有不可达的 minimal 分支会用到，保留以防御）
  ;(global.window as any).toast = { warning: mockToastWarning }

  return render(
    <ThinkingButton
      model={model}
      assistantId={assistantId}
      quickPanel={quickPanelApi}
      reasoningEffort={controlledEffort}
      onReasoningEffortChange={onReasoningEffortChange}
    />
  )
}

// Query helper functions
const getActionIconButton = () => screen.getByTestId('action-icon-button')
const getTooltip = () => screen.getByTestId('tooltip')
const getIconByTestId = (testId: string) => screen.getByTestId(testId)

interface PanelItem {
  level: ThinkingOption
  label: string
  isSelected: boolean
  action: () => void
}

/** 点击按钮打开面板，并取回 useQuickPanel().open 收到的 list（组件对外的真实契约）。 */
const openPanelAndGetItems = (overrides: Parameters<typeof renderComponent>[0] = {}): PanelItem[] => {
  const mockOpen = vi.fn()
  renderComponent({ ...overrides, useQuickPanelReturn: createUseQuickPanelReturn({ open: mockOpen }) })
  fireEvent.click(getActionIconButton())
  expect(mockOpen).toHaveBeenCalledTimes(1)
  return mockOpen.mock.calls[0][0].list as PanelItem[]
}

describe('ThinkingButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockToastWarning.mockClear()

    // Set default mock return values
    mockUseTranslation.mockReturnValue(createUseTranslationReturn())
    mockUseQuickPanel.mockReturnValue(createUseQuickPanelReturn())
    mockUseAssistant.mockReturnValue(createUseAssistantReturn())
    mockIsReasoningModel.mockReturnValue(true)
    mockIsFixedReasoningModel.mockReturnValue(false)
    mockIsGPT5SeriesReasoningModel.mockReturnValue(false)
    mockIsOpenAIWebSearchModel.mockReturnValue(false)
    mockIsDoubaoThinkingAutoModel.mockReturnValue(false)

    ;(global.window as any).toast = { warning: mockToastWarning }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  describe('basic rendering', () => {
    it('should render component correctly', () => {
      renderComponent()
      expect(getActionIconButton()).toBeInTheDocument()
      expect(getTooltip()).toBeInTheDocument()
    })

    it('should display correct icon for reasoning level', () => {
      const testCases: Array<{ option: ThinkingOption; expectedTestId: string }> = [
        { option: 'minimal', expectedTestId: 'mdi-lightbulb-on30' },
        { option: 'low', expectedTestId: 'mdi-lightbulb-on50' },
        { option: 'medium', expectedTestId: 'mdi-lightbulb-on80' },
        { option: 'high', expectedTestId: 'mdi-lightbulb-on90' },
        { option: 'xhigh', expectedTestId: 'mdi-lightbulb-on' },
        { option: 'auto', expectedTestId: 'mdi-lightbulb-auto-outline' },
        { option: 'none', expectedTestId: 'mdi-lightbulb-off-outline' },
        { option: 'default', expectedTestId: 'mdi-lightbulb-question' },
        // 'max' 是 REASONING_UI_OPTIONS 里的最高档，与 xhigh 同图标（满档）。
        // 记录：引入常驻档位时漏了 ThinkingIcon 的 'max' case，'满'档曾落到 default 分支
        // 显示问号（"未知"）图标；后续修复产品代码后，本行由 question 改为 on。
        { option: 'max', expectedTestId: 'mdi-lightbulb-on' }
      ]

      testCases.forEach(({ option, expectedTestId }) => {
        const { unmount } = renderComponent({
          reasoningEffort: option
        })
        expect(getIconByTestId(expectedTestId)).toBeInTheDocument()
        unmount()
      })
    })
  })

  describe('reasoning option list (model-independent)', () => {
    it('keeps the isReasoningModel control point effective', () => {
      // guard：若 reasoningKernel 先被 importOriginal 的模块图实例化（见文件头第二个坑），
      // 这里会拿到真实的 isReasoningModel，mock 静默失效，本用例立即失败。
      mockIsReasoningModel.mockReturnValue(true)
      expect(reasoningOptionsForModel(createModel())).toEqual(['none', 'auto', 'low', 'medium', 'high', 'max'])
      expect(mockIsReasoningModel).toHaveBeenCalled()

      mockIsReasoningModel.mockReturnValue(false)
      expect(reasoningOptionsForModel(createModel())).toEqual([])
      // 无模型时同样为空
      expect(reasoningOptionsForModel(undefined)).toEqual([])
    })

    it('should open the quick panel with the six fixed options for reasoning models', () => {
      // 用"关"态打开面板：已开启态下点击是一键关闭（见 click behavior）
      const items = openPanelAndGetItems({ reasoningEffort: 'none' })

      expect(items.map((item) => item.level)).toEqual(['none', 'auto', 'low', 'medium', 'high', 'max'])
      // 面板不再提供 'minimal'：这正是组件里 minimal + web search warning 分支不可达的原因
      expect(items.map((item) => item.level)).not.toContain('minimal')
      // 当前档位被标记为选中（本用例以"关"态打开面板，故选中 'none'）
      expect(items.filter((item) => item.isSelected).map((item) => item.level)).toEqual(['none'])
      // 文案来自同一张词表：'none' → off；'max' 复用 xhigh 文案（未新增 i18n key）
      expect(items.find((item) => item.level === 'none')!.label).toBe('Off')
      expect(items.find((item) => item.level === 'max')!.label).toBe('Extra High')
    })

    it('should open the quick panel with an empty list when the model is not a reasoning model', () => {
      // isReasoningModel=false → reasoningOptionsForModel 返回 []（UI 据此隐藏入口，见 thinkingTool.condition）
      const items = openPanelAndGetItems({ isReasoningModel: false, reasoningEffort: 'none' })

      expect(items).toEqual([])
    })
  })

  describe('click behavior', () => {
    it('should open quick panel when thinking is disabled', () => {
      const mockOpen = vi.fn()
      const useQuickPanelReturn = createUseQuickPanelReturn({ open: mockOpen })

      renderComponent({
        reasoningEffort: 'none',
        useQuickPanelReturn
      })

      fireEvent.click(getActionIconButton())
      expect(mockOpen).toHaveBeenCalled()
    })

    it('should turn thinking off in one click when it is already enabled', () => {
      // 恢复的交互：档位表里有"关"（none）时，已开启状态点一下**直接关闭**，不再打开面板。
      // （此前该分支要求"非多档模型"，而常驻六项下含 none 必含 low/medium/high → 条件恒不成立，
      //  这个交互实际消失、disableThinking 沦为死代码。）
      const mockOpen = vi.fn()
      const mockUpdateSettings = vi.fn()
      const useQuickPanelReturn = createUseQuickPanelReturn({ open: mockOpen })

      renderComponent({
        reasoningEffort: 'high',
        useQuickPanelReturn,
        useAssistantReturn: createUseAssistantReturn({ updateAssistantSettings: mockUpdateSettings })
      })

      fireEvent.click(getActionIconButton())
      expect(mockOpen).not.toHaveBeenCalled()
      expect(mockUpdateSettings).toHaveBeenCalledWith({
        reasoning_effort: 'none',
        reasoning_effort_cache: 'none',
        qwenThinkMode: false
      })
    })

    it('should close quick panel when the thinking panel is already visible', () => {
      const mockClose = vi.fn()
      const mockOpen = vi.fn()
      const useQuickPanelReturn = createUseQuickPanelReturn({
        isVisible: true,
        symbol: 'thinking',
        close: mockClose,
        open: mockOpen
      })

      renderComponent({
        reasoningEffort: 'high',
        useQuickPanelReturn
      })

      fireEvent.click(getActionIconButton())
      expect(mockClose).toHaveBeenCalled()
      expect(mockOpen).not.toHaveBeenCalled()
    })

    it('should open quick panel when a different quick panel symbol is visible', () => {
      const mockClose = vi.fn()
      const mockOpen = vi.fn()
      const useQuickPanelReturn = createUseQuickPanelReturn({
        isVisible: true,
        symbol: 'other-panel',
        close: mockClose,
        open: mockOpen
      })

      // 已开启态下点击是一键关闭（见上一条），故本用例用"关"态以走到打开面板的分支
      renderComponent({
        reasoningEffort: 'none',
        useQuickPanelReturn
      })

      fireEvent.click(getActionIconButton())
      expect(mockClose).not.toHaveBeenCalled()
      expect(mockOpen).toHaveBeenCalled()
    })

    describe('fixed reasoning models', () => {
      it('should not respond to clicks', () => {
        const mockOpen = vi.fn()
        const mockClose = vi.fn()
        const mockUpdateSettings = vi.fn()
        const useQuickPanelReturn = createUseQuickPanelReturn({
          isVisible: true,
          symbol: 'thinking',
          open: mockOpen,
          close: mockClose
        })
        const useAssistantReturn = createUseAssistantReturn({ updateAssistantSettings: mockUpdateSettings })

        renderComponent({
          isFixedReasoning: true,
          model: modelPresets.fixedReasoning(),
          useQuickPanelReturn,
          useAssistantReturn
        })

        fireEvent.click(getActionIconButton())
        expect(mockOpen).not.toHaveBeenCalled()
        expect(mockClose).not.toHaveBeenCalled()
        expect(mockUpdateSettings).not.toHaveBeenCalled()
      })
    })
  })

  describe('panel item actions (onThinkingChange)', () => {
    it('should write an enabled level to assistant settings', () => {
      const mockUpdateSettings = vi.fn()
      const useAssistantReturn = createUseAssistantReturn({ updateAssistantSettings: mockUpdateSettings })

      const items = openPanelAndGetItems({ reasoningEffort: 'none', useAssistantReturn })
      items.find((item) => item.level === 'high')!.action()

      expect(mockUpdateSettings).toHaveBeenCalledWith({
        reasoning_effort: 'high',
        reasoning_effort_cache: 'high',
        qwenThinkMode: true
      })
    })

    it('should write the disabled state when none is selected', () => {
      const mockUpdateSettings = vi.fn()
      const useAssistantReturn = createUseAssistantReturn({ updateAssistantSettings: mockUpdateSettings })

      const items = openPanelAndGetItems({ reasoningEffort: 'none', useAssistantReturn })
      items.find((item) => item.level === 'none')!.action()

      expect(mockUpdateSettings).toHaveBeenCalledWith({
        reasoning_effort: 'none',
        reasoning_effort_cache: 'none',
        qwenThinkMode: false
      })
    })

    it('should not warn for non-minimal levels even with OpenAI web search enabled', () => {
      // minimal 之外的所有档位都不触发 web search 警告
      const mockUpdateSettings = vi.fn()
      const useAssistantReturn = createUseAssistantReturn({ updateAssistantSettings: mockUpdateSettings })

      const items = openPanelAndGetItems({
        reasoningEffort: 'none',
        useAssistantReturn,
        isOpenAIWebSearchModel: true,
        isGPT5SeriesReasoningModel: true,
        enableWebSearch: true
      })
      items.find((item) => item.level === 'high')!.action()

      expect(mockToastWarning).not.toHaveBeenCalled()
      expect(mockUpdateSettings).toHaveBeenCalledWith({
        reasoning_effort: 'high',
        reasoning_effort_cache: 'high',
        qwenThinkMode: true
      })
    })

    it('should drive icon and label from the controlled effort without touching assistant settings', () => {
      const mockUpdateSettings = vi.fn()
      const useAssistantReturn = createUseAssistantReturn({ updateAssistantSettings: mockUpdateSettings })

      // 受控档位驱动图标与标签：开启态 → 可一键关闭 → 标签为 Close
      renderComponent({
        useAssistantReturn,
        controlledEffort: 'low',
        onReasoningEffortChange: vi.fn()
      })
      expect(getIconByTestId('mdi-lightbulb-on50')).toBeInTheDocument()
      expect(getActionIconButton()).toHaveAttribute('aria-label', 'Close')
      expect(mockUpdateSettings).not.toHaveBeenCalled()
    })

    it('should delegate to onReasoningEffortChange in controlled mode without touching assistant settings', () => {
      const mockUpdateSettings = vi.fn()
      const mockOnReasoningEffortChange = vi.fn()
      const useAssistantReturn = createUseAssistantReturn({ updateAssistantSettings: mockUpdateSettings })

      // 从"关"态打开面板（开启态下点击是一键关闭）
      const items = openPanelAndGetItems({
        useAssistantReturn,
        controlledEffort: 'none',
        onReasoningEffortChange: mockOnReasoningEffortChange
      })
      expect(items.map((item) => item.level)).toEqual(['none', 'auto', 'low', 'medium', 'high', 'max'])

      items.find((item) => item.level === 'max')!.action()
      expect(mockOnReasoningEffortChange).toHaveBeenCalledWith('max')
      expect(mockUpdateSettings).not.toHaveBeenCalled()
    })
  })

  describe('aria-labels consistency', () => {
    it('should show "Thinking" for fixed reasoning models', () => {
      renderComponent({
        isFixedReasoning: true,
        model: modelPresets.fixedReasoning()
      })

      expect(getActionIconButton()).toHaveAttribute('aria-label', 'Thinking')
    })

    it('should show "Close" for reasoning models while thinking is on (one-click close available)', () => {
      renderComponent({ reasoningEffort: 'high' })

      expect(getActionIconButton()).toHaveAttribute('aria-label', 'Close')
    })

    it('should show "Reasoning Effort" for reasoning models when thinking is off', () => {
      renderComponent({ reasoningEffort: 'none' })

      expect(getActionIconButton()).toHaveAttribute('aria-label', 'Reasoning Effort')
    })

    it('should show "Reasoning Effort" for non-reasoning models even with an enabled level', () => {
      // 非推理模型的档位表为空 → 不含 'none' 项 → 无法一键关闭 → 标签为 "Reasoning Effort"，
      // **与点击行为一致**（点击打开面板）。修正了此前"标签说 Close、点击却开面板"的不符。
      renderComponent({
        isReasoningModel: false,
        reasoningEffort: 'high'
      })

      expect(getActionIconButton()).toHaveAttribute('aria-label', 'Reasoning Effort')
    })

    it('should show "Reasoning Effort" for non-reasoning models when thinking is off', () => {
      renderComponent({
        isReasoningModel: false,
        reasoningEffort: 'none'
      })

      expect(getActionIconButton()).toHaveAttribute('aria-label', 'Reasoning Effort')
    })
  })

  describe('icon rendering', () => {
    it('should show auto outline icon for fixed reasoning models', () => {
      renderComponent({
        isFixedReasoning: true,
        model: modelPresets.fixedReasoning(),
        reasoningEffort: 'low'
      })

      // 固定推理模型不按档位取图标，恒为 auto
      expect(getIconByTestId('mdi-lightbulb-auto-outline')).toBeInTheDocument()
    })
  })

  describe('fixed reasoning model special behavior', () => {
    it('should show active state while aria-pressed still follows the real reasoning state', () => {
      const { unmount } = renderComponent({
        isFixedReasoning: true,
        model: modelPresets.fixedReasoning(),
        reasoningEffort: 'high'
      })
      expect(getActionIconButton()).toHaveAttribute('data-active', 'true')
      expect(getActionIconButton()).toHaveAttribute('aria-pressed', 'true')
      unmount()

      // 固定推理模型恒 active；aria-pressed 反映实际档位（'none' → false）
      renderComponent({
        isFixedReasoning: true,
        model: modelPresets.fixedReasoning(),
        reasoningEffort: 'none'
      })
      expect(getActionIconButton()).toHaveAttribute('data-active', 'true')
      expect(getActionIconButton()).toHaveAttribute('aria-pressed', 'false')
    })

    it('should show disabled pointer cursor style', () => {
      renderComponent({
        isFixedReasoning: true,
        model: modelPresets.fixedReasoning()
      })

      expect(getActionIconButton()).toHaveStyle({ cursor: 'default' })
    })
  })

  describe('edge cases', () => {
    it('should handle undefined reasoning level by falling back to none', () => {
      const assistantReturn = createUseAssistantReturn({
        assistant: createAssistant({ settings: { reasoning_effort: undefined } })
      })

      renderComponent({
        assistantId: 'assistant-1',
        useAssistantReturn: assistantReturn
      })

      // reasoning_effort 为 undefined 时回落到 'none'
      expect(getIconByTestId('mdi-lightbulb-off-outline')).toBeInTheDocument()
    })

    it('should still render the button for a model reported as non-reasoning', () => {
      renderComponent({
        isReasoningModel: false,
        reasoningEffort: 'none'
      })

      expect(getActionIconButton()).toBeInTheDocument()
      expect(getActionIconButton()).toHaveAttribute('aria-label', 'Reasoning Effort')
    })

    it('should render the off icon and inactive state when thinking is off', () => {
      renderComponent({
        reasoningEffort: 'none'
      })

      expect(getActionIconButton()).toHaveAttribute('aria-pressed', 'false')
      expect(getActionIconButton()).toHaveAttribute('data-active', 'false')
    })
  })
})

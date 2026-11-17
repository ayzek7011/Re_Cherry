/**
 * 行为测试：编辑已发送消息后"保存并发送"必须带上新增附件（2026-11-16 修复）。
 *
 * 原缺陷：Message.tsx 传给 resendUserMessageWithEdit 的 message 是渲染期闭包
 * prop——编辑器新增的附件块（新 uuid）已随 editMessageBlocks 提交进 store，但
 * 闭包对象上没有这些块。修复前 startBranchResend 按旧闭包收附件 → 分支重发的
 * 消息丢失新增附件；先点保存再重新生成因 regenerateAssistantMessage 从 store
 * 重读锚点而幸免。修复后 startBranchResend 从 store 单点重读锚点实体，文本与
 * 附件都以 store 为准。
 *
 * 两个用例：
 * 1. 闭包 prop 无附件块、store 实体有 → getUserMessage 收到的 files 含新附件。
 * 2. fork 失败回退原地重发 → 必须给用户可见信号（toast.warning），不能静默。
 */
import type { newMessagesActions as RealNewMessagesActions } from '@renderer/store/newMessage'
import type { Assistant, FileMetadata } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const topicId = 'topic-1'
const dispatchSpy = vi.fn()
const toastWarning = vi.fn()
const forkBranchToKernelMock = vi.fn()
const getUserMessageMock = vi.fn()
const loadTopicMessagesThunkMock = vi.fn(() => ({ type: 'test/loadTopicMessages' }))
const sendMessageThunkMock = vi.fn(() => ({ type: 'test/sendMessage' }))
const resendUserMessageWithEditThunkMock = vi.fn(() => ({ type: 'test/resendUserMessageWithEditThunk' }))
const removeBlocksThunkMock = vi.fn(() => ({ type: 'test/removeBlocks' }))

// 可变测试态：模拟 editMessageBlocks 提交前后的 store
const messageEntities: Record<string, Message> = {}
const blockEntities: Record<string, MessageBlock> = {}
const state = {
  messages: { entities: messageEntities, loadingByTopic: {}, displayCount: 30 },
  messageBlocks: { entities: blockEntities },
  runtime: {},
  assistants: { assistants: [] }
}

vi.mock('@renderer/store', () => {
  const store = {
    getState: () => state,
    dispatch: (action: unknown) => dispatchSpy(action)
  }
  return {
    default: store,
    useAppDispatch: () => (action: unknown) => dispatchSpy(action),
    useAppSelector: (selector: (s: unknown) => unknown) => selector(store.getState())
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))

vi.mock('@renderer/store/newMessage', async (importActual) => {
  const actual = (await importActual()) as { newMessagesActions: typeof RealNewMessagesActions }
  return {
    ...actual,
    newMessagesActions: {
      ...actual.newMessagesActions,
      setTopicLoading: (payload: { topicId: string; loading: boolean }) => ({
        type: 'test/setTopicLoading',
        payload
      })
    }
  }
})

vi.mock('@renderer/services/SpanManagerService', () => ({
  appendMessageTrace: vi.fn(),
  pauseTrace: vi.fn(),
  restartTrace: vi.fn()
}))

vi.mock('@renderer/services/kernelChat', () => ({
  cancelActiveTurn: vi.fn(),
  destroyTurnsInKernel: vi.fn(),
  forkBranchToKernel: (...args: unknown[]) => forkBranchToKernelMock(...args),
  kernelAnchorOf: vi.fn(),
  loadKernelTopicMessages: vi.fn()
}))

vi.mock('@renderer/services/MessagesService', () => ({
  getUserMessage: (...args: unknown[]) => getUserMessageMock(...args)
}))
vi.mock('@renderer/services/TokenService', () => ({ estimateUserPromptUsage: vi.fn() }))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  appendAssistantResponseThunk: vi.fn(),
  loadTopicMessagesThunk: () => loadTopicMessagesThunkMock(),
  regenerateAssistantResponseThunk: vi.fn(),
  removeBlocksThunk: () => removeBlocksThunkMock(),
  resendMessageThunk: vi.fn(),
  resendUserMessageWithEditThunk: () => resendUserMessageWithEditThunkMock(),
  sendMessage: () => sendMessageThunkMock(),
  // 模拟真实 thunk：把块提交进 store（editMessageBlocks 的提交动作）
  updateMessageAndBlocksThunk: vi.fn(
    (_topicId: string, messageUpdates: { id: string; blocks?: string[] }, blocks: MessageBlock[]) => {
      for (const block of blocks ?? []) {
        blockEntities[block.id] = block
      }
      const message = messageEntities[messageUpdates.id]
      if (message && messageUpdates.blocks) {
        message.blocks = [...messageUpdates.blocks]
      }
      return { type: 'test/updateMessageAndBlocks' }
    }
  )
}))

vi.mock('../useTopic', () => ({ TopicManager: { removeTopic: vi.fn(), clearTopicMessages: vi.fn() } }))

import { useMessageOperations } from '../useMessageOperations'

const topic = { id: topicId, name: 't', assistantId: 'a' } as never
const assistant = { id: 'a1' } as Assistant
const imageFile = { id: 'file-img', name: 'shot.png', ext: '.png', size: 3, count: 1 } as unknown as FileMetadata

/** 构造渲染期闭包持有的旧 message prop：只有文本块，没有编辑器新增的图片块。 */
const staleMessage = {
  id: 'msg-1',
  role: 'user',
  topicId,
  blocks: ['blk-text'],
  content: '原始问题'
} as unknown as Message

/** 编辑器返回的完整块列表：原文本块（改了文案）+ 新增图片块。 */
const editedBlocks = [
  {
    id: 'blk-text',
    type: MessageBlockType.MAIN_TEXT,
    content: '编辑后的问题'
  },
  {
    id: 'blk-img-new',
    type: MessageBlockType.IMAGE,
    file: imageFile
  }
] as unknown as MessageBlock[]

beforeEach(() => {
  // 初始 store：锚点实体只有文本块（编辑提交前的状态）
  messageEntities['msg-1'] = {
    id: 'msg-1',
    role: 'user',
    topicId,
    blocks: ['blk-text'],
    content: '原始问题'
  } as unknown as Message
  blockEntities['blk-text'] = {
    id: 'blk-text',
    type: MessageBlockType.MAIN_TEXT,
    content: '原始问题'
  } as unknown as MessageBlock
  delete blockEntities['blk-img-new']

  dispatchSpy.mockReset()
  toastWarning.mockReset()
  forkBranchToKernelMock.mockReset()
  getUserMessageMock.mockReset()
  loadTopicMessagesThunkMock.mockClear()
  sendMessageThunkMock.mockClear()
  resendUserMessageWithEditThunkMock.mockClear()
  removeBlocksThunkMock.mockClear()
  ;(window as unknown as { api: unknown; toast: unknown }).api = {}
  ;(window as unknown as { toast: unknown }).toast = {
    warning: toastWarning,
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn()
  }
})

describe('useMessageOperations.resendUserMessageWithEdit（编辑已发送消息）', () => {
  it('新增附件只存在于 store 实体（闭包 prop 没有）时，分支重发必须带上该附件', async () => {
    forkBranchToKernelMock.mockResolvedValue({
      id: 'child-1',
      createdAt: '2026-11-16T00:00:00.000Z',
      updatedAt: '2026-11-16T00:00:00.000Z'
    })
    getUserMessageMock.mockReturnValue({ message: { id: 'user-new' }, blocks: [] })

    const { result } = renderHook(() => useMessageOperations(topic))
    await result.current.resendUserMessageWithEdit(staleMessage, editedBlocks, assistant)

    // fork 用锚点 id（闭包与 store 一致）
    expect(forkBranchToKernelMock).toHaveBeenCalledWith(topicId, expect.objectContaining({ id: 'msg-1' }))
    // 核心断言：getUserMessage 收到的 files 含新增图片（修复前 files=[]）
    expect(getUserMessageMock).toHaveBeenCalledTimes(1)
    const call = getUserMessageMock.mock.calls[0][0] as { content: string; files: FileMetadata[] }
    expect(call.content).toBe('编辑后的问题')
    expect(call.files).toEqual([imageFile])
    // 流程走到发送
    expect(sendMessageThunkMock).toHaveBeenCalled()
  })

  it('fork 失败回退原地重发时，必须给用户可见信号（不静默）', async () => {
    forkBranchToKernelMock.mockResolvedValue(null)

    const { result } = renderHook(() => useMessageOperations(topic))
    await result.current.resendUserMessageWithEdit(staleMessage, editedBlocks, assistant)

    expect(toastWarning).toHaveBeenCalledWith('message.edit.branch_fallback')
    // 回退 thunk 已被派发
    expect(dispatchSpy).toHaveBeenCalledWith({ type: 'test/resendUserMessageWithEditThunk' })
    // 分支路径未继续：不发送、不建子话题消息
    expect(sendMessageThunkMock).not.toHaveBeenCalled()
    expect(getUserMessageMock).not.toHaveBeenCalled()
  })
})

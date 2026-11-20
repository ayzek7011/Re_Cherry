import { FILE_TYPE, type FileMetadata } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * TokenService 估算口径。
 *
 * 钉三件事：
 *   ① `estimateUserPromptUsage` 的 `completion_tokens` 恒为 0、`total_tokens = prompt + 图片`，
 *      对极小图片也不得小于 prompt（旧实现 `imageTokens - 7` 会把它压成负数）；
 *   ② 同一个口径作用在 `estimateMessageUsage` 上（两处曾是逐字重复的坏实现）；
 *   ③ `estimateHistoryTokens` 不再逐条累加窗口内每条 usage 的 `total_tokens`——
 *      那是"该条发出时的累积量"，相加等于把历史长度重复计入。
 *
 * 为了让数值断言与 tokenizer 实现无关，这里把 `tokenx` 的 `approximateTokenSize`
 * 桩成"字符数"，消息文本由 `find` 模块的桩按 id 从表里给。
 */

/** id → 主文本。`find` 模块的桩从这里取内容。 */
let textOf: Record<string, string> = {}
let filesOf: FileMetadata[] = []

vi.mock('tokenx', () => ({
  approximateTokenSize: (text: string) => text.length
}))

vi.mock('@renderer/utils/messageUtils/find', () => ({
  getMainTextContent: (message: { id?: string }) => textOf[message?.id ?? ''] ?? '',
  getThinkingContent: () => undefined,
  findFileBlocks: () => filesOf.map((file) => ({ file }))
}))

vi.mock('@renderer/services/MessagesService', () => ({
  filterMessages: (messages: Message[]) => messages,
  filterAfterContextClearMessages: (messages: Message[]) => messages
}))

import { estimateHistoryTokens, estimateMessageUsage, estimateUserPromptUsage } from '../TokenService'

const assistant = { id: 'a1', prompt: '12345678' } as never

function message(id: string, usage?: Message['usage'], role: Message['role'] = 'user'): Message {
  return { id, role, blocks: [], usage } as unknown as Message
}

function imageFile(size: number): FileMetadata {
  return {
    id: `img-${size}`,
    name: 'i.png',
    origin_name: 'i.png',
    ext: '.png',
    type: FILE_TYPE.IMAGE,
    size
  } as FileMetadata
}

beforeEach(() => {
  textOf = {}
  filesOf = []
})

describe('estimateUserPromptUsage', () => {
  it('completion_tokens = 0，total = 正文 + 图片估算（不再翻倍）', async () => {
    const usage = await estimateUserPromptUsage({ content: 'hello', files: [imageFile(500)] })

    expect(usage.prompt_tokens).toBe(5)
    expect(usage.completion_tokens).toBe(0)
    // 旧实现 total = prompt + (imageTokens - 7) = 5 + (5 - 7) = 3，小于 prompt。
    expect(usage.total_tokens).toBe(10)
  })

  it('极小图片：total 不为负，且恒等于 prompt + 图片估算', async () => {
    // 200 字节 → 2 图片 token；旧实现 total = 5 + (2 - 7) = 0，小于 prompt。
    const usage = await estimateUserPromptUsage({ content: 'hello', files: [imageFile(200)] })

    expect(usage.prompt_tokens).toBe(5)
    expect(usage.total_tokens).toBe(7)
    expect(usage.total_tokens).toBeGreaterThanOrEqual(usage.prompt_tokens)
  })

  it('无正文无文件：三项均为 0', async () => {
    const usage = await estimateUserPromptUsage({})

    expect(usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
  })
})

describe('estimateMessageUsage', () => {
  it('同一口径：completion_tokens = 0，total = 正文 + 图片', async () => {
    textOf = { m1: 'hello' }
    filesOf = [imageFile(500)]

    const usage = await estimateMessageUsage(message('m1'))

    expect(usage.prompt_tokens).toBe(5)
    expect(usage.completion_tokens).toBe(0)
    expect(usage.total_tokens).toBe(10)
  })
})

describe('estimateHistoryTokens', () => {
  it('有测量基线：用基线 prompt_tokens + 其后消息的本地增量，不重复累加历史', async () => {
    textOf = { m2: 'assistantmsg', m3: 'seconduserquestion' }
    const messages = [
      message('m1', { prompt_tokens: 100, completion_tokens: 0, total_tokens: 210 } as Message['usage'], 'user'),
      message('m2', { prompt_tokens: 210, completion_tokens: 14, total_tokens: 224 } as Message['usage'], 'assistant'),
      message('m3', undefined, 'user')
    ]

    const total = await estimateHistoryTokens(assistant, messages)

    // 100（基线：真实测量值）+ 12（'assistantmsg'）+ 1（拼接分隔符）+ 18（'seconduserquestion'）
    expect(total).toBe(131)
    // 旧实现按 role 取字段（user→total_tokens / assistant→completion_tokens）：
    //   210 + 14 + 0 = 224，把"走到 m1 为止的历史"又算了一遍。新值必须严格更小。
    expect(total).toBeLessThan(224)
  })

  it('窗口内无 usage：纯本地估算 = assistant.prompt + 全部消息文本（分隔符按旧实现计入）', async () => {
    textOf = { m1: 'aaaa', m2: 'bbbb', m3: 'cccc', m4: 'dddd' }
    const messages = [message('m1'), message('m2'), message('m3'), message('m4')]

    // '12345678' + '\n' + 'aaaa\nbbbb\ncccc\ndddd' = 8 + 1 + 19
    expect(await estimateHistoryTokens(assistant, messages)).toBe(28)
  })

  it('基线之前的消息不进增量（它们已含在基线测量里）', async () => {
    textOf = { m1: 'ignored-prefix-text', m2: 'baseline', m3: 'tail' }
    const messages = [
      message('m1', undefined, 'user'),
      message('m2', { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 } as Message['usage'], 'user'),
      message('m3', undefined, 'user')
    ]

    // 只有 m3 计入增量：100 + 4（'tail'）。m1 的 19 个字符被完全忽略。
    expect(await estimateHistoryTokens(assistant, messages)).toBe(104)
  })

  it('确定性：同一输入两次调用同值', async () => {
    textOf = { m2: 'tail' }
    const messages = [
      message('m1', { prompt_tokens: 42, completion_tokens: 0, total_tokens: 42 } as Message['usage'], 'user'),
      message('m2', undefined, 'assistant')
    ]

    const first = await estimateHistoryTokens(assistant, messages)
    const second = await estimateHistoryTokens(assistant, messages)

    expect(first).toBe(42 + 4)
    expect(second).toBe(first)
  })
})

/**
 * code_cli 配置读写通道的入参契约。
 *
 * 这一件守的是一个**真机才炸**的形状错配：渲染层按 V2 形状发 `{ targets: [...] }`，主进程却把
 * 首个入参当裸数组断言——类型检查、静态检查、全部单测都绿，只有运行时抛
 *   `Invalid code_cli.read_config input: targets must be an array`
 * 而调用方（useCurrentCliConfigConnection）把这个错误 catch 成"连接态 = null"，于是页面看起来
 * 只是"没识别出当前连接的供应商"，没有别的症状。
 *
 * 所以这里两侧都钉住：正确形状必须通过；**另一种**形状必须按名失败（同时接受两种形状等于让
 * "发错了"永远不被发现）。
 */
import { describe, expect, it } from 'vitest'

import {
  CLI_CONFIG_CONTENT_LIMIT,
  parseCliConfigReadInput,
  parseCliConfigWriteInput,
  parseDeepSeekHarnessStartInput
} from '../configPayload'

describe('parseCliConfigReadInput', () => {
  it('accepts the route payload shape the renderer sends', () => {
    expect(parseCliConfigReadInput({ targets: ['hermes-config', 'hermes-env'] })).toEqual([
      'hermes-config',
      'hermes-env'
    ])
  })

  it('deduplicates while keeping first-seen order', () => {
    expect(parseCliConfigReadInput({ targets: ['hermes-env', 'hermes-config', 'hermes-env'] })).toEqual([
      'hermes-env',
      'hermes-config'
    ])
  })

  it('accepts an empty target list (the caller short-circuits before the IPC, but the contract allows it)', () => {
    expect(parseCliConfigReadInput({ targets: [] })).toEqual([])
  })

  it('rejects a bare array — that is a different contract, and silently accepting both hides the mistake', () => {
    expect(() => parseCliConfigReadInput(['hermes-config'])).toThrow(/expected \{ targets: \[\.\.\.\] \}/)
  })

  it('rejects a missing or non-array targets field', () => {
    expect(() => parseCliConfigReadInput({})).toThrow(/targets must be an array/)
    expect(() => parseCliConfigReadInput({ targets: 'hermes-config' })).toThrow(/targets must be an array/)
    expect(() => parseCliConfigReadInput(null)).toThrow(/expected \{ targets/)
  })

  it('rejects a target outside the whitelist', () => {
    expect(() => parseCliConfigReadInput({ targets: ['config.yaml'] })).toThrow(/Invalid config target/)
    expect(() => parseCliConfigReadInput({ targets: ['hermes-config', 7] })).toThrow(/Invalid config target/)
  })
})

describe('parseCliConfigWriteInput', () => {
  const files = [{ target: 'hermes-config', content: 'model: x\n' }]

  it('accepts the write payload shape', () => {
    expect(parseCliConfigWriteInput({ cliTool: 'hermes', files })).toEqual({ cliTool: 'hermes', files })
  })

  it('rejects a tool that is not file-configured', () => {
    expect(() => parseCliConfigWriteInput({ cliTool: 'dsh', files })).toThrow(/Invalid cliTool/)
    expect(() => parseCliConfigWriteInput({ cliTool: undefined, files })).toThrow(/Invalid cliTool/)
  })

  it('rejects an empty or missing file list', () => {
    expect(() => parseCliConfigWriteInput({ cliTool: 'hermes', files: [] })).toThrow(/non-empty array/)
    expect(() => parseCliConfigWriteInput({ cliTool: 'hermes' })).toThrow(/non-empty array/)
  })

  it('rejects an unknown target and a malformed entry', () => {
    expect(() => parseCliConfigWriteInput({ cliTool: 'hermes', files: [{ target: 'nope', content: '' }] })).toThrow(
      /Invalid config target/
    )
    expect(() => parseCliConfigWriteInput({ cliTool: 'hermes', files: ['hermes-config'] })).toThrow(
      /Invalid config file entry/
    )
  })

  it('rejects non-string and oversized content', () => {
    expect(() =>
      parseCliConfigWriteInput({ cliTool: 'hermes', files: [{ target: 'hermes-env', content: 7 }] })
    ).toThrow(/Invalid config content/)
    expect(() =>
      parseCliConfigWriteInput({
        cliTool: 'hermes',
        files: [{ target: 'hermes-env', content: 'x'.repeat(CLI_CONFIG_CONTENT_LIMIT + 1) }]
      })
    ).toThrow(/Invalid config content/)
  })
})

describe('parseDeepSeekHarnessStartInput', () => {
  const valid = {
    mode: 'direct',
    uniqueModelId: 'deepseek::deepseek-chat',
    agentPreset: 'code',
    permissionMode: 'workspace-write'
  }

  it('accepts the payload the renderer sends and normalizes settings', () => {
    expect(parseDeepSeekHarnessStartInput(valid)).toEqual({
      mode: 'direct',
      uniqueModelId: 'deepseek::deepseek-chat',
      agentPreset: 'code',
      permissionMode: 'workspace-write'
    })
  })

  it('fills unknown or missing settings with the defaults instead of passing them through', () => {
    expect(parseDeepSeekHarnessStartInput({ mode: 'gateway', uniqueModelId: 'p::m' })).toEqual({
      mode: 'gateway',
      uniqueModelId: 'p::m',
      agentPreset: 'inherit',
      permissionMode: 'workspace-write'
    })
    expect(parseDeepSeekHarnessStartInput({ ...valid, agentPreset: 'not-a-preset', permissionMode: 42 })).toMatchObject(
      { agentPreset: 'inherit', permissionMode: 'workspace-write' }
    )
  })

  it('accepts a model id that itself contains single colons', () => {
    expect(parseDeepSeekHarnessStartInput({ mode: 'gateway', uniqueModelId: 'p::openai:gpt-4o' })).toMatchObject({
      uniqueModelId: 'p::openai:gpt-4o'
    })
  })

  it('rejects a non-object payload', () => {
    expect(() => parseDeepSeekHarnessStartInput(null)).toThrow(/expected an object/)
    expect(() => parseDeepSeekHarnessStartInput('direct')).toThrow(/expected an object/)
  })

  it('rejects a mode outside the direct/gateway pair (an unknown mode silently routed as direct before)', () => {
    expect(() => parseDeepSeekHarnessStartInput({ ...valid, mode: 'any' })).toThrow(/mode must be/)
    expect(() => parseDeepSeekHarnessStartInput({ ...valid, mode: undefined })).toThrow(/mode must be/)
  })

  it('rejects a uniqueModelId without the :: separator (parseUniqueModelId would slice out garbage)', () => {
    expect(() => parseDeepSeekHarnessStartInput({ ...valid, uniqueModelId: 'deepseek-chat' })).toThrow(
      /uniqueModelId must be/
    )
    expect(() => parseDeepSeekHarnessStartInput({ ...valid, uniqueModelId: 7 })).toThrow(/uniqueModelId must be/)
  })
})

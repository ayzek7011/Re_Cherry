// fork 缝：npm `bin` 入口解析的单测。
//
// 覆盖的正是"装完了但起不来"那条链的第一环：shim 存在 ≠ 能用，入口文件必须也能解析出来、
// 且核验能指出具体缺谁。异常 manifest（缺 bin / 路径逃逸 / JSON 损坏）必须返回 undefined，
// 绝不按猜出来的路径做判断。

import { describe, expect, it } from 'vitest'

import { parseBinTarget, resolveNpmBinTarget } from '../packageBin'

const DIR = 'C:\\CodeMate\\tools\\dsh\\node_modules\\@deepseek-ai\\dsh'

describe('parseBinTarget', () => {
  it('resolves the standard object form for the requested command', () => {
    const manifest = JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: './lib/bin.js' } })
    expect(parseBinTarget(DIR, 'dsh', manifest)).toBe(`${DIR}\\lib\\bin.js`)
  })

  it('picks the requested key rather than the first one', () => {
    const manifest = JSON.stringify({ bin: { dsh: 'lib/bin.js', 'dsh-acp': 'lib/acp.js' } })
    expect(parseBinTarget(DIR, 'dsh-acp', manifest)).toBe(`${DIR}\\lib\\acp.js`)
  })

  it('accepts the string shorthand and navigates nested relative paths', () => {
    expect(parseBinTarget(DIR, 'dsh', JSON.stringify({ bin: 'dist/cli/index.js' }))).toBe(`${DIR}\\dist\\cli\\index.js`)
  })

  it('normalizes forward slashes so the result is a native-path check target', () => {
    expect(parseBinTarget(DIR, 'dsh', JSON.stringify({ bin: { dsh: 'lib/bin.js' } }))).toBe(`${DIR}\\lib\\bin.js`)
  })

  it('returns undefined when the command is not declared', () => {
    expect(parseBinTarget(DIR, 'hermes', JSON.stringify({ bin: { dsh: 'lib/bin.js' } }))).toBeUndefined()
  })

  it('returns undefined when there is no bin field at all', () => {
    expect(parseBinTarget(DIR, 'dsh', JSON.stringify({ name: 'dsh' }))).toBeUndefined()
  })

  it('returns undefined for a corrupted manifest instead of throwing', () => {
    expect(parseBinTarget(DIR, 'dsh', '{ not json')).toBeUndefined()
  })

  it('refuses a declaration that escapes the package directory', () => {
    expect(parseBinTarget(DIR, 'dsh', JSON.stringify({ bin: { dsh: '../../../evil.js' } }))).toBeUndefined()
    expect(parseBinTarget(DIR, 'dsh', JSON.stringify({ bin: { dsh: 'lib/../../evil.js' } }))).toBeUndefined()
  })

  it('rejects a sibling directory whose name only shares the prefix', () => {
    expect(parseBinTarget(DIR, 'dsh', JSON.stringify({ bin: { dsh: '../../../dsh-evil/cli.js' } }))).toBeUndefined()
  })

  it('ignores non-string entries in the bin map', () => {
    expect(parseBinTarget(DIR, 'dsh', JSON.stringify({ bin: { dsh: 42 } }))).toBeUndefined()
  })
})

describe('resolveNpmBinTarget', () => {
  it('reads the package.json next to the package directory', async () => {
    const seen: string[] = []
    const io = {
      readFile: async (filePath: string) => {
        seen.push(filePath)
        return JSON.stringify({ bin: { dsh: './lib/bin.js' } })
      }
    }
    await expect(resolveNpmBinTarget(io, DIR, 'dsh', '\\')).resolves.toBe(`${DIR}\\lib\\bin.js`)
    expect(seen).toEqual([`${DIR}\\package.json`])
  })

  it('treats an unreadable manifest as "nothing to verify" rather than a failure', async () => {
    const io = {
      readFile: async () => {
        throw new Error('ENOENT')
      }
    }
    await expect(resolveNpmBinTarget(io, DIR, 'dsh', '\\')).resolves.toBeUndefined()
  })
})

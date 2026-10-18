/**
 * 编码助手数据重置契约。
 *
 * 语义见 resetHarnessData.ts 头注：home 缺失 = nothing to reset；保留会话 = sessions
 * 先改名叫到 home 兄弟暂存位、删完搬回；删除失败 = 尽力搬回并上抛。路径全部由调用方
 * 派生，本件不触 node:fs/node:path（main 测试环境 mock 了它们），用 FakeIo 驱动。
 */
import { describe, expect, it } from 'vitest'

import { resetHarnessData } from '../resetHarnessData'

class FakeIo {
  readonly dirs = new Set<string>()
  readonly ops: Array<{ op: string; path: string; to?: string }> = []
  /** removeDir 对这些路径抛错（模拟删除失败）。 */
  readonly failRemove = new Set<string>()

  joinPath = (...parts: string[]): string => parts.join('/')
  parentDir = (file: string): string => file.split('/').slice(0, -1).join('/')
  exists = async (path: string): Promise<boolean> => this.dirs.has(path)
  removeDir = async (path: string): Promise<void> => {
    if (this.failRemove.has(path)) throw new Error('EPERM (simulated)')
    this.ops.push({ op: 'rm', path })
    for (const dir of [...this.dirs]) if (dir === path || dir.startsWith(`${path}/`)) this.dirs.delete(dir)
  }
  ensureDir = async (path: string): Promise<void> => {
    this.dirs.add(path)
  }
  rename = async (from: string, to: string): Promise<void> => {
    if (!this.dirs.has(from)) throw new Error(`ENOENT (rename): ${from}`)
    // 真实 fs 的 rename 会整树搬——假件也要重映射全部子孙条目，否则删除阶段会把
    // 假件里留在旧路径的子目录一并清掉，制造出生产代码没有的假失败。
    const moved = [...this.dirs].filter((dir) => dir === from || dir.startsWith(`${from}/`))
    for (const dir of moved) {
      this.dirs.delete(dir)
      this.dirs.add(dir === from ? to : `${to}${dir.slice(from.length)}`)
    }
    this.ops.push({ op: 'mv', path: from, to })
  }
}

function seed(io: FakeIo): void {
  const home = 'data/CodeMate/home/dsh'
  io.dirs.add('data/CodeMate/home')
  io.dirs.add(home)
  io.dirs.add(`${home}/sessions`)
  io.dirs.add(`${home}/sessions/--E-Workspace-Re_Cherry--`)
  io.dirs.add(`${home}/profiles`)
  io.dirs.add(`${home}/logs`)
}

const HOME = 'data/CodeMate/home/dsh'

describe('resetHarnessData', () => {
  it('home 不存在：nothing to reset，成功且零操作', async () => {
    const io = new FakeIo()
    await expect(resetHarnessData(HOME, true, io)).resolves.toBe(true)
    expect(io.ops).toEqual([])
  })

  it('不保留会话：home 整树删除', async () => {
    const io = new FakeIo()
    seed(io)
    await expect(resetHarnessData(HOME, false, io)).resolves.toBe(true)
    expect(io.dirs.has(HOME)).toBe(false)
    expect(io.ops.filter((op) => op.op === 'mv')).toEqual([])
  })

  it('保留会话：sessions 先出树、home 删除、原位搬回', async () => {
    const io = new FakeIo()
    seed(io)
    await expect(resetHarnessData(HOME, true, io)).resolves.toBe(true)
    expect(io.dirs.has(HOME)).toBe(true)
    expect(io.dirs.has(`${HOME}/sessions`)).toBe(true)
    expect(io.dirs.has(`${HOME}/sessions/--E-Workspace-Re_Cherry--`)).toBe(true)
    expect(io.dirs.has(`${HOME}/profiles`)).toBe(false)
    expect(io.dirs.has(`${HOME}/logs`)).toBe(false)
    const stashOp = io.ops.find((op) => op.op === 'mv' && op.path === `${HOME}/sessions`)
    expect(stashOp?.to).toBe('data/CodeMate/home/dsh.reset-stash')
  })

  it('删除失败：会话搬回原位，错误上抛（不谎报成功）', async () => {
    const io = new FakeIo()
    seed(io)
    io.failRemove.add(HOME)
    await expect(resetHarnessData(HOME, true, io)).rejects.toThrow('EPERM (simulated)')
    expect(io.dirs.has(`${HOME}/sessions`)).toBe(true)
    expect(io.dirs.has('data/CodeMate/home/dsh.reset-stash')).toBe(false)
  })

  it('保留会话但 sessions 本就不存在：纯删除，不建暂存位', async () => {
    const io = new FakeIo()
    seed(io)
    io.dirs.delete(`${HOME}/sessions`)
    await expect(resetHarnessData(HOME, true, io)).resolves.toBe(true)
    expect(io.dirs.has(HOME)).toBe(false)
    expect(io.ops.filter((op) => op.op === 'mv')).toEqual([])
  })
})

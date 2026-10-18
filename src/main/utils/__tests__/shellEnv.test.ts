// 真机事故回归（受管 dsh 装好了却报"损坏或过时的安装"）：
// npm 的 bin shim（node_modules/.bin/dsh.cmd）自己不带 node，读 `%dp0%\node.exe` 不到就
// 回退到 **PATH 上的 `node`**。而探针子进程的 env 来自 getShellEnv()——它此前把
// getBinarySearchDirs() 实现为空数组，受管 node 运行时目录从未进过 PATH：
//   · 机器上另装了 node → shim 找到系统 node（版本还不一定对）→ 好安装照样通过；
//   · 干净机器（测试者机）→ 找不到 node → shim 直接失败 → 判成"损坏安装"。
// 本文件锁住修复后的行为：受管 node 目录必须出现在 shell env 的 PATH 里，且**置于最前、
// 排在 dsh 的 .bin 之前**（shim 的 `node` 必须解析到受管版本，而不是用户自装的旧 node）。

import fsp from 'node:fs/promises'
import path from 'node:path'

import type * as ElectronModule from 'electron'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// vi.mock 的工厂会被提升到 import 之前，故共享变量必须经 vi.hoisted 声明。
const { state } = vi.hoisted(() => ({ state: { root: '' } }))

// 把 Electron 的 userData 指向临时夹具：受管运行时根 = <fixture>/Data/CodeMate/runtime/node。
// setupFiles（tests/main.setup.ts）已 mock 过 electron，这里覆盖 getPath 以改根。
vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<typeof ElectronModule>()
  return {
    ...actual,
    app: {
      ...(actual as { app?: object }).app,
      getPath: vi.fn((key: string) => {
        if (key === 'userData') return state.root
        return path.join(state.root, 'unknown')
      })
    }
  }
})

// 测试池的 setup 别名把裸 `os` 指向浏览器 polyfill（没有 tmpdir），故临时目录只走进程环境。
const tempRoot = (): string => process.env.TEMP ?? process.env.TMP ?? '.'

beforeAll(async () => {
  state.root = await fsp.mkdtemp(path.join(tempRoot(), 'codemate-shellenv-'))
  const nodeRoot = path.join(state.root, 'Data', 'CodeMate', 'runtime', 'node')
  // 有标记 → 认作受管运行时。
  await fsp.mkdir(path.join(nodeRoot, '24.9.0'), { recursive: true })
  await fsp.writeFile(path.join(nodeRoot, '24.9.0', '.codemate-runtime-version'), '24.9.0\n', 'utf-8')
  // 无标记 → 半成品/异物目录，必须被忽略（否则会把一个缺 node.exe 的目录塞进 PATH）。
  await fsp.mkdir(path.join(nodeRoot, '9.9.9'), { recursive: true })
  // dsh 的 bin 目录（dshmarket provision 的 pnpm shim 落点）。
  await fsp.mkdir(path.join(state.root, 'Data', 'CodeMate', 'tools', 'dsh', 'node_modules', '.bin'), {
    recursive: true
  })
})

afterAll(async () => {
  await fsp.rm(state.root, { recursive: true, force: true }).catch(() => undefined)
})

describe('getShellEnv 的受管工具目录', () => {
  it('把受管 node 版本目录与 dsh 的 .bin 前置进 PATH，且 node 在最前', async () => {
    vi.resetModules()
    const { getShellEnv } = await import('@main/utils/shellEnv')
    const { managedNodeRuntimeRoot, managedToolBinDirs } = await import('@main/services/binaryManager/layout')

    // 预置进程 PATH，断言"前置"而不是"替换"（用户已有的项必须还在）。
    const originalPath = process.env.Path ?? process.env.PATH
    process.env.Path = `${originalPath ?? ''}${path.delimiter}C:\\somewhere-else-codemate-test`
    try {
      const env = await getShellEnv()
      const pathValue = env.PATH ?? ''
      const segments = pathValue.split(path.delimiter)
      const nodeDir = path.join(managedNodeRuntimeRoot(), '24.9.0')
      const toolsBin = managedToolBinDirs()[0]

      expect(pathValue).toContain(nodeDir)
      expect(pathValue).toContain(toolsBin)
      // 受管 node 必须排在最前（否则 PATH 上的旧 node 会被 .cmd shim 先捞到），.bin 紧随其后。
      expect(segments[0]).toBe(nodeDir)
      expect(segments[1]).toBe(toolsBin)
      expect(pathValue.indexOf(nodeDir)).toBeLessThan(pathValue.indexOf(toolsBin))
      // 前置语义：原有项仍在，且被排到受管目录之后。
      expect(pathValue).toContain('somewhere-else-codemate-test')
      expect(pathValue.indexOf('somewhere-else-codemate-test')).toBeGreaterThan(pathValue.indexOf(toolsBin))
      // 无标记目录不得进 PATH。
      expect(pathValue).not.toContain(path.join('node', '9.9.9'))
    } finally {
      if (originalPath === undefined) delete process.env.Path
      else process.env.Path = originalPath
    }
  })

  it('受管运行时根不存在时只前置 dsh 的 .bin，不抛错', async () => {
    const emptyRoot = await fsp.mkdtemp(path.join(tempRoot(), 'codemate-shellenv-empty-'))
    const previous = state.root
    state.root = emptyRoot
    try {
      vi.resetModules()
      const { getShellEnv } = await import('@main/utils/shellEnv')
      const { managedToolBinDirs, managedNodeRuntimeRoot } = await import('@main/services/binaryManager/layout')
      const env = await getShellEnv()
      const pathValue = env.PATH ?? ''
      expect(managedToolBinDirs()).toHaveLength(1)
      expect(pathValue).toContain(managedToolBinDirs()[0])
      expect(pathValue).not.toContain(managedNodeRuntimeRoot())
    } finally {
      state.root = previous
      await fsp.rm(emptyRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  // 真机时序回归：应用启动时受管 node 还没装 → 探针的 env 里没有 node（memo 记下空数组）
  // → 用户点安装、node 落地 → 必须能作废这份记忆，否则紧随的重探仍拿不到 node，
  // 首次安装照旧报"损坏或过时的安装"，非要重启应用才生效。
  it('作废记忆后，新落地的受管运行时会被下一次 getShellEnv 看到', async () => {
    const freshRoot = await fsp.mkdtemp(path.join(tempRoot(), 'codemate-shellenv-fresh-'))
    const previous = state.root
    state.root = freshRoot
    try {
      vi.resetModules()
      const { getShellEnv, invalidateManagedSearchDirs } = await import('@main/utils/shellEnv')
      const { managedNodeRuntimeRoot } = await import('@main/services/binaryManager/layout')
      const nodeDir = path.join(managedNodeRuntimeRoot(), '24.9.0')

      // ① 运行时还没装：能被记住的只有 dsh 的 .bin，没有 node 目录。
      const before = await getShellEnv()
      expect(before.PATH ?? '').not.toContain(nodeDir)

      // ② 受管 node 落地（模拟 ensureNodeRuntime 解压完成 + 写标记）。
      await fsp.mkdir(nodeDir, { recursive: true })
      await fsp.writeFile(path.join(nodeDir, '.codemate-runtime-version'), '24.9.0\n', 'utf-8')

      // ③ 不作废就仍然看不到（证明 memo 真的在生效，测试不是蒙对的）。
      const stale = await getShellEnv()
      expect(stale.PATH ?? '').not.toContain(nodeDir)

      // ④ 作废后必须看到，且排在最前。
      invalidateManagedSearchDirs()
      const refreshed = await getShellEnv()
      expect((refreshed.PATH ?? '').split(path.delimiter)[0]).toBe(nodeDir)
    } finally {
      state.root = previous
      await fsp.rm(freshRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})

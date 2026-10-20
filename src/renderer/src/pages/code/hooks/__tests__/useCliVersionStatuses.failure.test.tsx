/**
 * useCliVersionStatuses 的失败语义（行为级）。
 *
 * ① 快照读取失败**不得**渲染成"未安装"：耗尽式重试的旧实现会把 resolved 置 true 而
 *    statuses 保持空——装配点的 fallback 把它显示成可点击的「安装」（失败伪装成确定的
 *    空结果，且诱导重装）。现契约：失败时 resolved 保持 false（"检查中"骨架），封顶退避
 *    重试，成功即恢复。
 * ② latestVersions 查询失败 → 已应用工具 latestUnknown=true（版本卡抑制"已是最新"徽章
 *    ——查询失败与"没有更新"是两回事）；查询成功即清除。source 型（paper-agent）不标：
 *    其最新版本本来就不走这条通道。
 */
import { CodeCli } from '@shared/types/codeCli'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCliVersionStatuses } from '../useCliVersionStatuses'
import type { BinaryToolSnapshot } from '../../utils/binarySnapshot'

const APPLIED_DSH: BinaryToolSnapshot = {
  name: 'dsh',
  application: 'applied',
  availability: { source: 'managed', path: 'C:\\t\\dsh\\node_modules\\.bin\\dsh.cmd', version: '0.2.0' }
}

describe('useCliVersionStatuses（失败语义）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function installBinaryApi(impl: {
    snapshots: () => Promise<unknown>
    latestVersions?: () => Promise<unknown>
    onChanged?: (cb: () => void) => () => void
  }) {
    const onChanged = vi.fn(impl.onChanged ?? (() => () => undefined))
    ;(window as unknown as { api: unknown }).api = {
      codeCli: {
        binary: {
          snapshots: vi.fn(impl.snapshots),
          latestVersions: vi.fn(impl.latestVersions ?? (() => Promise.resolve({}))),
          onChanged
        }
      }
    }
    return onChanged
  }

  it('快照读取失败：resolved 保持 false（不冒充"未安装"），重试成功即恢复', async () => {
    let calls = 0
    installBinaryApi({
      snapshots: () => {
        calls += 1
        return calls === 1 ? Promise.reject(new Error('main busy')) : Promise.resolve({ dsh: APPLIED_DSH })
      },
      latestVersions: () => Promise.resolve({ dsh: '0.3.0' })
    })

    const { result } = renderHook(() => useCliVersionStatuses([CodeCli.DEEPSEEK_HARNESS]))
    await act(async () => {})
    expect(result.current.resolved).toBe(false)
    expect(result.current.statuses).toEqual({})

    // 封顶退避的重试（2s）成功 → resolved 落定、latest 注入。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    expect(result.current.resolved).toBe(true)
    expect(result.current.statuses[CodeCli.DEEPSEEK_HARNESS]?.installed).toBe(true)
    expect(result.current.statuses[CodeCli.DEEPSEEK_HARNESS]?.latest).toBe('0.3.0')
  })

  it('latestVersions 失败：已应用的注册表型工具标 latestUnknown；恢复后清除', async () => {
    let latestFail = true
    const fireChanged = installBinaryApi({
      snapshots: () => Promise.resolve({ dsh: APPLIED_DSH }),
      latestVersions: () => (latestFail ? Promise.reject(new Error('registry unreachable')) : Promise.resolve({ dsh: '0.3.0' }))
    })

    const { result } = renderHook(() => useCliVersionStatuses([CodeCli.DEEPSEEK_HARNESS]))
    await act(async () => {})
    expect(result.current.resolved).toBe(true)
    expect(result.current.statuses[CodeCli.DEEPSEEK_HARNESS]?.latestUnknown).toBe(true)

    // onChanged 触发全量重拉：查询恢复 → unknown 清除（标志只在失败时存在，成功即无键）。
    latestFail = false
    await act(async () => {
      fireChanged.mock.calls[0]?.[0]?.()
    })
    await act(async () => {})
    expect(result.current.statuses[CodeCli.DEEPSEEK_HARNESS]?.latestUnknown).toBeUndefined()
    expect(result.current.statuses[CodeCli.DEEPSEEK_HARNESS]?.latest).toBe('0.3.0')
  })
})

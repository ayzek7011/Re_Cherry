// fork 缝：能力探针的"失败原因"单测。
//
// 真机事故：探针把退出码、stderr、是不是超时全部丢弃，只留一行"失败了"——于是用户在 /code
// 面板上看到的是"它 failed to run (--version)，可能损坏或过时"这种**猜出来的**解释，真因
// （缺依赖 / shim 指向的入口文件不存在 / 冷启动没跑完）无人知晓。这里钉住"失败必须带原因"。
//
// 刻意只覆盖"根本起不来"这一条路径：那种情况**不需要真的执行任何程序**（spawn 阶段就失败），
// 因此测起来既确定又不依赖机器上装了什么。

import { describe, expect, it } from 'vitest'

import { probeBinary, probeBinaryDetailed } from '../resolveBinary'

const MISSING = 'C:\\no-such-dir-codemate-test\\definitely-missing-binary.exe'

describe('probeBinaryDetailed', () => {
  it('reports the spawn failure reason instead of swallowing it', async () => {
    const probe = await probeBinaryDetailed(MISSING, { timeout: 5000 })
    expect(probe.runnable).toBe(false)
    expect(probe.stdout).toBe('')
    expect(probe.detail).toBeTruthy()
    // ENOENT（或 Windows 上的等价措辞）必须出现在原因里——这就是日志与界面要展示的东西。
    expect((probe.detail ?? '').length).toBeGreaterThan(0)
  })

  it('keeps the reason on a single line so it survives redaction and log formatting', async () => {
    const probe = await probeBinaryDetailed(MISSING, { timeout: 5000 })
    expect(probe.detail ?? '').not.toMatch(/[\r\n]/)
  })
})

describe('probeBinary', () => {
  it('narrows to runnable/version only (callers that never show the reason)', async () => {
    const probe = await probeBinary(MISSING)
    expect(probe).toEqual({ runnable: false })
  })
})

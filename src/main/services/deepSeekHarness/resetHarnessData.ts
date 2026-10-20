// fork 缝：编码助手数据重置（2026-10-19）。应用内「重置编码助手」的核心动作：
// 停 harness 后删 Data\CodeMate\home\dsh（可选保留 sessions）。路径全部由调用方
// （DeepSeekHarnessService）从 paths.ts 派生，本件不触 node:fs/node:path（main 测试
// 环境 mock 了它们），文件操作经 HarnessResetIo 端口注入。
//
// 语义（§10 失败规则）：
// - home 不存在 → nothing to reset，按成功返回；
// - 保留会话 = 先把 sessions 改名到 home 的兄弟暂存位，删完再搬回；
// - 删除失败 → 尽力把暂存位搬回原位（home 半删状态保留），错误原样上抛，由调用方
//   包成 {success:false}；渲染层 toast.error；
// - 恢复也失败 → 两个错误一起上抛（AggregateError），stash 原样保留待查——那是用户
//   会话仅剩的一份拷贝，静默吞掉的话，下一次"有新会话"的重置会把它当残渣清掉；
// - 孤儿暂存位领养：上次重置失败遗留的 stash 在本轮开头先还原成 home/sessions，再按
//   本轮 keepSessions 语义正常走（false = 连同 home 一起删，补全上次未完成的全删意图；
//   true = 原位保留）。不领养的话 home 删完后 stash 成永久孤儿。
//
// 端口契约：removeDir 为递归强删（missing-ok）；ensureDir 为递归建；rename 不覆盖
// 已存在目标（暂存位名固定，先强删再改名保证幂等）。

export interface HarnessResetIo {
  joinPath(...parts: string[]): string
  parentDir(path: string): string
  exists(path: string): Promise<boolean>
  removeDir(path: string): Promise<void>
  ensureDir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}

const RESET_STASH_SUFFIX = '.reset-stash'

export async function resetHarnessData(home: string, keepSessions: boolean, io: HarnessResetIo): Promise<boolean> {
  const sessionsDir = io.joinPath(home, 'sessions')
  const stashDir = io.joinPath(io.parentDir(home), `dsh${RESET_STASH_SUFFIX}`)

  // 领养孤儿暂存位（在「home 不存在 → nothing to reset」早退**之前**：上次重置可能
  // 把 home 连根删掉、却在最后一步搬回失败）。领养 = 原样还原，交给下方正常流程。
  if ((await io.exists(stashDir)) && !(await io.exists(sessionsDir))) {
    await io.ensureDir(home)
    await io.rename(stashDir, sessionsDir)
  }

  if (!(await io.exists(home))) return true

  const sessionsExist = keepSessions && (await io.exists(sessionsDir))
  if (sessionsExist) {
    // 残 stash 先清（幂等）：上方领养已保证它不存在；这一支只兜"stash 与 sessions 并存"
    // 的手工状态。
    await io.removeDir(stashDir)
    await io.rename(sessionsDir, stashDir)
  }
  try {
    await io.removeDir(home)
  } catch (error) {
    if (sessionsExist) {
      await io.ensureDir(io.parentDir(home))
      try {
        await io.rename(stashDir, sessionsDir)
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          'Failed to reset the harness data and to restore the stashed sessions; they remain at the reset-stash location'
        )
      }
    }
    throw error
  }
  if (sessionsExist) {
    await io.ensureDir(home)
    await io.rename(stashDir, io.joinPath(home, 'sessions'))
  }
  return true
}

// fork 缝：编码助手数据重置（2026-10-19）。应用内「重置编码助手」的核心动作：
// 停 harness 后删 Data\CodeMate\home\dsh（可选保留 sessions）。路径全部由调用方
// （DeepSeekHarnessService）从 paths.ts 派生，本件不触 node:fs/node:path（main 测试
// 环境 mock 了它们），文件操作经 HarnessResetIo 端口注入。
//
// 语义（§10 失败规则）：
// - home 不存在 → nothing to reset，按成功返回；
// - 保留会话 = 先把 sessions 改名到 home 的兄弟暂存位，删完再搬回；
// - 删除失败 → 尽力把暂存位搬回原位（home 半删状态保留），错误原样上抛，由调用方
//   包成 {success:false}；渲染层 toast.error。
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
  if (!(await io.exists(home))) return true
  const sessionsDir = io.joinPath(home, 'sessions')
  const stashDir = io.joinPath(io.parentDir(home), `dsh${RESET_STASH_SUFFIX}`)
  const sessionsExist = keepSessions && (await io.exists(sessionsDir))
  if (sessionsExist) {
    // 残 stash 先清（幂等）：上次重置中途失败留下的同名暂存位不参与本轮。
    await io.removeDir(stashDir)
    await io.rename(sessionsDir, stashDir)
  }
  try {
    await io.removeDir(home)
  } catch (error) {
    if (sessionsExist && stashDir) {
      await io.ensureDir(io.parentDir(home))
      await io.rename(stashDir, sessionsDir).catch(() => undefined)
    }
    throw error
  }
  if (sessionsExist && stashDir) {
    await io.ensureDir(home)
    await io.rename(stashDir, io.joinPath(home, 'sessions'))
  }
  return true
}

// fork 缝（原创）：目录原子替换。
//
// 为什么要有这件：旧安装路径的形态是"**先删旧的，再去装新的**"——hermes 先 `fsp.rm(工具目录)`
// 再建 venv、paper-agent 先删源码树再解压、前端产物先删 dist 再复制。任何一步失败（网络、
// 磁盘、杀软锁文件）留下的都是残骸：可用安装没了，用户连回滚选项都没有。真机上表现为
// "升级失败后工具直接变成未安装/损坏"。
//
// 本件把顺序倒过来：**先把新的准备到 staging 目录，再一次性切换**。切换失败时把旧目录
// 放回原位，调用方拿到的失败是"升级没成功"，而不是"工具没了"。
//
// 与 `removeTree.ts` 同一套 Windows 纪律：目录改名会撞杀软扫描窗口（EPERM/EBUSY/EACCES
// 异步释放），故改名走退避重试；旧目录的删除是收尾动作，失败只留 `.old-*` 残渣、不影响
// 可用性。

import fsp from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'

import { removeTreeWithRetry } from './removeTree'

const logger = loggerService.withContext('AtomicSwap')

const RENAME_RETRY_MAX = 5

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

/** 目录改名；EPERM/EBUSY/EACCES 退避重试（杀软扫描窗口），其余错误立即上抛。 */
export async function renameWithRetry(source: string, target: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= RENAME_RETRY_MAX; attempt++) {
    try {
      await fsp.rename(source, target)
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error
      logger.warn(`rename attempt ${attempt}/${RENAME_RETRY_MAX} failed (${code}), retrying`, { source, target })
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * `buildInPlace` 的用途：新目录**必须在最终路径上生成**的场景。
 *
 * 为什么不能一律用 {@link replaceDirectory}：Python venv 的 launcher 与控制台脚本把 venv
 * 自身的绝对路径写死在文件里（Windows 的 `Scripts/*.exe`、POSIX 的 `#!` shebang），事后
 * 改名会把它们改坏——"先建在 staging 再改名"对 venv 是错的。
 *
 * 顺序：旧目录先改名让位（备份）→ 在最终路径上建新的 → 成功删备份；**任一步失败就把新
 * 目录清掉、把备份放回原位**，用户手上仍是一个能用的安装。
 */
export async function buildInPlace(targetDir: string, build: (dir: string) => Promise<void>): Promise<void> {
  await fsp.mkdir(path.dirname(targetDir), { recursive: true })
  const backupDir = `${targetDir}.old-${Date.now()}`
  const hadTarget = await pathExists(targetDir)
  if (hadTarget) await renameWithRetry(targetDir, backupDir)
  try {
    await build(targetDir)
  } catch (error) {
    const cleared = await removeTreeWithRetry(targetDir)
    if (hadTarget) {
      // 清理失败（残树仍被锁）时放回必撞 ENOTEMPTY——与其做注定失败的 rename 再把
      // "恢复成功"含糊掉，不如直接把两个事实都讲清楚：本次构建失败、旧安装完整保留
      // 在 .old-* 备份位，用户可手工取回或稍后重试（重试会再走一轮同样的交换）。
      if (!cleared) {
        throw new Error(
          `The build failed and the partial result at ${targetDir} could not be cleared (locked?). ` +
            `The previous installation is preserved at ${backupDir}; retry later or restore it manually.`
        )
      }
      try {
        await renameWithRetry(backupDir, targetDir)
      } catch (restoreError) {
        logger.warn(`failed to restore the previous directory after a failed build`, {
          targetDir,
          backupDir,
          error: restoreError instanceof Error ? restoreError.message : String(restoreError)
        })
      }
    }
    throw error
  }
  if (hadTarget) {
    const removed = await removeTreeWithRetry(backupDir)
    if (!removed) logger.warn(`the replaced directory could not be removed and was left behind`, { backupDir })
  }
}

/**
 * 用 `stagingDir` 替换 `targetDir`（staging 与 target 必须同盘——调用方一律把 staging 建在
 * 目标旁边，故改名恒可用）。
 *
 * @returns 替换是否完成。false 表示旧目录已放回原位、升级未生效（不抛，因为"旧安装仍在"
 * 是调用方要如实上报的正常结果）。
 */
export async function replaceDirectory(stagingDir: string, targetDir: string): Promise<boolean> {
  await fsp.mkdir(path.dirname(targetDir), { recursive: true })
  const backupDir = `${targetDir}.old-${Date.now()}`
  const hadTarget = await pathExists(targetDir)
  if (hadTarget) await renameWithRetry(targetDir, backupDir)
  try {
    await renameWithRetry(stagingDir, targetDir)
  } catch (error) {
    if (hadTarget) {
      // 切换失败 → 把旧目录放回去（这一步失败才是真的坏消息，如实记日志）。
      try {
        await renameWithRetry(backupDir, targetDir)
      } catch (restoreError) {
        logger.warn(`failed to restore the previous directory after a failed swap`, {
          targetDir,
          backupDir,
          error: restoreError instanceof Error ? restoreError.message : String(restoreError)
        })
      }
    }
    logger.warn(`directory swap failed`, {
      targetDir,
      error: error instanceof Error ? error.message : String(error)
    })
    return false
  }
  if (hadTarget) {
    // 收尾：删不掉只留 `.old-*` 残渣（下次安装/卸载会再扫到），不影响这次升级已生效。
    const removed = await removeTreeWithRetry(backupDir)
    if (!removed) logger.warn(`the replaced directory could not be removed and was left behind`, { backupDir })
  }
  return true
}

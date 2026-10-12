// fork 缝：受管 CLI 二进制解析（2026-09-24；升级；补能力探针）。
// 解析顺序：CodeMate 受管目录（tools/ 子树）→ 系统 PATH（where/which）。受管布局映射
// 起由 binaryManager/layout.ts 提供（与安装器、PaperAgentService 同一份；此前
// 本文件内联一份、靠注释与安装器"保持一致"，已漂移过一次）。依赖方向仍单向：
// resolveBinary → layout（叶子），BinaryManager → 本文件。
//
// 真机事故加固：的探测是"PATH 命中即可用"——不验能否运行、不验版本，系统 PATH
// 上的同名异物（旧版缺子命令、pipx 装的时候没带 [web] extras、损坏安装）照样被打上可用
// 标签放行启动，最后炸一句 "exited before it was ready"（V2 的对位语义是 availability
// 授权执行、application 授权变更；V2 探测含 realpath/归属/版本，fork 裁掉后无替代）。
// 现补 `--version` 能力探针：能跑且报出版本 → runnable:true + version；否则 runnable:false
// ——快照层标 broken，服务层启动前显式拒绝（不再靠子进程退出后的英文哑弹）。
// 二次真机事故：探针原用裸 execFile——Windows 上 .cmd/.bat 不经 shell 直接 spawn 是
// EINVAL（CVE-2024-27980 防护，Node 同步 throw），受管 dsh 恰好是 node_modules/.bin/dsh.cmd
// → 快照通道每 2s 炸一次。改用 V2 processRunner 的 executeCommand（内部 cross-spawn，
// .cmd 转发已处理）——用户裁决"复制 V2 现成代码，别手搓"。probeSystemPath 的 where/which
// 是真实 .exe，保留 execFile 无碍。

import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { isWin } from '@main/constant'
import { managedBinaryPathFor } from '@main/services/binaryManager/layout'
import { executeCommand } from '@main/utils/processRunner'

const logger = loggerService.withContext('ResolveBinary')

/** 能力探针的入参：所有通道（快照、启动、安装收尾核验）都探同一个东西，避免各处漂移。 */
const PROBE_ARGS: readonly string[] = ['--version']
/** 探针失败原因的长度上限（要进用户可见的报错与日志，过长会把真话淹掉）。 */
const PROBE_DETAIL_LIMIT = 200

export interface ResolvedBinary {
  source: 'system' | 'managed'
  path: string
  /** `--version` 探针输出首行（截断）；探针失败为 undefined。 */
  version?: string
  /** 二进制可运行（`--version` 退出码 0）。false ⇒ 快照层标 broken、启动层拒绝。 */
  runnable: boolean
  /**
   * 探针失败原因（超时 / 退出码 + stderr / 起不来），成功时为 undefined。
   *
   * 真机事故：这个字段原先不存在，探针只留一行日志——于是用户在 /code 面板上看到的
   * 是"它 failed to run (--version)，可能损坏或过时"这种**猜出来的**解释，日志里也只有
   * "失败了"四个字：退出码、stderr、是不是超时全被丢掉，真因（缺依赖 / .cmd shim 指向的
   * 入口文件不存在 / 5 秒冷启动没跑完）谁也不知道。探针失败必须连带"为什么"一起上报。
   */
  probeDetail?: string
}

/** 把多行 stderr 压成一行诊断尾巴（空白折叠 + 截断）。 */
function collapseDiagnostic(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= PROBE_DETAIL_LIMIT) return collapsed
  return `${collapsed.slice(0, PROBE_DETAIL_LIMIT - 1)}…`
}

/**
 * 把探针抛出的错误转成人能读的原因。executeCommand 的失败面共三类：超时
 * （`Command timed out after <n>ms`）、非零退出（stderr 原文，空则 `Command failed with
 * code <c>`）、根本起不来（spawn 的 ENOENT/EINVAL/EACCES 原文）。
 */
function describeProbeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/timed out after \d+ms/.test(message)) return message
  return collapseDiagnostic(message) || 'the probe produced no output'
}

/** 探针产物：runnable/version 如上，另带失败原因与命令原始输出（安装收尾核验要用后者定位）。 */
export interface BinaryProbeDetail {
  runnable: boolean
  version?: string
  /** `--version` 的 stdout（成功时才有内容）。 */
  stdout: string
  /** 失败原因（成功为 undefined）。 */
  detail?: string
}

export function probeSystemPath(executable: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const command = isWin ? 'where' : 'which'
    execFile(command, [executable], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(undefined)
      const firstLine = stdout.split(/\r?\n/, 1)[0]?.trim()
      resolve(firstLine || undefined)
    })
  })
}

/** `--version` 能力探针：能跑且非空输出 → {runnable:true, version}；否则 runnable:false。
 * 二次真机事故修复：原用裸 execFile（.cmd 直接 spawn EINVAL），换 V2 现成的
 * executeCommand（内部 cross-spawn 处理 .cmd 转发）。非零退出/超时 → 不能跑，原因一并返回
 * （见 BinaryProbeDetail 注释：吞掉原因会让用户和日志都只剩猜测）。 */
export async function probeBinaryDetailed(binPath: string, options?: { timeout?: number }): Promise<BinaryProbeDetail> {
  const timeout = options?.timeout ?? 5000
  try {
    const stdout = await executeCommand(binPath, [...PROBE_ARGS], { timeout })
    const firstLine = stdout.split(/\r?\n/, 1)[0]?.trim().slice(0, 80)
    return { runnable: true, ...(firstLine ? { version: firstLine } : {}), stdout }
  } catch (error) {
    const detail = describeProbeError(error)
    logger.info(`code-mate: probe --version failed for ${binPath}: ${detail}`)
    return { runnable: false, stdout: '', detail }
  }
}

/** 探针的收窄形态（快照/启动通道只关心 runnable 与 version）。 */
export async function probeBinary(binPath: string): Promise<{ runnable: boolean; version?: string }> {
  const probe = await probeBinaryDetailed(binPath)
  return { runnable: probe.runnable, ...(probe.version ? { version: probe.version } : {}) }
}

/** 受管布局映射（单点到 binaryManager/layout.ts——此前本文件内联一份并与
 * BinaryManager.managedBinaryPath 靠注释"保持一致"，已经漂移过一次：paper-agent 加进
 * 预设表后这里不认识它，任何走本解析器的通道都会把已安装的源码型工具判成未安装）。
 * 未知工具返回 undefined → 调用方回落系统 PATH。 */
function managedBinaryPath(executable: string): string | undefined {
  return managedBinaryPathFor(executable)
}

/** 解析受管 CLI 的可执行文件（受管优先，回退系统 PATH）；找不到返回 null（调用方给用户可见错误）。 */
export async function resolveBinary(executable: string): Promise<ResolvedBinary | null> {
  const managed = managedBinaryPath(executable)
  if (
    managed &&
    (await fsp.access(managed).then(
      () => true,
      () => false
    ))
  ) {
    // 受管件也过探针：装了但跑不起来（peer 缺失/损坏）不该被当成可启动。
    const probe = await probeBinaryDetailed(managed)
    if (!probe.runnable) {
      logger.warn(
        `code-mate: managed "${executable}" at ${managed} failed the --version probe: ${probe.detail ?? 'unknown'}`
      )
    }
    logger.info(`code-mate: "${executable}" resolved to managed ${managed}`)
    return {
      source: 'managed',
      path: managed,
      ...(probe.version ? { version: probe.version } : {}),
      runnable: probe.runnable,
      ...(probe.detail ? { probeDetail: probe.detail } : {})
    }
  }
  const found = await probeSystemPath(executable)
  if (!found) {
    logger.info(`code-mate: "${executable}" not found on PATH`)
    return null
  }
  // where.exe 在 Win 上可能返回带引号或多行结果；取首行并去引号。
  const normalized = found.replace(/^"(.*)"$/, '$1')
  const systemPath = path.isAbsolute(normalized) ? normalized : found
  const probe = await probeBinaryDetailed(systemPath)
  logger.info(`code-mate: "${executable}" resolved to ${systemPath}`, {
    ...(probe.version ? { version: probe.version } : {}),
    runnable: probe.runnable
  })
  return {
    source: 'system',
    path: systemPath,
    ...(probe.version ? { version: probe.version } : {}),
    runnable: probe.runnable,
    ...(probe.detail ? { probeDetail: probe.detail } : {})
  }
}

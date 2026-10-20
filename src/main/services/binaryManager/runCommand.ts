// fork 缝（原创）：受管子进程命令执行原语。
// 从 BinaryManager 的私有 runCommand 逐字抽出（两个调用方：安装器本身、市场基线通道），
// 语义不变：
// - crossPlatformSpawn（cross-spawn）负责 Windows .cmd 的 cmd.exe 转发与逐参引号；
// - stdout/stderr 各留尾部 OUTPUT_TAIL_LIMIT 字节——失败诊断要的是最后那几行（pnpm 的
//   ERR_PNPM_* 与"哪个包"总在末尾），不是开头的进度行；
// - 超时 kill 并如实上抛（kill 后 close 事件仍会到达，由 settled 守卫保证只结算一次）。

import { crossPlatformSpawn, killProcessTree } from '@main/utils/processRunner'

/** 单条受管命令的默认超时预算（安装是分钟级；市场基线的 pnpm 安装同量级）。 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60_000

const OUTPUT_TAIL_LIMIT = 16 * 1024

export interface BoundedCommandOptions {
  env: NodeJS.ProcessEnv
  /** 命令的人类可读标识——它出现在失败消息的第一行（用户可见）。 */
  label: string
  timeoutMs?: number
  cwd?: string
  /**
   * 逐行回调：给"只能从输出里读出进度"的阶段用（pip 的 `Collecting …` /
   * `Downloading … (1.2 MB)`）。收到的总是**完整行**（内部处理跨 chunk 拼接）。
   * 回调抛错不影响命令执行（进度是附属信息，不该拖垮安装）。
   */
  onOutputLine?: (line: string) => void
}

/** 执行一条受管命令；非 0 退出/启动失败/超时一律 reject（附尾部输出）。 */
export function runBoundedCommand(executable: string, args: string[], options: BoundedCommandOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const child = crossPlatformSpawn(executable, args, {
      env: options.env,
      ...(options.cwd ? { cwd: options.cwd } : {})
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    // 两条流各留自己的半行缓冲：共用一个的话，stdout 的半行会被 stderr 的整行粘成假行。
    const lineBuffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
    const emitLines = (stream: 'stdout' | 'stderr', text: string) => {
      if (!options.onOutputLine) return
      const lines = `${lineBuffers[stream]}${text}`.split(/\r?\n/)
      lineBuffers[stream] = lines.pop() ?? ''
      for (const line of lines) {
        try {
          options.onOutputLine(line)
        } catch {
          // 进度回调是附属信息：它出错不该影响命令本身，也不该刷屏（丢弃这一行即可）。
        }
      }
    }
    // 收尾补一行换行：最后一行没有换行符时（进程尾行）否则永远不会当作完整行上报。
    const flushLines = () => {
      emitLines('stdout', '\n')
      emitLines('stderr', '\n')
    }
    const settle = (finish: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      finish()
    }
    const appendTail = (current: string, chunk: Buffer) => `${current}${chunk.toString()}`.slice(-OUTPUT_TAIL_LIMIT)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendTail(stdout, chunk)
      emitLines('stdout', chunk.toString())
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendTail(stderr, chunk)
      emitLines('stderr', chunk.toString())
    })
    const timeout = setTimeout(() => {
      // 杀树而非 child.kill()：cross-spawn 的 .cmd 走 cmd.exe 包装层，只杀直接子进程
      // 会留下孤儿 node/pip 树继续持有文件锁（紧随的回滚/卸载撞占用）。与
      // processRunner.executeCommand 的同款修复一致。
      killProcessTree(child)
      settle(() => reject(new Error(`${options.label} timed out after ${timeoutMs}ms`)))
    }, timeoutMs)
    child.once('error', (error) => {
      settle(() => reject(new Error(`${options.label} failed to start: ${error.message}`)))
    })
    child.once('close', (code) => {
      flushLines()
      settle(() => {
        if (code === 0) return resolve(stdout)
        const output = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
        reject(new Error(`${options.label} exited with code ${code}${output ? `\n${output}` : ''}`))
      })
    })
  })
}

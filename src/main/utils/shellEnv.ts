import { loggerService } from '@logger'
// fork 缝：V2 平台常量位于 @main/core/platform，fork 等价物为 @main/constant。
import { isMac, isWin } from '@main/constant'
import { managedNodeRuntimeRoot, managedToolBinDirs } from '@main/services/binaryManager/layout'
import { spawn } from 'child_process'
// fork 缝：V2 的 @application 路径系统未移植；'sys.home' 在 V2 即 os.homedir()
// （见 V2 src/main/core/paths/pathRegistry.ts）。dedupePathSegments 缝实现也需要 path。
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'

// fork 缝：V2 的 ./binaryEnv（mise 受管二进制环境）与 ./bundledGit（内置 MinGit）未随 fork
// 移植，按其在 shellEnv.ts 的消费面内联最小等价实现：dedupePathSegments 为 V2
// binaryEnv.ts 原文逐字；fork 无 mise、无内置 git，受管二进制目录改为 CodeMate 受管
// node 运行时 + dsh 的 .bin（getBinarySearchDirs 见 resolveManagedSearchDirs）；
// mergeBinaryExecutionEnv / getBundledGitDir 仍为空实现。
// fork 缝：registry-js 未随 fork 安装（V2 依赖）。以 string 变量承载模块名，让 TS 不做
// 静态解析（fork tsconfig noImplicitAny:false 下 dynamic import 为 any）；运行时 import
// 失败仍走 readWindowsRegistryPath 原有 try/catch 回退，与 V2 失败路径一致。
const REGISTRY_JS_MODULE: string = 'registry-js'

const logger = loggerService.withContext('ShellEnv')

// ── fork 缝：binaryEnv/bundledGit 最小等价（说明见文件头）─────────────────────────

/**
 * Collapse a list of PATH segments to unique entries, first occurrence wins.
 * On Windows the compare is case-insensitive (the filesystem is), so `C:\Foo`
 * and `c:\foo` fold together; elsewhere it is case-sensitive. Blank segments
 * are dropped. Order is preserved — never sorted — because it is load-bearing
 * on Windows, where the shims dir must stay ahead of the system PATH.
 */
function dedupePathSegments(segments: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const segment of segments) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    const canonical = isWin ? path.normalize(trimmed).toLowerCase() : path.normalize(trimmed)
    if (seen.has(canonical)) continue
    seen.add(canonical)
    unique.push(trimmed)
  }
  return unique
}

/** fork 缝：V2 返回 mise shims 目录与 cherry.bin；fork 的等价物是 CodeMate 受管 node
 *  运行时目录（见 resolveManagedSearchDirs）。 */
function getBinarySearchDirs(): Promise<string[]> {
  return resolveManagedSearchDirs()
}

/**
 * 受管 node 运行时标记文件名——与 binaryManager/runtimeDownloader.ts 的
 * RUNTIME_VERSION_MARKER 同值。此处刻意不 import 那个模块：runtimeDownloader 会拉起
 * node-stream-zip 等重依赖，而 shellEnv 在主进程启动路径上被每个子进程读取。
 */
const RUNTIME_VERSION_MARKER = '.codemate-runtime-version'

let managedSearchDirsMemo: Promise<string[]> | null = null

/**
 * 丢弃受管目录的记忆，下次拼 PATH 时重扫一遍。
 *
 * 为什么非要有这个入口（真机时序）：应用刚启动、受管 node 还没装时，第一个子进程
 * （快照探针）就把"运行时根不存在 ⇒ 只有 .bin"的结果记进了 memo。此后装完受管 node，
 * 那条 memo 仍钉着空数组 → 探针的 PATH 里永远没有 node → **首次安装依旧报
 * "损坏或过时的安装"，用户必须重启应用才生效**。装完就作废，让下一次探针看到新目录。
 */
export function invalidateManagedSearchDirs(): void {
  managedSearchDirsMemo = null
}

/**
 * 找出实际安装的受管 node 运行时目录（版本段由标记文件自证，不硬编码版本号）。
 * 定位失败（无运行时 / 非 Electron 进程）返回空数组——宁可少一个回退目录，绝不抛。
 */
async function discoverManagedNodeDirs(): Promise<string[]> {
  try {
    const root = managedNodeRuntimeRoot()
    const entries = await fsp.readdir(root, { withFileTypes: true })
    const dirs: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name)
      try {
        const marker = (await fsp.readFile(path.join(dir, RUNTIME_VERSION_MARKER), 'utf-8')).trim()
        if (!marker) continue
      } catch {
        continue // 没有受管标记的目录不是我们的运行时（可能是半成品 .tmp-*）
      }
      dirs.push(dir)
      if (!isWin) dirs.push(path.join(dir, 'bin'))
    }
    return dirs
  } catch (error) {
    logger.debug('Managed runtime dirs unavailable', { error })
    return []
  }
}

/**
 * 受管工具搜索目录（**前置**到 PATH）。Windows：`runtime/node/<版本>`（内含 node.exe）
 * + 各 npm 型工具的 `.bin`（dshmarket 的 pnpm shim 落点，见 managedToolBinDirs）。这些目录
 * 必须进 PATH——npm 的 bin shim 自己
 * 不带 node，找不到 `node` 就直接失败（真机事故见 binaryManager/layout.ts 的
 * managedNodeRuntimeRoot 注释）。
 *
 * 顺序必须在**前**，不能追加到尾部：受管 node 是这些工具的契约运行时，PATH 上若存在
 * 用户自装的旧 node（v18 之类），`.cmd` shim 会先捞到它、用错版本去跑 dsh，症状与
 * "找不到 node" 同样是"装好了却起不来"。前置也与启动路径一致——DeepSeekHarnessService
 * 本来就用 withPathPrepend 把受管 nodeBinDir 放在最前。
 */
function resolveManagedSearchDirs(): Promise<string[]> {
  // 记忆的是整份候选（含各 npm 型工具的 .bin）——每次调用都重算会把 managedToolBinDirs()
  // 再拼一遍，且 Promise.all 的并发读者会看到不同数组。
  managedSearchDirsMemo ??= discoverManagedNodeDirs().then((nodeDirs) => [...nodeDirs, ...managedToolBinDirs()])
  return managedSearchDirsMemo
}

/** fork 缝：V2 注入 MISE_* 并前置 shims 目录；fork 无 mise，环境原样浅拷贝。 */
function mergeBinaryExecutionEnv(env: Record<string, string>): Record<string, string> {
  return { ...env }
}

/** fork 缝：V2 返回内置 MinGit 的 cmd 目录；fork 无内置 git，返回 null。 */
function getBundledGitDir(): string | null {
  return null
}

// ── fork 缝结束 ─────────────────────────────────────────────────────────────────

// Give shells enough time to source profile files, but fail fast when they hang.
const SHELL_ENV_TIMEOUT_MS = 15_000

/** Read PATH using Windows-compatible, case-insensitive environment-key semantics. */
export function getPathFromEnvironment(env: Record<string, string | undefined>): string | undefined {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path')
  return pathKey ? env[pathKey] : undefined
}

/**
 * fork 缝（真机事故）：构造带 PATH 前置的子进程 env。
 * Windows shell env 的键名是注册表原样的 `Path`——普通对象上 `env.PATH`（大写）是
 * undefined；spread 副本里原键仍在，与新写的 `PATH` 并存，spawn 时哪个生效是未定义
 * 行为（真机症状：子进程只看到截断的 PATH，`node` 直接找不到）。这里读原键（大小写
 * 不敏感）→ 删全部 PATH 变体 → 统一写单一大写 `PATH`。
 */
export function withPathPrepend(
  env: Record<string, string | undefined>,
  prependDirs: readonly string[],
  pathSeparator = isWin ? ';' : ':'
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env }
  const existing = getPathFromEnvironment(result) ?? ''
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === 'path') delete result[key]
  }
  result.PATH = [...prependDirs, existing].filter((segment) => segment !== '').join(pathSeparator)
  return result
}

/**
 * Puts the Cherry-managed tool directories (managed Node runtime, every npm-type tool's
 * `.bin`) at the FRONT of PATH — see resolveManagedSearchDirs for why they must win over
 * a system Node — while preserving the original key casing and avoiding duplicate segments.
 * Bundled MinGit (empty in this fork) still goes to the very tail.
 */
const prependCherryToolDirsToPath = async (env: Record<string, string>) => {
  const pathSeparator = isWin ? ';' : ':'
  const cherryToolDirs = await getBinarySearchDirs()
  // Bundled MinGit as a last-resort git: it stays at the very tail, letting any
  // spawned process (agent, CLI) resolve a bare `git` with no system git — while
  // system/mise/PATH git always win ahead.
  const bundledGitDir = getBundledGitDir()
  const tailDirs = bundledGitDir ? [bundledGitDir] : []
  const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === 'path')
  const canonicalPathKey = pathKeys[0] || (isWin ? 'Path' : 'PATH')
  const existingPathValue = env[canonicalPathKey] || env.PATH || ''

  // Managed dirs first, then the user's own segments, MinGit last — dedup keeps an
  // already-present segment at its first (now earliest) position instead of duplicating it.
  const updatedPath = dedupePathSegments([
    ...cherryToolDirs,
    ...existingPathValue.split(pathSeparator),
    ...tailDirs
  ]).join(pathSeparator)

  if (pathKeys.length > 0) {
    pathKeys.forEach((key) => {
      env[key] = updatedPath
    })
  } else {
    env[canonicalPathKey] = updatedPath
  }

  if (!isWin) {
    env.PATH = updatedPath
  }
}

const applyBinaryExecutionEnv = (env: Record<string, string>) => {
  const merged = mergeBinaryExecutionEnv(env)
  Object.keys(env).forEach((key) => delete env[key])
  Object.assign(env, merged)
}

/**
 * Replace `%VAR%` references with values from `env` (case-insensitive lookup).
 */
function expandWindowsEnvVars(value: string, env: Record<string, string>): string {
  return value.replace(/%([^%]+)%/g, (original, varName: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === varName.toLowerCase())
    return key ? env[key] : original
  })
}

/**
 * Read the **current** system + user PATH from the Windows registry and expand
 * embedded `%VAR%` references so callers get a ready-to-use PATH string.
 * Returns null when both registry reads fail.
 */
async function readWindowsRegistryPath(env: Record<string, string>): Promise<string | null> {
  try {
    // fork 缝：模块名经 REGISTRY_JS_MODULE 变量传入（registry-js 未随 fork 安装，见文件头缝说明）
    const { HKEY, RegistryValueType, enumerateValuesSafe } = await import(REGISTRY_JS_MODULE)
    const readPathValue = (hive: (typeof HKEY)[keyof typeof HKEY], subkey: string): string | null => {
      const pathValue = enumerateValuesSafe(hive, subkey).find(
        (value) =>
          value.name.toLowerCase() === 'path' &&
          (value.type === RegistryValueType.REG_SZ || value.type === RegistryValueType.REG_EXPAND_SZ)
      )
      return typeof pathValue?.data === 'string' ? pathValue.data : null
    }

    const systemPath = readPathValue(
      HKEY.HKEY_LOCAL_MACHINE,
      'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
    )
    const userPath = readPathValue(HKEY.HKEY_CURRENT_USER, 'Environment')

    if (!systemPath && !userPath) {
      return null
    }

    const combined = [systemPath, userPath].filter(Boolean).join(';')
    return expandWindowsEnvVars(combined, env)
  } catch {
    return null
  }
}

/**
 * Build a fresh environment on Windows by copying `process.env` and replacing
 * PATH with the current registry value. This avoids the stale PATH problem
 * where `cmd.exe /c set` only inherits the Electron parent process's env.
 */
async function getWindowsEnvironment(): Promise<Record<string, string>> {
  const env: Record<string, string> = {}
  for (const key in process.env) {
    env[key] = process.env[key] || ''
  }

  const registryPath = await readWindowsRegistryPath(env)
  if (registryPath) {
    const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path')
    for (const key of pathKeys) {
      env[key] = registryPath
    }
    if (pathKeys.length === 0) {
      env.Path = registryPath
    }
    logger.debug('Replaced PATH with fresh registry value')
  } else {
    logger.warn('Could not read PATH from Windows registry, keeping process.env PATH')
  }

  return env
}

/**
 * Spawns a login shell in the user's home directory to capture its environment variables.
 *
 * We explicitly run a login, non-interactive shell. This loads login profiles such as macOS
 * `~/.zprofile` (where Homebrew commonly installs its PATH) without executing interactive prompt,
 * theme, or terminal plugin setup from `~/.zshrc`.
 *
 * Timeout handling is important because profile scripts might block forever (e.g. misconfigured
 * `read` or prompts). We proactively kill the shell and surface an error in that case so that
 * the app does not hang.
 * @returns {Promise<Object>} A promise that resolves with an object containing
 * the environment variables, or rejects with an error.
 */
function getLoginShellEnvironment(signal?: AbortSignal): Promise<Record<string, string>> {
  signal?.throwIfAborted()
  // On Windows, skip the shell spawn entirely — `cmd.exe /c set` just inherits
  // the (potentially stale) parent process env. Instead, read the current PATH
  // straight from the Windows registry.
  if (isWin) {
    return getWindowsEnvironment()
  }

  return new Promise((resolve, reject) => {
    const homeDirectory =
      process.env.HOME || process.env.Home || process.env.USERPROFILE || process.env.UserProfile || os.homedir() // fork 缝：application.getPath('sys.home')（V2 该键即 os.homedir()）
    if (!homeDirectory) {
      return reject(new Error("Could not determine user's home directory."))
    }

    let shellPath = process.env.SHELL

    if (!shellPath) {
      if (isMac) {
        logger.warn(
          "process.env.SHELL is not set. Defaulting to /bin/zsh for macOS. This might not be the user's login shell."
        )
        shellPath = '/bin/zsh'
      } else {
        logger.warn("process.env.SHELL is not set. Defaulting to /bin/bash. This might not be the user's login shell.")
        shellPath = '/bin/bash'
      }
    }

    const commandArgs = ['-lc', 'env']

    logger.debug(`Spawning shell: ${shellPath} with args: ${commandArgs.join(' ')} in ${homeDirectory}`)

    let settled = false
    let timeoutId: NodeJS.Timeout | undefined

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = undefined
      }
    }

    const resolveOnce = (value: Record<string, string>) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(value)
    }

    const rejectOnce = (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(error)
    }

    const child = spawn(shellPath, commandArgs, {
      signal,
      killSignal: 'SIGKILL',
      cwd: homeDirectory, // Run the command in the user's home directory
      detached: false, // Stay attached so we can clean up reliably
      stdio: ['ignore', 'pipe', 'pipe'], // stdin, stdout, stderr
      shell: false, // We are specifying the shell command directly
      windowsHide: true // 登录 shell 是控制台子系统：不加则从 GUI 进程 spawn 时闪控制台窗口
    })

    let output = ''
    let errorOutput = ''

    // Protects against shells that wait for user input or hang during profile sourcing.
    timeoutId = setTimeout(() => {
      const errorMessage = `Timed out after ${SHELL_ENV_TIMEOUT_MS}ms while retrieving shell environment. Shell: ${shellPath}. Args: ${commandArgs.join(
        ' '
      )}. CWD: ${homeDirectory}`
      logger.error(errorMessage)
      child.kill('SIGKILL')
      rejectOnce(new Error(errorMessage))
    }, SHELL_ENV_TIMEOUT_MS)

    child.stdout.on('data', (data) => {
      output += data.toString()
    })

    child.stderr.on('data', (data) => {
      errorOutput += data.toString()
    })

    child.on('error', (error) => {
      logger.error(`Failed to start shell process: ${shellPath}`, error)
      rejectOnce(new Error(`Failed to start shell: ${error.message}`))
    })

    child.on('close', (code) => {
      if (settled) {
        return
      }

      if (code !== 0) {
        const errorMessage = `Shell process exited with code ${code}. Shell: ${shellPath}. Args: ${commandArgs.join(' ')}. CWD: ${homeDirectory}. Stderr: ${errorOutput.trim()}`
        logger.error(errorMessage)
        return rejectOnce(new Error(errorMessage))
      }

      if (errorOutput.trim()) {
        // Some shells might output warnings or non-fatal errors to stderr
        // during profile loading. Log it, but proceed if exit code is 0.
        logger.warn(`Shell process stderr output (even with exit code 0):\n${errorOutput.trim()}`)
      }

      // Convert each VAR=VALUE line into our env map.
      const env: Record<string, string> = {}
      const lines = output.split(/\r?\n/)

      lines.forEach((line) => {
        const trimmedLine = line.trim()
        if (trimmedLine) {
          const separatorIndex = trimmedLine.indexOf('=')
          if (separatorIndex > 0) {
            // Ensure '=' is present and it's not the first character
            const key = trimmedLine.substring(0, separatorIndex)
            const value = trimmedLine.substring(separatorIndex + 1)
            env[key] = value
          }
        }
      })

      if (Object.keys(env).length === 0 && output.length < 100) {
        // Arbitrary small length check
        // This might indicate an issue if no env vars were parsed or output was minimal
        logger.warn(
          'Parsed environment is empty or output was very short. This might indicate an issue with shell execution or environment variable retrieval.'
        )
        logger.warn(`Raw output from shell:\n${output}`)
      }

      resolveOnce(env)
    })
  })
}

let cachedEnv: Record<string, string> | null = null
let inflight: Promise<Record<string, string>> | null = null

async function fetchShellEnv(): Promise<Record<string, string>> {
  try {
    return await getLoginShellEnvironment()
  } catch (error) {
    logger.error('Failed to get shell environment, falling back to process.env', { error })
    const fallbackEnv: Record<string, string> = {}
    for (const key in process.env) {
      fallbackEnv[key] = process.env[key] || ''
    }
    return fallbackEnv
  }
}

/**
 * Fetch the shell env, collapsing concurrent callers onto a single spawn.
 *
 * Resolving the login shell can be slow or hang (misconfigured profiles), so
 * letting overlapping callers each spawn their own shell multiplies a 15s
 * timeout into several. Sharing the in-flight promise keeps it to one spawn.
 */
function loadShellEnv(): Promise<Record<string, string>> {
  if (inflight) {
    return inflight
  }
  // fetchShellEnv never rejects (it falls back to process.env), so the cache
  // is always populated and `inflight` always cleared.
  inflight = fetchShellEnv()
    .then((env) => {
      cachedEnv = env
      return env
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/**
 * Get the cached shell environment. If no cache exists yet, fetches it once.
 * This is a pure query -- it never invalidates the cache.
 *
 * Returns a shallow copy: callers routinely mutate the env they get back (e.g.
 * `removeEnvProxy`, merging per-spawn overrides), and handing out the cached
 * object itself would let one such mutation silently poison every later reader.
 */
export async function getRawShellEnv(signal?: AbortSignal): Promise<Record<string, string>> {
  signal?.throwIfAborted()
  // A cancellable cold query owns its shell; aborting it must not poison the shared app cache.
  const env = cachedEnv ?? (await (signal ? getLoginShellEnvironment(signal) : loadShellEnv()))
  signal?.throwIfAborted()
  cachedEnv ??= env
  return { ...env }
}

export async function getShellEnv(signal?: AbortSignal): Promise<Record<string, string>> {
  const env = await getRawShellEnv(signal)
  await prependCherryToolDirsToPath(env)
  applyBinaryExecutionEnv(env)
  return env
}

/**
 * Invalidate the shell env cache and immediately re-fetch a fresh environment.
 * This is an explicit command -- callers use this when they need to pick up
 * newly installed tools (nvm, mise, fnm, etc.) that change PATH.
 *
 * Returns a fresh shallow copy (see getShellEnv) so callers can use it directly
 * without a separate getShellEnv() call, avoiding stale-read race conditions.
 *
 * If a fetch is already in flight, that one is reused instead of spawning a
 * second shell -- it is already fresh enough, and a duplicate spawn just
 * multiplies the cost when the user's profile is slow.
 */
export async function refreshShellEnv(): Promise<Record<string, string>> {
  if (inflight) {
    // Reusing a capture that started before the event prompting this refresh
    // (e.g. a tool install completing mid-flight). Acceptable because downstream
    // lookups hit the filesystem live; logged so the reuse is observable.
    logger.debug('refreshShellEnv reusing in-flight shell capture instead of re-spawning')
    const env = { ...(await inflight) }
    await prependCherryToolDirsToPath(env)
    applyBinaryExecutionEnv(env)
    return env
  }
  cachedEnv = null
  return getShellEnv()
}

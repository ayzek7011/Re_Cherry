// fork 缝（原创）：dshmarket（插件市场）受管通道。
//
// 背景（真机反馈）：dsh 核心升级后插件市场停在旧版 → 与本代核心不兼容 → 用户报"新版本的
// 插件市场不可用"。机理：dshmarket **不是官方包**（harness 源码里 grep `dshmarket` 零命中），
// 它只是 web profile 目录里的一个普通依赖；官方 in-box bundle 由 `resolveBundleDir` 先从
// dsh 安装目录解析（换核心即换官方包），而 dshmarket 只能由 pnpm 移动。
//
// 本件保证两件事（社区版 dsh-desktop market-baseline 的**目的**，不是它的常量）：
// ① 市场装上了、且可读——装完读回 `node_modules/dshmarket/package.json` 才算数
//    （pnpm 退出 0 ≠ 插件生效）；
// ② 每次启动 Harness 前把"缺失/不可读/链接残留/上次没修完"的市场补上，失败回滚 manifest 并
//    留下次重试的标记；补不上但现有市场还能用时**不阻断启动**。
//
// **为什么不学社区版钉死一个"已验证版本"**（两次真机回归的教训）：
// 社区版的 `VERIFIED_MARKET_BASELINE` 是**随代际 bump 的常量**——我参照的那份开发期快照
// （2026-09-24）写的是 `1.45.1`，而社区当前（2026-09-29）已经改成 `1.65.1`。照着抄一份常量，
// 就是在抄一个会过期的数字：本机 dsh 是 `0.2.0-rc.2`，而 `dshmarket@1.45.1` 只声明
// `@deepseek-ai/dsh-settings ^0.1.x`，于是被 dsh 自己拒收：
//   dsh: installation rejected: Plugin dshmarket@1.45.1 is incompatible with dsh 0.2.0-rc.2
// 结果：安装必失败 → 工具判 broken → 市场永远补不上。
//
// **版本权威在 dsh，选版依据是"已装 dsh 的 peer 要求"**：本件读 registry 的版本元数据，
// 挑出**声明与该 dsh 版本兼容**的最高版本（社区版 `inferPluginRuntimeCompatibility` /
// `selectCompatiblePluginUpgrade` 的选版逻辑对位），挑不出来才回退 dist-tag `latest`。
// dsh 换代 → 挑出来的版本跟着换，不需要任何人回来改常量。
//
// 可测性：本件不 import electron，文件系统、命令执行、版本元数据都走端口注入（main 测试环境
// mock 了 node:fs/node:path）；零参包装是本件对应用侧的默认绑定。

import fsp from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { isWin } from '@main/constant'
import { cacheRoot, codeMateToolsRoot, deepSeekHarnessHome, nodeRuntimeDir } from '@main/services/deepSeekHarness/paths'
import { withPathPrepend } from '@main/utils/shellEnv'

import { managedToolBinDirs } from './layout'
import { NPM_REGISTRY_FALLBACK, NPM_REGISTRY_MIRROR } from './registry'
import { DEFAULT_COMMAND_TIMEOUT_MS, runBoundedCommand } from './runCommand'
import { NODE_VERSION } from './runtimeDownloader'

const logger = loggerService.withContext('MarketBaseline')

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 市场所在的 profile（dsh 自带 web 模板，市场恒装在这里）。 */
export const MARKET_PROFILE = 'web'
/** 市场包名（社区版 `MARKET_PACKAGE` 对位）。 */
export const MARKET_PACKAGE = 'dshmarket'
/**
 * 兜底安装规格（dist-tag）：**只在按兼容性挑不出具体版本时使用**（拿不到元数据 / 宿主版本未知 /
 * 没有任何版本声明兼容）。正常情况下装的是 {@link selectCompatibleMarketVersion} 挑出的**精确
 * 版本**——参见文件头：钉一个自造的基线常量会过期，钉一个"现场算出来的兼容版"不会。
 */
export const MARKET_INSTALL_SPEC = 'latest'

/** 版本元数据的查询预算（目录接口比单版本查询大，给宽一点）。 */
const MARKET_METADATA_TIMEOUT_MS = 15_000

/** 社区版成对的 [主源, 备用源]；两半（版本解析与抓包）必须同源。 */
const MARKET_REGISTRIES = [NPM_REGISTRY_MIRROR, NPM_REGISTRY_FALLBACK] as const

/** 回退判据：只有"这个源拿不到这个东西"类失败才值得换源，EPERM/EBUSY 换源没意义。 */
const REGISTRY_FALLBACK_PATTERN =
  /ERR_PNPM_NO_MATCHING_VERSION|ERR_PNPM_FETCH|ERR_PNPM_META_FETCH_FAIL|404|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|certificate/i

/** pnpm ≥10 从 pnpm-workspace.yaml 读链接器设置（harness `initProfile` 写入的同一份内容）。 */
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

// ---------------------------------------------------------------------------
// 版本判据：可读性 + 按 dsh 兼容性选版
// ---------------------------------------------------------------------------

export interface SemverVersion {
  major: number
  minor: number
  patch: number
  prerelease: Array<string | number>
}

const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** 解析严格 semver；不合法返回 null。 */
export function parseSemver(input: string): SemverVersion | null {
  if (typeof input !== 'string') return null
  const match = SEMVER_PATTERN.exec(input.trim())
  if (!match) return null
  const prerelease = match[4] ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : []
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease }
}

/** 比较 semver：a>b → 1，a<b → -1（社区版 plugin-market-check 逐字移植）。 */
export function compareSemver(aStr: string, bStr: string): number {
  const a = parseSemver(aStr)
  const b = parseSemver(bStr)
  if (!a && !b) return aStr.localeCompare(bStr)
  if (!a) return -1
  if (!b) return 1

  if (a.major !== b.major) return a.major > b.major ? 1 : -1
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1

  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0

  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const aPart = a.prerelease[index]
    const bPart = b.prerelease[index]
    if (aPart === undefined) return -1
    if (bPart === undefined) return 1
    if (aPart === bPart) continue
    const aNumeric = typeof aPart === 'number'
    const bNumeric = typeof bPart === 'number'
    if (aNumeric && !bNumeric) return -1
    if (!aNumeric && bNumeric) return 1
    return aPart > bPart ? 1 : -1
  }
  return 0
}

/** 单个比较符（`^0.2.0-rc.1` / `>=1.0.0` / `~1.2` / `*` / 精确版）——社区版逐字移植。 */
export function satisfiesComparator(versionStr: string, comparator: string): boolean {
  const comp = comparator.trim()
  if (!comp || comp === '*' || comp === 'x' || comp === 'X') return true

  const v = parseSemver(versionStr)
  if (!v) return false

  if (comp.startsWith('^')) {
    const target = comp.slice(1).trim()
    const t = parseSemver(target)
    if (!t) return false
    // 预发布版本只满足"同一 major.minor.patch 且目标也是预发布"的范围。
    if (v.prerelease.length > 0) {
      if (t.prerelease.length === 0 || v.major !== t.major || v.minor !== t.minor || v.patch !== t.patch) {
        return false
      }
    }
    if (compareSemver(versionStr, target) < 0) return false
    if (t.major > 0) return v.major === t.major
    if (t.minor > 0) return v.major === 0 && v.minor === t.minor
    return v.major === 0 && v.minor === 0 && v.patch === t.patch
  }

  if (comp.startsWith('~')) {
    const target = comp.slice(1).trim()
    const t = parseSemver(target)
    if (!t) return false
    if (v.prerelease.length > 0) {
      if (t.prerelease.length === 0 || v.major !== t.major || v.minor !== t.minor || v.patch !== t.patch) {
        return false
      }
    }
    if (compareSemver(versionStr, target) < 0) return false
    return v.major === t.major && v.minor === t.minor
  }

  if (comp.startsWith('>=')) return compareSemver(versionStr, comp.slice(2).trim()) >= 0
  if (comp.startsWith('>')) return compareSemver(versionStr, comp.slice(1).trim()) > 0
  if (comp.startsWith('<=')) return compareSemver(versionStr, comp.slice(2).trim()) <= 0
  if (comp.startsWith('<')) return compareSemver(versionStr, comp.slice(1).trim()) < 0
  if (comp.startsWith('=')) return compareSemver(versionStr, comp.slice(1).trim()) === 0
  return compareSemver(versionStr, comp) === 0
}

/** 范围（`||` 分隔的备选，空格分隔的 AND）——社区版逐字移植。 */
export function satisfiesRange(versionStr: string, range: string): boolean {
  if (!range || range.trim() === '*' || range.trim() === '') return true
  const alternatives = range
    .split('||')
    .map((alt) => alt.trim())
    .filter(Boolean)
  if (alternatives.length === 0) return true
  return alternatives.some((alt) =>
    alt
      .split(/\s+/)
      .filter(Boolean)
      .every((part) => satisfiesComparator(versionStr, part))
  )
}

/** registry packument 的最小消费面（只取选版需要的字段）。 */
export interface MarketVersionManifest {
  version: string
  name?: string
  deprecated?: string | boolean
  peerDependencies?: Record<string, string>
  engines?: Record<string, string>
  dsh?: { minVersion?: string }
}

export interface MarketMetadata {
  versions: Record<string, MarketVersionManifest>
  latest: string
}

/** 已装宿主的事实：判市场候选是否兼容的依据（活探针纠正后）。 */
export interface HostFacts {
  /** 已装 dsh 的版本（只用于 `engines.dsh` / `dsh.minVersion`）。 */
  dshVersion?: string
  /**
   * 某个宿主包在本机的已装版本（包名 → 版本）。
   *
   * **为什么必须逐包**：市场声明的 peer 是多个**各自版本线**的包——`@deepseek-ai/dsh-settings`
   * 与 dsh 同代（0.2.0-rc.2），而 `@deepseek-ai/schemastery` 是 `^3.18.1`。社区版
   * `inferPluginRuntimeCompatibility` 把**所有** `@deepseek-ai/*` peer 都拿去和"当前 dsh 版本"
   * 比，于是把 `^3.18.1` 与 `0.2.0-rc.2` 相比 → 把正确的 1.66.5 判成不兼容（活探针实测：会挑出
   * 1.11.3）。逐包对已装版本才是可用的判据。返回 undefined = 本机没装这个包 → 不作为不兼容的证据。
   */
  peerVersion: (packageName: string) => Promise<string | undefined>
}

/**
 * 该版本市场是否与本机 dsh 兼容：
 * ① `peerDependencies` 里每个 `@deepseek-ai/*`（cordis 除外——由 harness 自身提供、版本线独立）
 *    的声明范围必须被**该包在本机的已装版本**满足；
 * ② `engines.dsh` 与 `dsh.minVersion` 声明须被已装 dsh 版本满足；
 * ③ 依赖已移除的 `@deepseek-ai/dsh-host-apiproxy` 一律判不兼容。
 *
 * 真机意义：dsh 0.2.0-rc.2 会**拒收**只声明 `@deepseek-ai/dsh-settings ^0.1.x` 的 dshmarket
 * （1.45.1 即如此）。这条判定让我们在安装之前就避开它，而不是等 dsh 报错。
 */
export async function inferMarketRuntimeCompatibility(
  manifest: MarketVersionManifest,
  host: HostFacts
): Promise<{ compatible: boolean; reason?: string }> {
  const peers = manifest.peerDependencies ?? {}
  if ('@deepseek-ai/dsh-host-apiproxy' in peers) {
    return { compatible: false, reason: 'depends on the removed @deepseek-ai/dsh-host-apiproxy' }
  }

  for (const [peer, range] of Object.entries(peers)) {
    if (!peer.startsWith('@deepseek-ai/') || peer === '@deepseek-ai/cordis' || !range) continue
    const installed = await host.peerVersion(peer)
    if (installed && !satisfiesRange(installed, range)) {
      return { compatible: false, reason: `declares peer ${peer} (${range}) but ${installed} is installed` }
    }
  }

  const minVersion = manifest.dsh?.minVersion
  for (const constraint of [manifest.engines?.dsh, minVersion ? `>=${minVersion}` : undefined]) {
    if (constraint && host.dshVersion && !satisfiesRange(host.dshVersion, constraint)) {
      return { compatible: false, reason: `requires dsh ${constraint} but ${host.dshVersion} is installed` }
    }
  }

  return { compatible: true }
}

/**
 * 选一个可与本机 dsh 共存的市场版本：兼容、未废弃、取最高。
 *
 * **为什么不钉版本常量**：社区版会随代际 bump 它们的 `VERIFIED_MARKET_BASELINE`
 * （2026-09-24 是 1.45.1，2026-09-29 已是 1.65.1），而 dshmarket 是第三方包、我们无法验证
 * 某个常量是否还成立——照着抄一份常量，就是在抄一个会过期的数字（本次真机回归的成因）。
 * 按**已装 dsh 的 peer 要求**现场挑版本则不会过期：dsh 换代 → 挑出来的版本跟着换。
 *
 * 预发布：dsh 自己是预发布（如 0.2.0-rc.2）时允许预发布候选；否则只认稳定版，退而求其次才用
 * 预发布（避免把 rc 塞给稳定宿主）。
 */
export async function selectCompatibleMarketVersion(
  metadata: MarketMetadata,
  host: HostFacts
): Promise<{ version: string; reason?: string } | undefined> {
  const candidates = Object.values(metadata.versions)
    .filter((manifest) => !!parseSemver(manifest.version) && !manifest.deprecated)
    .sort((left, right) => compareSemver(right.version, left.version))

  const hostIsPrerelease = (parseSemver(host.dshVersion ?? '')?.prerelease.length ?? 0) > 0
  let prereleaseCandidate: { version: string; reason?: string } | undefined
  for (const candidate of candidates) {
    if (!(await inferMarketRuntimeCompatibility(candidate, host)).compatible) continue
    if ((parseSemver(candidate.version)?.prerelease.length ?? 1) === 0) {
      return { version: candidate.version }
    }
    prereleaseCandidate ??= {
      version: candidate.version,
      reason: 'prerelease host; the newest compatible build is a prerelease'
    }
  }
  return hostIsPrerelease ? prereleaseCandidate : undefined
}

/** 市场版本元数据（两个 registry 依次尝试，全失败返回 undefined——由调用方回退 latest）。 */
export async function fetchMarketMetadata(
  fetchImpl: typeof fetch,
  options: { registries?: readonly string[]; timeoutMs?: number } = {}
): Promise<MarketMetadata | undefined> {
  const registries = options.registries ?? MARKET_REGISTRIES
  const timeoutMs = options.timeoutMs ?? MARKET_METADATA_TIMEOUT_MS
  const failures: string[] = []
  for (const registry of registries) {
    try {
      const response = await fetchImpl(`${registry}/${MARKET_PACKAGE}`, {
        signal: AbortSignal.timeout(timeoutMs),
        // 完整元数据才带 per-version 的 peerDependencies/engines（简版安装元数据没有）。
        headers: { accept: 'application/json' }
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = (await response.json()) as {
        versions?: Record<string, MarketVersionManifest>
        'dist-tags'?: { latest?: unknown }
      }
      const latest = payload['dist-tags']?.latest
      if (typeof latest !== 'string' || !parseSemver(latest) || !payload.versions?.[latest]) {
        throw new Error('invalid version metadata')
      }
      return { versions: payload.versions, latest }
    } catch (error) {
      failures.push(`${registry}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  logger.warn('Failed to read dshmarket metadata from every registry', { failures })
  return undefined
}

/** 市场是否"可用"：装着、版本号可读即可（可用性不判大小——兼容性由上面的选版负责）。 */
export function isUsableMarketVersion(version: string | undefined): boolean {
  return !!version && !!parseSemver(version)
}

// ---------------------------------------------------------------------------
// 端口：文件系统与命令执行（注入以便单测；main 测试环境 mock 了 node:fs）
// ---------------------------------------------------------------------------

export type MarketEntryKind = 'missing' | 'file' | 'directory' | 'link'

export interface MarketIo {
  /** 读文本；缺失/不可读返回 undefined（不抛）。 */
  readText(file: string): Promise<string | undefined>
  writeText(file: string, contents: string): Promise<void>
  removeFile(file: string): Promise<void>
  entryKind(target: string): Promise<MarketEntryKind>
  /** 链接目标；非链接或缺失返回 undefined。 */
  linkTarget(target: string): Promise<string | undefined>
  ensureDir(dir: string): Promise<void>
}

export interface MarketCommandOptions {
  label: string
  /** 本次命令要用的 registry（默认主镜像）；调用方据此同时设 env 与 `--registry=`。 */
  registry?: string
  timeoutMs?: number
}

export type MarketCommandRunner = (args: readonly string[], options: MarketCommandOptions) => Promise<string>

export const nodeMarketIo: MarketIo = {
  async readText(file) {
    try {
      return await fsp.readFile(file, 'utf-8')
    } catch {
      return undefined
    }
  },
  async writeText(file, contents) {
    await fsp.writeFile(file, contents, 'utf-8')
  },
  async removeFile(file) {
    await fsp.rm(file, { force: true })
  },
  async entryKind(target) {
    try {
      const entry = await fsp.lstat(target)
      if (entry.isSymbolicLink()) return 'link'
      return entry.isDirectory() ? 'directory' : 'file'
    } catch {
      return 'missing'
    }
  },
  async linkTarget(target) {
    try {
      return await fsp.readlink(target)
    } catch {
      return undefined
    }
  },
  async ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true })
  }
}

// ---------------------------------------------------------------------------
// 布局与读取
// ---------------------------------------------------------------------------

export interface MarketPaths {
  home: string
  profileDir: string
  manifestPath: string
  nodeModulesDir: string
  /** 未完成的修复标记（社区版 `.desktop-market-install-pending.json` 的 fork 对位）。 */
  pendingPath: string
}

export function marketPaths(dshHome: string): MarketPaths {
  const profileDir = path.join(dshHome, 'profiles', MARKET_PROFILE)
  return {
    home: dshHome,
    profileDir,
    manifestPath: path.join(profileDir, 'package.json'),
    nodeModulesDir: path.join(profileDir, 'node_modules'),
    pendingPath: path.join(profileDir, '.codemate-market-install-pending.json')
  }
}

interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

interface LoadedManifest {
  raw: string
  manifest: ProfileManifest
}

async function readManifest(io: MarketIo, paths: MarketPaths): Promise<LoadedManifest | undefined> {
  const raw = await io.readText(paths.manifestPath)
  if (raw === undefined) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return { raw, manifest: parsed as ProfileManifest }
  } catch {
    // 坏 manifest 不猜：当作"没有 profile"处理，调用方各自 fail-closed。
    return undefined
  }
}

/** 读某个 profile 依赖的实际安装版本（链接与实目录两种布局都成立）。 */
export async function readProfileBundleVersion(
  io: MarketIo,
  profileDir: string,
  packageName: string
): Promise<string | undefined> {
  const raw = await io.readText(path.join(profileDir, 'node_modules', ...packageName.split('/'), 'package.json'))
  if (raw === undefined) return undefined
  try {
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/** 市场是否是 `.generations` 链接（社区宿主残留的形态；fork 自己不产生 generation）。 */
async function isGenerationLink(io: MarketIo, paths: MarketPaths): Promise<boolean> {
  const marketPath = path.join(paths.nodeModulesDir, MARKET_PACKAGE)
  if ((await io.entryKind(marketPath)) !== 'link') return false
  return (await io.linkTarget(marketPath))?.includes('.generations') ?? false
}

/** pnpm ≥10 只从 profile 的 pnpm-workspace.yaml 读链接器设置；缺失则补上（幂等）。 */
async function ensurePnpmWorkspaceSettings(io: MarketIo, profileDir: string): Promise<void> {
  if ((await io.entryKind(path.join(profileDir, 'pnpm-workspace.yaml'))) !== 'missing') return
  await io.ensureDir(profileDir)
  await io.writeText(path.join(profileDir, 'pnpm-workspace.yaml'), PROFILE_PNPM_WORKSPACE)
}

/**
 * 撤下"安装已完成"的声明（harness 与社区宿主的 `.install-complete` 指纹文件）。
 * 修复前必须撤：它是对 package.json + pnpm-lock.yaml 的指纹，留着会让后续启动认为
 * profile 已完整而跳过安装。缺文件时 `rm -f` 无害。
 */
async function clearProfileInstallMarker(io: MarketIo, profileDir: string): Promise<void> {
  await io.removeFile(path.join(profileDir, '.install-complete'))
}

/** manifest 是否"声明了市场"（依赖 + bundle 层都要在，否则视为用户已移除/已禁用）。 */
function declaresMarket(manifest: ProfileManifest): boolean {
  const declared = manifest.dependencies?.[MARKET_PACKAGE]
  const bundles = manifest.dsh?.profile?.bundles ?? []
  return !!declared && bundles.includes(MARKET_PACKAGE)
}

// ---------------------------------------------------------------------------
// 命令拼装
// ---------------------------------------------------------------------------

function marketAddArgs(spec: string, registry: string): string[] {
  return [
    'plugin',
    '--profile',
    MARKET_PROFILE,
    'add',
    '--workspace-root',
    `${MARKET_PACKAGE}@${spec}`,
    `--registry=${registry}`
    // 真机事故：这里**不能**带 `--no-frozen-lockfile`——它是 `pnpm install` 的开关，
    // `pnpm add` 不认（exit 2: unexpected argument）。`add` 本身就是"改锁文件"的操作，
    // 在 CI 环境下也不需要放行参数。只有下面的 `plugin install` 那条要显式放行。
  ]
}

function profileInstallArgs(registry: string): string[] {
  return ['plugin', '--profile', MARKET_PROFILE, 'install', '--no-frozen-lockfile', `--registry=${registry}`]
}

async function runWithRegistryFallback(
  runner: MarketCommandRunner,
  buildArgs: (registry: string) => string[],
  label: (registry: string) => string,
  note?: (line: string) => void
): Promise<string> {
  try {
    return await runner(buildArgs(MARKET_REGISTRIES[0]), {
      label: label(MARKET_REGISTRIES[0]),
      registry: MARKET_REGISTRIES[0]
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!REGISTRY_FALLBACK_PATTERN.test(message)) throw error
    note?.(`[market] ${MARKET_REGISTRIES[0]} could not provide the bundle; retrying from ${MARKET_REGISTRIES[1]}`)
    return await runner(buildArgs(MARKET_REGISTRIES[1]), {
      label: label(MARKET_REGISTRIES[1]),
      registry: MARKET_REGISTRIES[1]
    })
  }
}

/**
 * 决定这次装哪个版本：按已装 dsh 的 peer 要求现场挑（见 {@link selectCompatibleMarketVersion}），
 * 挑不出来才回退到 dist-tag `latest`——两种情况都如实记一行日志，便于真机排障。
 */
export async function resolveMarketSpec(options: MarketChannelOptions): Promise<{ spec: string; why: string }> {
  if (!options.host) {
    return { spec: MARKET_INSTALL_SPEC, why: 'the installed dsh is unreadable' }
  }
  const metadata = await fetchMarketMetadata(options.fetchImpl ?? fetch, {
    ...(options.registries ? { registries: options.registries } : {})
  })
  if (!metadata) {
    return { spec: MARKET_INSTALL_SPEC, why: 'registry metadata is unavailable' }
  }
  const picked = await selectCompatibleMarketVersion(metadata, options.host)
  if (!picked) {
    return {
      spec: MARKET_INSTALL_SPEC,
      why: `no published version declares compatibility with the installed dsh (${options.host.dshVersion ?? 'unknown'})`
    }
  }
  return {
    spec: picked.version,
    why: `highest version compatible with the installed dsh (${options.host.dshVersion ?? 'unknown'})${picked.reason ? ` — ${picked.reason}` : ''}`
  }
}

/** 跑一次"装市场"并核验可读；失败如实抛（调用方决定是阻断还是仅告警）。 */
async function addMarketAndVerify(
  io: MarketIo,
  runner: MarketCommandRunner,
  paths: MarketPaths,
  spec: string,
  note?: (line: string) => void
): Promise<string | undefined> {
  await runWithRegistryFallback(
    runner,
    (registry) => marketAddArgs(spec, registry),
    (registry) => `dsh plugin add ${MARKET_PACKAGE}@${spec} (${registry})`,
    note
  )
  const version = await readProfileBundleVersion(io, paths.profileDir, MARKET_PACKAGE)
  if (!isUsableMarketVersion(version)) {
    throw new Error(
      `${MARKET_PACKAGE} install reported success, but the active version is ${version ?? 'missing'}; the profile may have been left half-installed`
    )
  }
  return version
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

export interface MarketChannelOptions {
  dshHome: string
  io: MarketIo
  runner: MarketCommandRunner
  /**
   * 已装宿主的事实（决定装哪个市场版本）。缺省表示"拿不到"——此时回退 dist-tag。
   * 应用侧从 `tools/dsh/node_modules/` 读 dsh 与各宿主包的版本。
   */
  host?: HostFacts
  /** 版本元数据来源（单测注入）；缺省走两个 registry。 */
  fetchImpl?: typeof fetch
  /** 元数据 registry 顺序（单测注入）。 */
  registries?: readonly string[]
  note?: (line: string) => void
}

export interface MarketInstallOutcome {
  /** 本次是否真的跑了安装（缺省 profile 初始化时也算）。 */
  installed: boolean
  /** 操作结束时读到的市场实际版本（可读时）。 */
  version?: string
}

/**
 * 安装面：把市场装进 web profile（安装器在装配 dsh 时调用）。
 *
 * 顺序有意为之：**先声明再安装**——`add` 失败时若什么都没留下，市场连声明都没了，启动前的
 * 修复就无从下手。声明 + bundle 层先写，失败也能被下一次启动兜住。
 *
 * **失败如实抛**（由调用方决定是否阻断整体安装：市场是 bundle，不该让工具本体装不上）。
 */
export async function installMarketBundleWith(options: MarketChannelOptions): Promise<MarketInstallOutcome> {
  const { io, runner, note } = options
  const paths = marketPaths(options.dshHome)

  let loaded = await readManifest(io, paths)
  if (!loaded) {
    // 首次安装：profile 还不存在，让 dsh 自己按模板建（initProfile 写 manifest / patch /
    // pnpm-workspace.yaml），再回来声明市场。
    note?.('[market] initializing the web profile')
    await io.ensureDir(paths.profileDir)
    await ensurePnpmWorkspaceSettings(io, paths.profileDir)
    await runWithRegistryFallback(runner, profileInstallArgs, (registry) => `dsh plugin init (${registry})`, note)
    loaded = await readManifest(io, paths)
  }
  if (!loaded) throw new Error(`dsh web profile manifest was not created at ${paths.manifestPath}`)

  const { spec, why } = await resolveMarketSpec(options)
  note?.(`[market] installing ${MARKET_PACKAGE}@${spec}: ${why}`)
  const declared: ProfileManifest = {
    ...loaded.manifest,
    dependencies: { ...loaded.manifest.dependencies, [MARKET_PACKAGE]: spec }
  }
  const bundles = declared.dsh?.profile?.bundles ?? []
  declared.dsh = {
    ...declared.dsh,
    profile: {
      ...declared.dsh?.profile,
      bundles: bundles.includes(MARKET_PACKAGE) ? bundles : [...bundles, MARKET_PACKAGE]
    }
  }
  await io.writeText(paths.manifestPath, `${JSON.stringify(declared, undefined, 2)}\n`)
  try {
    const version = await addMarketAndVerify(io, runner, paths, spec, note)
    return { installed: true, ...(version ? { version } : {}) }
  } catch (error) {
    // 声明留下（下次启动的修复据此接手）；pnpm 可能已改过 manifest，还原成进来时的样子。
    await io.writeText(paths.manifestPath, loaded.raw)
    throw error
  }
}

/**
 * 启动前入口：市场"缺失 / 不可读 / 链接残留 / 上次没修完"时补装。
 *
 * 快路径只有两三次文件读；需要修时才动 profile。**前置条件是 Harness 已停**——重装会替换共享
 * 树里的包。失败回滚 manifest 并把待修标记留给下次启动；调用方再决定是否阻断启动
 *（现有市场可加载时不该阻断）。
 */
export async function ensureMarketInstalledWith(options: MarketChannelOptions): Promise<MarketInstallOutcome> {
  const { io, runner, note } = options
  const paths = marketPaths(options.dshHome)
  const loaded = await readManifest(io, paths)
  if (!loaded) return { installed: false }
  // 用户移除/禁用了市场 → 不复活（那是用户意图，不是实现细节）。
  if (!declaresMarket(loaded.manifest)) return { installed: false }

  const installed = await readProfileBundleVersion(io, paths.profileDir, MARKET_PACKAGE)
  const linked = await isGenerationLink(io, paths)
  const pending = (await io.entryKind(paths.pendingPath)) !== 'missing'
  if (isUsableMarketVersion(installed) && !linked && !pending) {
    return { installed: false, ...(installed ? { version: installed } : {}) }
  }

  const { spec, why } = await resolveMarketSpec(options)
  note?.(
    linked
      ? `[market] ${MARKET_PACKAGE} ${installed ?? '(unknown)'} is a link; reinstalling ${spec} into the shared tree (${why})`
      : `[market] (re)installing ${MARKET_PACKAGE} ${installed ?? '(missing)'} as ${spec} (${why})`
  )

  await ensurePnpmWorkspaceSettings(io, paths.profileDir)
  await clearProfileInstallMarker(io, paths.profileDir)
  if (!pending) {
    await io.writeText(paths.pendingPath, `${JSON.stringify({ spec, at: Date.now() })}\n`)
  }
  try {
    const version = await addMarketAndVerify(io, runner, paths, spec, note)
    await io.removeFile(paths.pendingPath)
    return { installed: true, ...(version ? { version } : {}) }
  } catch (error) {
    // pnpm 可能在失败前就改过包，故 manifest 回滚不等于"树回滚"——待修标记仍在，下次启动再修。
    await io.writeText(paths.manifestPath, loaded.raw)
    throw error
  }
}

/**
 * 现有市场能否撑起这次启动：装着、版本可读、不是 generation 链接。
 * 补装失败（受限网络 / dsh 拒收该版本）不该让用户丢掉本来还能用的 profile。
 */
export async function isMarketUsableWith(io: MarketIo, paths: MarketPaths): Promise<boolean> {
  const marketPath = path.join(paths.nodeModulesDir, MARKET_PACKAGE)
  const kind = await io.entryKind(marketPath)
  if (kind === 'missing') return false
  if (kind === 'link' && ((await io.linkTarget(marketPath))?.includes('.generations') ?? false)) return false
  return isUsableMarketVersion(await readProfileBundleVersion(io, paths.profileDir, MARKET_PACKAGE))
}

// ---------------------------------------------------------------------------
// 应用侧默认绑定
// ---------------------------------------------------------------------------

/** 受管 dsh 的 CLI 入口（npm 型安装布局，与 BinaryManager.installNpmTool 一致）。 */
function managedDshEntry(): string {
  return path.join(codeMateToolsRoot(), 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/** 受管 dsh 安装树里某个包的已装版本（读不到返回 undefined）。 */
async function installedPackageVersion(packageName: string): Promise<string | undefined> {
  try {
    const raw = await fsp.readFile(
      path.join(codeMateToolsRoot(), 'dsh', 'node_modules', ...packageName.split('/'), 'package.json'),
      'utf-8'
    )
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/**
 * 本机宿主事实——**选市场版本的依据**：dsh 自身的版本 + 各 `@deepseek-ai/*` 包在本机的
 * 已装版本（市场的 peer 声明要对上它们）。带一层进程内缓存：一次选版会问同一个包好几次。
 */
async function installedHostFacts(): Promise<HostFacts | undefined> {
  const dshVersion = await installedPackageVersion('@deepseek-ai/dsh')
  if (!dshVersion) return undefined
  const cache = new Map<string, string | undefined>()
  return {
    dshVersion,
    peerVersion: async (packageName) => {
      if (!cache.has(packageName)) cache.set(packageName, await installedPackageVersion(packageName))
      return cache.get(packageName)
    }
  }
}

function managedNodeBin(): string {
  const dir = nodeRuntimeDir(NODE_VERSION)
  return isWin ? path.join(dir, 'node.exe') : path.join(dir, 'bin', 'node')
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

/**
 * 受管命令环境（与 BinaryManager.installNpmTool 的 bundleEnv 同形，两处生命周期不同：
 * 那处是安装期、这处是启动前修复）。DSH_HOME 必须显式给——缺省时 profile 解析到 ~/.dsh，
 * 就是"装进 A 处、运行读 B 处"那次真机事故的成因。
 */
function marketCommandEnv(registry: string): NodeJS.ProcessEnv {
  const pathSep = isWin ? ';' : ':'
  const nodeDir = nodeRuntimeDir(NODE_VERSION)
  const nodeBinDir = isWin ? nodeDir : path.join(nodeDir, 'bin')
  const toolsBinDirs = managedToolBinDirs()
  const env = withPathPrepend(process.env, [nodeBinDir, ...toolsBinDirs], pathSep)
  env.DSH_HOME = deepSeekHarnessHome()
  env.npm_config_cache = path.join(cacheRoot(), 'npm')
  env.npm_config_store_dir = path.join(cacheRoot(), 'pnpm-store')
  env.npm_config_registry = registry
  return env
}

const managedMarketRunner: MarketCommandRunner = async (args, options) => {
  const nodeBin = managedNodeBin()
  const entry = managedDshEntry()
  for (const required of [nodeBin, entry]) {
    if (!(await pathExists(required))) {
      throw new Error(`${options.label} cannot run: ${required} is missing; install DeepSeek Harness first`)
    }
  }
  return runBoundedCommand(nodeBin, [entry, ...args], {
    env: marketCommandEnv(options.registry ?? NPM_REGISTRY_MIRROR),
    label: options.label,
    timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  })
}

async function defaultMarketOptions(): Promise<MarketChannelOptions> {
  const host = await installedHostFacts()
  return {
    dshHome: deepSeekHarnessHome(),
    io: nodeMarketIo,
    runner: managedMarketRunner,
    ...(host ? { host } : {}),
    note: (line) => logger.info(line)
  }
}

/** 安装面入口（BinaryManager 调用）：按已装 dsh 的兼容性挑版本、装进共享树并核验。 */
export async function installMarketBundle(): Promise<MarketInstallOutcome> {
  return installMarketBundleWith(await defaultMarketOptions())
}

/** 启动前入口（DeepSeekHarnessService 调用）：需要时才补装并核验。 */
export async function ensureMarketInstalled(): Promise<MarketInstallOutcome> {
  return ensureMarketInstalledWith(await defaultMarketOptions())
}

/** 现有市场是否仍可加载（补装失败时的降级判据）。 */
export function isMarketUsable(): Promise<boolean> {
  return isMarketUsableWith(nodeMarketIo, marketPaths(deepSeekHarnessHome()))
}

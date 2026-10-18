// fork 缝：编码助手 harness 启动自愈（2026-10-19）。
//
// 真机三代事故同一形状：核心换代后，社区 bundle 的 cordis.patch.yml 仍携带上一代
// 契约（最近一次：dsh-vision-router 2.3.0 覆盖官方 connection 行并注入本代已删除的
// webRuntime 服务），required 插件永远 pending，启动审计拒绝，进程 exit 1，用户只
// 看到一句英文哑弹。本模块只做三件事：
//   1. 从 harness 输出尾巴解析启动审计表（"Plugins waiting for services"）；
//   2. 把"等不到的服务"反查到肇事补丁文件（行为判据：审计行 × 补丁的 id/inject 声明，
//      不信 engines/peerDeps——DVR 2.3.0 声明兼容 rc.2 实际依赖已删除服务）；
//   3. 经组合层选择态可逆停用肇事 bundle：package.json 的 dsh.profile.bundles 正是
//      官方 pluginManager 持久化选择态的同一处（"Turning Off only deselects the
//      layer"），依赖保留、数据不碰，市场里重新勾选即恢复。
// 包管理命令一律不跑：变形手术归官方机器，这里只在 harness 已停的独占窗口里改选择态。
//
// 已知限制（有意为之）：patch 扫描是行级 naive 解析，覆盖官方与社区补丁的既有书写
// 形状（内联数组 + 逐项列表），不引 YAML 依赖——判据错漏的代价只是一次没点名的失败，
// 不是错误动作。
//
// main 测试环境 mock 了 node:fs/node:path（见 marketBaseline.test.ts 头注），故一切
// 文件访问经 HarnessAuditIo 端口注入，本文件不 import fs/path。

/** 一条启动审计等待行：插件 id、是否 required、缺的服务。 */
export interface StartupAuditEntry {
  pluginId: string
  required: boolean
  missing: string[]
}

/** 带启动审计的启动失败（DeepSeekHarnessService 在 waitForReady 处附加；表缺失时无此属性）。 */
export type DeepSeekHarnessStartupFailure = Error & { startupAudit?: StartupAuditEntry[] }

/** 从 harness 的 stdout/stderr 尾巴解析 "Plugins waiting for services (N):" 表。 */
export function parseStartupAudit(text: string): StartupAuditEntry[] {
  const lines = text.split(/\r?\n/)
  const headerIndex = lines.findIndex((line) => /^Plugins waiting for services \(\d+\):/.test(line.trim()))
  if (headerIndex < 0) return []
  const entries: StartupAuditEntry[] = []
  for (const line of lines.slice(headerIndex + 1)) {
    // 行形状："  connection (required)  webRuntime"——恰好两空格缩进，两空格以上分列。
    // 栈帧行以四空格起头，不匹配即表尾。
    const match = /^ {2}(\S.*?) {2,}(\S.*?)\s*$/.exec(line)
    if (!match) break
    const label = match[1]
    if (label === 'Plugin') continue // 表头行。
    entries.push({
      pluginId: label.replace(/ \(required\)$/, ''),
      required: label.endsWith(' (required)'),
      missing: match[2]
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    })
  }
  return entries
}

/** 一个补丁文件声明出的行 id 与注入服务集合。 */
export interface PatchDeclarations {
  ids: Set<string>
  injects: Set<string>
}

/**
 * 行级解析 cordis.patch.yml 里声明的 id 与 inject。
 * id 形状："- id: connection" / "id: 'web-runtime'"（requestId 之类不匹配：id 前必须是
 * 行首、空白或列表破折号）。inject 形状：内联 "inject: [webStartup]" 与逐项
 * "inject:\n  - webStartup" 两种。
 */
export function parsePatchDeclarations(patchYaml: string): PatchDeclarations {
  const ids = new Set<string>()
  const injects = new Set<string>()
  for (const match of patchYaml.matchAll(/(?:^|\n)[\t ]*(?:-[\t ]*)?id:[\t ]*['"]?([\w@/.-]+)/g)) {
    ids.add(match[1])
  }
  for (const match of patchYaml.matchAll(/inject:[\t ]*\[([^\]]*)\]/g)) {
    for (const item of match[1].split(',')) {
      const name = item.trim().replace(/^['"]|['"]$/g, '')
      if (name.length > 0) injects.add(name)
    }
  }
  for (const match of patchYaml.matchAll(/inject:[\t ]*\n((?:[\t ]*-[\t ]*[\w@/-]+[\t ]*(?:\n|$))+)/g)) {
    for (const item of match[1].matchAll(/-[\t ]*([\w@/-]+)/g)) injects.add(item[1])
  }
  return { ids, injects }
}

/** 文件访问端口：测试注入假件，运行侧由 DeepSeekHarnessService 提供真件。 */
export interface HarnessAuditIo {
  joinPath(...parts: string[]): string
  readText(file: string): Promise<string | undefined>
  writeText(file: string, contents: string): Promise<void>
}

/** 肇事 bundle：它的补丁覆盖了审计里正在等服务的行，或注入了审计里缺的服务。 */
export interface BundleCulprit {
  packageName: string
  patchFile: string
  retargeted: string[]
  injectedMissing: string[]
}

const OFFICIAL_SCOPE = '@deepseek-ai/'
const BUNDLE_PATCH_BASENAME = 'cordis.patch.yml'

/** 组合层 bundle 名单 = profile package.json 的 dependencies ∪ dsh.profile.bundles。 */
async function readBundlePackageNames(profileRoot: string, io: HarnessAuditIo): Promise<string[]> {
  const manifest = await io.readText(io.joinPath(profileRoot, 'package.json'))
  if (!manifest) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(manifest)
  } catch {
    return []
  }
  const root = parsed as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: unknown } }
  }
  const names = new Set<string>(Object.keys(root.dependencies ?? {}))
  const bundles = root.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    for (const item of bundles) if (typeof item === 'string') names.add(item)
  }
  return [...names]
}

async function readPatchDeclarations(patchFile: string, io: HarnessAuditIo): Promise<PatchDeclarations | undefined> {
  const text = await io.readText(patchFile)
  if (text === undefined) return undefined
  return parsePatchDeclarations(text)
}

/**
 * 把审计里"等不到服务"的行反查到社区补丁文件。只看社区包：官方树（@deepseek-ai/*）
 * 不在 profile 依赖里，其补丁由核心自己负责。
 */
export async function locateCulpritBundles(
  profileRoot: string,
  audit: StartupAuditEntry[],
  io: HarnessAuditIo
): Promise<BundleCulprit[]> {
  if (audit.length === 0) return []
  const culprits = new Map<string, BundleCulprit>()
  for (const packageName of await readBundlePackageNames(profileRoot, io)) {
    if (packageName.startsWith(OFFICIAL_SCOPE)) continue
    const patchFile = io.joinPath(profileRoot, 'node_modules', packageName, BUNDLE_PATCH_BASENAME)
    const declarations = await readPatchDeclarations(patchFile, io)
    if (!declarations) continue
    const retargeted: string[] = []
    const injectedMissing: string[] = []
    for (const entry of audit) {
      if (declarations.ids.has(entry.pluginId)) retargeted.push(entry.pluginId)
      for (const service of entry.missing) {
        if (declarations.injects.has(service)) injectedMissing.push(service)
      }
    }
    if (retargeted.length === 0 && injectedMissing.length === 0) continue
    culprits.set(packageName, {
      packageName,
      patchFile,
      retargeted,
      injectedMissing: [...new Set(injectedMissing)]
    })
  }
  return [...culprits.values()]
}

/** 首次自动停用时的原状备份后缀（只建一次，不覆盖更早的备份）。 */
export const AUTO_DISABLE_BACKUP_SUFFIX = '.pre-autodisable.json'

/**
 * 可逆停用：从 dsh.profile.bundles 移除该包（依赖保留）。返回是否发生了变更。
 * 备份落在 package.json 旁，文件名带 .pre-autodisable.json 后缀。
 */
export async function disableBundleSelection(
  profileRoot: string,
  packageName: string,
  io: HarnessAuditIo
): Promise<boolean> {
  const manifestFile = io.joinPath(profileRoot, 'package.json')
  const manifest = await io.readText(manifestFile)
  if (!manifest) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(manifest)
  } catch {
    return false
  }
  const root = parsed as { dsh?: { profile?: { bundles?: string[] } } }
  const bundles = root.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes(packageName)) return false
  const backupFile = manifestFile + AUTO_DISABLE_BACKUP_SUFFIX
  if ((await io.readText(backupFile)) === undefined) {
    await io.writeText(backupFile, manifest)
  }
  root.dsh = { ...root.dsh, profile: { ...root.dsh?.profile, bundles: bundles.filter((item) => item !== packageName) } }
  await io.writeText(manifestFile, `${JSON.stringify(root, null, 2)}\n`)
  return true
}

/** 换代预检风险项：社区补丁覆盖官方行 / 注入服务的声明清单（只进日志，不拦截）。 */
export interface CompositionRisk {
  packageName: string
  patchFile: string
  retargetedOfficialIds: string[]
  injectedServices: string[]
}

/** 官方行 id 集合：从官方 bundle 自己的 cordis.patch.yml 提取（Loader 读的就是它们，同源零漂移）。 */
export async function collectOfficialRowIds(officialBundleRoots: string[], io: HarnessAuditIo): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const bundleRoot of officialBundleRoots) {
    const text = await io.readText(io.joinPath(bundleRoot, BUNDLE_PATCH_BASENAME))
    if (!text) continue
    for (const id of parsePatchDeclarations(text).ids) ids.add(id)
  }
  return ids
}

/** 组合风险清单：社区补丁凡覆盖官方行或声明注入的，逐条登记。 */
export async function collectCompositionRisks(
  profileRoot: string,
  officialRowIds: ReadonlySet<string>,
  io: HarnessAuditIo
): Promise<CompositionRisk[]> {
  const risks: CompositionRisk[] = []
  for (const packageName of await readBundlePackageNames(profileRoot, io)) {
    if (packageName.startsWith(OFFICIAL_SCOPE)) continue
    const patchFile = io.joinPath(profileRoot, 'node_modules', packageName, BUNDLE_PATCH_BASENAME)
    const declarations = await readPatchDeclarations(patchFile, io)
    if (!declarations) continue
    const retargetedOfficialIds = [...declarations.ids].filter((id) => officialRowIds.has(id))
    const injectedServices = [...declarations.injects]
    if (retargetedOfficialIds.length === 0 && injectedServices.length === 0) continue
    risks.push({ packageName, patchFile, retargetedOfficialIds, injectedServices })
  }
  return risks
}

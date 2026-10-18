import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import type {
  AppUpdateErrorCode,
  AppUpdatePhase,
  AppUpdatePrefs,
  AppUpdateProgress,
  AppUpdateState
} from '@shared/types/appUpdate'
import { app, net } from 'electron'

import { windowService } from './WindowService'

const logger = loggerService.withContext('AppUpdateService')

export type { AppUpdateErrorCode, AppUpdatePhase, AppUpdatePrefs, AppUpdateProgress, AppUpdateState }

/** 默认更新源：本仓自己的 GitHub Releases（公开仓库，运行期不需要 token）。 */
export const DEFAULT_UPDATE_SOURCE = 'https://api.github.com/repos/ayzek7011/Re_Cherry'

const REQUEST_TIMEOUT_MS = 20_000
/** 启动后延迟多久做首次检查：不跟启动过程抢 IO。 */
const BOOT_CHECK_DELAY_MS = 15_000
/** 进度推送节流：500 ms 一次足够画进度条，别把 IPC 灌满。 */
const PROGRESS_TICK_MS = 500

export interface ReleaseAsset {
  name: string
  size?: number
  browser_download_url: string
  digest?: string | null
}

export interface ReleaseInfo {
  tag_name: string
  name?: string | null
  body?: string | null
  html_url?: string | null
  assets?: ReleaseAsset[]
}

/** `v1.2.3` → `1.2.3`。 */
export function normalizeTagVersion(tag: string): string {
  return tag.trim().replace(/^[vV]/, '')
}

/**
 * 版本比较。
 *
 * 本仓的版本方案是 `主.次.修` 后接可选的 `-修订号`（如 `0.4.6-1`），`-修订号` 表示
 * **`0.4.6` 之后的修订**，所以要当额外的一段数字来比，而不是 semver 的预发布段。
 * 非数字段按 0 处理（本仓版本号里不该出现预发布标记）。
 */
export function compareVersions(a: string, b: string): number {
  const segments = (value: string) =>
    normalizeTagVersion(value)
      .split(/[.+-]/)
      .filter((part) => part.length > 0)
      .map((part) => (/^\d+$/.test(part) ? Number(part) : 0))
  const left = segments(a)
  const right = segments(b)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l !== r) return l > r ? 1 : -1
  }
  return 0
}

/**
 * 安装包命名是 `${productName}-${version}-${arch}-setup.exe`。
 * 先精确到架构，再退到任意 setup；便携版（`-portable.exe`）不能自更新，故不作为首选。
 */
export function pickInstallerAsset(
  assets: ReleaseAsset[] | undefined,
  arch: string = process.arch
): ReleaseAsset | null {
  const list = (assets ?? []).filter((asset) => /\.exe$/i.test(asset.name) && !/\.blockmap$/i.test(asset.name))
  const setup = list.filter((asset) => /-setup\.exe$/i.test(asset.name))
  const matchesArch = (asset: ReleaseAsset) => asset.name.toLowerCase().includes(`-${arch.toLowerCase()}-`)
  return setup.find(matchesArch) ?? setup[0] ?? list.find(matchesArch) ?? list[0] ?? null
}

/** `sha256:abcd…` → `abcd…`（小写）；没有摘要或格式不认识时返回 null。 */
export function parseSha256Digest(digest: string | null | undefined): string | null {
  if (!digest) return null
  const match = digest.trim().match(/^sha256:([0-9a-f]{64})$/i)
  return match ? match[1].toLowerCase() : null
}

/**
 * 是否跑在便携版里。
 *
 * 便携版没有可替换的安装目录，装不了新版；它对"有新版本"只能给手动下载的引导。
 * 判定与 `VersionService.getInstallMode()` 同一口径（NSIS 便携目标会注入该环境变量）。
 */
export function isPortableRuntime(): boolean {
  return process.env.PORTABLE_EXECUTABLE_DIR !== undefined
}

/** 更新源规范化：空串或非法值用默认源；只接受 http(s)。 */
export function resolveSourceUrl(input: string | null | undefined): string {
  const raw = (input ?? '').trim()
  if (!/^https?:\/\//i.test(raw)) return DEFAULT_UPDATE_SOURCE
  return raw.replace(/\/+$/, '')
}

/** 取 Release 信息的端点：默认源本身就是 API 根，自建镜像按 `<base>/releases/latest` 拼。 */
export function buildReleaseEndpoint(source: string): string {
  const base = resolveSourceUrl(source)
  if (/\/releases\/latest$/i.test(base)) return base
  if (/\/releases$/i.test(base)) return `${base}/latest`
  return `${base}/releases/latest`
}

/**
 * 校验渲染层送来的偏好补丁：只接受认识的键与正确的类型，其余一概丢掉。
 * 主进程 handler 必须自己校验输入，不能把渲染层的形状当契约。
 */
export function parsePrefsPatch(raw: unknown): Partial<AppUpdatePrefs> {
  if (!raw || typeof raw !== 'object') return {}
  const input = raw as Record<string, unknown>
  const patch: Partial<AppUpdatePrefs> = {}
  if (typeof input.sourceUrl === 'string') patch.sourceUrl = input.sourceUrl
  if (typeof input.autoDownload === 'boolean') patch.autoDownload = input.autoDownload
  if (typeof input.ignoredVersion === 'string' || input.ignoredVersion === null) {
    patch.ignoredVersion = input.ignoredVersion
  }
  return patch
}

const DEFAULT_PREFS: AppUpdatePrefs = { sourceUrl: '', autoDownload: false, ignoredVersion: null }

class UpdateRequestError extends Error {
  constructor(
    public readonly code: AppUpdateErrorCode,
    detail: string
  ) {
    super(detail)
    this.name = 'UpdateRequestError'
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

class AppUpdateService {
  private state: AppUpdateState
  private prefs: AppUpdatePrefs = { ...DEFAULT_PREFS }
  private prefsLoaded = false
  private inFlight: Electron.ClientRequest | null = null
  private downloading = false
  private cancelRequested = false
  private downloaded: { version: string; path: string; name: string } | null = null
  private bootTimer: NodeJS.Timeout | null = null

  constructor() {
    this.state = {
      phase: 'idle',
      currentVersion: app.getVersion(),
      latestVersion: null,
      releaseNotes: null,
      releasePageUrl: null,
      assetName: null,
      assetSize: null,
      progress: null,
      ignored: false,
      verified: null,
      manual: false,
      errorCode: null,
      errorDetail: null
    }
  }

  // ------------------------------------------------------------------ 对外接口

  public getState(): AppUpdateState {
    return { ...this.state }
  }

  public async getPrefs(): Promise<AppUpdatePrefs> {
    await this.ensurePrefs()
    return { ...this.prefs }
  }

  public async setPrefs(patch: Partial<AppUpdatePrefs>): Promise<AppUpdatePrefs> {
    await this.ensurePrefs()
    if (patch.sourceUrl !== undefined) {
      const trimmed = patch.sourceUrl.trim()
      // 存"与默认源等价的值"没有意义：留空串，源变化时只改常量。
      this.prefs.sourceUrl = trimmed.length === 0 || resolveSourceUrl(trimmed) === DEFAULT_UPDATE_SOURCE ? '' : trimmed
    }
    if (patch.autoDownload !== undefined) this.prefs.autoDownload = patch.autoDownload === true
    if (patch.ignoredVersion !== undefined) {
      this.prefs.ignoredVersion = patch.ignoredVersion ? normalizeTagVersion(patch.ignoredVersion) : null
    }
    await this.persistPrefs()

    // 刚打开自动下载、手上又正好有可用版本：立即开始，不必等下一次检查。
    if (patch.autoDownload === true && this.state.phase === 'available' && !this.isIgnored()) {
      void this.download()
    }
    this.syncIgnoreFlag()
    return { ...this.prefs }
  }

  /** 启动后的首次检查。未打包（dev）默认不查，避免开发期误报；`RC_UPDATE_CHECK=1` 可强制。 */
  public scheduleBootCheck(): void {
    if (this.bootTimer) return
    if (!app.isPackaged && process.env.RC_UPDATE_CHECK !== '1') {
      logger.info('app update: boot check skipped (not packaged)')
      return
    }
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null
      void this.check({ manual: false })
    }, BOOT_CHECK_DELAY_MS)
    this.bootTimer.unref?.()
  }

  public async check(options: { manual?: boolean } = {}): Promise<AppUpdateState> {
    if (this.downloading || this.state.phase === 'checking') return this.getState()
    await this.ensurePrefs()
    this.patch({ phase: 'checking', manual: options.manual === true, errorCode: null, errorDetail: null })

    const endpoint = buildReleaseEndpoint(this.prefs.sourceUrl)
    let release: ReleaseInfo
    try {
      release = await this.fetchRelease(endpoint)
    } catch (error) {
      const code = error instanceof UpdateRequestError ? error.code : 'network'
      logger.warn(`app update: check failed (${code}) at ${endpoint}`)
      this.patch({ phase: 'error', errorCode: code, errorDetail: describeError(error) })
      return this.getState()
    }

    const latest = normalizeTagVersion(release.tag_name ?? '')
    if (latest.length === 0) {
      logger.warn('app update: release payload has no tag_name')
      this.patch({ phase: 'error', errorCode: 'parse', errorDetail: 'missing tag_name' })
      return this.getState()
    }

    const common = {
      latestVersion: latest,
      releaseNotes: release.body ?? null,
      releasePageUrl: release.html_url ?? null,
      manual: options.manual === true
    }

    if (compareVersions(latest, this.state.currentVersion) <= 0) {
      logger.info(`app update: up to date (latest ${latest}, current ${this.state.currentVersion})`)
      this.patch({
        ...common,
        phase: 'latest',
        assetName: null,
        assetSize: null,
        progress: null,
        verified: null,
        ignored: false
      })
      return this.getState()
    }

    const asset = pickInstallerAsset(release.assets)
    if (!asset) {
      logger.warn(`app update: ${latest} has no installer asset`)
      this.patch({ ...common, phase: 'error', errorCode: 'no-asset', errorDetail: 'no installer asset in release' })
      return this.getState()
    }

    // 便携版没有可替换的安装目录：能报"有新版本"，但只能引导手动下载。
    if (isPortableRuntime()) {
      logger.info(`app update: ${latest} available, but this build is portable (manual download only)`)
      this.patch({
        ...common,
        phase: 'error',
        assetName: asset.name,
        assetSize: asset.size ?? null,
        progress: null,
        verified: null,
        errorCode: 'unsupported',
        errorDetail: 'portable build cannot self-update'
      })
      return this.getState()
    }

    // 上一轮下过别的版本：清掉，避免临时目录里堆安装包。
    if (this.downloaded && this.downloaded.version !== latest) await this.removeDownloaded()

    this.patch({
      ...common,
      phase: 'available',
      assetName: asset.name,
      assetSize: asset.size ?? null,
      progress: null,
      verified: null,
      errorCode: null,
      errorDetail: null
    })
    this.syncIgnoreFlag()
    logger.info(`app update: ${latest} available (${asset.name})`)

    if (this.prefs.autoDownload && !this.state.ignored) void this.download()
    return this.getState()
  }

  public async download(): Promise<AppUpdateState> {
    if (isPortableRuntime()) {
      this.patch({ phase: 'error', errorCode: 'unsupported', errorDetail: 'portable build cannot self-update' })
      return this.getState()
    }
    if (this.state.phase !== 'available' && this.state.phase !== 'error') return this.getState()
    const version = this.state.latestVersion
    if (!version) return this.getState()
    await this.ensurePrefs()

    let release: ReleaseInfo
    try {
      release = await this.fetchRelease(buildReleaseEndpoint(this.prefs.sourceUrl))
    } catch (error) {
      const code = error instanceof UpdateRequestError ? error.code : 'network'
      this.patch({ phase: 'error', errorCode: code, errorDetail: describeError(error) })
      return this.getState()
    }

    const asset = pickInstallerAsset(release.assets)
    if (!asset) {
      this.patch({ phase: 'error', errorCode: 'no-asset', errorDetail: 'no installer asset in release' })
      return this.getState()
    }

    const target = join(await this.ensureDownloadDir(), asset.name)
    const expected = parseSha256Digest(asset.digest)
    if (!expected) logger.warn(`app update: ${asset.name} carries no sha256 digest, integrity is not checked`)

    this.downloading = true
    this.cancelRequested = false
    this.patch({
      phase: 'downloading',
      progress: { percent: 0, transferred: 0, total: asset.size ?? 0, bytesPerSecond: 0 },
      errorCode: null,
      errorDetail: null
    })

    try {
      await this.streamToFile(asset.browser_download_url, target, asset.size ?? 0, expected)
    } catch (error) {
      await rm(target, { force: true }).catch(() => undefined)
      this.downloading = false
      if (this.cancelRequested) {
        this.cancelRequested = false
        return this.getState()
      }
      const code = error instanceof UpdateRequestError ? error.code : 'io'
      logger.warn(`app update: download failed (${code})`)
      this.patch({ phase: 'error', progress: null, errorCode: code, errorDetail: describeError(error) })
      return this.getState()
    }

    this.downloading = false
    this.downloaded = { version, path: target, name: asset.name }
    this.patch({
      phase: 'downloaded',
      progress: { percent: 100, transferred: asset.size ?? 0, total: asset.size ?? 0, bytesPerSecond: 0 },
      verified: expected ? true : null
    })
    logger.info(`app update: ${asset.name} downloaded, ready to install`)
    return this.getState()
  }

  public cancelDownload(): AppUpdateState {
    if (this.state.phase !== 'downloading') return this.getState()
    this.cancelRequested = true
    this.inFlight?.abort()
    this.inFlight = null
    this.downloading = false
    logger.info('app update: download canceled')
    this.patch({ phase: 'available', progress: null })
    return this.getState()
  }

  /** 启动下载好的安装器并退出本进程（NSIS 需要本进程让出文件占用）。 */
  public async install(): Promise<boolean> {
    const file = this.downloaded
    if (isPortableRuntime()) return false
    if (this.state.phase !== 'downloaded' || !file) return false
    if (!(await isUsableFile(file.path))) {
      logger.warn(`app update: installer missing or empty (${file.path})`)
      this.patch({ phase: 'error', errorCode: 'io', errorDetail: 'installer file is missing or empty' })
      return false
    }

    logger.info(`app update: launching installer ${file.name}`)
    const child = spawn(file.path, [], { detached: true, stdio: 'ignore' })
    child.on('error', (error) => {
      logger.error(`app update: failed to launch installer (${describeError(error)})`)
    })
    child.unref()
    app.quit()
    return true
  }

  // ------------------------------------------------------------------ 内部实现

  private isIgnored(): boolean {
    return this.state.latestVersion !== null && this.prefs.ignoredVersion === this.state.latestVersion
  }

  private syncIgnoreFlag(): void {
    const ignored = this.isIgnored()
    if (ignored !== this.state.ignored) this.patch({ ignored })
  }

  private patch(next: Partial<AppUpdateState>): void {
    this.state = { ...this.state, ...next }
    this.emit()
  }

  private emit(): void {
    const window = windowService.getMainWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send(IpcChannel.App_Update_State, this.getState())
  }

  private async prefsPath(): Promise<string> {
    return join(app.getPath('userData'), 'app-update.json')
  }

  private async ensurePrefs(): Promise<void> {
    if (this.prefsLoaded) return
    this.prefsLoaded = true
    try {
      const parsed = JSON.parse(await readFile(await this.prefsPath(), 'utf-8')) as Partial<AppUpdatePrefs>
      this.prefs = {
        sourceUrl: typeof parsed.sourceUrl === 'string' ? parsed.sourceUrl : '',
        autoDownload: parsed.autoDownload === true,
        ignoredVersion: typeof parsed.ignoredVersion === 'string' ? parsed.ignoredVersion : null
      }
    } catch (error) {
      // 首次运行没有这个文件是正常形态；读坏了也不该让更新功能变成"不可用"：退回默认值并留日志。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`app update: prefs unreadable, using defaults (${describeError(error)})`)
      }
      this.prefs = { ...DEFAULT_PREFS }
    }
  }

  private async persistPrefs(): Promise<void> {
    try {
      await writeFile(await this.prefsPath(), `${JSON.stringify(this.prefs, null, 2)}\n`, 'utf-8')
    } catch (error) {
      logger.warn(`app update: prefs not persisted (${describeError(error)})`)
    }
  }

  private async ensureDownloadDir(): Promise<string> {
    const dir = join(app.getPath('temp'), 're-cherry-update')
    await mkdir(dir, { recursive: true })
    return dir
  }

  private async removeDownloaded(): Promise<void> {
    const file = this.downloaded
    this.downloaded = null
    if (file) await rm(file.path, { force: true }).catch(() => undefined)
  }

  private fetchRelease(endpoint: string): Promise<ReleaseInfo> {
    return new Promise<ReleaseInfo>((resolve, reject) => {
      const request = net.request({ method: 'GET', url: endpoint, redirect: 'follow' })
      this.inFlight = request
      request.setHeader('Accept', 'application/vnd.github+json')
      request.setHeader('User-Agent', `Re_Cherry/${app.getVersion()}`)
      const timer = setTimeout(() => {
        request.abort()
        reject(new UpdateRequestError('network', `request timeout after ${REQUEST_TIMEOUT_MS} ms`))
      }, REQUEST_TIMEOUT_MS)

      request.on('response', (response) => {
        clearTimeout(timer)
        if (response.statusCode < 200 || response.statusCode >= 300) {
          // 把响应体排空，避免连接挂在那儿（Electron 的 IncomingMessage 没有 resume()）。
          response.on('data', () => undefined)
          reject(new UpdateRequestError('http', `HTTP ${response.statusCode}`))
          return
        }
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as ReleaseInfo)
          } catch (error) {
            reject(new UpdateRequestError('parse', describeError(error)))
          }
        })
        response.on('error', (error: Error) => reject(new UpdateRequestError('network', describeError(error))))
      })
      request.on('error', (error) => {
        clearTimeout(timer)
        reject(new UpdateRequestError('network', describeError(error)))
      })
      request.end()
    })
  }

  private streamToFile(
    url: string,
    target: string,
    expectedSize: number,
    expectedSha256: string | null
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const hash = createHash('sha256')
      const out = createWriteStream(target)
      const request = net.request({ method: 'GET', url, redirect: 'follow' })
      this.inFlight = request
      request.setHeader('User-Agent', `Re_Cherry/${app.getVersion()}`)

      let transferred = 0
      let total = expectedSize
      let lastTick = Date.now()
      let lastBytes = 0

      const fail = (error: Error) => {
        out.destroy()
        request.abort()
        this.inFlight = null
        reject(error)
      }

      request.on('response', (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.on('data', () => undefined)
          fail(new UpdateRequestError('http', `HTTP ${response.statusCode}`))
          return
        }
        const declared = Number(
          Array.isArray(response.headers['content-length'])
            ? response.headers['content-length'][0]
            : response.headers['content-length']
        )
        if (Number.isFinite(declared) && declared > 0) total = declared

        response.on('data', (chunk: Buffer) => {
          transferred += chunk.length
          hash.update(chunk)
          out.write(chunk)
          const now = Date.now()
          if (now - lastTick >= PROGRESS_TICK_MS) {
            const elapsed = (now - lastTick) / 1000
            this.patch({
              progress: {
                // 完成前不显示 100%：写入收尾与摘要校验还没走完。
                percent: total > 0 ? Math.min(99, Math.round((transferred / total) * 100)) : 0,
                transferred,
                total,
                bytesPerSecond: elapsed > 0 ? Math.round((transferred - lastBytes) / elapsed) : 0
              }
            })
            lastTick = now
            lastBytes = transferred
          }
        })
        response.on('end', () => {
          out.end(() => {
            this.inFlight = null
            if (expectedSha256) {
              const actual = hash.digest('hex').toLowerCase()
              if (actual !== expectedSha256) {
                reject(new UpdateRequestError('digest', `sha256 mismatch (expected ${expectedSha256}, got ${actual})`))
                return
              }
            }
            resolve()
          })
        })
        response.on('error', (error: Error) => fail(new UpdateRequestError('network', describeError(error))))
      })
      request.on('error', (error) => fail(new UpdateRequestError('network', describeError(error))))
      out.on('error', (error) => fail(new UpdateRequestError('io', describeError(error))))
      request.end()
    })
  }
}

/** 安装器落地检查：文件不存在或为空都不许静默地"启动成功"。 */
export async function isUsableFile(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

export const appUpdateService = new AppUpdateService()

// fork 缝（原创）：npm 包 `bin` 声明的入口文件解析。
//
// 为什么需要它：受管 dsh 的"可执行物"是 npm 生成的转发 shim
// （`<toolDir>/node_modules/.bin/dsh.cmd`），内容形如
// `"%_prog%" "%dp0%\..\@deepseek-ai\dsh\lib\bin.js" %*`——shim 本身只是壳，**真正能不能起来
// 取决于它指向的入口文件在不在**。此前安装收尾只检查 shim 存在，于是"装完了但起不来"
// （真机报错：`...\tools\dsh\node_modules\bin\dsh.cmd ... it failed to run (--version)`）
// 能一路报到安装成功：用户拿到一句"可能是损坏或过时的安装"，而真因（入口文件缺失/声明与实际
// 不一致）谁也不知道。
//
// 解析本身是纯函数（`parseBinTarget`），便于单测覆盖各种 manifest 形态；读文件走注入的 io
// 接口，与 marketBaseline 的 `nodeMarketIo` 同一种做法（同样的理由：可测、可换实现）。

export interface BinManifestIo {
  readFile(filePath: string): Promise<string>
}

/** 把一层 `..` / `.` 与混用的分隔符折叠掉；`../..` 这类逃逸因此会保留成前导 `..`。 */
function normalizeRelative(relative: string): string[] {
  const segments: string[] = []
  for (const raw of relative.split(/[\\/]+/)) {
    if (!raw || raw === '.') continue
    if (raw === '..') {
      // 已经到顶还继续 `..` ⇒ 逃出包目录，保留下来让下面的前缀检查拒掉。
      if (segments.length === 0 || segments[segments.length - 1] === '..') segments.push('..')
      else segments.pop()
      continue
    }
    segments.push(raw)
  }
  return segments
}

/**
 * 从 `package.json` 原文里取出 `binName` 对应的入口文件路径（**包目录内的绝对路径**）。
 *
 * 解析不到、或声明指向包目录之外（异常/恶意 manifest 想借 `../..` 把"入口"指到别处），
 * 都返回 undefined——调用方据此跳过核验，绝不按猜出来的路径做判断。
 *
 * - `bin` 是字符串：包名只有一条命令时 npm 的简写形态（此时命令名由包名决定，调用方传的
 *   binName 无从核对，故照收）。
 * - `bin` 是对象：标准形态，按 `binName` 取值。
 * - 缺 `bin` / 类型不对 / JSON 损坏：undefined。
 */
export function parseBinTarget(
  packageDir: string,
  binName: string,
  manifestText: string,
  sep = '\\'
): string | undefined {
  let parsed: { bin?: unknown }
  try {
    parsed = JSON.parse(manifestText) as { bin?: unknown }
  } catch {
    return undefined
  }
  const bin = parsed.bin
  let relative: string | undefined
  if (typeof bin === 'string') relative = bin
  else if (bin && typeof bin === 'object' && !Array.isArray(bin)) {
    const target = (bin as Record<string, unknown>)[binName]
    if (typeof target === 'string') relative = target
  }
  if (!relative) return undefined
  const segments = normalizeRelative(relative)
  if (segments.length === 0 || segments.includes('..')) return undefined
  return [packageDir, ...segments].join(sep)
}

/** 读包 manifest 并解析入口文件；读不到（包没装上/manifest 缺失）返回 undefined。 */
export async function resolveNpmBinTarget(
  io: BinManifestIo,
  packageDir: string,
  binName: string,
  separator: string
): Promise<string | undefined> {
  let manifestText: string
  try {
    manifestText = await io.readFile(`${packageDir}${separator}package.json`)
  } catch {
    return undefined
  }
  return parseBinTarget(packageDir, binName, manifestText, separator)
}

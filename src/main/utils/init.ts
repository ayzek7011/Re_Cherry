import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isLinux, isPortable, isWin } from '@main/constant'
import { HOME_CHERRY_DIR } from '@shared/config/constant'
import { app } from 'electron'

// Please don't import any other modules which is not node/electron built-in modules

function hasWritePermission(path: string) {
  try {
    fs.accessSync(path, fs.constants.W_OK)
    return true
  } catch (error) {
    return false
  }
}

function getConfigDir() {
  return path.join(os.homedir(), HOME_CHERRY_DIR, 'config')
}

export function initAppDataDir() {
  const registered = getRegisteredAppDataPath()
  if (registered.status === 'ok' && registered.path) {
    app.setPath('userData', registered.path)
    recordDataPathForUninstaller(registered.path)
    return
  }
  if (registered.status === 'missing' && registered.path) {
    // 登记的数据目录不可用：默认目录里可能躺着上一世的数据（真机：Roaming 残影），
    // 回落会让旧聊天记录"诈尸"。只留证据不改行为——回落本身是既定语义。
    process.stderr.write(
      `[init] registered data directory is unavailable, falling back to the default location: ${registered.path}\n`
    )
  }

  if (isPortable) {
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
    const portableDataPath = path.join(portableDir || app.getPath('exe'), 'data')
    app.setPath('userData', portableDataPath)
    recordDataPathForUninstaller(portableDataPath)
    return
  }
  recordDataPathForUninstaller(app.getPath('userData'))
}

type RegisteredAppDataPath = { status: 'none' } | { status: 'missing'; path: string } | { status: 'ok'; path: string }

function getRegisteredAppDataPath(): RegisteredAppDataPath {
  try {
    const configPath = path.join(getConfigDir(), 'config.json')
    if (!fs.existsSync(configPath)) {
      return { status: 'none' }
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))

    if (!config.appDataPath) {
      return { status: 'none' }
    }

    let executablePath = app.getPath('exe')
    if (isLinux && process.env.APPIMAGE) {
      // 如果是 AppImage 打包的应用，直接使用 APPIMAGE 环境变量
      // 这样可以确保获取到正确的可执行文件路径
      executablePath = path.join(path.dirname(process.env.APPIMAGE), 'cherry-studio.appimage')
    }

    if (isWin && isPortable) {
      executablePath = path.join(process.env.PORTABLE_EXECUTABLE_DIR || '', 'cherry-studio-portable.exe')
    }

    let appDataPath = null
    // 兼容旧版本
    if (config.appDataPath && typeof config.appDataPath === 'string') {
      appDataPath = config.appDataPath
      // 将旧版本数据迁移到新版本
      appDataPath && updateAppDataConfig(appDataPath)
    } else {
      appDataPath = config.appDataPath.find(
        (item: { executablePath: string }) => item.executablePath === executablePath
      )?.dataPath
    }

    if (appDataPath && fs.existsSync(appDataPath) && hasWritePermission(appDataPath)) {
      return { status: 'ok', path: appDataPath }
    }
    if (appDataPath) {
      return { status: 'missing', path: appDataPath }
    }

    return { status: 'none' }
  } catch (error) {
    return { status: 'none' }
  }
}

/**
 * 把最终 userData 落点登记进注册表，NSIS 卸载器据此提供"同时删除应用数据"。
 * 只在打包版跑（bootstrap 门）；失败只留 stderr 证据——注册表是卸载器的便利，
 * 不是正确性依赖。
 */
function recordDataPathForUninstaller(userDataPath: string) {
  if (process.platform !== 'win32') return
  try {
    const child = spawn(
      'reg',
      ['add', 'HKCU\\Software\\Re_Cherry', '/v', 'DataPath', '/t', 'REG_SZ', '/d', userDataPath, '/f'],
      { windowsHide: true, stdio: 'ignore' }
    )
    child.on('error', () => {
      process.stderr.write('[init] could not record the data path for the uninstaller\n')
    })
  } catch {
    process.stderr.write('[init] could not record the data path for the uninstaller\n')
  }
}

export function updateAppDataConfig(appDataPath: string) {
  const configDir = getConfigDir()
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }

  // config.json
  // appDataPath: [{ executablePath: string, dataPath: string }]
  const configPath = path.join(configDir, 'config.json')
  let executablePath = app.getPath('exe')
  if (isLinux && process.env.APPIMAGE) {
    executablePath = path.join(path.dirname(process.env.APPIMAGE), 'cherry-studio.appimage')
  }

  // 如果是 Windows 可移植版本，则使用 PORTABLE_EXECUTABLE_FILE 环境变量
  if (isWin && isPortable) {
    executablePath = path.join(process.env.PORTABLE_EXECUTABLE_DIR || '', 'cherry-studio-portable.exe')
  }

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({ appDataPath: [{ executablePath, dataPath: appDataPath }] }, null, 2))
    return
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  if (!config.appDataPath || (config.appDataPath && typeof config.appDataPath !== 'object')) {
    config.appDataPath = []
  }

  const existingPath = config.appDataPath.find(
    (item: { executablePath: string }) => item.executablePath === executablePath
  )

  if (existingPath) {
    existingPath.dataPath = appDataPath
  } else {
    config.appDataPath.push({ executablePath, dataPath: appDataPath })
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

/**
 * 启动自愈契约（真机三代事故的判据件）。
 *
 * 样本取自真机日志：dsh 0.2.1-rc.2 上 dsh-vision-router 2.3.0 的补丁覆盖官方
 * connection 行并注入本代已删除的 webRuntime 服务，required 插件永远 pending，
 * 启动审计拒绝。判据只有行为层：审计行 × 补丁声明的 id/inject。声明类检查
 * （engines/peerDeps）不做判据——DVR 2.3.0 的 peerDeps 声称兼容 rc.2，实际依赖
 * 已删除服务。
 *
 * 本模块不触 node:fs/node:path（main 测试环境 mock 了它们），用 FakeIo 端口驱动。
 */
import { describe, expect, it } from 'vitest'

import {
  collectCompositionRisks,
  collectOfficialRowIds,
  disableBundleSelection,
  locateCulpritBundles,
  parsePatchDeclarations,
  parseStartupAudit
} from '../harnessStartupAudit'

/** 真机日志原文（2026-10-18，startup-2026-10-18T14-25-42，四次启动同签名）。 */
const REAL_FAILURE_TAIL = `dsh: startup failed: 1 required plugin did not activate

Plugins waiting for services (9):
  Plugin                 Missing services
  connection (required)  webRuntime
  session-log-download   connection
  open-in-app            connection
  session-controller     fileUploads
  schedule               sessionController
  file-upload            connection
  ui-deliverables        connection, sessionController
  better-sidebar         webRuntime
  mobile-access          connection
    at auditStartupEntries (file:///F:/Some/Where/dsh-app-boot/lib/index.js:4467:31)
    at async boot (file:///F:/Some/Where/dsh-app-boot/lib/index.js:4541:3)
`

/** 真机肇事补丁的形状（dsh-vision-router 2.3.0 的 cordis.patch.yml 节选）。 */
const VISION_ROUTER_PATCH = `# dsh-vision-router bundle layer
- id: modules
  name: '@deepseek-ai/dsh-client-modules'
  inject: [webServer]

- id: connection
  name: '@deepseek-ai/dsh-client-connection'
  inject: [webRuntime, webServer]

- insert:
    - id: vision-router
      name: dsh-vision-router
      config:
        progressiveTools: false

- id: attachment-local
  config:
    maxImageBytes: 20971520
`

class FakeIo {
  readonly files = new Map<string, string>()
  joinPath = (...parts: string[]): string => parts.join('/')
  readText = async (file: string): Promise<string | undefined> => this.files.get(file)
  writeText = async (file: string, contents: string): Promise<void> => {
    this.files.set(file, contents)
  }
}

function writeProfile(io: FakeIo): void {
  io.files.set(
    'profile/package.json',
    JSON.stringify({
      dependencies: { 'dsh-vision-router': '2.3.0', dshmarket: '1.66.39' },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket', 'dsh-vision-router']
        }
      }
    })
  )
  io.files.set('profile/node_modules/dsh-vision-router/cordis.patch.yml', VISION_ROUTER_PATCH)
  io.files.set(
    'profile/node_modules/dshmarket/cordis.patch.yml',
    '# market: no official row overrides\n- insert:\n    - id: market-ui\n      name: dshmarket\n'
  )
}

describe('parseStartupAudit', () => {
  it('解析真机审计表：required 标记与缺失服务', () => {
    const audit = parseStartupAudit(REAL_FAILURE_TAIL)
    expect(audit).toHaveLength(9)
    expect(audit[0]).toEqual({ pluginId: 'connection', required: true, missing: ['webRuntime'] })
    const deliverables = audit.find((entry) => entry.pluginId === 'ui-deliverables')
    expect(deliverables).toEqual({
      pluginId: 'ui-deliverables',
      required: false,
      missing: ['connection', 'sessionController']
    })
    expect(audit.find((entry) => entry.pluginId === 'better-sidebar')?.required).toBe(false)
  })

  it('没有审计表时返回空（启动失败另有原因，自愈不介入）', () => {
    expect(parseStartupAudit('DeepSeek Harness startup timed out\n')).toEqual([])
    expect(parseStartupAudit('')).toEqual([])
  })
})

describe('parsePatchDeclarations', () => {
  it('识别列表 id 与内联 inject', () => {
    const declarations = parsePatchDeclarations(VISION_ROUTER_PATCH)
    expect(declarations.ids).toEqual(new Set(['modules', 'connection', 'vision-router', 'attachment-local']))
    expect(declarations.injects).toEqual(new Set(['webServer', 'webRuntime']))
  })

  it('识别逐项 inject 列表', () => {
    const declarations = parsePatchDeclarations('some:\n  inject:\n    - webStartup\n    - credentials\n')
    expect(declarations.injects).toEqual(new Set(['webStartup', 'credentials']))
  })

  it('requestId 之类不误报为 id', () => {
    const declarations = parsePatchDeclarations('someRow:\n  requestId: abc\n')
    expect(declarations.ids.size).toBe(0)
  })
})

describe('locateCulpritBundles', () => {
  it('真机形状：把 connection 的死因反查到 dsh-vision-router 的补丁', async () => {
    const io = new FakeIo()
    writeProfile(io)
    const audit = parseStartupAudit(REAL_FAILURE_TAIL)
    const culprits = await locateCulpritBundles('profile', audit, io)
    expect(culprits).toHaveLength(1)
    expect(culprits[0].packageName).toBe('dsh-vision-router')
    expect(culprits[0].retargeted).toEqual(['connection'])
    expect(culprits[0].injectedMissing).toEqual(['webRuntime'])
  })

  it('官方范围包与无相关声明的补丁不进肇事名单', async () => {
    const io = new FakeIo()
    writeProfile(io)
    io.files.set('profile/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml', '- id: connection\n  name: x\n')
    const audit = parseStartupAudit(REAL_FAILURE_TAIL)
    const culprits = await locateCulpritBundles('profile', audit, io)
    expect(culprits.map((culprit) => culprit.packageName)).toEqual(['dsh-vision-router'])
  })
})

describe('disableBundleSelection', () => {
  it('只取消选择态：bundles 移除、依赖保留、首次留备份', async () => {
    const io = new FakeIo()
    writeProfile(io)
    await expect(disableBundleSelection('profile', 'dsh-vision-router', io)).resolves.toBe(true)
    const manifest = JSON.parse(io.files.get('profile/package.json') ?? '{}')
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket'])
    expect(manifest.dependencies['dsh-vision-router']).toBe('2.3.0')
    expect(io.files.get('profile/package.json.pre-autodisable.json')).toBeDefined()
  })

  it('备份只建一次；重复停用与未知包不再变更', async () => {
    const io = new FakeIo()
    writeProfile(io)
    await disableBundleSelection('profile', 'dsh-vision-router', io)
    io.files.set('profile/package.json.pre-autodisable.json', 'KEEP-OLD-BACKUP')
    await expect(disableBundleSelection('profile', 'dsh-vision-router', io)).resolves.toBe(false)
    await expect(disableBundleSelection('profile', 'not-installed', io)).resolves.toBe(false)
    expect(io.files.get('profile/package.json.pre-autodisable.json')).toBe('KEEP-OLD-BACKUP')
  })
})

describe('collectOfficialRowIds / collectCompositionRisks', () => {
  it('官方行集合来自官方补丁本体；社区覆盖与注入逐条登记', async () => {
    const io = new FakeIo()
    io.files.set('tools/@deepseek-ai/dsh-base/cordis.patch.yml', '- id: tool-bash\n  disabled: true\n')
    io.files.set('tools/@deepseek-ai/dsh-web-app/cordis.patch.yml', '- insert:\n    - id: connection\n      name: x\n')
    const officialRowIds = await collectOfficialRowIds(
      ['tools/@deepseek-ai/dsh-base', 'tools/@deepseek-ai/dsh-web-app'],
      io
    )
    expect(officialRowIds).toEqual(new Set(['tool-bash', 'connection']))
    writeProfile(io)
    const risks = await collectCompositionRisks('profile', officialRowIds, io)
    expect(risks).toHaveLength(1)
    expect(risks[0].packageName).toBe('dsh-vision-router')
    expect(risks[0].retargetedOfficialIds).toEqual(['connection'])
    expect(risks[0].injectedServices).toEqual(['webServer', 'webRuntime'])
  })
})

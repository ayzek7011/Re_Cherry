# 发布流程

## 版本号与 tag

- 版本号写在 `package.json` 的 `version`。tag 用 `git tag -a v<version>`（带注释的 tag）。
- 一个 tag 对应一次可交付的代码状态。tag 指向提交，不指向工作区。
- 发布说明写在 `electron-builder.yml` 的 `releaseInfo.releaseNotes`。

## 发布说明格式

`releaseNotes` 是**多语块**字符串，最新的版本在最前面。

```
releaseInfo:
  releaseNotes: |
    <!--LANG:en-->
    Re_Cherry <版本> - <一行标题>

    <一段概述>

    <分组标题>
    - <一条变更>

    <!--LANG:zh-CN-->
    <同上，中文>

    <!--LANG:END-->
```

写新版本时在最前面插入一组 `<!--LANG:en-->` + `<!--LANG:zh-CN-->`，保留旧版本块。

## 步骤

1. 在干净工作区跑全档门禁（见 quality-gates.md）。
2. 改 `package.json` 的 `version`。
3. 在 `electron-builder.yml` 的 `releaseNotes` 前面插入新版本的英中两块。
4. 提交。
5. `git tag -a v<version> -m '<标题>'`。
6. 需要产物时打包：`pnpm build:win:x64 --publish never`。
   `--publish never` 必带。CI 模式会尝试发布到 GitHub 并失败。
7. 验收产物：启动它，打开聊天页，再打开一个懒加载路由。

## 应用内更新

更新是自研的：主进程查 GitHub Release、自己下载、自己校验摘要、自己拉起安装器。**没有 electron-updater**，
所以发布时不需要 `latest.yml`，只有安装包本身。

| 项 | 事实 |
|---|---|
| 默认更新源 | `https://api.github.com/repos/ayzek7011/Re_Cherry`（公开仓库，运行期不需要 token） |
| 端点形态 | `<源>/releases/latest`；自建镜像按同一形状提供 |
| 取哪个资产 | `Re_Cherry-<版本>-<架构>-setup.exe` |
| 便携版 | 没有可替换的安装目录，不能自更新，只给手动下载的引导 |
| 完整性 | 用 GitHub 资产自带的 `digest: sha256:…`；源没给摘要时如实标"未校验" |
| 偏好 | `{userData}/app-update.json`（更新源 / 自动下载 / 被忽略的版本） |
| 首次检查 | 启动后 15 s 一次；未打包时默认不查，`RC_UPDATE_CHECK=1` 可强制 |
| 安装 | 启动已下载的安装器，然后退出本进程（NSIS 需要本进程让出文件占用） |

要让一个版本可被更新，只需要在 Release 里附上 `-setup.exe`（命名与 `artifactName` 一致）。
换自建更新源时，该源需提供 `<源>/releases/latest`，返回 GitHub Release API 形状的 JSON。

## 打包契约

打包由 `electron-builder.yml` 与三个脚本共同保证：

| 脚本 | 职责 |
|---|---|
| `scripts/before-pack.js` | 打包前准备 |
| `scripts/after-pack.js` | 交付后断言：原生闭包必须真的落在 `app.asar.unpacked` |
| `scripts/notarize.js` | 签名后的公证（macOS） |

`after-pack.js` 断言的原生件：`sharp` 的平台包与 libvips DLL、`onnxruntime-node` 的绑定与 DLL、
`ppu-ocv`、`@napi-rs/canvas` 及其平台包。缺件在打包期变红，不进真机。

因为 electron-builder 看不见顶层可解析包的 `optionalDependencies`，平台二进制必须在根
`package.json` 的 `optionalDependencies` 里显式声明，并在 `asarUnpack` 里显式列出。

## 构建期不变式

`electron.vite.config.ts` 里有一条构建期断言：产物中不得出现 `require.cache` 的改写。
被内联进产物的包若执行 `delete require.cache[__filename]`，它会删掉入口模块自己，
之后任何 chunk 的 `require` 都会重跑整份入口（表现为 IPC 二次注册、内核启动失败）。

运行时要在主进程 `require` 的包必须声明在根 `dependencies`：`external` 名单取自它，
打包收集也取自它。

## 上线前冒烟

`tools/smoke-cdp.cjs` 通过 DevTools 协议连一个已构建的实例。启动应用时给
`RC_REMOTE_DEBUG_PORT=<端口>`，另开终端执行：

```
node tools/smoke-cdp.cjs <端口>
```

只看四项：`rootMounted`、`apiBridge`、`mcpCheckCommand`、`errors` 为空。
脚本里的 `hasSidebar` / `hasMainContent` 是启发式选择器，本应用用 div + styled-components，
这两项恒为 false，不作为判据。

## 首屏面复测

改动 chunk 切分前后各测一次：

```
pnpm build
node tools/measure-eager.cjs [--json]
```

它只读 `out/renderer`，不改任何东西。数字口径见 limits-and-baseline.md。

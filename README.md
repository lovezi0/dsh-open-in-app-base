# dsh-open-in-app-base

[DeepSeek Harness](https://www.deepseek.com/harness)（DSH）第三方插件：在会话（Session）头部工具栏提供一个 **"Open In..." 按钮组底座**。

DSH 原生 "Open In..." 按钮内置的软件清单是编译期固定的，客户端还有一层白名单过滤，第三方软件无法接入，官方也没有开放应用级扩展点。本插件不 fork 宿主、不修改宿主配置：它在同一位置提供一个自己的按钮组，并把「用哪个软件打开」开放成一个注册契约——同类插件注册自己的目标软件，即会出现在菜单里，且外观与原生按钮一致。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE) [![npm](https://img.shields.io/npm/v/dsh-open-in-app-base.svg?label=npm&labelColor=000000&color=ff4b01)](https://www.npmjs.com/package/dsh-open-in-app-base) [![DeepSeek Harness:0.2.0-rc.1](https://img.shields.io/badge/DeepSeek%20Harness-0.2.0--rc.1-success.svg?labelColor=4D6BFE)](https://github.com/deepseek-ai/deepseek-harness) [![Desktop: supported](https://img.shields.io/badge/Desktop-supported-success.svg?labelColor=4D6BFE)](#安装)

## 特性

- **开放插槽**：贡献方注册 `id` / `label` / `route`（可选 `icon` / `order`）即可加入菜单，无需接触本插件源码。
- **外观统一**：按钮规格（24px 高、11px 字号、0.5px 描边、圆角与 hover）对齐原生 split 按钮；贡献方只提供图标路径数据，尺寸、描边、颜色与按钮结构由底座渲染。
- **零宿主面**：底座自身不注册本机路由、不启动任何进程；目标软件的探测与启动留在贡献方自己的插件里，安全边界清晰。
- **隐身优先**：没有任何已注册目标、已注册目标全部不可用、或当前会话还没有工作区时，按钮整体不渲染。
- **双端一致**：web profile 与 Desktop（Electron）加载同一份浏览器产物。

## 安装

```bash
# web profile（命令行）
dsh plugin --profile web add dsh-open-in-app-base

# Desktop 在应用内 Plugins 页安装
dsh-open-in-app-base
```

> 本插件是「Open In...」下游插件的共同依赖：下游插件只提供目标软件与打开逻辑，按钮与菜单由本插件渲染——只装下游插件时功能不会出现，两者需一并安装。下游插件的安装说明里也应显式写明这一点（见《开发指南》）。

## 使用

按钮出现在会话头部工具栏（原生 "Open In..." 的右侧）：

- 点击按钮（图标或右侧下拉箭头）展开按钮组菜单，菜单里选中某个软件才真正打开当前会话的工作区目录——下游装了 1 个还是多个，交互一致；
- 菜单里选过的软件会在本次会话内被记住，并在菜单中打勾；
- 目标软件未安装（或探测失败）时不会出现在菜单里；全部不可用时整个按钮不渲染。

## 扩展开发

想写一个指向某软件的 Open In 下游插件？注册契约、客户端半边与宿主半边的最小实现、四条硬要求、下游安装说明模板与常见坑，见 **[DEVELOPMENT.md](./DEVELOPMENT.md)**。本仓库的构建与自测同样在该文件。

## 工作原理（简述）

插件分两半：宿主半边是空的 `apply`（只为让插件出现在宿主加载层里），浏览器半边在会话头部槽位注册按钮组，并以 cordis 服务 `openInAppTargets` 暴露注册表。按钮组挂载后并发探测各已注册目标的可用性，据此决定是否渲染以及是否显示下拉菜单；点击后向目标自己的路由发起请求，由目标插件完成「用什么命令、在什么平台、怎么探测安装」这些具体实现。

## 第三方素材

图标来自 [lucide](https://lucide.dev)（ISC 许可），源文件位于 `assets/`，构建时以路径数据内联进浏览器产物。

## 版本历史

- **0.1.0** 
    - 🔥add plugin dsh-open-in-app-base

## License

[MIT](./LICENSE)

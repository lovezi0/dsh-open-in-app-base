# 开发指南

本文件面向两件事：

1. 为会话头部的「Open In...」按钮组写一个指向某软件的**下游插件**；
2. 本仓库自身的构建与自测。

分工先说清：**按钮与菜单由底座渲染、外观统一**，下游只提供「目标软件」——向上游注册一条记录，并在自己的宿主半边实现「是否可用」与「怎么打开」。底座不注册任何本机路由、不启动任何进程，探测与启动的边界都留在下游插件里。

## 写一个 Open In 下游插件

### 1. 注册契约

在插件里向注册表服务 `openInAppTargets` 注册一个目标：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 稳定唯一标识；同一 id 重复注册会抛错 |
| `label` | ✅ | 显示名（纯文本，本地化由贡献方自理） |
| `route` | ✅ | 目标路由前缀，**文档相对路径**（如 `open-myapp`，不以 `/` 开头、不含协议） |
| `icon` | — | 24×24 描边图标的 `<path d>` 字符串数组；缺省用内置默认图标 |
| `order` | — | 菜单内升序（默认 0） |

`register()` 返回反注册函数，建议放进 `ctx.effect` 以便插件卸载时自动撤销。

### 2. 客户端半边

```js
export const inject = ["openInAppTargets"]

export function apply(ctx) {
  ctx.effect(() => ctx.openInAppTargets.register({
    id: "myapp",
    label: "My App",
    route: "open-myapp",
    icon: ["M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6", "m21 3-9 9", "M15 3h6v6"],
  }), "myapp: open target")
}
```

> 手写浏览器 bundle 的插件（`window.__ModuleLoader__.load({ id, factory })`）照旧：`factory` 返回的对象里带 `inject` 与 `apply` 即可，其中 `id` 必须等于包名。

### 3. 宿主半边：两条同源路由

底座按约定调用贡献方的两条路由，路径即 `<route>/...`（相对当前页面，web 与 `dsh-app://` 下均同源）：

| 端点 | 约定 |
|---|---|
| `GET <route>/available` | 返回 `{ ok: true, available: boolean }`；非 2xx、解析失败、网络异常一律视为不可用 |
| `POST <route>/open`，body `{ path }` | 2xx 表示打开成功；其余状态触发底座的失败提示 |

### 4. 四条硬要求

- **围栏**：注册本机路由必须拒绝非可信来源（跨站、非回环且非可信 Host），否则任意本机页面都能借道拉起你的软件。
- **文档相对路径**：`route` 不要带前导斜杠，也不要写死 origin。
- **别自己再挂按钮**：会话头部由底座统一渲染，贡献方只注册目标，不要再往头部槽位注册自己的按钮。
- **声明底座依赖**：下游插件必须在自己的安装说明里显式写明需要本插件，原因与模板见下一节。

### 5. 下游安装说明必须声明底座依赖

下游插件的按钮与菜单由本底座渲染，且浏览器侧依赖是按 cordis 服务解析的：底座不在时，下游 client 半的 `inject: ["openInAppTargets"]` 永远等不到服务，`apply` 根本不会执行——功能静默失效，下游自己也无法察觉或补救。因此下游插件必须在自己的 README / 安装说明里显式声明这个前置依赖，建议照抄以下写法（只把最后一行换成自己的地址）：

> ⚠️ 本插件依赖 `dsh-open-in-app-base`：请先安装底座，否则会话头部不会出现「Open In...」菜单项。
>
> ```bash
> dsh plugin --profile web add dsh-open-in-app-base
> dsh plugin --profile web add <本插件地址>
> ```

### 6. 常见坑

- 跨插件依赖要用 **cordis 服务名**（`inject: ["openInAppTargets"]`）；包清单里的 `dsh.client.inject` 写的是**包名**、只影响加载预取，不具备服务注入语义。
- 浏览器半边只能 `require` 平台单例（`react`、`react-dom`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`），且不支持插件内相对 `require`；样式只能以 JS 字符串内联，颜色请用 `--dsw-*` 主题变量。
- 目标图标只传路径数据（24×24、描边、`currentColor`）。想让菜单项图标与底座风格一致，可从 [lucide](https://lucide.dev) 取同一风格的图标路径。

## 本仓库的构建与自测

- 构建：`npm run build`（纯 Node 脚本，零依赖；产物 `lib/` 随仓库提交，安装侧零构建）。
- 离线自测：`npm run selftest`（host 侧校验导出与清单/产物的对齐关系；client 侧在 vm 沙箱里执行构建产物，覆盖注册契约校验、可用性过滤、单/多目标渲染决策、点击与菜单链路、失败提示与隐身行为）。
- 提交前请自行完成脱敏检查（本机路径、用户名、凭据一律不得入库）。

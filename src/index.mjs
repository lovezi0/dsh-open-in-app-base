// dsh-open-in-app-base — 宿主半边。
//
// 纯 UI 插件：空的 apply 只为让插件出现在宿主的 cordis 层里；浏览器半边随
// package.json 的 dsh.client 声明装配（exports["./client"]）。
// 目标软件的探测与启动不在本包：由贡献方自带 host 半边与同源路由负责。
export const name = "open-in-app-base";

export function apply() {}

// dsh-open-in-app-base — 宿主半边。
//
// 两件事：① 让插件出现在宿主的 cordis 层里（浏览器半边随 package.json 的
// dsh.client 声明装配，exports["./client"]）；② 提供 openInAppState 服务，
// 由底座独占 state 文件的读写，下游只经服务存取自己的设置。
// 目标软件的探测与启动不在本包：由贡献方自带 host 半边与同源路由负责。
import { createStateService } from "./state.mjs";

export const name = "open-in-app-base";

/**
 * 注册状态服务。
 * 此处不读盘也不写盘（存储实现按需懒加载），因此目录不可写、文件损坏等都不会
 * 让插件 FAILED —— 底座是所有下游的共同依赖，加载期必须零风险。
 * @param ctx - 宿主 cordis 上下文；缺席时静默跳过，保持离线自测可空参调用。
 */
export function apply(ctx) {
  try {
    // home 解析优先用宿主挂上 ctx 的官方实现；缺席时存储实现内部回落本地同优先级解析。
    const homePath = typeof ctx?.get === "function" ? ctx.get("dshHomePath") : undefined;
    const service = createStateService({
      homePath: typeof homePath === "function" ? homePath : undefined,
      logger: ctx?.logger,
    });
    if (typeof ctx?.provide === "function") ctx.provide("openInAppState", service);
  } catch (error) {
    // 兜底：apply 抛异常会让插件 FAILED 并被卸载，代价远大于少一个服务。
    const message = `openInAppState was not registered: ${String(error?.message ?? error)}`;
    if (typeof ctx?.logger?.warn === "function") ctx.logger.warn(message);
    else if (typeof console !== "undefined") console.warn(`dsh-open-in-app-base: ${message}`);
  }
}

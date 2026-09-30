window.__ModuleLoader__.load({
  id: "dsh-open-in-app-base",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    // 平台单例：shell 的冻结模块表按包名共享这两项（react 与设计系统 primitives），
    // 浏览器模块系统不支持插件相对 require，其余依赖一律不可 require。
    let React = require("react");
    let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

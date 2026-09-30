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


    // 图标取自本包 assets/（lucide，ISC）。浏览器 bundle 是自包含单文件、无法 require svg，
    // 只能内联路径数据；此处与 assets/*.svg 的 <path d> 逐一对应，由 client 自测比对。
    const ICON_BUTTON_PATHS = [
      "M12 22v-9",
      "M15.17 2.21a1.67 1.67 0 0 1 1.63 0L21 4.57a1.93 1.93 0 0 1 0 3.36L8.82 14.79a1.655 1.655 0 0 1-1.64 0L3 12.43a1.93 1.93 0 0 1 0-3.36z",
      "M20 13v3.87a2.06 2.06 0 0 1-1.11 1.83l-6 3.08a1.93 1.93 0 0 1-1.78 0l-6-3.08A2.06 2.06 0 0 1 4 16.87V13",
      "M21 12.43a1.93 1.93 0 0 0 0-3.36L8.83 2.2a1.64 1.64 0 0 0-1.63 0L3 4.57a1.93 1.93 0 0 0 0 3.36l12.18 6.86a1.636 1.636 0 0 0 1.63 0z",
    ];
    const ICON_TARGET_DEFAULT_PATHS = [
      "M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6",
      "m21 3-9 9",
      "M15 3h6v6",
    ];


    // ---- 贡献方契约 ----
    // 目标 = { id, label, route } 必填，可带 icon（24×24 描边路径数组）与 order。
    // 外观不由贡献方决定：图标只收路径数据，尺寸/描边/颜色/结构由本插件统一渲染。

    const ROUTE_PREFIX_HINT = "route 必须是文档相对路径（不以 / 开头、不含协议），web 与 dsh-app:// 下才同源可达";

    function normalizeTarget(input) {
      if (input === null || typeof input !== "object") {
        throw new Error("openInAppTargets.register: 目标必须是对象");
      }
      const id = typeof input.id === "string" ? input.id.trim() : "";
      const label = typeof input.label === "string" ? input.label.trim() : "";
      const route = typeof input.route === "string" ? input.route.trim().replace(/\/+$/, "") : "";
      if (id.length === 0) throw new Error("openInAppTargets.register: id 必须是非空字符串");
      if (label.length === 0) throw new Error(`openInAppTargets.register(${id}): label 必须是非空字符串`);
      if (route.length === 0) throw new Error(`openInAppTargets.register(${id}): route 必须是非空字符串`);
      if (route.startsWith("/") || route.includes("://")) {
        throw new Error(`openInAppTargets.register(${id}): ${ROUTE_PREFIX_HINT}`);
      }
      let icon = ICON_TARGET_DEFAULT_PATHS;
      if (input.icon !== undefined && input.icon !== null) {
        if (!Array.isArray(input.icon) || input.icon.length === 0
          || input.icon.some((d) => typeof d !== "string" || d.trim().length === 0)) {
          throw new Error(`openInAppTargets.register(${id}): icon 必须是非空的 svg path 字符串数组`);
        }
        icon = input.icon.slice();
      }
      const order = input.order === undefined ? 0 : Number(input.order);
      if (!Number.isFinite(order)) throw new Error(`openInAppTargets.register(${id}): order 必须是有限数`);
      return Object.freeze({ id, label, route, icon: Object.freeze(icon), order });
    }

    /** 目标注册表：快照恒为冻结数组（新数组只在变更时产生，供 useSyncExternalStore 语义使用）。 */
    function createTargetRegistry() {
      const entries = [];
      const listeners = new Set();
      let snapshot = Object.freeze([]);
      function publish() {
        // Array#sort 稳定：order 相同的目标保持注册顺序。
        snapshot = Object.freeze(entries.slice().sort((a, b) => a.order - b.order));
        for (const listener of Array.from(listeners)) listener();
      }
      return {
        register(input) {
          const target = normalizeTarget(input);
          if (entries.some((entry) => entry.id === target.id)) {
            throw new Error(`openInAppTargets.register: id "${target.id}" 已被注册`);
          }
          entries.push(target);
          publish();
          let released = false;
          return () => {
            if (released) return;
            released = true;
            const index = entries.indexOf(target);
            if (index < 0) return;
            entries.splice(index, 1);
            publish();
          };
        },
        snapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
      };
    }

    /** 首选目标的会话内记忆（不落盘）。 */
    function createSnapshotValue(initial) {
      let value = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        set(next) {
          if (next === value) return;
          value = next;
          for (const listener of Array.from(listeners)) listener();
        },
      };
    }

    /**
     * 渲染决策（纯函数）：无可用目标不渲染；否则渲染按钮组，且主按钮与下拉同一个动作。
     * 底座不指向任何软件，所以「打开」只发生在菜单选择之后——目标数量不改变交互。
     * @param targets - 注册表快照。
     * @param availability - 目标 id → 是否可用。
     * @param chosenId - 上次成功打开的目标 id（菜单里打勾）。
     * @returns 无可用目标时为 null，否则为上次使用的目标与菜单项。
     */
    function computeView(targets, availability, chosenId) {
      const available = targets.filter((target) => availability[target.id] === true);
      if (available.length === 0) return null;
      const preferred = available.find((target) => target.id === chosenId) ?? available[0];
      return { preferred, items: available };
    }


    // 本插件词条。贡献方 label 是纯文本，其本地化由贡献方自理；此处只覆盖底座自身文案。
    const NS = "open-in-app-base";
    const zh = {
      "open.menu": "打开方式",
      more: "更多打开方式",
      openError: "打开失败，请重试",
    };
    const en = {
      "open.menu": "Open with…",
      more: "More ways to open",
      openError: "Could not open. Try again.",
    };

    /** 宿主词条缺失时的兜底翻译（按 navigator.language 选词典，支持 {name} 插值）。 */
    function fallbackT(key, vars) {
      const chinese = typeof navigator !== "undefined"
        && String(navigator.language || "").toLowerCase().startsWith("zh");
      const text = (chinese ? zh : en)[key] ?? key;
      if (vars === undefined || vars === null) return text;
      return text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
    }


    // ---- 样式 ----
    // 规格逐项对齐原生 ui-open-in-app 的 split 按钮（24px 高 / 11px 字号 / radius-sm /
    // 0.5px l4 边框 / hover 使用 interactive-bg-hover）；样式只能 JS 字符串内联。
    const STYLE_ID = "dsh-open-in-app-base-style";
    const STYLE_CSS = [
      ".oiab-anchor{display:inline-flex;flex:none;align-self:center;}",
      ".oiab-split{display:inline-flex;align-items:stretch;box-sizing:border-box;height:24px;overflow:hidden;",
      "border:0.5px solid var(--dsw-alias-border-l4,#e5e7eb);border-radius:var(--dsw-radius-sm,6px);",
      "font-family:var(--dsw-font-family,inherit);}",
      ".oiab-main,.oiab-chevron{display:inline-flex;align-items:center;justify-content:center;border:0;background:none;",
      "color:var(--dsw-alias-label-primary,#1f2329);font-size:11px;line-height:16px;white-space:nowrap;cursor:pointer;}",
      ".oiab-main{gap:4px;padding:3px 5px;}",
      ".oiab-chevron{padding:3px 4px 3px 3px;border-left:0.5px solid var(--dsw-alias-border-l4,#e5e7eb);",
      "color:var(--dsw-alias-label-secondary,#6b7280);}",
      ".oiab-main:hover:not(:disabled),.oiab-main:focus-visible,",
      ".oiab-chevron:hover:not(:disabled),.oiab-chevron:focus-visible{background:var(--dsw-alias-interactive-bg-hover,#f2f3f5);}",
      ".oiab-main:disabled,.oiab-chevron:disabled{cursor:default;}",
      // svg 默认 inline 基线对齐会留出字母下伸间隙，置 block 后与文字同中线。
      ".oiab-icon{display:block;flex:none;}",
    ].join("");

    function injectStyles() {
      if (typeof document === "undefined") return () => {};
      const existing = document.getElementById(STYLE_ID);
      if (existing !== null) return () => { existing.remove(); };
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = STYLE_CSS;
      document.head.appendChild(style);
      return () => { style.remove(); };
    }

    /** 按 24×24 描边规格渲染图标；只接受路径数据，外观不交给调用方。 */
    function renderIcon(paths, size) {
      return React.createElement("svg", {
        className: "oiab-icon",
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        focusable: "false",
      }, paths.map((d, index) => React.createElement("path", { key: index, d })));
    }

    /** 失败提示：由发起手势的控件自身播报一次（key 变化使相同文案能重播）。 */
    function useFailureToast() {
      const seq = React.useRef(0);
      const [banner, setBanner] = React.useState(null);
      return {
        toast: banner === null ? null : React.createElement(primitives.Toast, {
          key: banner.seq,
          text: banner.text,
          icon: React.createElement(primitives.IconWarningOutlineRegular, null),
          onDone: () => { setBanner(null); },
        }),
        show: (text) => {
          seq.current += 1;
          setBanner({ seq: seq.current, text });
        },
      };
    }

    /**
     * 构造 Session header 按钮组组件。
     * @param injectFace - 槽位注入面（注册表快照、首选值、探测与打开）。
     * @returns Session header 槽位组件。
     */
    function createButton(injectFace) {
      return function OpenInAppBaseButton(props) {
        const t = typeof props.t === "function" ? props.t : fallbackT;
        const sessionId = props.sessionId;
        const targets = props.useOpenInAppTargets((rows) => rows) ?? [];
        const chosenId = props.useOpenInAppChoice((id) => id);
        const cwd = props.useSessions((state) => state?.byId?.[sessionId]?.cwd);
        const alive = React.useRef(true);
        const inFlight = React.useRef(false);
        const [availability, setAvailability] = React.useState({});
        const [menuOpen, setMenuOpen] = React.useState(false);
        const [busy, setBusy] = React.useState(false);
        const failure = useFailureToast();

        React.useEffect(() => () => { alive.current = false; }, []);

        /** 并发探测所有已注册目标；探测不抛错，不可用即为 false。 */
        function probe() {
          return Promise.all(targets.map(async (target) => [target.id, await injectFace.probeAvailable(target)]))
            .then((results) => {
              if (alive.current) setAvailability(Object.fromEntries(results));
            });
        }

        React.useEffect(() => { probe(); }, [targets]);

        const view = computeView(targets, availability, chosenId);
        const path = typeof cwd === "string" && cwd.length > 0 ? cwd : null;
        if (view === null || path === null) return null;

        // 主按钮不直接用某个目标打开：底座不指向任何软件，点击只展开目标菜单。
        const label = t("open.menu");

        /** 打开指定目标（缺省当前首选）；成功后才更新首选记忆。 */
        function run(id) {
          const target = view.items.find((row) => row.id === id) ?? view.preferred;
          if (inFlight.current) return;
          inFlight.current = true;
          setBusy(true);
          injectFace.launch(target, path)
            .then(() => {
              if (!alive.current) return;
              injectFace.choose(target.id);
            })
            .catch(() => {
              if (alive.current) failure.show(t("openError"));
            })
            .finally(() => {
              inFlight.current = false;
              if (alive.current) setBusy(false);
            });
        }

        /** 主按钮与 chevron 同一个动作：展开/收起目标菜单，展开前刷新一次可用性。 */
        function toggleMenu() {
          if (!menuOpen) probe();
          setMenuOpen((value) => !value);
        }

        const split = React.createElement("div", {
          className: "oiab-split",
          "data-open-in-app-base": "button",
          "data-state": busy ? "busy" : "idle",
        }, [
          React.createElement(primitives.Tooltip, {
            key: "main",
            portal: true,
            side: "bottom",
            delayMs: 500,
            label,
          }, React.createElement("button", {
            type: "button",
            className: "oiab-main",
            disabled: busy,
            "aria-label": label,
            "aria-haspopup": "menu",
            "aria-expanded": menuOpen && !busy,
            onClick: toggleMenu,
          }, renderIcon(ICON_BUTTON_PATHS, 13))),
          React.createElement("button", {
            key: "chevron",
            type: "button",
            className: "oiab-chevron",
            disabled: busy,
            "aria-haspopup": "menu",
            "aria-expanded": menuOpen && !busy,
            "aria-label": t("more"),
            onClick: toggleMenu,
          }, React.createElement(primitives.IconChevronDownOutlineRegular, { size: 10 })),
        ]);

        const menu = React.createElement(primitives.Menu, {
          className: "oiab-anchor",
          open: menuOpen && !busy,
          autoFocus: true,
          portal: true,
          dense: true,
          align: "end",
          items: view.items.map((target) => ({
            id: target.id,
            label: target.label,
            icon: renderIcon(target.icon, 14),
          })),
          selectedId: view.preferred.id,
          onSelect: (id) => {
            setMenuOpen(false);
            run(id);
          },
          onClose: () => { setMenuOpen(false); },
          anchor: split,
        });

        return React.createElement(React.Fragment, null, menu, failure.toast);
      };
    }


    function warn(message) {
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn(`dsh-open-in-app-base: ${message}`);
      }
    }

    /**
     * 装配：样式、词条、注册表服务与 Session header 槽位。
     * @param ctx - 客户端 cordis 上下文（slots / locale / provide / effect）。
     */
    function apply(ctx) {
      ctx.effect(() => injectStyles(), "open-in-app-base: styles");
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "open-in-app-base: dictionaries");
      } catch (error) {
        // 词条注册失败不影响功能：组件退回内置词典。
        warn(`locale registration failed: ${String(error?.message ?? error)}`);
      }

      const registry = createTargetRegistry();
      const choice = createSnapshotValue(undefined);
      // 贡献方唯一的接入点：client 侧服务。目标软件的探测与启动在贡献方自己的 host 路由里。
      ctx.provide("openInAppTargets", { register: registry.register });

      const injectFace = {
        hooks: {
          openInAppTargets: { getSnapshot: registry.snapshot, subscribe: registry.subscribe },
          openInAppChoice: { getSnapshot: choice.getSnapshot, subscribe: choice.subscribe },
        },
        choose: (id) => { choice.set(id); },
        /** 可用性探测：非 2xx、解析失败与网络异常一律视为不可用，不阻断其它目标。 */
        probeAvailable: async (target) => {
          try {
            const response = await fetch(`${target.route}/available`, { headers: { accept: "application/json" } });
            if (!response.ok) return false;
            const body = await response.json();
            return body?.available === true;
          } catch {
            return false;
          }
        },
        launch: async (target, path) => {
          const response = await fetch(`${target.route}/open`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path }),
          });
          if (!response.ok) throw new Error(`${target.route}/open responded ${response.status}`);
        },
      };

      const Button = createButton(injectFace);
      // 追加注册到 Session header 工具位：原生 open-in-app 占 -10，本按钮组紧贴其右。
      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
        name: "conversation.session.header.utilities",
        id: "open-in-app-base",
        order: -9,
        locale: NS,
        inject: () => injectFace,
      }, Button));
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  }
});

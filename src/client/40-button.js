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

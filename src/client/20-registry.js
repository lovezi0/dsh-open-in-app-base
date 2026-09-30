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

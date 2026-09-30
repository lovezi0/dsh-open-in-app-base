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

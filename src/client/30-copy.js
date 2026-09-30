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

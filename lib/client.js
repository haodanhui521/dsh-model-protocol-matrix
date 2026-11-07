window.__ModuleLoader__.load({
  id: "dsh-model-protocol-matrix",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /**
     * dsh-model-protocol-matrix —— client 半。
     *
     * 客户端 bundle 以 classic script 加载，ESM 的 import/export 在那是语法错误，
     * 因此这里用 window.__ModuleLoader__.load({ id, factory }) 包装（所有官方插件同款），
     * React 通过 factory 的 require 取，组件用 React.createElement 写。
     *
     * 设置分节**原生渲染**（不是 iframe）：iframe 在设置对话框里会变成第二个滚动容器。
     * 数据来自插件自己的 /protocol-matrix/api/*，与独立页 /protocol-matrix/ui 共用同一后端。
     *
     * 这一半在渲染器启动期间执行：apply 里任何 throw 都不能外泄。
     */

    const SETTINGS_SLOT = "settings.section";
    const SECTION_ID = "dsh-model-protocol-matrix";
    const API = "/protocol-matrix/api";
    const PAGE_PATH = "/protocol-matrix/ui";
    const NS = "dsh-model-protocol-matrix";

    const DICTIONARIES = {
      zh: {
        settingsNav: "协议矩阵",
        title: "模型协议矩阵",
        description: "每个模型单独选择请求协议；拆分出的路由由插件托管，可一键回滚。",
        loading: "正在读取当前配置…",
        loadFailed: "读取失败",
        route: "路由",
        model: "模型",
        protocol: "协议",
        probe: "探测",
        probing: "探测中…",
        inherited: "继承路由",
        apply: "应用变更",
        openPage: "打开完整页面",
        conflict: "检测到 dsh-gearbox，两者二选一：当前为只读模式，不会写入任何配置。",
        noChange: "没有待应用的变更",
        applied: "已写入配置",
        failed: "失败",
        hidden: "已隐藏",
        managed: "插件派生",
        probeDone: "探测完成",
      },
      en: {
        settingsNav: "Protocol matrix",
        title: "Model protocol matrix",
        description: "Pick a wire protocol per model; derived routes are plugin-managed and reversible.",
        loading: "Reading current configuration…",
        loadFailed: "Load failed",
        route: "Route",
        model: "Model",
        protocol: "Protocol",
        probe: "Probe",
        probing: "Probing…",
        inherited: "Inherit route",
        apply: "Apply changes",
        openPage: "Open full page",
        conflict: "dsh-gearbox detected — pick one. Read-only: nothing will be written.",
        noChange: "Nothing to apply",
        applied: "Written",
        failed: "Failed",
        hidden: "hidden",
        managed: "derived",
        probeDone: "Probe finished",
      },
    };

    /** 服务名（不是包名）：包名只写在 package.json 的 dsh.client.inject 里。 */
    const inject = ["slots", "locale"];

    /** 探测摘要用：协议顺序与短名。 */
    const PROTOCOL_KEYS = ["openai-completions", "openai-responses", "anthropic-messages"];
    const PROTOCOL_SHORT = { "openai-completions": "Chat", "openai-responses": "Responses", "anthropic-messages": "Anthropic" };

    function usableText(v) {
      if (v === "recommended" || v === "usable") return "可用";
      if (v === "not_recommended") return "不可用";
      return "未知";
    }

    function verdictText(v) {
      return ({
        recommended: "推荐", usable: "可用", not_recommended: "不推荐", unknown: "未知",
        supported: "支持思考", unsupported: "不支持思考", ok: "可用", exists: "端点存在",
        missing: "端点不存在", "model-missing": "模型不可用", "auth-failed": "鉴权失败",
        "rate-limited": "限流", "not-applicable": "不适用",
      })[v] || (v || "未探测");
    }

    const PROTOCOL_LABEL = {
      "openai-completions": "Chat Completions",
      "openai-responses": "Responses",
      "anthropic-messages": "Anthropic Messages",
    };

    const STYLE = {
      wrap: { display: "flex", flexDirection: "column", gap: "12px", maxWidth: "860px" },
      title: { margin: 0, fontSize: "16px", fontWeight: 600 },
      desc: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12.5px" },
      banner: { padding: "9px 12px", borderRadius: "8px", background: "var(--dsw-alias-interactive-bg-hover-danger, #fdeaea)", color: "var(--dsw-alias-state-error-primary, #a01818)", fontSize: "12.5px" },
      bar: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" },
      button: { font: "inherit", padding: "5px 11px", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.55))", background: "transparent", color: "inherit", cursor: "pointer", fontSize: "12.5px" },
      primary: { font: "inherit", padding: "5px 12px", borderRadius: "8px", border: "1px solid #2f6feb", background: "#2f6feb", color: "#ffffff", cursor: "pointer", fontSize: "12.5px", fontWeight: 500 },
      cell: { padding: "6px 8px", borderBottom: "1px solid var(--dsw-alias-border-l1)", fontSize: "12.5px", verticalAlign: "middle" },
      head: { padding: "6px 8px", borderBottom: "1px solid var(--dsw-alias-border-l1)", fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", textAlign: "left", fontWeight: 500 },
      routeRow: { padding: "6px 8px", background: "var(--dsw-alias-bg-module-platform)", fontWeight: 600, fontSize: "12.5px" },
      muted: { color: "var(--dsw-alias-label-tertiary)" },
      pill: { display: "inline-block", padding: "1px 6px", borderRadius: "99px", fontSize: "11px", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-tertiary)" },
      flash: { fontSize: "12.5px", color: "var(--dsw-alias-label-secondary)" },
      select: { font: "inherit", fontSize: "12.5px", padding: "2px 6px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l1)", background: "transparent", color: "inherit" },
    };

    function makeSection(React, t) {
      const h = React.createElement;
      return function Section() {
        const store = React.useState({ loading: true, error: null, inv: null });
        const state = store[0];
        const setState = store[1];
        const pend = React.useState({});
        const pending = pend[0];
        const setPending = pend[1];
        const note = React.useState("");
        const flash = note[0];
        const setFlash = note[1];
        const busyState = React.useState(false);
        const busy = busyState[0];
        const setBusy = busyState[1];

        const load = async () => {
          try {
            const res = await fetch(API + "/inventory");
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || "HTTP error");
            setState({ loading: false, error: null, inv: data });
          } catch (error) {
            setState({ loading: false, error: String((error && error.message) || error), inv: null });
          }
        };

        React.useEffect(() => { load(); }, []);

        const post = async (path, body) => {
          const res = await fetch(API + path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body || {}),
          });
          return res.json();
        };

        const probe = async (route, model) => {
          setBusy(true);
          setFlash(t("probing") + " " + route + "/" + model);
          try {
            const out = await post("/probe", { route: route, model: model });
            setFlash(out.ok ? t("probeDone") + ": " + route + "/" + model : t("failed") + ": " + (out.error || ""));
            await load();
          } catch (error) { setFlash(t("failed") + ": " + String((error && error.message) || error)); }
          setBusy(false);
        };

        const applyAll = async () => {
          setBusy(true);
          try {
            const out = await post("/apply", { plan: pending });
            if (!out.ok) setFlash(t("failed") + ": " + (out.code || "") + " " + (out.error || ""));
            else if (!out.changed) setFlash(t("noChange"));
            else { setFlash(t("applied")); setPending({}); }
            await load();
          } catch (error) { setFlash(t("failed") + ": " + String((error && error.message) || error)); }
          setBusy(false);
        };

        if (state.loading) return h("div", { style: STYLE.wrap }, h("div", { style: STYLE.desc }, t("loading")));
        if (state.error) return h("div", { style: STYLE.wrap }, h("div", { style: STYLE.banner }, t("loadFailed") + ": " + state.error));

        const inv = state.inv;
        const children = [];
        children.push(h("div", { key: "head" },
          h("h3", { style: STYLE.title }, t("title")),
          h("div", { style: STYLE.desc }, t("description"))));
        if (inv.gearbox) children.push(h("div", { key: "gb", style: STYLE.banner }, t("conflict")));

        const head = h("tr", { key: "hrow" },
          h("th", { style: STYLE.head }, t("route") + " / " + t("model")),
          h("th", { style: STYLE.head }, t("protocol")),
          h("th", { style: STYLE.head }, ""));
        const rows = [head];
        for (const route of inv.routes) {
          rows.push(h("tr", { key: "r-" + route.route },
            h("td", { style: STYLE.routeRow, colSpan: 3 },
              route.route,
              route.managed ? h("span", { style: Object.assign({}, STYLE.pill, { marginLeft: "6px" }) }, t("managed")) : null,
              h("span", { style: Object.assign({}, STYLE.muted, { marginLeft: "8px" }) }, (route.api || "") + " · " + (route.baseURL || "")))));
          for (const model of route.models) {
            const key = route.route + "/" + model.id;
            const current = Object.prototype.hasOwnProperty.call(pending, key) ? pending[key] : (model.selected || "");
            rows.push(h("tr", { key: "m-" + key },
              h("td", { style: STYLE.cell },
                h("code", null, model.id),
                model.hidden ? h("span", { style: Object.assign({}, STYLE.pill, { marginLeft: "6px" }) }, t("hidden")) : null),
              h("td", { style: STYLE.cell },
                h("select", {
                  style: STYLE.select,
                  value: current,
                  disabled: inv.gearbox || busy,
                  onChange: (event) => {
                    const value = event.target.value;
                    setPending(Object.assign({}, pending, { [key]: value === "" ? null : value }));
                  },
                },
                  h("option", { value: "" }, t("inherited")),
                  h("option", { value: "openai-completions" }, PROTOCOL_LABEL["openai-completions"]),
                  h("option", { value: "openai-responses" }, PROTOCOL_LABEL["openai-responses"]),
                  h("option", { value: "anthropic-messages" }, PROTOCOL_LABEL["anthropic-messages"]))),
              h("td", { style: STYLE.cell },
                h("button", { style: STYLE.button, disabled: busy || inv.gearbox, onClick: () => probe(route.route, model.id) }, t("probe")))));
            const summary = PROTOCOL_KEYS.map((p) => {
              const entry = model.protocols[p];
              if (!entry) return null;
              return PROTOCOL_SHORT[p] + "=" + usableText(entry.verdict);
            }).filter(Boolean).join(" \u00b7 ");
            if (summary) {
              rows.push(h("tr", { key: "p-" + key },
                h("td", {
                  colSpan: 3,
                  style: Object.assign({}, STYLE.cell, { color: "var(--dsw-alias-label-tertiary, #8a8a8e)", fontSize: "11.5px" }),
                },
                  summary,
                  model.protocols["openai-responses"] && model.protocols["openai-responses"].reasoning && model.protocols["openai-responses"].reasoning.evidence
                    ? " \u2014 " + model.protocols["openai-responses"].reasoning.evidence
                    : null)));
            }
          }
        }
        children.push(h("table", { key: "table", style: { width: "100%", borderCollapse: "collapse" } }, h("tbody", null, rows)));
        children.push(h("div", { key: "bar", style: STYLE.bar },
          h("button", { style: STYLE.primary, disabled: busy || inv.gearbox, onClick: applyAll }, t("apply")),
          h("button", {
            style: STYLE.button,
            onClick: () => { try { window.open(PAGE_PATH, "_blank", "noopener"); } catch (error) { /* ignore */ } },
          }, t("openPage"))));
        if (flash) children.push(h("div", { key: "flash", style: STYLE.flash }, flash));
        return h("div", { style: STYLE.wrap }, children);
      };
    }

    function activeLanguage(ctx) {
      try {
        const value = ctx.locale && (ctx.locale.current ? ctx.locale.current() : ctx.locale.language);
        const code = typeof value === "string" ? value : (value && (value.language || value.code || value.locale));
        if (code === "en" || code === "zh") return code;
      } catch (error) { /* fall through */ }
      try {
        if (String(navigator.language || "").toLowerCase().startsWith("zh")) return "zh";
      } catch (error) { /* fall through */ }
      return "zh";
    }

    function apply(ctx, config) {
      let language = "zh";
      try {
        for (const code of Object.keys(DICTIONARIES)) ctx.locale?.register?.(NS, code, DICTIONARIES[code]);
        language = (config && (config.language === "zh" || config.language === "en")) ? config.language : activeLanguage(ctx);
      } catch (error) { ctx.logger?.warn?.("dsh-model-protocol-matrix: locale 注册失败", error); }
      const t = (key) => (DICTIONARIES[language] && DICTIONARIES[language][key]) || DICTIONARIES.en[key] || key;

      try {
        const React = require("react");
        if (!React) throw new Error("react 不在客户端模块表里");
        const Section = makeSection(React, t);
        ctx.effect(() => ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots.register({
          name: SETTINGS_SLOT,
          id: SECTION_ID,
          order: 120,
          label: () => t("settingsNav"),
        }, Section)), "dsh-model-protocol-matrix: settings section");
        ctx.logger?.info?.("dsh-model-protocol-matrix: settings section registered");
      } catch (error) {
        // 渲染器启动期：失败只是一行入口缺失，绝不能让 apply 抛出。
        ctx.logger?.warn?.("dsh-model-protocol-matrix: 设置分节注册失败", error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});

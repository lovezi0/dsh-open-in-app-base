// 浏览器半边离线自测：在 vm 沙箱里执行构建产物 lib/client.js（同时验证产物与源一致），
// 用假 React / document / fetch 驱动完整渲染链：注册契约校验、可用性过滤、
// 单/多目标渲染决策、点击与菜单打开链路、失败提示、反注册与无 cwd 的隐身行为。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const BUNDLE = readFileSync(new URL("lib/client.js", root), "utf8");

// ---- 假 React（按序复用的钩子槽 + 手动冲刷 effect） ----

let hookSlots = {};
let hookIdx = 0;
let effectQueue = [];

const React = {
  Fragment: Symbol("Fragment"),
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined),
  }),
  useState: (init) => {
    const i = hookIdx++;
    if (!(i in hookSlots)) hookSlots[i] = { value: typeof init === "function" ? init() : init };
    const slot = hookSlots[i];
    return [slot.value, (next) => { slot.value = typeof next === "function" ? next(slot.value) : next; }];
  },
  useRef: (init) => {
    const i = hookIdx++;
    if (!(i in hookSlots)) hookSlots[i] = { current: init };
    return hookSlots[i];
  },
  useEffect: (fn) => { effectQueue.push(fn); },
};

const primitives = {
  Menu: "Menu",
  Tooltip: "Tooltip",
  Toast: "Toast",
  IconChevronDownOutlineRegular: "IconChevronDownOutlineRegular",
  IconWarningOutlineRegular: "IconWarningOutlineRegular",
};

const settle = async (times = 6) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

// ---- 装载 client bundle ----

let captured = null;
const fetchCalls = [];
let fetchHandler = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, available: true }) });

const sandbox = {
  window: { __ModuleLoader__: { load: (def) => { captured = def; } } },
  document: { getElementById: () => null, createElement: () => ({ id: "", textContent: "", remove() {} }), head: { appendChild() {} } },
  navigator: { language: "zh-CN" },
  console,
  setTimeout,
  clearTimeout,
  fetch: (url, options) => {
    fetchCalls.push({ url: String(url), options });
    return fetchHandler(String(url), options);
  },
};
vm.createContext(sandbox);
vm.runInContext(BUNDLE, sandbox, { filename: "lib/client.js" });

assert.ok(captured, "module registered via __ModuleLoader__");
assert.equal(captured.id, pkg.name, "registered id equals the package name");

const clientExports = captured.factory((name) => {
  if (name === "react") return React;
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
  throw new Error(`unexpected require: ${name}`);
});

// ---- 假客户端 ctx ----

function makeEnv() {
  const provided = new Map();
  const localeCalls = [];
  let slotKey = null;
  let registration = null;
  const ctx = {
    effect: (fn) => { const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; },
    provide: (name, value) => { provided.set(name, value); },
    locale: { register: (ns, dictionaries) => { localeCalls.push({ ns, dictionaries }); } },
    slots: {
      inject: (key, cb) => { slotKey = key; registration = cb(); return () => {}; },
      register: (options, component) => ({ options, component }),
    },
  };
  clientExports.apply(ctx);
  return { ctx, provided, localeCalls, slotKey, registration };
}

/** 模拟槽位渲染器：把注册项声明的 hooks 源转成组件 prop 的同名 selector 钩子。 */
function mount(env, { sessionId = "s1", byId = { s1: { cwd: "X:\\demo dir" } } } = {}) {
  const face = env.registration.options.inject();
  const component = env.registration.component;
  const props = {
    sessionId,
    useSessions: (selector) => selector({ byId }),
    useOpenInAppTargets: (selector) => selector(face.hooks.openInAppTargets.getSnapshot()),
    useOpenInAppChoice: (selector) => selector(face.hooks.openInAppChoice.getSnapshot()),
  };
  return {
    face,
    props,
    render({ effects = false } = {}) {
      hookIdx = 0;
      const out = component(props);
      if (effects) {
        const queue = effectQueue;
        effectQueue = [];
        for (const fn of queue) fn();
      }
      return out;
    },
  };
}

const TARGET = { id: "codebuddy", label: "CodeBuddy", route: "open-in-codebuddy" };
const NEW = (name, extra = {}) => ({ id: name, label: name.toUpperCase(), route: `open-${name}`, ...extra });

function nodes(out) {
  const menu = out?.children?.[0] ?? null;
  const anchor = menu?.props?.anchor ?? null;
  const tooltip = anchor?.children?.[0] ?? null;
  const main = tooltip?.children?.[0] ?? null;
  return { menu, anchor, main, chevron: anchor?.children?.[1] ?? null };
}

// ---- 场景 0：装配契约 ----

{
  hookSlots = {};
  const env = makeEnv();
  assert.equal(JSON.stringify(clientExports.inject), JSON.stringify(["slots", "locale"]), "declared client services");
  assert.equal(env.slotKey, "conversation.session.header.utilities", "targets the session header utilities slot");
  assert.equal(env.registration.options.name, "conversation.session.header.utilities");
  assert.equal(env.registration.options.id, "open-in-app-base", "own slot id keeps the native entry untouched");
  assert.equal(env.registration.options.order, -9, "sits right after the native open-in-app entry (-10)");
  assert.equal(env.registration.options.locale, "open-in-app-base");
  assert.equal(typeof env.registration.options.inject, "function", "inject face declared");

  const service = env.provided.get("openInAppTargets");
  assert.ok(service && typeof service.register === "function", "registration service provided");

  assert.equal(env.localeCalls.length, 1, "dictionaries registered once");
  assert.equal(env.localeCalls[0].ns, "open-in-app-base");
  const { zh, en } = env.localeCalls[0].dictionaries;
  assert.equal(JSON.stringify(Object.keys(zh).sort()), JSON.stringify(Object.keys(en).sort()), "zh/en key sets match");
  console.log("client-selftest: scenario 0 (wiring) passed");
}

// ---- 场景 1：无注册目标 → 不渲染 ----

{
  hookSlots = {};
  const env = makeEnv();
  const view = mount(env);
  view.render({ effects: true });
  await settle();
  assert.equal(view.render(), null, "no target renders nothing");
  console.log("client-selftest: scenario 1 (no target hides the group) passed");
}

// ---- 场景 2：单目标 → 仍是按钮组：点击展开菜单，选择后才打开 ----

{
  hookSlots = {};
  fetchCalls.length = 0;
  const env = makeEnv();
  const release = env.provided.get("openInAppTargets").register(TARGET);
  const view = mount(env);
  view.render({ effects: true });
  await settle();
  const out = view.render();
  const { menu, anchor, main, chevron } = nodes(out);
  assert.equal(anchor.type, "div");
  assert.equal(anchor.props.className, "oiab-split");
  assert.equal(anchor.children.length, 2, "the group keeps its split shape");
  assert.ok(chevron !== null, "a single target still renders the chevron");
  assert.equal(main.type, "button");
  assert.equal(main.props.className, "oiab-main");
  assert.equal(main.props.disabled, false);
  assert.equal(main.props["aria-haspopup"], "menu");
  assert.equal(main.props["aria-label"], "打开方式");
  assert.equal(menu.props.open, false);
  assert.equal(menu.props.selectedId, "codebuddy");

  assert.ok(fetchCalls.some((call) => call.url === "open-in-codebuddy/available"), "probe hits the document-relative route");

  main.props.onClick();
  const opened = nodes(view.render());
  assert.equal(opened.menu.props.open, true, "the primary button opens the group menu");
  assert.equal(opened.main.props["aria-expanded"], true);
  assert.equal(fetchCalls.filter((call) => call.url.endsWith("/open")).length, 0, "the group never opens anything by itself");

  opened.menu.props.onSelect("codebuddy");
  await settle();
  const post = fetchCalls.find((call) => call.url === "open-in-codebuddy/open");
  assert.ok(post, "menu selection issues POST to the open route");
  assert.equal(post.options.method, "POST");
  assert.equal(JSON.parse(post.options.body).path, "X:\\demo dir");
  assert.equal(view.face.hooks.openInAppChoice.getSnapshot(), "codebuddy", "preferred target remembered after success");

  release();
  await settle();
  assert.equal(view.render(), null, "unregistering the target hides the group");
  console.log("client-selftest: scenario 2 (single target + menu) passed");
}

// ---- 场景 3：多目标 → 带下拉；菜单按 order 升序；选择即打开 ----

{
  hookSlots = {};
  fetchCalls.length = 0;
  const env = makeEnv();
  const service = env.provided.get("openInAppTargets");
  service.register(NEW("late", { order: 10 }));
  service.register(NEW("early", { order: -5 }));
  const view = mount(env);
  view.render({ effects: true });
  await settle();
  const out = view.render();
  const { menu, chevron } = nodes(out);
  assert.ok(chevron !== null, "multi target renders a chevron");
  assert.equal(chevron.props["aria-expanded"], false, "the menu starts collapsed");
  assert.equal(menu.props.items.length, 2, "both targets listed");
  assert.equal(JSON.stringify(menu.props.items.map((item) => item.id)), JSON.stringify(["early", "late"]), "menu follows order");
  assert.equal(menu.props.selectedId, "early", "first in order is the default target");
  assert.equal(menu.props.open, false);

  chevron.props.onClick();
  const openMenu = nodes(view.render());
  assert.equal(openMenu.chevron.props["aria-expanded"], true);
  assert.equal(openMenu.menu.props.open, true, "chevron opens the menu");

  fetchCalls.length = 0;
  openMenu.menu.props.onSelect("late");
  await settle();
  assert.equal(fetchCalls[0].url, "open-late/open", "menu selection opens the chosen target");
  assert.equal(view.face.hooks.openInAppChoice.getSnapshot(), "late", "selection becomes the remembered target");
  console.log("client-selftest: scenario 3 (multi target menu) passed");
}

// ---- 场景 4：全部不可用 → 不渲染 ----

{
  hookSlots = {};
  fetchHandler = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, available: false }) });
  const env = makeEnv();
  env.provided.get("openInAppTargets").register(TARGET);
  const view = mount(env);
  view.render({ effects: true });
  await settle();
  assert.equal(view.render(), null, "no available target renders nothing");
  fetchHandler = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, available: true }) });
  console.log("client-selftest: scenario 4 (all unavailable hides the group) passed");
}

// ---- 场景 5：契约校验（非法输入抛错，fail loud） ----

{
  hookSlots = {};
  const env = makeEnv();
  const register = env.provided.get("openInAppTargets").register;
  assert.throws(() => register(null), /目标必须是对象/);
  assert.throws(() => register({ label: "X", route: "x" }), /id 必须是非空字符串/);
  assert.throws(() => register({ id: "x", route: "x" }), /label 必须是非空字符串/);
  assert.throws(() => register({ id: "x", label: "X" }), /route 必须是非空字符串/);
  assert.throws(() => register({ id: "x", label: "X", route: "/root-relative" }), /文档相对路径/);
  assert.throws(() => register({ id: "x", label: "X", route: "https://host/x" }), /文档相对路径/);
  assert.throws(() => register({ id: "x", label: "X", route: "x", icon: "M0 0" }), /icon/);
  assert.throws(() => register({ id: "x", label: "X", route: "x", icon: [""] }), /icon/);
  assert.throws(() => register({ id: "x", label: "X", route: "x", order: "soon" }), /order/);
  const release = register({ id: "x", label: "X", route: "x/" });
  assert.throws(() => register({ id: "x", label: "X", route: "x" }), /已被注册/);
  release();
  register({ id: "x", label: "X", route: "x" });
  console.log("client-selftest: scenario 5 (contract validation) passed");
}

// ---- 场景 6：无 cwd → 不渲染 ----

{
  hookSlots = {};
  const env = makeEnv();
  env.provided.get("openInAppTargets").register(TARGET);
  const view = mount(env, { sessionId: "ghost", byId: {} });
  view.render({ effects: true });
  await settle();
  assert.equal(view.render(), null, "a session without a workspace renders nothing");
  console.log("client-selftest: scenario 6 (no workspace hides the group) passed");
}

// ---- 场景 7：打开失败 → 播报提示且不记首选 ----

{
  hookSlots = {};
  fetchCalls.length = 0;
  fetchHandler = (url) => Promise.resolve(url.endsWith("/open")
    ? { ok: false, status: 500, json: () => Promise.resolve({}) }
    : { ok: true, json: () => Promise.resolve({ ok: true, available: true }) });
  const env = makeEnv();
  env.provided.get("openInAppTargets").register(TARGET);
  const view = mount(env);
  view.render({ effects: true });
  await settle();
  nodes(view.render()).main.props.onClick();
  nodes(view.render()).menu.props.onSelect("codebuddy");
  await settle();
  const out = view.render();
  assert.equal(out.children[1]?.type, "Toast", "a failed open announces a toast");
  assert.equal(view.face.hooks.openInAppChoice.getSnapshot(), undefined, "preferred target untouched on failure");
  fetchHandler = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, available: true }) });
  console.log("client-selftest: scenario 7 (failure toast) passed");
}

// ---- 场景 8：探测语义（非 2xx / 解析失败 / 网络异常都算不可用） ----

{
  hookSlots = {};
  fetchCalls.length = 0;
  const env = makeEnv();
  const face = env.registration.options.inject();
  fetchHandler = () => Promise.reject(new Error("offline"));
  assert.equal(await face.probeAvailable(TARGET), false, "network failure means unavailable");
  assert.equal(fetchCalls[0].url, "open-in-codebuddy/available", "probe uses the document-relative route");
  fetchHandler = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  assert.equal(await face.probeAvailable(TARGET), false, "non-2xx means unavailable");
  fetchHandler = () => Promise.resolve({ ok: true, json: () => Promise.reject(new Error("not json")) });
  assert.equal(await face.probeAvailable(TARGET), false, "malformed body means unavailable");
  fetchHandler = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, available: true }) });
  assert.equal(await face.probeAvailable(TARGET), true, "explicit availability is honoured");
  console.log("client-selftest: scenario 8 (probe semantics) passed");
}

// ---- 场景 9：内联图标与 assets 源文件一致 ----

{
  const iconsSource = readFileSync(new URL("src/client/10-icons.js", root), "utf8");
  for (const [asset, expected] of [["assets/package-open.svg", 4], ["assets/square-arrow-out-up-right.svg", 3]]) {
    const svg = readFileSync(new URL(asset, root), "utf8");
    const paths = [...svg.matchAll(/d="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(paths.length, expected, `${asset} exposes ${expected} paths`);
    for (const d of paths) assert.ok(iconsSource.includes(`"${d}"`), `${asset} path inlined verbatim: ${d.slice(0, 24)}…`);
  }
  console.log("client-selftest: scenario 9 (inline icons match assets) passed");
}

console.log("client-selftest: all scenarios passed");

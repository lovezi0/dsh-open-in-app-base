// 宿主半边离线自测：不装载进 DSH，校验导出契约、清单/产物对齐关系与状态服务行为。
// 覆盖：入口导出、apply 接线、package.json 字段指向真实产物、bundle patch 行与包名一致、
//       openInAppState 的校验规则、读写往返、跨 owner 隔离、降级、订阅、mtime 重载与原子写。
import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, root), "utf8"));
const pkg = readJson("package.json");

const { apply, name } = await import(new URL("lib/index.js", root).href);
const { createStateService } = await import(new URL("lib/state.mjs", root).href);

assert.equal(typeof apply, "function", "apply exported");
// 三个名字各司其职：insert.name 是包名、insert.id 是 patch 行标识、插件导出的 name 是 cordis 服务名。
assert.equal(name, "open-in-app-base", "exported name is the cordis service name");
assert.doesNotThrow(() => { apply(); }, "apply is safe to call without a context");
assert.doesNotThrow(
  () => apply({ get: () => undefined, provide: () => { throw new Error("boom"); }, logger: { warn: () => {} } }),
  "apply never throws: a failing provide must not put the plugin into FAILED",
);

// ---- 清单与产物对齐 ----

assert.equal(pkg.main, "lib/index.js", "main points at the built host entry");
assert.equal(pkg.exports["."], "./lib/index.js", "exports[\".\"] matches main");
assert.equal(pkg.exports["./client"], "./lib/client.js", "exports[\"./client\"] matches the client bundle");
for (const rel of ["lib/index.js", "lib/state.mjs", "lib/client.js", "cordis.patch.yml", pkg.exports["."], pkg.exports["./client"]]) {
  assert.ok(existsSync(new URL(rel, root)), `built file exists: ${rel}`);
}
for (const rel of ["src/index.mjs", "src/state.mjs", "src/client/00-head.js", "src/client/90-tail.js"]) {
  assert.ok(existsSync(new URL(rel, root)), `source file exists: ${rel}`);
}
assert.ok(pkg.files.includes("DEVELOPMENT.md"), "the dev guide ships with the package (README links to it)");
assert.equal(pkg.dependencies, undefined, "no runtime dependencies are declared");
assert.equal(pkg.peerDependencies, undefined, "the state capability adds no peer dependency");

// ---- 文档引用齐备：README 与开发指南里的包内相对链接必须真实存在 ----

for (const doc of ["README.md", "DEVELOPMENT.md"]) {
  const text = readFileSync(new URL(doc, root), "utf8");
  for (const match of text.matchAll(/\]\(\.\/([^)#?]+)\)/g)) {
    assert.ok(existsSync(new URL(match[1], root)), `${doc} links to an existing file: ${match[1]}`);
  }
}

// ---- bundle patch 行 ----

const patch = readFileSync(new URL(pkg.dsh.bundle.patch, root), "utf8");
// 转义只用 [ \t]，与 \s 等价且避免「字母 + 冒号 + 反斜杠」被脱敏规则误判。
const rowId = /^[ \t]*-[ \t]*id:[ \t]*(\S+)[ \t]*$/m.exec(patch);
const rowName = /^[ \t]*name:[ \t]*'?([^'\s]+)'?[ \t]*$/m.exec(patch);
assert.ok(rowId && rowName, "bundle patch declares one insert row");
assert.equal(rowName[1], pkg.name, "insert.name is the package name (resolved through profile node_modules)");
assert.equal(rowId[1], name, "insert.id equals the exported cordis service name");

// ---- client 半的静态声明 ----

const clientBundle = readFileSync(new URL("lib/client.js", root), "utf8");
assert.ok(clientBundle.includes(`id: "${pkg.name}"`), "client bundle registers under the package name");
assert.ok(clientBundle.includes("conversation.session.header.utilities"), "client bundle targets the session header slot");
assert.ok(!clientBundle.includes("@deepseek-ai/dsh-client-ui-open-in-app"), "client bundle does not reach into the native open-in-app package");

// ---- openInAppState：服务注册与存储行为 ----
// 全部用例都在临时目录内进行，不触碰真实的 $DSH_HOME。

const SANDBOX = mkdtempSync(join(tmpdir(), "oiab-state-"));
let sequence = 0;
/** 每个用例一个独立目录，互不干扰。 */
const freshDir = () => join(SANDBOX, `case-${++sequence}`);
const stateFile = (dir) => join(dir, "state.json");
const silent = { warn: () => {} };

function collectWarnings() {
  const lines = [];
  return { logger: { warn: (message) => { lines.push(String(message)); } }, lines };
}

try {
  // 服务注册：stub ctx 上必须出现 openInAppState，且 homePath 由 ctx 提供时被真正采用。
  const wiredHome = freshDir();
  const provided = new Map();
  apply({
    get: (key) => (key === "dshHomePath" ? (...segments) => join(wiredHome, ...segments) : undefined),
    provide: (key, value) => { provided.set(key, value); },
    logger: silent,
  });
  assert.ok(provided.has("openInAppState"), "apply registers the openInAppState service");
  const wiredView = provided.get("openInAppState").namespace("dsh-open-in-codebuddy");
  wiredView.set("home", "codebuddy-install-root");
  assert.ok(existsSync(stateFile(join(wiredHome, "dsh-open-in-app-base"))), "the ctx-provided dshHomePath decides the state file location");

  // 服务形状：命名空间视图暴露约定的六个方法。
  const shapeService = createStateService({ homeDir: freshDir(), logger: silent });
  const shapeView = shapeService.namespace("dsh-open-in-codebuddy");
  for (const method of ["get", "set", "delete", "keys", "all", "subscribe"]) {
    assert.equal(typeof shapeView[method], "function", `namespace exposes ${method}()`);
  }
  assert.equal(shapeView.get("absent"), undefined, "an unknown key reads as undefined");
  assert.deepEqual(shapeView.keys(), [], "an untouched namespace has no keys");

  // owner 校验。
  assert.throws(() => shapeService.namespace(""), /owner/, "empty owner is rejected");
  assert.throws(() => shapeService.namespace("a".repeat(129)), /owner/, "an overlong owner is rejected");
  assert.throws(() => shapeService.namespace("has space"), /owner/, "an owner outside the allowed character set is rejected");
  assert.throws(() => shapeService.namespace(42), /owner/, "a non-string owner is rejected");

  // key 校验。
  assert.throws(() => shapeView.set("", 1), /key/, "an empty key is rejected");
  assert.throws(() => shapeView.set("a".repeat(129), 1), /key/, "an overlong key is rejected");
  assert.throws(() => shapeView.set("bad\u0001key", 1), /key/, "a control character in the key is rejected");
  assert.throws(() => shapeView.get(null), /key/, "a non-string key is rejected on read");

  // value 校验：拒绝一切不可 JSON 序列化的形态。
  assert.throws(() => shapeView.set("k", undefined), /JSON/, "undefined is rejected (delete is the way to clear)");
  assert.throws(() => shapeView.set("k", () => {}), /JSON/, "a function is rejected");
  assert.throws(() => shapeView.set("k", Symbol("s")), /JSON/, "a symbol is rejected");
  assert.throws(() => shapeView.set("k", 1n), /JSON/, "a BigInt is rejected");
  const circular = {};
  circular.self = circular;
  assert.throws(() => shapeView.set("k", circular), /JSON/, "a circular value is rejected");
  shapeView.set("nullValue", null);
  assert.equal(shapeView.get("nullValue"), null, "null is a legal JSON value");
  shapeView.set("numberValue", 5);
  assert.equal(shapeView.get("numberValue"), 5, "a number round-trips");

  // 体积上限：序列化后的字节数超过 64 KiB 即拒绝。
  assert.throws(() => shapeView.set("big", "x".repeat(65536)), /上限/, "an oversized value is rejected");
  shapeView.set("justEnough", "x".repeat(65530));
  assert.equal(shapeView.get("justEnough").length, 65530, "a value just under the limit is accepted");

  // 深拷贝：传入与取出的值都不与内部状态共享引用。
  const copyDir = freshDir();
  const copyView = createStateService({ homeDir: copyDir, logger: silent }).namespace("owner");
  const source = ["a"];
  copyView.set("list", source);
  source.push("b");
  assert.deepEqual(copyView.get("list"), ["a"], "the stored value is a copy, not the caller's object");
  copyView.get("list").push("c");
  assert.deepEqual(copyView.get("list"), ["a"], "get() hands out a copy");
  const snapshot = copyView.all();
  snapshot.list.push("d");
  snapshot.injected = true;
  assert.deepEqual(copyView.get("list"), ["a"], "all() hands out copies");
  assert.deepEqual(copyView.keys(), ["list"], "all() mutations never reach the namespace");

  // 读写往返：新实例重新打开同一目录即可读到既有值（string 与 array 各一例）。
  const roundTripDir = freshDir();
  createStateService({ homeDir: roundTripDir, logger: silent })
    .namespace("dsh-open-in-codebuddy").set("home", "codebuddy-install-root");
  createStateService({ homeDir: roundTripDir, logger: silent })
    .namespace("dsh-open-in-androidstudio").set("studioHome", ["studio-root-a", "studio-root-b"]);
  const reopened = createStateService({ homeDir: roundTripDir, logger: silent });
  assert.equal(reopened.namespace("dsh-open-in-codebuddy").get("home"), "codebuddy-install-root");
  assert.deepEqual(reopened.namespace("dsh-open-in-androidstudio").get("studioHome"), ["studio-root-a", "studio-root-b"],
    "a later instance sees every owner written before it");

  // 跨 owner 隔离：键名可以相同、形状可以不同，且写一个不覆盖另一个。
  const isolationDir = freshDir();
  const spaceA = createStateService({ homeDir: isolationDir, logger: silent }).namespace("owner-a");
  const spaceB = createStateService({ homeDir: isolationDir, logger: silent }).namespace("owner-b");
  spaceA.set("home", "string-value");
  spaceB.set("home", ["array-value"]);
  spaceA.set("home", "string-value-2");
  const isolated = createStateService({ homeDir: isolationDir, logger: silent });
  assert.equal(isolated.namespace("owner-a").get("home"), "string-value-2");
  assert.deepEqual(isolated.namespace("owner-b").get("home"), ["array-value"], "an owner write never clobbers another owner");

  // 损坏降级：坏档只 warn，服务继续可用，且后续写入能覆盖坏档。
  const corruptDir = freshDir();
  mkdirSync(corruptDir, { recursive: true });
  writeFileSync(stateFile(corruptDir), "{ not json", "utf8");
  const corruptWarnings = collectWarnings();
  const corruptService = createStateService({ homeDir: corruptDir, logger: corruptWarnings.logger });
  assert.equal(corruptService.namespace("owner").get("k"), undefined, "a corrupt file degrades to an empty state");
  assert.ok(corruptWarnings.lines.length >= 1, "a corrupt file is reported");
  corruptService.namespace("owner").set("k", 1);
  assert.deepEqual(
    JSON.parse(readFileSync(stateFile(corruptDir), "utf8")).namespaces,
    { owner: { k: 1 } },
    "a write replaces the corrupt file",
  );

  // 异档降级：unit.name 不匹配时按空状态处理。
  const foreignDir = freshDir();
  mkdirSync(foreignDir, { recursive: true });
  writeFileSync(stateFile(foreignDir), JSON.stringify({ unit: { name: "someone-else", version: 1 }, namespaces: { owner: { k: 1 } } }), "utf8");
  const foreignWarnings = collectWarnings();
  const foreignService = createStateService({ homeDir: foreignDir, logger: foreignWarnings.logger });
  assert.equal(foreignService.namespace("owner").get("k"), undefined, "a foreign unit file degrades to an empty state");
  assert.ok(foreignWarnings.lines.some((line) => line.includes("another unit")), "the foreign owner is reported");

  // 订阅：每次真实变更各通知一次，未变更与幂等删除都不通知，反注册后彻底静默。
  const listenDir = freshDir();
  const listenView = createStateService({ homeDir: listenDir, logger: silent }).namespace("owner");
  let notifications = 0;
  const unsubscribe = listenView.subscribe(() => { notifications += 1; });
  listenView.set("a", 1);
  assert.equal(notifications, 1, "set notifies once");
  listenView.set("a", 1);
  assert.equal(notifications, 1, "an unchanged set neither writes nor notifies");
  listenView.delete("a");
  assert.equal(notifications, 2, "delete notifies once");
  const afterDelete = readFileSync(stateFile(listenDir), "utf8");
  listenView.delete("a");
  assert.equal(notifications, 2, "an idempotent delete neither writes nor notifies");
  assert.equal(readFileSync(stateFile(listenDir), "utf8"), afterDelete, "an idempotent delete leaves the file untouched");
  assert.throws(() => listenView.subscribe("nope"), /listener/, "a non-function listener is rejected");
  unsubscribe();
  listenView.set("a", 2);
  assert.equal(notifications, 2, "unsubscribing silences the listener");

  // 外部重载：外部改写文件后，下一次读取即可见（拉取式，无 watcher，也不依赖时间戳）。
  const reloadDir = freshDir();
  const reloadView = createStateService({ homeDir: reloadDir, logger: silent }).namespace("owner");
  reloadView.set("k", "first");
  let reloadNotifications = 0;
  reloadView.subscribe(() => { reloadNotifications += 1; });
  const external = JSON.parse(readFileSync(stateFile(reloadDir), "utf8"));
  external.namespaces.owner.k = "external";
  writeFileSync(stateFile(reloadDir), JSON.stringify(external, null, 2), "utf8");
  assert.equal(reloadView.get("k"), "external", "an external write is picked up on the next read");
  assert.equal(reloadNotifications, 1, "an external reload notifies subscribers");

  // 原子写：目录里除正式文件外不留临时文件，且文件是合法 JSON。
  assert.deepEqual(readdirSync(reloadDir), ["state.json"], "no temp file survives an atomic write");
  assert.equal(typeof JSON.parse(readFileSync(stateFile(reloadDir), "utf8")).namespaces, "object");

  // home 解析：ctx 未提供 dshHomePath 时回落本地解析，遵循 $DSH_HOME 优先。
  const fallbackDir = freshDir();
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = fallbackDir;
  try {
    const fallbackWarnings = collectWarnings();
    const fallbackView = createStateService({
      homePath: () => { throw new Error("no ctx service"); },
      logger: fallbackWarnings.logger,
    }).namespace("owner");
    fallbackView.set("k", "v");
    assert.ok(fallbackWarnings.lines.some((line) => line.includes("falling back")), "a failing dshHomePath is reported");
    assert.ok(
      existsSync(stateFile(join(fallbackDir, "dsh-open-in-app-base"))),
      "the local resolver honours $DSH_HOME when the ctx service is unavailable",
    );
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }

  console.log("host-selftest: all assertions passed");
} finally {
  rmSync(SANDBOX, { recursive: true, force: true });
}

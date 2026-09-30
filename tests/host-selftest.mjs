// 宿主半边离线自测：不装载进 DSH，校验导出契约与清单/产物的对齐关系。
// 覆盖：入口导出、apply 可安全执行、package.json 字段指向真实产物、bundle patch 行与包名一致。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, root), "utf8"));
const pkg = readJson("package.json");

const { apply, name } = await import(new URL("lib/index.js", root).href);

assert.equal(typeof apply, "function", "apply exported");
// 三个名字各司其职：insert.name 是包名、insert.id 是 patch 行标识、插件导出的 name 是 cordis 服务名。
assert.equal(name, "open-in-app-base", "exported name is the cordis service name");
assert.doesNotThrow(() => { apply(); }, "empty apply is safe to call");

// ---- 清单与产物对齐 ----

assert.equal(pkg.main, "lib/index.js", "main points at the built host entry");
assert.equal(pkg.exports["."], "./lib/index.js", "exports[\".\"] matches main");
assert.equal(pkg.exports["./client"], "./lib/client.js", "exports[\"./client\"] matches the client bundle");
for (const rel of ["lib/index.js", "lib/client.js", "cordis.patch.yml", pkg.exports["."], pkg.exports["./client"]]) {
  assert.ok(existsSync(new URL(rel, root)), `built file exists: ${rel}`);
}
for (const rel of ["src/index.mjs", "src/client/00-head.js", "src/client/90-tail.js"]) {
  assert.ok(existsSync(new URL(rel, root)), `source file exists: ${rel}`);
}
assert.ok(pkg.files.includes("DEVELOPMENT.md"), "the dev guide ships with the package (README links to it)");

// ---- 文档引用齐备：README 与开发指南里的包内相对链接必须真实存在 ----

for (const doc of ["README.md", "DEVELOPMENT.md"]) {
  const text = readFileSync(new URL(doc, root), "utf8");
  for (const match of text.matchAll(/\]\(\.\/([^)#?]+)\)/g)) {
    assert.ok(existsSync(new URL(match[1], root)), `${doc} links to an existing file: ${match[1]}`);
  }
}

// ---- bundle patch 行 ----

const patch = readFileSync(new URL(pkg.dsh.bundle.patch, root), "utf8");
const rowId = /^\s*-\s*id:\s*(\S+)\s*$/m.exec(patch);
const rowName = /^\s*name:\s*'?([^'\s]+)'?\s*$/m.exec(patch);
assert.ok(rowId && rowName, "bundle patch declares one insert row");
assert.equal(rowName[1], pkg.name, "insert.name is the package name (resolved through profile node_modules)");
assert.equal(rowId[1], name, "insert.id equals the exported cordis service name");

// ---- client 半的静态声明 ----

const clientBundle = readFileSync(new URL("lib/client.js", root), "utf8");
assert.ok(clientBundle.includes(`id: "${pkg.name}"`), "client bundle registers under the package name");
assert.ok(clientBundle.includes("conversation.session.header.utilities"), "client bundle targets the session header slot");
assert.ok(!clientBundle.includes("@deepseek-ai/dsh-client-ui-open-in-app"), "client bundle does not reach into the native open-in-app package");

console.log("host-selftest: all assertions passed");

// dsh-open-in-app-base — 宿主侧状态存储实现。
//
// 底座独占本文件的全部文件 I/O，下游只经 cordis 服务 openInAppState 读写，
// 因此下游不需要知道路径、格式与落盘细节。
//
// 存储模型：单一 JSON 文档 + 按 owner（下游包名）分命名空间。
// 数据量在 KiB 级，故采用「内存态 + 同步落盘」，避免异步竞态与写队列。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const STATE_DIR_NAME = "dsh-open-in-app-base";
const STATE_FILE_NAME = "state.json";
const UNIT_NAME = "dsh-open-in-app-base";
const UNIT_VERSION = 1;

const OWNER_MAX_LENGTH = 128;
const OWNER_PATTERN = /^[A-Za-z0-9@._/-]+$/;
const KEY_MAX_LENGTH = 128;
const KEY_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const VALUE_MAX_BYTES = 65536;

/**
 * 本地兜底的 harness home 解析，仅在宿主 ctx 未提供 dshHomePath 服务时使用。
 * 优先级与官方 @deepseek-ai/dsh-home-paths 的 resolveDshHome 一致：
 * 非空 $DSH_HOME > ~/.dsh，并支持 ~ / ~/ / ~\ 前缀展开。
 * @param segments - 追加到 home 之下的路径片段。
 * @returns 规范化后的绝对路径。
 */
function localHomePath(...segments) {
  const configured = process.env.DSH_HOME;
  const selected = typeof configured === "string" && configured.trim().length > 0
    ? configured.trim()
    : join(homedir(), ".dsh");
  return join(resolve(expandTilde(selected)), ...segments);
}

function expandTilde(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 深拷贝：入内存与出服务的值都不与调用方共享引用，避免外部改动污染内部状态。 */
function cloneValue(value) {
  return value === null || typeof value !== "object" ? value : JSON.parse(JSON.stringify(value));
}

function defaultWarn(message) {
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(`dsh-open-in-app-base: ${message}`);
  }
}

/**
 * 创建一个状态服务实例。
 * @param options - 可选配置。
 * @param options.homeDir - 直接指定状态目录（测试注入用）；给出时优先于 homePath。
 * @param options.homePath - 宿主 ctx 的 dshHomePath（官方实现）；缺席或异常时回落本地解析。
 * @param options.logger - 日志器，只用其 warn；缺席时退回 console.warn。
 * @returns 服务对象，含 namespace(owner) 方法。
 */
export function createStateService(options = {}) {
  const homeDir = options.homeDir;
  const homePath = options.homePath;
  const warn = typeof options.logger?.warn === "function"
    ? (message) => { options.logger.warn(message); }
    : defaultWarn;

  const stateFile = resolveStateFile();

  /** 内存态文档；每次同步或落盘时被整体替换。 */
  let document = { namespaces: {} };
  let loaded = false;
  const listeners = new Set();
  const views = new Map();

  function resolveStateFile() {
    if (typeof homeDir === "string" && homeDir.trim().length > 0) {
      return join(resolve(homeDir.trim()), STATE_FILE_NAME);
    }
    if (typeof homePath === "function") {
      try {
        const resolved = homePath(STATE_DIR_NAME, STATE_FILE_NAME);
        if (typeof resolved === "string" && resolved.length > 0) return resolved;
        warn("dshHomePath returned no path; falling back to the local resolver");
      } catch (error) {
        warn(`dshHomePath failed; falling back to the local resolver: ${String(error?.message ?? error)}`);
      }
    }
    return localHomePath(STATE_DIR_NAME, STATE_FILE_NAME);
  }

  /** 读取并规范化磁盘文档；任何异常都降级为空状态（坏档不阻断能力）。 */
  function loadDocument() {
    let text;
    try {
      text = readFileSync(stateFile, "utf8");
    } catch (error) {
      // ENOENT 是正常首启；其余读取错误值得记录。
      if (error?.code !== "ENOENT") warn(`state file is unreadable, starting empty: ${String(error?.message ?? error)}`);
      return { namespaces: {} };
    }
    try {
      const parsed = JSON.parse(text);
      if (!isPlainObject(parsed)) {
        warn("state file is not a JSON object, starting empty");
        return { namespaces: {} };
      }
      const unit = parsed.unit;
      if (isPlainObject(unit) && unit.name !== undefined && unit.name !== UNIT_NAME) {
        warn(`state file belongs to another unit (${String(unit.name)}), starting empty`);
        return { namespaces: {} };
      }
      const namespaces = parsed.namespaces;
      if (!isPlainObject(namespaces)) return { namespaces: {} };
      // 只收编对象形态的命名空间：非对象项无法承载 key/value，直接丢弃以免读取期出错。
      const kept = {};
      for (const [owner, value] of Object.entries(namespaces)) {
        if (isPlainObject(value)) kept[owner] = value;
      }
      return { namespaces: kept };
    } catch (error) {
      warn(`state file is unreadable, starting empty: ${String(error?.message ?? error)}`);
      return { namespaces: {} };
    }
  }

  /**
   * 拉取式同步：每次读写前重读磁盘并与内存比对。底座不装文件 watcher，
   * 外部进程的写入只在本进程下一次读/写时被感知。
   *
   * 这里刻意不用 mtime 做短路：文件时间戳精度有限（毫秒级），同一毫秒内的连续
   * 外部写会被判成「没变」，随后的写入便会基于过期内存整档覆盖掉别的 owner。
   * 状态文件在 KiB 级，整读一份的成本远低于一次跨 owner 数据丢失。
   * @returns 是否发生了外部变更（用于决定是否通知订阅者）。
   */
  function syncFromDisk() {
    const next = loadDocument();
    const changed = loaded && JSON.stringify(next) !== JSON.stringify(document);
    document = next;
    loaded = true;
    if (changed) notify();
    return changed;
  }

  function notify() {
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch (error) {
        // 通知不是事务参与者：变更已经落盘，监听方异常只能记录，不能反噬写入。
        warn(`state listener failed: ${String(error?.message ?? error)}`);
      }
    }
  }

  function namespaces() {
    return isPlainObject(document.namespaces) ? document.namespaces : {};
  }

  /** 取某 owner 的命名空间对象；缺失时返回空对象，调用方据此构造下一版。 */
  function ownerSpace(owner) {
    const space = namespaces()[owner];
    return isPlainObject(space) ? space : {};
  }

  /**
   * 落盘优先写入：先构造下一版文档并原子写盘，成功后才提交内存。
   * 写盘失败时内存保持原值并抛错，避免出现「内存已变、磁盘未变」的静默分歧。
   */
  function persist(owner, nextSpace) {
    const nextNamespaces = { ...namespaces(), [owner]: nextSpace };
    const text = JSON.stringify({ unit: { name: UNIT_NAME, version: UNIT_VERSION }, namespaces: nextNamespaces }, null, 2);
    const directory = dirname(stateFile);
    // 临时文件名带 pid 与随机后缀：多 profile 进程同时写同一文件时不会互相踩同一个 tmp。
    const tempFile = `${stateFile}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(tempFile, text, "utf8");
      renameSync(tempFile, stateFile);
    } catch (error) {
      try {
        rmSync(tempFile, { force: true });
      } catch {
        // 清理孤儿 tmp 失败不影响主流程：异常已由下面的抛错上报。
      }
      warn(`state file write failed: ${String(error?.message ?? error)}`);
      throw new Error(`openInAppState(${owner}): 状态落盘失败：${String(error?.message ?? error)}`, { cause: error });
    }
    document = { namespaces: nextNamespaces };
    loaded = true;
  }

  function assertOwner(owner) {
    const text = typeof owner === "string" ? owner.trim() : "";
    if (text.length === 0) {
      throw new Error("openInAppState.namespace: owner 必须是非空字符串（下游包名）");
    }
    if (text.length > OWNER_MAX_LENGTH) {
      throw new Error(`openInAppState.namespace: owner 长度不得超过 ${OWNER_MAX_LENGTH}`);
    }
    if (!OWNER_PATTERN.test(text)) {
      throw new Error(`openInAppState.namespace: owner "${text}" 含非法字符（只允许字母、数字与 @ . _ / -）`);
    }
    return text;
  }

  function assertKey(owner, key) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error(`openInAppState(${owner}): key 必须是非空字符串`);
    }
    if (key.length > KEY_MAX_LENGTH) {
      throw new Error(`openInAppState(${owner}): key 长度不得超过 ${KEY_MAX_LENGTH}`);
    }
    if (KEY_CONTROL_PATTERN.test(key)) {
      throw new Error(`openInAppState(${owner}): key 不得包含控制字符`);
    }
    return key;
  }

  /** 校验 value 并返回其深拷贝副本；不可序列化或超限即抛错。 */
  function normalizeValue(owner, key, value) {
    let text;
    try {
      text = JSON.stringify(value);
    } catch (error) {
      throw new Error(
        `openInAppState(${owner}).set("${key}"): value 无法序列化为 JSON（循环引用或含 BigInt）：${String(error?.message ?? error)}`,
        { cause: error },
      );
    }
    if (text === undefined) {
      throw new Error(
        `openInAppState(${owner}).set("${key}"): value 必须是可 JSON 序列化的值（拒绝 undefined / 函数 / Symbol）；清空请用 delete`,
      );
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > VALUE_MAX_BYTES) {
      throw new Error(`openInAppState(${owner}).set("${key}"): value 序列化后 ${bytes} 字节，超过上限 ${VALUE_MAX_BYTES}`);
    }
    return JSON.parse(text);
  }

  function namespace(owner) {
    const name = assertOwner(owner);
    const cached = views.get(name);
    if (cached !== undefined) return cached;
    const view = Object.freeze({
      get(key) {
        assertKey(name, key);
        syncFromDisk();
        return cloneValue(ownerSpace(name)[key]);
      },
      set(key, value) {
        assertKey(name, key);
        const stored = normalizeValue(name, key, value);
        syncFromDisk();
        const current = ownerSpace(name);
        if (Object.prototype.hasOwnProperty.call(current, key) && JSON.stringify(current[key]) === JSON.stringify(stored)) {
          return; // 值未变：不写盘、不通知。
        }
        persist(name, { ...current, [key]: stored });
        notify();
      },
      delete(key) {
        assertKey(name, key);
        syncFromDisk();
        const current = ownerSpace(name);
        if (!Object.prototype.hasOwnProperty.call(current, key)) return;
        const next = { ...current };
        delete next[key];
        // 该 owner 清空后保留空对象：语义直白，且省去「何时删除条目」的判断。
        persist(name, next);
        notify();
      },
      keys() {
        syncFromDisk();
        return Object.keys(ownerSpace(name));
      },
      all() {
        syncFromDisk();
        const space = ownerSpace(name);
        const snapshot = {};
        for (const [key, value] of Object.entries(space)) snapshot[key] = cloneValue(value);
        return snapshot;
      },
      subscribe(listener) {
        if (typeof listener !== "function") {
          throw new Error(`openInAppState(${name}).subscribe: listener 必须是函数`);
        }
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    });
    views.set(name, view);
    return view;
  }

  return Object.freeze({ namespace });
}

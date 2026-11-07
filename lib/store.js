/**
 * 状态存储：意图 / 清单 / 探测缓存 / 备份。
 *
 * 位置：~/.dsh/profiles/desktop/.dsh-model-protocol-matrix/
 * 为什么不用插件自己的 loader 条目存：
 *   写自己的条目会触发该条目重载 → 本插件重新激活 → 再次写入（gearbox 用
 *   “写入前 preview + deepEqual 短路”压住这个循环）。把变更频繁的意图/清单
 *   放到外部 JSON，只让静态设置留在 patch 里，能彻底避开这个自激路径。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const PROFILE = 'desktop';

export function stateDir() {
  return join(homedir(), '.dsh', 'profiles', PROFILE, '.dsh-model-protocol-matrix');
}

export function backupsDir() {
  return join(stateDir(), 'backups');
}

export function patchPath() {
  return join(homedir(), '.dsh', 'profiles', PROFILE, 'cordis.patch.yml');
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** 读 JSON；缺失或损坏时返回 fallback（损坏文件会先重命名留证）。 */
export function readJSON(file, fallback) {
  const path = join(stateDir(), file);
  if (!existsSync(path)) return structuredClone(fallback);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const rescue = path + '.corrupt-' + Date.now();
    try { rmSync(rescue, { force: true }); } catch {}
    try { writeFileSync(rescue, readFileSync(path, 'utf8')); } catch {}
    return structuredClone(fallback);
  }
}

/** 原子写：同目录临时文件 + rename，避免半截 JSON。 */
export function writeJSON(file, value) {
  ensureDir(stateDir());
  const path = join(stateDir(), file);
  const tmp = path + '.tmp-' + process.pid + '-' + Date.now();
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try { rmSync(path, { force: true }); } catch {}
  writeFileSync(path, readFileSync(tmp));
  rmSync(tmp, { force: true });
}

// ---------------------------------------------------------------- 意图 / 清单

const EMPTY_INTENT = { version: 1, profile: PROFILE, routes: {} };
const EMPTY_MANIFEST = { version: 1, profile: PROFILE, managedRoutes: {}, baseline: {}, lastApply: null, pendingWrite: null };

export function readIntent() {
  return readJSON('intent.json', EMPTY_INTENT);
}

export function writeIntent(intent) {
  writeJSON('intent.json', { ...intent, version: 1, profile: PROFILE });
}

export function readManifest() {
  return readJSON('manifest.json', EMPTY_MANIFEST);
}

export function writeManifest(manifest) {
  writeJSON('manifest.json', { ...manifest, version: 1, profile: PROFILE });
}

// ---------------------------------------------------------------- 探测缓存

export function readProbeCache() {
  return readJSON('probe-cache.json', { version: 1, entries: {} });
}

export function writeProbeCache(cache) {
  writeJSON('probe-cache.json', { ...cache, version: 1 });
}

export function probeKey(route, model, protocol, endpointHash) {
  return [route, model, protocol, endpointHash].join('|');
}

// ---------------------------------------------------------------- 隐藏列表

export function readHidden() {
  const intent = readIntent();
  return Array.isArray(intent.hidden) ? intent.hidden : [];
}

export function writeHidden(hidden) {
  const intent = readIntent();
  writeIntent({ ...intent, hidden: [...new Set(hidden)].sort() });
}

// ---------------------------------------------------------------- 备份

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * 写入前双备份：命名空间快照（权威）+ patch 文件副本（用户当前配置就在文件里）。
 * 任一步失败即抛错，调用方必须中止写入。
 */
export function backup(liveProviders, patch = true) {
  ensureDir(backupsDir());
  const at = stamp();
  const snapshot = join(backupsDir(), `llm-pi-ai-${at}.json`);
  writeFileSync(snapshot, JSON.stringify({ at: new Date().toISOString(), providers: liveProviders }, null, 2) + '\n', { mode: 0o600 });

  let fileCopy = null;
  if (patch && existsSync(patchPath())) {
    fileCopy = join(backupsDir(), `cordis.patch.${at}.yml`);
    writeFileSync(fileCopy, readFileSync(patchPath()), { mode: 0o600 });
  }
  prune(20);
  return { at: new Date().toISOString(), snapshot, patch: fileCopy };
}

function prune(keep) {
  if (!existsSync(backupsDir())) return;
  const files = readdirSync(backupsDir()).filter((f) => f.endsWith('.json') || f.endsWith('.yml'));
  const byStamp = new Map();
  for (const name of files) {
    const m = /^(?:llm-pi-ai-|cordis\.patch\.)(.+)\.(?:json|yml)$/.exec(name);
    if (!m) continue;
    const list = byStamp.get(m[1]) ?? [];
    list.push(name);
    byStamp.set(m[1], list);
  }
  const ordered = [...byStamp.keys()].sort().reverse();
  for (const key of ordered.slice(keep)) {
    for (const name of byStamp.get(key)) {
      try { rmSync(join(backupsDir(), name), { force: true }); } catch {}
    }
  }
}

export function listBackups() {
  if (!existsSync(backupsDir())) return [];
  return readdirSync(backupsDir())
    .filter((f) => f.startsWith('llm-pi-ai-') && f.endsWith('.json'))
    .sort()
    .reverse()
    .map((f) => join(backupsDir(), f));
}

export function readBackup(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

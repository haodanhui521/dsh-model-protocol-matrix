/**
 * dsh-model-protocol-matrix —— host 半。
 *
 * 职责：
 *  1. 读 llm-pi-ai（经 configEditor），把“每个模型一个协议”的意图编译成合法路由；
 *  2. 写回 llm-pi-ai（备份 → 本地预校验 → editor.edit → 回读校验，见 apply.js）；
 *  3. 三协议探测（裸 HTTP + 对照探针，见 probe.js）；
 *  4. 隐藏不可用模型（包装 llm.listModels，一处生效覆盖 composer / 子代理 / 官方设置页）。
 *
 * 与 dsh-gearbox **硬互斥**：检测到它的 loader 条目即进入只读模式。
 * 原因：gearbox 的协议切换每次 apply 都基于 live providers 全量重算，
 * 没有路由所有权概念，两者同时写必然互相覆盖。
 */
import { isDeepStrictEqual } from 'node:util';
import { Config } from './config.js';
import { applyIntent, normalizeIntent, snapshotOf, validateProviders } from './apply.js';
import { PROTOCOLS } from './compat.js';
import { plan } from './planner.js';
import { probeModelProtocol } from './probe.js';
import { settingsPage } from './settings-page.js';
import {
  backup,
  listBackups,
  readBackup,
  readHidden,
  readIntent,
  readManifest,
  readProbeCache,
  writeHidden,
  writeIntent,
  writeManifest,
  writeProbeCache,
} from './store.js';

export const name = 'dsh-model-protocol-matrix';
export const inject = ['configEditor', 'webServer', 'credentials', 'llm'];
export { Config };

const PI_AI = '@deepseek-ai/dsh-llm-pi-ai';
const PI_AI_ID = 'llm-pi-ai';
const GEARBOX = 'dsh-gearbox';
const PATCHED = Symbol.for('dsh-model-protocol-matrix/listModels');

/** 注入给 apply.js 的 store 适配器（apply.js 只依赖接口，便于单测注入内存实现）。 */
const storeAdapter = { readIntent, readManifest, backup, writeIntent, writeManifest };

// ---------------------------------------------------------------- 配置读取

function findEntry(ctx, packageName, id) {
  const editor = ctx.get('configEditor');
  if (editor === undefined) return undefined;
  try {
    return editor.entries().find((entry) =>
      entry.options?.name === packageName
      || entry.name === packageName
      || entry.options?.id === id);
  } catch {
    return undefined;
  }
}

function piAiEntry(ctx) {
  return findEntry(ctx, PI_AI, PI_AI_ID);
}

function gearboxPresent(ctx) {
  return findEntry(ctx, GEARBOX, 'gearbox') !== undefined;
}

function snapshot(ctx) {
  const editor = ctx.get('configEditor');
  const entry = piAiEntry(ctx);
  if (editor === undefined || entry === undefined) return { editor, entry, live: {} };
  const { live } = snapshotOf(editor, entry);
  return { editor, entry, live };
}

// ---------------------------------------------------------------- 探测

async function resolveKey(ctx, profile) {
  const ref = profile?.apiKeyEnv;
  if (typeof ref !== 'string' || ref.length === 0) return { key: undefined, source: 'none' };
  const credentials = ctx.get('credentials');
  try {
    const resolved = await credentials?.resolve?.(ref);
    if (resolved?.value) return { key: resolved.value, source: 'credentials' };
  } catch { /* 落到环境变量 */ }
  if (process.env[ref]) return { key: process.env[ref], source: 'env' };
  return { key: undefined, source: 'missing' };
}

async function probeOne(ctx, { route, model, protocols, timeoutMs }) {
  const { live } = snapshot(ctx);
  const profile = live[route];
  if (profile === undefined) return { ok: false, error: '路由 ' + route + ' 不存在' };
  if (!Array.isArray(profile.models) || !profile.models.some((m) => m.id === model)) {
    return { ok: false, error: '模型 ' + model + ' 不在路由 ' + route + ' 下' };
  }
  const list = Array.isArray(protocols) && protocols.length > 0 ? protocols : [...PROTOCOLS];
  const { key } = await resolveKey(ctx, profile);
  const cache = readProbeCache();
  const results = [];
  for (const protocol of list) {
    if (!PROTOCOLS.includes(protocol)) continue;
    const result = await probeModelProtocol({
      route, model, protocol,
      baseURL: profile.baseURL,
      key,
      timeoutMs,
      runId: route + ':' + model,
    });
    cache.entries[route + '|' + model + '|' + protocol] = result;
    results.push(result);
  }
  writeProbeCache(cache);
  return { ok: true, route, model, results, keySource: key === undefined ? 'missing' : 'resolved' };
}

// ---------------------------------------------------------------- 可见性

let hiddenCache = null;
function hiddenSet() {
  if (hiddenCache === null) hiddenCache = new Set(readHidden());
  return hiddenCache;
}

/**
 * 包装 llm.listModels 实现隐藏。
 *
 * 一处生效覆盖：composer（modelDirectories → remote.session.modelCatalog）、
 * 子代理模型选择（dsh-tool-subagent 直接调 llm.listModels）、官方模型页。
 * 全程容错：服务不可用、属性只读（冻结对象 / getter）都只降级为“隐藏不可用”，
 * 绝不让 apply 抛出——插件挂载失败会比少一个功能严重得多。
 */
function installVisibility(ctx) {
  try {
    const llm = ctx.get('llm');
    if (llm === undefined || typeof llm.listModels !== 'function') return;
    if (llm.listModels[PATCHED] === true) return;

    const original = llm.listModels.bind(llm);
    const patched = async (provider) => {
      const models = await original(provider);
      const hidden = hiddenSet();
      if (hidden.size === 0) return models;
      return models.filter((model) => !hidden.has(provider + '/' + model.id));
    };
    patched[PATCHED] = true;
    patched.original = original;
    llm.listModels = patched;   // 实例属性遮蔽原型方法

    ctx.effect(() => () => {
      if (llm.listModels === patched) llm.listModels = original;
    }, 'dsh-model-protocol-matrix: visibility filter');
  } catch (error) {
    ctx.logger?.warn?.('dsh-model-protocol-matrix: 隐藏能力未安装（llm.listModels 不可包装）', error);
  }
}

// ---------------------------------------------------------------- HTTP

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (raw.length === 0) return {};
  return JSON.parse(raw);
}

/** 收集全部模型（不经过 llm.listModels，因此隐藏后本页仍可见）。 */
function inventory(ctx) {
  const { live } = snapshot(ctx);
  const intent = readIntent();
  const manifest = readManifest();
  const cache = readProbeCache();
  const hidden = new Set(readHidden());
  return {
    gearbox: gearboxPresent(ctx),
    routes: Object.entries(live).map(([route, profile]) => ({
      route,
      api: profile.api,
      baseURL: profile.baseURL,
      displayName: profile.displayName,
      managed: Object.hasOwn(manifest.managedRoutes, route),
      models: (profile.models ?? []).map((model) => ({
        id: model.id,
        name: model.name,
        protocols: Object.fromEntries(
          PROTOCOLS.map((protocol) => [protocol, cache.entries?.[route + '|' + model.id + '|' + protocol] ?? null]),
        ),
        selected: intent.routes?.[route]?.models?.[model.id]?.protocol,
        hidden: hidden.has(route + '/' + model.id),
      })),
    })),
    hidden: [...hidden],
    backups: listBackups().slice(0, 5),
  };
}

function registerHttp(ctx) {
  const webServer = ctx.get('webServer');
  if (webServer === undefined) return;
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/protocol-matrix/api',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://dsh.internal');
      try {
        if (req.method === 'GET' && url.pathname === '/protocol-matrix/api/info') {
          return json(res, 200, { ok: true, gearbox: gearboxPresent(ctx), inventory: inventory(ctx) });
        }
        if (req.method === 'GET' && url.pathname === '/protocol-matrix/api/inventory') {
          return json(res, 200, { ok: true, ...inventory(ctx) });
        }
        if (req.method === 'POST' && url.pathname === '/protocol-matrix/api/validate') {
          const body = await readBody(req);
          const { live } = snapshot(ctx);
          const manifest = readManifest();
          const intent = normalizeIntent(body, readIntent());
          const preview = plan(live, intent, { managedRoutes: manifest.managedRoutes });
          return json(res, 200, {
            ok: true,
            changed: !isDeepStrictEqual(preview.nextProviders, live),
            diff: preview.diff,
            notes: preview.notes,
            conflicts: preview.conflicts,
            rejected: validateProviders(preview.nextProviders, manifest.managedRoutes),
          });
        }
        if (req.method === 'POST' && url.pathname === '/protocol-matrix/api/apply') {
          const body = await readBody(req);
          const { editor, entry } = snapshot(ctx);
          return json(res, 200, await applyIntent({
            editor, entry, store: storeAdapter, input: body, gearbox: gearboxPresent(ctx),
          }));
        }
        if (req.method === 'POST' && url.pathname === '/protocol-matrix/api/probe') {
          return json(res, 200, await probeOne(ctx, await readBody(req)));
        }
        if (req.method === 'GET' && url.pathname === '/protocol-matrix/api/visibility') {
          return json(res, 200, { ok: true, hidden: readHidden() });
        }
        if (req.method === 'POST' && url.pathname === '/protocol-matrix/api/visibility') {
          const body = await readBody(req);
          const key = body.route + '/' + body.model;
          const hidden = new Set(readHidden());
          if (body.hidden === true) hidden.add(key); else hidden.delete(key);
          writeHidden([...hidden]);
          hiddenCache = hidden;
          return json(res, 200, { ok: true, hidden: [...hidden] });
        }
        if (req.method === 'POST' && url.pathname === '/protocol-matrix/api/restore') {
          const body = await readBody(req);
          const backups = listBackups();
          const target = body.backup ?? backups[0];
          if (target === undefined) return json(res, 404, { ok: false, error: '没有可用备份' });
          const editor = ctx.get('configEditor');
          const entry = piAiEntry(ctx);
          const saved = readBackup(target);
          await editor.edit(entry, (current) => ({ ...current, providers: saved.providers }));
          return json(res, 200, { ok: true, restored: target });
        }
        return json(res, 404, { ok: false, error: 'unknown route' });
      } catch (error) {
        return json(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }), 'dsh-model-protocol-matrix: api');

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/protocol-matrix/ui',
    handler: async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(settingsPage());
    },
  }), 'dsh-model-protocol-matrix: ui');
}

// ---------------------------------------------------------------- 入口

export function apply(ctx, rawConfig) {
  const config = rawConfig ?? {};
  if (config.enabled === false) {
    ctx.logger?.info?.('dsh-model-protocol-matrix: disabled');
    return;
  }
  if (gearboxPresent(ctx)) {
    ctx.logger?.warn?.('dsh-model-protocol-matrix: 检测到 dsh-gearbox，进入只读模式（两者二选一）');
  }
  try {
    installVisibility(ctx);
    registerHttp(ctx);
    ctx.logger?.info?.('dsh-model-protocol-matrix: mounted at /protocol-matrix/ui');
  } catch (error) {
    ctx.logger?.warn?.('dsh-model-protocol-matrix: 挂载失败', error);
  }
}
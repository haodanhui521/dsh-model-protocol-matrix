/**
 * 写入通道：意图 → 目标 providers → 本地预校验 → 备份 → configEditor.edit → 回读校验。
 *
 * 与 index.js 分离，是为了让这一层可以在 node 里用 mock editor 单测
 * （index.js 依赖 @deepseek-ai/schemastery，只能在 DSH 运行时里加载）。
 */
import { isDeepStrictEqual } from 'node:util';
import { mergeProviders, plan } from './planner.js';
import { COMPAT_GATES, PROTOCOLS } from './compat.js';

/** 从 configEditor 读三层：entry / inherited(bundle) / override(profile)，合并成 live providers。 */
export function snapshotOf(editor, entry) {
  const record = editor.configuration().find((candidate) => candidate.entry === entry);
  const live = mergeProviders(record?.inherited, record?.override ?? entry.options?.config ?? {});
  return { record, live };
}

/**
 * 归一化意图：
 *  - 完整结构 { routes: { [route]: { models: { [id]: { protocol } } } } }
 *  - 或简化 { plan: { "route/model": protocol|null } }，null 表示清除选择
 */
export function normalizeIntent(input, base) {
  const intent = { version: 1, routes: {}, ...(base ?? {}) };
  if (input?.routes !== undefined) return { ...intent, routes: input.routes };
  const routes = { ...(intent.routes ?? {}) };
  for (const [key, protocol] of Object.entries(input?.plan ?? {})) {
    const slash = key.indexOf('/');
    if (slash <= 0) continue;
    const route = key.slice(0, slash);
    const model = key.slice(slash + 1);
    const models = { ...(routes[route]?.models ?? {}) };
    if (protocol === null) delete models[model];
    else if (PROTOCOLS.includes(protocol)) models[model] = { protocol, source: 'manual' };
    else continue;
    routes[route] = { ...(routes[route] ?? {}), models };
  }
  return { ...intent, routes };
}

/** 写前影子校验：任何一条不合法都不写（pi-ai 的 INVALID_CONFIG 会拖垮整份保存）。 */
export function validateProviders(providers, managedRoutes = {}) {
  const rejected = [];
  for (const [route, profile] of Object.entries(providers ?? {})) {
    const managed = Object.hasOwn(managedRoutes, route);
    const models = Array.isArray(profile.models) ? profile.models : [];
    if (managed || models.length > 0) {
      if (profile.api === undefined) rejected.push({ route, field: 'api', reason: '缺少 api' });
      else if (!PROTOCOLS.includes(profile.api)) rejected.push({ route, field: 'api', reason: '未知协议 ' + profile.api });
      if (profile.baseURL === undefined) rejected.push({ route, field: 'baseURL', reason: '缺少 baseURL' });
      if (models.length === 0) rejected.push({ route, field: 'models', reason: '缺少 models 列表' });
      if (managed && profile.modelOverrides !== undefined) rejected.push({ route, field: 'modelOverrides', reason: '派生路由不能带 modelOverrides' });
    }
    for (const model of models) {
      for (const field of Object.keys(model.compat ?? {})) {
        if (!COMPAT_GATES[profile.api]?.has(field)) {
          rejected.push({ route, model: model.id, field: 'compat.' + field, reason: profile.api + ' 不接受该开关（会拖垮整份保存）' });
        }
      }
    }
    for (const field of Object.keys(profile.compat ?? {})) {
      if (!COMPAT_GATES[profile.api]?.has(field)) {
        rejected.push({ route, field: 'compat.' + field, reason: profile.api + ' 不接受该开关' });
      }
    }
  }
  return rejected;
}

/** 依据 diff 更新 manifest 的托管路由表。 */
export function managedRoutesAfter(diff, nextProviders, previous) {
  const managed = { ...(previous ?? {}) };
  for (const item of diff ?? []) {
    if (item.kind === 'create' || item.kind === 'update') {
      managed[item.route] = {
        owner: 'plugin',
        parent: item.parent ?? item.route,
        protocol: nextProviders[item.route]?.api,
        models: (nextProviders[item.route]?.models ?? []).map((model) => model.id),
      };
    }
    if (item.kind === 'delete') delete managed[item.route];
  }
  return managed;
}

/**
 * @param {object} options
 * @param {object} options.editor configEditor 服务
 * @param {object} options.entry  llm-pi-ai 的 loader 条目
 * @param {object} options.store  真实 store 或测试用内存 store
 * @param {object} options.input  意图输入
 * @param {boolean} [options.gearbox] 是否检测到 dsh-gearbox
 * @returns {Promise<object>} 结果对象（ok/changed/diff/notes/backup/rejected/conflicts/code）
 */
export async function applyIntent({ editor, entry, store, input, gearbox = false }) {
  if (gearbox) {
    return { ok: false, code: 'GEARBOX_CONFLICT', error: '检测到 dsh-gearbox：两者二选一，请先禁用/卸载 gearbox' };
  }
  if (editor === undefined || entry === undefined) {
    return { ok: false, code: 'NO_PI_AI', error: '找不到 llm-pi-ai 的 loader 条目' };
  }

  const { live } = snapshotOf(editor, entry);
  const intent = normalizeIntent(input, store.readIntent());
  const manifest = store.readManifest();
  const preview = plan(live, intent, { managedRoutes: manifest.managedRoutes });

  if (preview.conflicts.length > 0) {
    return { ok: false, code: 'CONFLICT', conflicts: preview.conflicts, diff: preview.diff, notes: preview.notes };
  }
  const rejected = validateProviders(preview.nextProviders, manifest.managedRoutes);
  if (rejected.length > 0) {
    return { ok: false, code: 'INVALID', rejected, diff: preview.diff, notes: preview.notes };
  }
  if (isDeepStrictEqual(preview.nextProviders, live)) {
    return { ok: true, changed: false, diff: [], notes: preview.notes };
  }

  const saved = store.backup(live);

  let written;
  await editor.edit(entry, (current, inherited) => {
    const merged = mergeProviders(inherited, current);
    const next = plan(merged, intent, { managedRoutes: manifest.managedRoutes });
    written = next.nextProviders;
    return { ...current, providers: next.nextProviders };
  });

  const { live: actual } = snapshotOf(editor, entry);
  if (!isDeepStrictEqual(actual, written)) {
    await editor.edit(entry, (current) => ({ ...current, providers: live }));
    return { ok: false, code: 'READBACK_MISMATCH', error: '写入后回读不一致，已回滚', backup: saved };
  }

  store.writeIntent(intent);
  store.writeManifest({
    ...manifest,
    managedRoutes: managedRoutesAfter(preview.diff, preview.nextProviders, manifest.managedRoutes),
    lastApply: { at: new Date().toISOString(), backup: saved },
  });

  return { ok: true, changed: true, diff: preview.diff, notes: preview.notes, backup: saved };
}

/**
 * 拓扑规划：把「每个模型一个协议」的意图编译成合法的 llm-pi-ai providers 结构。
 *
 * 纯函数，无 I/O，便于 harness 单测。拆分语义与 dsh-gearbox 的
 * splitProvidersByProtocol 逐条一致（suffix / 克隆 / 冲突加后缀），
 * 增量只有三处：
 *   1) manifest 所有权校验（目标路由名被非托管路由占用 → 冲突，不写）
 *   2) 目录路由物化（有 models 列表的才拆；只有 modelOverrides 的路由原样穿过）
 *   3) 派生路由自包含校验（api + baseURL + 非空 models，且不带 modelOverrides）
 */
import { PROTOCOLS, API_SUFFIX, clipCompat, normalizeBaseURL } from './compat.js';

/** 派生路由从父 profile 继承的字段白名单（连接事实，不含 models/modelOverrides/api）。 */
export const CONNECTION_FIELDS = [
  'apiKeyEnv',
  'baseURL',
  'headers',
  'retryPolicy',
  'defaultContextWindow',
  'defaultMaxTokens',
  'defaultInput',
  'reasoning',
  'thinkingBudgets',
  'cacheRetention',
  'transport',
  'timeoutMs',
  'websocketConnectTimeoutMs',
  'streamIdleTimeoutMs',
  'maxRequestImageBytes',
  'maxRequestImages',
  'imageOffloadCountQuantum',
  'requestImagePixelBudget',
  'requestImageMaxBytes',
];

/**
 * bundle 层 + profile 层合并。
 * configEditor 的 patch row 是**整体替换** config 键，不是深合并；
 * 不先合并两层就把 override 写回去，会静默丢掉 bundle 层声明的路由。
 */
export function mergeProviders(inherited, current) {
  const merged = { ...(inherited?.providers ?? {}) };
  for (const [route, profile] of Object.entries(current?.providers ?? {})) {
    merged[route] = { ...(merged[route] ?? {}), ...profile };
  }
  return merged;
}

function pickConnection(profile) {
  const out = {};
  for (const field of CONNECTION_FIELDS) {
    if (profile[field] !== undefined) out[field] = profile[field];
  }
  return out;
}

/** 派生路由名（与 gearbox 同款）。 */
export function deriveRouteName(route, api) {
  const suffix = API_SUFFIX[api] ?? api.replace(/[^a-z0-9]+/gi, '-');
  return `${route}-${suffix}`;
}

/** 裁剪并复制一个模型条目到目标协议。 */
function cloneModel(api, model, route, notes) {
  const next = { ...model };
  if (model.compat !== undefined) {
    const { compat, dropped, unknown, suspicious } = clipCompat(api, model.compat);
    if (dropped.length > 0) {
      notes.push({
        level: 'warn',
        code: 'compat-dropped',
        route,
        model: model.id,
        message: `已移除 compat.${dropped.join(' / ')}：${api} 不接受该开关`,
      });
    }
    if (unknown.length > 0) {
      notes.push({
        level: 'warn',
        code: 'compat-unknown',
        route,
        model: model.id,
        message: `compat.${unknown.join(' / ')} 不是 pi-ai 声明的字段，已移除`,
      });
    }
    if (suspicious.length > 0) {
      notes.push({
        level: 'warn',
        code: 'thinking-format-mismatch',
        route,
        model: model.id,
        message: `该模型的 compat.thinkingFormat 只在 openai-completions 生效；${api} 下不会发出，请确认端点是否理会思考参数`,
      });
    }
    if (Object.keys(compat).length > 0) next.compat = compat;
    else delete next.compat;
  }
  return next;
}

/** 路由级 compat：按目标协议裁剪（路由级宽松，但整路无模型接受时 pi-ai 会拒）。 */
function clipRouteCompat(api, profile, route, notes) {
  if (profile.compat === undefined) return undefined;
  const { compat, dropped, unknown } = clipCompat(api, profile.compat);
  if (dropped.length > 0) {
    notes.push({
      level: 'warn',
      code: 'route-compat-dropped',
      route,
      message: `路由级 compat 已移除 ${dropped.join(' / ')}：${api} 不接受`,
    });
  }
  if (unknown.length > 0) {
    notes.push({
      level: 'warn',
      code: 'route-compat-unknown',
      route,
      message: `路由级 compat 含未声明字段 ${unknown.join(' / ')}，已移除`,
    });
  }
  return Object.keys(compat).length > 0 ? compat : undefined;
}

/** 把一个 profile 改造成目标协议（继承连接事实 + 裁剪 compat + 归一化 baseURL）。 */
function reprofile(profile, api, models, route, notes) {
  const connection = pickConnection(profile);
  const next = {
    ...connection,
    api,
    models,
    displayName: profile.displayName === undefined
      ? `${route.replace(/-${API_SUFFIX[api]}$/, '')} · ${API_SUFFIX[api]}`
      : `${profile.displayName}`,
  };
  const compat = clipRouteCompat(api, profile, route, notes);
  if (compat !== undefined) next.compat = compat;
  else delete next.compat;

  const check = normalizeBaseURL(api, connection.baseURL);
  if (check.value !== connection.baseURL) {
    next.baseURL = check.value;
    notes.push({
      level: 'info',
      code: 'baseurl-normalized',
      route,
      message: `baseURL 已按 ${api} 规则调整为 ${check.value}（${check.reason}）`,
    });
  }
  if (!check.ok && check.value === connection.baseURL) {
    notes.push({ level: 'error', code: 'baseurl-invalid', route, message: check.reason });
  }
  // 自包含校验：派生路由不在安装目录里，必须三件俱全
  if (next.api === undefined || next.baseURL === undefined || !Array.isArray(next.models) || next.models.length === 0) {
    notes.push({ level: 'error', code: 'not-self-contained', route, message: '派生路由缺少 api / baseURL / models' });
  }
  return next;
}

/**
 * 规划一次重组。
 *
 * @param {object} live 合并后的 providers（bundle + profile）
 * @param {object} intent `{ routes: { [route]: { models: { [modelId]: { protocol } } } } }`
 * @param {object} [options]
 * @param {object} [options.managedRoutes] manifest 里登记的本插件派生路由
 * @returns {{ nextProviders: object, diff: Array, notes: Array, conflicts: Array }}
 */
export function plan(live, intent, options = {}) {
  const managedRoutes = options.managedRoutes ?? {};
  const providers = live ?? {};
  const out = {};
  const diff = [];
  const notes = [];
  const conflicts = [];

  // 托管路由的模型先“归还”给父路由，再按意图重新分组。
  // 否则模型迁走之后，父路由的 models 里已经看不到它们，本轮会把派生路由
  // 误判为“不再需要”而删除 —— 这正是幂等失效的根因。
  const working = structuredClone(providers);
  for (const [route, meta] of Object.entries(managedRoutes)) {
    const child = working[route];
    const parent = meta?.parent === undefined ? undefined : working[meta.parent];
    if (child === undefined || parent === undefined) continue;
    const parentModels = Array.isArray(parent.models) ? parent.models : [];
    const childModels = Array.isArray(child.models) ? child.models : [];
    const seen = new Set(parentModels.map((model) => model.id));
    parent.models = [...parentModels, ...childModels.filter((model) => !seen.has(model.id))];
    delete working[route];
  }

  for (const [route, profile] of Object.entries(working)) {
    // 托管路由（manifest 登记的本插件派生路由）不参与本轮遍历：
    // 它们由父路由的分组结果重新生成，否则会被当作"父路由"再拆一次。
    if (Object.hasOwn(managedRoutes, route)) continue;
    const intentRoute = intent?.routes?.[route];
    const models = Array.isArray(profile.models) ? profile.models : [];

    if (models.length === 0) {
      // 只有 modelOverrides / 依赖安装目录：没有可迁移的 per-model 条目
      out[route] = profile;
      if (intentRoute && Object.keys(intentRoute.models ?? {}).length > 0) {
        notes.push({
          level: 'warn',
          code: 'no-models-list',
          route,
          message: '该路由只声明了 modelOverrides（或依赖安装目录），没有 models 列表可迁移；请先物化 models 再做模型级协议',
        });
      }
      continue;
    }

    // 计算每个模型的目标协议
    const targetOf = (model) => {
      const wanted = intentRoute?.models?.[model.id]?.protocol;
      if (wanted === undefined) return profile.api;
      if (!PROTOCOLS.includes(wanted)) {
        notes.push({
          level: 'error',
          code: 'unknown-protocol',
          route,
          model: model.id,
          message: `未知协议 "${wanted}"（合法：${PROTOCOLS.join(' / ')}）`,
        });
        return profile.api;
      }
      return wanted;
    };

    const groups = new Map();
    for (const model of models) {
      const api = targetOf(model);
      if (!groups.has(api)) groups.set(api, []);
      groups.get(api).push(model);
    }

    // 单组：不产生任何多余路由
    if (groups.size <= 1) {
      const [api, group] = [...groups.entries()][0] ?? [profile.api, models];
      if (api === profile.api) {
        out[route] = profile;
        continue;
      }
      const next = reprofile(profile, api, group.map((m) => cloneModel(api, m, route, notes)), route, notes);
      out[route] = next;
      diff.push({ kind: 'update', route, api, from: profile.api, models: group.map((m) => m.id) });
      continue;
    }

    // 多组：父路由保留“主协议组”，其余各生成一条派生路由
    const primaryApi = groups.has(profile.api) ? profile.api : [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0][0];
    for (const [api, group] of groups) {
      if (api === primaryApi) {
        out[route] = { ...profile, models: group.map((m) => cloneModel(api, m, route, notes)) };
        diff.push({ kind: 'shrink', route, api, models: group.map((m) => m.id) });
        continue;
      }
      const target = deriveRouteName(route, api);
      const existing = working[target];
      const managed = Object.hasOwn(managedRoutes, target);
      if (existing !== undefined && !managed) {
        conflicts.push({
          code: 'route-name-taken',
          route: target,
          message: `目标路由名 "${target}" 已被现有路由占用，且不是本插件派生的；请改名或先合并`,
        });
        continue;
      }
      const next = reprofile(
        { ...profile, displayName: `${profile.displayName ?? route} · ${API_SUFFIX[api]}` },
        api,
        group.map((m) => cloneModel(api, m, route, notes)),
        target,
        notes,
      );
      out[target] = next;
      diff.push({
        kind: managed ? 'update' : 'create',
        route: target,
        parent: route,
        api,
        models: group.map((m) => m.id),
      });
    }
  }

  // 收敛：manifest 登记过、但本次不再需要的派生路由 → 删除
  for (const route of Object.keys(managedRoutes)) {
    if (!Object.hasOwn(out, route)) {
      diff.push({ kind: 'delete', route, reason: '不再需要该协议分组' });
    }
  }

  return { nextProviders: out, diff, notes, conflicts };
}
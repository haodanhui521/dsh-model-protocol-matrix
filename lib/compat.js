/**
 * 协议兼容门（compat gate）——逐字段抄自 @deepseek-ai/dsh-llm-pi-ai 0.2.2-rc.1
 * 的 COMPLETIONS_COMPAT_GATE / RESPONSES_COMPAT_GATE / COMPAT_GATES。
 *
 * 为什么必须本地维护一份：
 *  - 模型级 compat 只要有一个字段不在该模型 api 的 gate 内，pi-ai 会抛
 *    `model "X" sets compat "Y", but its api is "Z", which does not take it`，
 *    整份配置保存失败（一条坏规则拖垮全部改动）。
 *  - 路由级 compat 对不接受的模型是跳过；但若整条路由没有任何模型接受该字段，
 *    同样会抛 `no model on the route speaks a protocol that takes it`。
 *
 * 因此拆分路由时必须先裁剪，且把裁剪结果回报给用户，不静默丢。
 */

/** pi-ai 只支持这三种文本协议（model.api 的合法取值）。 */
export const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'];

/** 派生路由名后缀：与 dsh-gearbox 的 API_SUFFIX 保持一致。 */
export const API_SUFFIX = {
  'openai-completions': 'completions',
  'openai-responses': 'responses',
  'anthropic-messages': 'anthropic',
};

/** 协议展示名（设置页用）。 */
export const PROTOCOL_LABEL = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
};

/**
 * 每个协议可接受的 compat 字段。
 * 来源：dsh-llm-pi-ai/lib/index.js 的 COMPAT_GATES（offer 项）。
 */
export const COMPAT_GATES = {
  'openai-completions': new Set([
    'supportsStore',
    'supportsDeveloperRole',
    'supportsReasoningEffort',
    'supportsUsageInStreaming',
    'supportsFinishReason',
    'maxTokensField',
    'requiresToolResultName',
    'requiresAssistantAfterToolResult',
    'requiresThinkingAsText',
    'requiresReasoningContentOnAssistantMessages',
    'thinkingFormat',
    'chatTemplateKwargs',
    'chatTemplateArgs',
    'supportsThinkingTokenBudget',
    'thinkingTokenBudgetField',
    'vllmPriority',
    'supportsStrictMode',
    'cacheControlFormat',
    'supportsLongCacheRetention',
  ]),
  'openai-responses': new Set([
    'supportsDeveloperRole',
    'supportsMaxOutputTokens',
    'supportsStrictMode',
    'supportsLongCacheRetention',
  ]),
  'anthropic-messages': new Set([
    'supportsEagerToolInputStreaming',
    'supportsLongCacheRetention',
    'supportsCacheControlOnTools',
    'supportsTemperature',
    'forceAdaptiveThinking',
    'allowEmptySignature',
    'supportsStrictTools',
  ]),
};

/** compat 里 schema 未声明的字段（写进配置会因未知键被拒）——用于诊断提示。 */
export const KNOWN_COMPAT_FIELDS = new Set(
  Object.values(COMPAT_GATES).flatMap((gate) => [...gate]),
);

/**
 * 按目标协议裁剪一个 compat 对象。
 * @param {string} api 目标协议
 * @param {object|undefined} compat 待裁剪的 compat（可为路由级或模型级）
 * @returns {{ compat: object, dropped: string[], unknown: string[], suspicious: string[] }}
 */
export function clipCompat(api, compat) {
  const out = {};
  const dropped = [];
  const unknown = [];
  const suspicious = [];
  const gate = COMPAT_GATES[api];
  if (!gate) return { compat: out, dropped, unknown, suspicious };

  for (const [field, value] of Object.entries(compat ?? {})) {
    if (!KNOWN_COMPAT_FIELDS.has(field)) {
      unknown.push(field);
      continue;
    }
    if (!gate.has(field)) {
      dropped.push(field);
      continue;
    }
    if (value === null || value === undefined) {
      // pi-ai 拒绝“有键无值”（只有 reasoningEfforts 的 off 允许 null）
      dropped.push(field);
      continue;
    }
    out[field] = value;
  }

  // thinkingFormat 只对 completions 有意义；出现在别的协议的模型上时，
  // 除了被裁剪，还要提示用户“这个模型声称的思考格式不会被发出去”。
  if (compat && compat.thinkingFormat !== undefined && api !== 'openai-completions') {
    suspicious.push('thinkingFormat');
  }
  return { compat: out, dropped, unknown, suspicious };
}

/** 协议要求 baseURL 自带 /v1 还是不能带。 */
export function baseURLRule(api) {
  return api === 'anthropic-messages' ? 'no-v1' : 'with-v1';
}

/**
 * 归一化 baseURL：返回建议值与是否合法。
 * 不静默改：调用方必须把 reason 展示给用户（planner 会把 fix 记进 diff）。
 * @param {string} api
 * @param {string} raw
 */
export function normalizeBaseURL(api, raw) {
  const value = String(raw ?? '').trim().replace(/\/+$/, '');
  if (value === '') return { ok: false, value, reason: 'baseURL 为空' };
  const hasV1 = /\/v1$/.test(value);
  if (api === 'anthropic-messages') {
    if (!hasV1) return { ok: true, value };
    return {
      ok: false,
      value: value.replace(/\/v1$/, ''),
      reason: 'anthropic-messages 的 baseURL 不能带 /v1（SDK 自己拼 /v1/messages）',
    };
  }
  if (hasV1) return { ok: true, value };
  return {
    ok: false,
    value: value + '/v1',
    reason: `${api} 的 baseURL 必须自带 /v1`,
  };
}

/** 非法 compat 字段 → 直接拒绝写入（模型级会拖垮整份保存）。 */
export function assertGateForModel(api, compat, label) {
  const illegal = Object.keys(compat ?? {}).filter((f) => !COMPAT_GATES[api]?.has(f));
  if (illegal.length > 0) {
    return `${label} 的 compat 含 ${illegal.join(', ')}，${api} 不接受（合法：${[...(COMPAT_GATES[api] ?? [])].join(', ')}）`;
  }
  return null;
}

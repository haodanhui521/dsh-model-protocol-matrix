/**
 * 三协议探测（裸 HTTP，不经过 ctx.llm.stream / 不套用路由 compat、headers、retryPolicy）。
 *
 * 判定哲学：**"不支持"必须来自确凿信号**，其它一律 unknown，绝不擅自改写配置。
 *  - 端点存在性用「无凭据 + 最小合法体」探测，并用一条**对照请求**（不存在的路径）
 *    识别“网关对未知路径也回 401”的情况，避免把 404 误判成 401。
 *  - 思考是否生效用 gearbox scripts/probe-endpoint.mjs 的**对照探针**：
 *    合法 effort vs 故意非法 effort；非法值被拒 = 端点确实解析该字段。
 *  - 429 / 5xx / 超时 → 退避重试 2 次，仍失败即 unknown。
 */
import { normalizeBaseURL } from './compat.js';

/** 1x1 透明 PNG（67 字节），用于多模态探测，不产生像素计费。 */
export const PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/** 8x8 纯色 PNG（78 字节）：部分网关会拒绝 1x1 的“加载失败”，用它复核一次。 */
export const PIXEL_PNG_8_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR42mOsWHCHARtgYsABBqcEAIlrAgTvgNvSAAAAAElFTkSuQmCC';

export const PROBE_HEADER = 'X-DSH-Probe';

/** 协议要求的端点路径（anthropic 的 baseURL 不带 /v1，路径自带 /v1/messages）。 */
export function endpointURL(baseURL, api) {
  const clean = String(baseURL ?? '').trim().replace(/\/+$/, '');
  if (api === 'anthropic-messages') {
    const base = clean.replace(/\/v1$/, '');
    return base + '/v1/messages';
  }
  if (api === 'openai-responses') return clean + '/responses';
  return clean + '/chat/completions';
}

/** 模型发现 URL：completions/responses 用 {base}/models；anthropic 用 {base}/v1/models。 */
export function modelsURL(baseURL, api) {
  const clean = String(baseURL ?? '').trim().replace(/\/+$/, '');
  if (api === 'anthropic-messages') return clean.replace(/\/v1$/, '') + '/v1/models?limit=1000';
  return clean + '/models';
}

export function authHeaders(api, key) {
  if (key === undefined || key === null || key === '') return {};
  if (api === 'anthropic-messages') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  return { authorization: `Bearer ${key}` };
}

/** 最小请求体：max token 一律 8，成本可控。 */
export function pingBody(api, model, extra = {}) {
  if (api === 'openai-completions') {
    return { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false, ...extra };
  }
  if (api === 'openai-responses') {
    return {
      model,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
      max_output_tokens: 8,
      ...extra,
    };
  }
  return { model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }], ...extra };
}

/** 多模态请求体。 */
export function imageBody(api, model, png = PIXEL_PNG_BASE64) {
  const data = `data:image/png;base64,${png}`;
  if (api === 'openai-completions') {
    return {
      model,
      max_tokens: 8,
      stream: false,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'ping' }, { type: 'image_url', image_url: { url: data } }],
      }],
    };
  }
  if (api === 'openai-responses') {
    return {
      model,
      max_output_tokens: 8,
      input: [{
        role: 'user',
        content: [{ type: 'input_text', text: 'ping' }, { type: 'input_image', image_url: data }],
      }],
    };
  }
  return {
    model,
    max_tokens: 8,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'ping' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXEL_PNG_BASE64 } },
      ],
    }],
  };
}

/** 各协议的“合法思考参数”与“故意非法值”；对照探针两发一读。 */
export const THINKING_CONTROL = {
  'openai-responses': {
    valid: { reasoning: { effort: 'low' } },
    invalid: { reasoning: { effort: 'definitely-not-an-effort' } },
    // “关闭”用省略字段表达（比 effort:none 更通用）
    off: {},
  },
  'anthropic-messages': {
    valid: { thinking: { type: 'enabled', budget_tokens: 1024 } },
    invalid: { thinking: { type: 'definitely-not-a-type', budget_tokens: -1 } },
    off: { thinking: { type: 'disabled' } },
  },
  'openai-completions': {
    valid: { reasoning_effort: 'low' },
    invalid: { reasoning_effort: 'definitely-not-an-effort' },
    off: {},
  },
};

/** completions 的 thinkingFormat 候选矩阵（命中即停）。 */
export const THINKING_FORMAT_PROBES = [
  { format: 'openai', extra: { reasoning_effort: 'low' } },
  { format: 'deepseek', extra: { thinking: { type: 'enabled' }, reasoning_effort: 'low' } },
  { format: 'zai', extra: { thinking: { type: 'enabled' } } },
  { format: 'qwen', extra: { enable_thinking: true } },
  { format: 'qwen-chat-template', extra: { enable_thinking: true, reasoning_effort: 'low' } },
  { format: 'openrouter', extra: { reasoning: { effort: 'low' } } },
  { format: 'chat-template', extra: { chat_template_kwargs: { thinking: { enabled: true } } } },
];

/** 推理信号（协议各异，禁止互推）。 */
export function reasoningSignal(api, json) {
  if (!json || typeof json !== 'object') return 'unknown';
  if (api === 'openai-responses') {
    const items = Array.isArray(json.output) ? json.output : [];
    if (items.some((i) => i?.type === 'reasoning')) return 'yes';
    const rt = json?.usage?.output_tokens_details?.reasoning_tokens;
    if (typeof rt === 'number') return rt > 0 ? 'yes' : 'no';
    return 'unknown';
  }
  if (api === 'openai-completions') {
    const m = json?.choices?.[0]?.message ?? {};
    if (typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0) return 'yes';
    if (typeof m.reasoning === 'string' && m.reasoning.length > 0) return 'yes';
    const rt = json?.usage?.completion_tokens_details?.reasoning_tokens;
    if (typeof rt === 'number') return rt > 0 ? 'yes' : 'no';
    return 'unknown';
  }
  if (api === 'anthropic-messages') {
    const blocks = Array.isArray(json.content) ? json.content : [];
    if (blocks.some((b) => b?.type === 'thinking')) return 'yes';
    const tt = json?.usage?.output_tokens_details?.thinking_tokens;
    if (typeof tt === 'number') return tt > 0 ? 'yes' : 'no';
    return 'unknown';
  }
  return 'unknown';
}

/** 容量字段归一化（三种协议的列表字段名不同）。 */
export function capacityOf(item) {
  const pick = (...names) => {
    for (const name of names) {
      const value = item?.[name];
      if (Number.isInteger(value) && value > 0) return value;
    }
    return undefined;
  };
  return {
    contextWindow: pick('context_length', 'context_window', 'max_input_tokens', 'max_context_length'),
    maxTokens: pick('max_completion_tokens', 'max_output_tokens', 'max_tokens', 'top_provider_max_completion_tokens'),
  };
}

const RETRY_DELAYS = [500, 1500];

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 一次裸 HTTP 请求；永不抛出（用返回值表达失败）。 */
export async function request(url, { method = 'POST', headers = {}, body, timeoutMs = 20000, runId = 'manual' } = {}) {
  const started = Date.now();
  const attempts = [0, ...RETRY_DELAYS];
  let last = { status: 0, error: 'no-attempt' };
  for (const delay of attempts) {
    if (delay > 0) await sleep(delay);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          [PROBE_HEADER]: `model-protocol-matrix/0.1 run=${runId}`,
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { /* 非 JSON（SSE / 纯文本） */ }
      last = { status: res.status, ms: Date.now() - started, text: text.slice(0, 512), json };
      if (res.status !== 429 && res.status < 500) return last;   // 只有 429 / 5xx 值得重试
    } catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      last = { status: 0, ms: Date.now() - started, error: timeout ? `timeout after ${timeoutMs}ms` : String(error?.message ?? error), timeout };
    }
  }
  return last;
}

/** 从"不带 /v1 的根"推一个同源的不存在路径，用于对照。 */
function controlURL(baseURL, api) {
  const clean = String(baseURL ?? '').trim().replace(/\/+$/, '');
  const root = api === 'anthropic-messages' ? clean.replace(/\/v1$/, '') : clean;
  return root + '/__dsh_probe_missing_endpoint__';
}

/**
 * L0：端点是否存在（无凭据）。
 * @returns {{ verdict: 'exists'|'missing'|'unknown', status: number, controlStatus?: number, evidence: string }}
 */
export async function probeEndpoint({ baseURL, api, model, timeoutMs = 20000, runId }) {
  const url = endpointURL(baseURL, api);
  const main = await request(url, { body: pingBody(api, model), timeoutMs, runId });
  const control = await request(controlURL(baseURL, api), { body: pingBody(api, model), timeoutMs, runId });

  if (main.status === 404) {
    return { verdict: 'missing', status: 404, controlStatus: control.status, evidence: 'POST 端点返回 404' };
  }
  if ([400, 401, 403, 415, 422].includes(main.status)) {
    // 对照：若网关对不存在的路径也回同一个状态，则无法据此区分端点是否存在
    if (control.status === main.status) {
      return {
        verdict: 'unknown',
        status: main.status,
        controlStatus: control.status,
        evidence: `端点与不存在路径都返回 ${main.status}，无法区分`,
      };
    }
    return { verdict: 'exists', status: main.status, controlStatus: control.status, evidence: `端点返回 ${main.status}（存在但需要凭据/参数）` };
  }
  if (main.status === 0) {
    return { verdict: 'unknown', status: 0, controlStatus: control.status, evidence: main.error ?? 'transport error' };
  }
  return { verdict: 'unknown', status: main.status, controlStatus: control.status, evidence: `端点返回 ${main.status}` };
}

/**
 * L1：带凭据的最小请求 —— 鉴权 + 模型是否可服务。
 * @returns {{ verdict: 'ok'|'auth-failed'|'model-missing'|'rate-limited'|'unknown', status, ms, evidence }}
 */
export async function probeModel({ baseURL, api, model, key, timeoutMs = 20000, runId }) {
  const res = await request(endpointURL(baseURL, api), {
    headers: authHeaders(api, key),
    body: pingBody(api, model),
    timeoutMs,
    runId,
  });
  if (res.status === 200) return { verdict: 'ok', status: 200, ms: res.ms, evidence: 'model 可用' };
  if (res.status === 401 || res.status === 403) return { verdict: 'auth-failed', status: res.status, ms: res.ms, evidence: '凭据被拒' };
  if (res.status === 404) return { verdict: 'model-missing', status: 404, ms: res.ms, evidence: '模型不存在' };
  if (res.status === 429) return { verdict: 'rate-limited', status: 429, ms: res.ms, evidence: '限流' };
  if (res.status === 400) {
    const text = String(res.text ?? '');
    if (/model/i.test(text) && /(not found|unknown|invalid|不存在)/i.test(text)) {
      return { verdict: 'model-missing', status: 400, ms: res.ms, evidence: text.slice(0, 160) };
    }
    return { verdict: 'unknown', status: 400, ms: res.ms, evidence: text.slice(0, 160) };
  }
  if (res.status === 0) return { verdict: 'unknown', status: 0, ms: res.ms, evidence: res.error ?? 'transport error' };
  return { verdict: 'unknown', status: res.status, ms: res.ms, evidence: String(res.text ?? '').slice(0, 160) };
}

/**
 * L2：思考是否生效 —— 对照探针。
 * @returns {{ verdict: 'supported'|'unsupported'|'unknown', valid: object, invalid: object, evidence: string }}
 */
export async function probeReasoning({ baseURL, api, model, key, timeoutMs = 20000, runId }) {
  const control = THINKING_CONTROL[api];
  if (!control) return { verdict: 'unknown', evidence: `${api} 无对照探针定义` };
  const url = endpointURL(baseURL, api);
  const auth = authHeaders(api, key);

  const valid = await request(url, { headers: auth, body: pingBody(api, model, control.valid), timeoutMs, runId });
  const invalid = await request(url, { headers: auth, body: pingBody(api, model, control.invalid), timeoutMs, runId });
  const off = await request(url, { headers: auth, body: pingBody(api, model, control.off ?? {}), timeoutMs, runId });

  const signal = reasoningSignal(api, valid.json);
  const offSignal = reasoningSignal(api, off.json);
  const invalidRejected = invalid.status >= 400;
  const validOk = valid.status === 200;

  const summary = {
    valid: { status: valid.status, signal, reasoning_tokens: valid?.json?.usage?.output_tokens_details?.reasoning_tokens ?? valid?.json?.usage?.completion_tokens_details?.reasoning_tokens },
    invalid: { status: invalid.status, rejected: invalidRejected, sample: String(invalid.text ?? '').slice(0, 120) },
    off: { status: off.status, signal: offSignal },
  };

  if (!validOk && signal === 'unknown' && !invalidRejected) {
    return { verdict: 'unknown', ...summary, evidence: '请求未给出可判定信号' };
  }
  if (signal === 'yes' && invalidRejected) {
    return { verdict: 'supported', ...summary, evidence: '有推理产出，且端点拒绝非法 effort（字段确实被解析）' };
  }
  if (signal === 'yes' && !invalidRejected) {
    // 端点不校验非法 effort：不能直接断言“生效”。用一次“关闭思考”的差分请求判定。
    if (offSignal === 'no') {
      return { verdict: 'supported', ...summary, evidence: '有推理产出，且省略思考参数后推理消失（差分证明字段生效）' };
    }
    if (offSignal === 'yes') {
      return { verdict: 'unknown', ...summary, evidence: '该端点忽略 effort 取值，且“关闭思考”后仍在推理：无法证明 effort 生效（可能总是思考）' };
    }
    return { verdict: 'unknown', ...summary, evidence: '端点忽略 effort 取值，关闭档位未能给出可判定信号' };
  }
  if (signal === 'no' && !invalidRejected) {
    return { verdict: 'unsupported', ...summary, evidence: '无推理产出，且端点接受非法 effort（字段被忽略）' };
  }
  if (signal === 'no' && invalidRejected) {
    return { verdict: 'unknown', ...summary, evidence: '端点解析该字段，但本次没有产出推理（可能是模型/档位问题）' };
  }
  return { verdict: 'unknown', ...summary, evidence: '信号不足' };
}

/** completions 专用：逐个 thinkingFormat 候选探测，命中即停。 */
export async function probeThinkingFormat({ baseURL, api, model, key, timeoutMs = 20000, runId }) {
  if (api !== 'openai-completions') {
    return { verdict: 'not-applicable', evidence: 'thinkingFormat 只被 openai-completions 接受' };
  }
  const url = endpointURL(baseURL, api);
  const auth = authHeaders(api, key);
  const tried = [];
  for (const { format, extra } of THINKING_FORMAT_PROBES) {
    const res = await request(url, { headers: auth, body: pingBody(api, model, extra), timeoutMs, runId });
    const signal = reasoningSignal(api, res.json);
    tried.push({ format, status: res.status, signal });
    if (res.status === 200 && signal === 'yes') {
      return { verdict: 'supported', format, tried, evidence: `${format} 被接受且有推理产出` };
    }
  }
  return { verdict: 'unknown', tried, evidence: '没有任何 thinkingFormat 候选同时满足「被接受 + 有推理产出」' };
}

/** 多模态：1x1 PNG 是否被接受。 */
const IMAGE_LOAD_ERROR = /loading data|failed to (load|decode|fetch)|invalid image data|cannot load image|unable to load/i;
const IMAGE_CAP_ERROR = /(does not support|not support|unsupported|invalid|unknown)[^.]{0,40}(image|vision|modalit)|(image|vision|modalit)[^.]{0,40}(not supported|unsupported)/i;

export async function probeImage({ baseURL, api, model, key, timeoutMs = 20000, runId }) {
  const url = endpointURL(baseURL, api);
  const auth = authHeaders(api, key);
  const attempt = (png) => request(url, { headers: auth, body: imageBody(api, model, png), timeoutMs, runId });

  let res = await attempt(PIXEL_PNG_BASE64);
  let text = String(res.text ?? '');

  // 1x1 在少数网关会被判“图片加载失败”，换 8x8 复核一次再下结论。
  if (res.status >= 400 && IMAGE_LOAD_ERROR.test(text)) {
    const retry = await attempt(PIXEL_PNG_8_BASE64);
    if (retry.status === 200) {
      return { verdict: 'supported', status: 200, evidence: '8x8 PNG 被接受（1x1 被网关拒绝加载）' };
    }
    res = retry;
    text = String(res.text ?? '');
  }

  if (res.status === 200) return { verdict: 'supported', status: 200, evidence: 'PNG 被接受' };
  if (res.status === 400 || res.status === 422) {
    // 只有“能力不支持”的表述才判 unsupported；“图片数据加载失败”不是能力结论。
    if (IMAGE_CAP_ERROR.test(text)) return { verdict: 'unsupported', status: res.status, evidence: text.slice(0, 160) };
    return { verdict: 'unknown', status: res.status, evidence: '网关未接受测试图，但错误不指向能力缺失：' + text.slice(0, 140) };
  }
  return { verdict: 'unknown', status: res.status, evidence: res.error ?? text.slice(0, 160) };
}

/** 模型发现：容量信息（anthropic 也提供 /v1/models）。 */
export async function probeModelList({ baseURL, api, key, timeoutMs = 20000, runId }) {
  const res = await request(modelsURL(baseURL, api), {
    method: 'GET',
    headers: authHeaders(api, key),
    timeoutMs,
    runId,
  });
  if (res.status !== 200 || res.json === undefined) {
    return { verdict: 'unknown', status: res.status, evidence: res.error ?? String(res.text ?? '').slice(0, 160) };
  }
  const list = Array.isArray(res.json?.data) ? res.json.data
    : Array.isArray(res.json?.models) ? res.json.models
    : Array.isArray(res.json) ? res.json : null;
  if (list === null) return { verdict: 'unknown', status: 200, evidence: '列表结构未识别' };
  const table = {};
  for (const item of list) {
    const id = item?.id ?? item?.name;
    if (typeof id !== 'string') continue;
    table[id] = capacityOf(item);
  }
  const sampleKeys = Object.keys(list[0] ?? {}).slice(0, 12).join(',');
  const hasCapacity = Object.values(table).some((entry) => entry.contextWindow !== undefined || entry.maxTokens !== undefined);
  return {
    verdict: 'ok',
    status: 200,
    count: list.length,
    table,
    evidence: hasCapacity
      ? `${list.length} 个模型，容量字段可读`
      : `${list.length} 个模型，但列表未返回容量字段（样本键：${sampleKeys || 'none'}）`,
  };
}

/** 打分与结论（硬门槛 + 加权）。 */
export function scoreProbe(result) {
  const hardFail = result.endpoint?.verdict !== 'exists'
    || result.model?.verdict !== 'ok';
  if (hardFail) {
    const blocked = result.endpoint?.verdict === 'missing' || result.model?.verdict === 'model-missing';
    return { verdict: blocked ? 'not_recommended' : 'unknown', score: 0 };
  }
  let score = 0;
  if (result.reasoning?.verdict === 'supported') score += 0.3;
  if (result.image?.verdict === 'supported') score += 0.2;
  if (result.thinkingFormat?.verdict === 'supported') score += 0.15;
  else if (result.capacity?.verdict === 'ok') score += 0.15;
  if (result.model?.ms !== undefined && result.model.ms < 3000) score += 0.1;
  if (result.reasoning?.verdict === 'unsupported') score = Math.min(score, 0.45);
  const verdict = result.reasoning?.verdict === 'unknown' && result.endpoint?.verdict === 'exists'
    ? 'usable'
    : 'recommended';
  return { verdict, score: Number(score.toFixed(2)) };
}

/**
 * 全维度探测一个 (route, model) 在某个协议下的表现。
 * 请求预算：1 端点(+1 对照) + 1 鉴权/模型 + 2 思考对照 + ≤7 format + 1 图片 + 1 列表 ≈ 最多 14。
 */
export async function probeModelProtocol({
  route,
  model,
  protocol,
  baseURL,
  key,
  timeoutMs = 20000,
  runId = 'manual',
}) {
  const endpoint = await probeEndpoint({ baseURL, api: protocol, model, timeoutMs, runId });
  const out = { route, modelId: model, protocol, checkedAt: new Date().toISOString(), endpoint };

  if (endpoint.verdict === 'missing') {
    out.verdict = 'not_recommended';
    out.score = 0;
    out.note = '端点不存在';
    return out;
  }
  const modelRes = await probeModel({ baseURL, api: protocol, model, key, timeoutMs, runId });
  out.model = modelRes;
  if (modelRes.verdict !== 'ok') {
    out.verdict = modelRes.verdict === 'model-missing' ? 'not_recommended' : 'unknown';
    out.score = 0;
    out.note = modelRes.evidence;
    return out;
  }
  out.reasoning = await probeReasoning({ baseURL, api: protocol, model, key, timeoutMs, runId });
  out.thinkingFormat = await probeThinkingFormat({ baseURL, api: protocol, model, key, timeoutMs, runId });
  out.image = await probeImage({ baseURL, api: protocol, model, key, timeoutMs, runId });
  out.capacity = await probeModelList({ baseURL, api: protocol, key, timeoutMs, runId });
  const scored = scoreProbe(out);
  out.verdict = scored.verdict;
  out.score = scored.score;
  return out;
}

export { normalizeBaseURL };
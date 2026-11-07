/**
 * 探测层的本地 HTTP 验证：起一个三协议 mock 网关，验证判定规则（不依赖真实凭据/外网）。
 *   node scripts/probe-check.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  probeEndpoint, probeModel, probeReasoning, probeThinkingFormat,
  probeImage, probeModelList, probeModelProtocol, scoreProbe,
} from '../lib/probe.js';

const KEY = 'sk-test';

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let json;
      try { json = JSON.parse(raw || '{}'); } catch { json = {}; }
      resolve(json);
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = await readBody(req);
  const json = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  const authorized = req.headers.authorization === 'Bearer ' + KEY || req.headers['x-api-key'] === KEY;
  const hasImage = JSON.stringify(body).includes('image_url') || JSON.stringify(body).includes('"image"');

  if (url.pathname.includes('__dsh_probe_missing_endpoint__')) return json(404, { error: 'not found' });
  // 先按路径路由、再鉴权：未知路径直接 404（真实网关的常见形态之一）
  const known = ['/v1/models', '/v1/chat/completions', '/v1/responses', '/v1/messages'];
  if (!known.includes(url.pathname)) return json(404, { error: 'unknown path' });
  if (url.pathname === '/v1/models') {
    if (!authorized) return json(401, { error: 'unauthorized' });
    return json(200, { data: [{ id: 'deepseek-v4.1-flash', context_length: 1000000, max_completion_tokens: 384000 }] });
  }
  if (!authorized) return json(401, { error: 'unauthorized' });

  if (url.pathname === '/v1/chat/completions') {
    if (body.reasoning_effort === 'definitely-not-an-effort') return json(400, { error: 'unsupported reasoning_effort' });
    if (hasImage) return json(200, { choices: [{ message: { content: 'ok' } }], usage: { completion_tokens_details: { reasoning_tokens: 12 } } });
    return json(200, {
      choices: [{ message: { content: 'ok', reasoning_content: 'thinking…' } }],
      usage: { completion_tokens_details: { reasoning_tokens: 42 } },
    });
  }
  if (url.pathname === '/v1/responses') {
    if (body.reasoning && body.reasoning.effort === 'definitely-not-an-effort') return json(400, { error: 'invalid reasoning.effort' });
    if (hasImage) return json(200, { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { output_tokens_details: { reasoning_tokens: 5 } } });
    return json(200, {
      output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { output_tokens_details: { reasoning_tokens: 37 } },
    });
  }
  if (url.pathname === '/v1/messages') {
    if (body.thinking && body.thinking.type === 'definitely-not-a-type') return json(400, { error: 'invalid thinking.type' });
    if (hasImage) return json(200, { content: [{ type: 'text', text: 'ok' }] });
    return json(200, {
      content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'ok' }],
      usage: { output_tokens_details: { thinking_tokens: 9 } },
    });
  }
  return json(404, { error: 'unknown' });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = 'http://127.0.0.1:' + port + '/v1';

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  \u2713 ' + name); }
  catch (error) { fail += 1; console.log('  \u2717 ' + name + '\n      ' + String(error?.message ?? error).split('\n')[0]); }
}

console.log('probe · 三协议 mock 网关');

await t('端点存在（无凭据 → 401，对照路径 404）', async () => {
  const r = await probeEndpoint({ baseURL: base, api: 'openai-responses', model: 'm' });
  assert.equal(r.verdict, 'exists');
  assert.equal(r.status, 401);
  assert.equal(r.controlStatus, 404);
});
await t('端点不存在（404）', async () => {
  const r = await probeEndpoint({ baseURL: 'http://127.0.0.1:' + port + '/nope', api: 'openai-completions', model: 'm' });
  assert.equal(r.verdict, 'missing');
});
await t('网关对未知路径统一 401 → 端点判定降级 unknown', async () => {
  const s2 = createServer(async (req, res) => {
    await readBody(req);
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"unauthorized"}');
  });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const p2 = s2.address().port;
  const r = await probeEndpoint({ baseURL: 'http://127.0.0.1:' + p2 + '/v1', api: 'openai-responses', model: 'm' });
  assert.equal(r.verdict, 'unknown');
  s2.close();
});
await t('鉴权 + 模型可用', async () => {
  const r = await probeModel({ baseURL: base, api: 'openai-responses', model: 'deepseek-v4.1-flash', key: KEY });
  assert.equal(r.verdict, 'ok');
});
await t('错误凭据 → auth-failed', async () => {
  const r = await probeModel({ baseURL: base, api: 'openai-responses', model: 'deepseek-v4.1-flash', key: 'wrong' });
  assert.equal(r.verdict, 'auth-failed');
});
await t('responses 思考：有推理 + 非法 effort 被拒 → supported', async () => {
  const r = await probeReasoning({ baseURL: base, api: 'openai-responses', model: 'm', key: KEY });
  assert.equal(r.verdict, 'supported');
  assert.equal(r.invalid.rejected, true);
  assert.equal(r.valid.signal, 'yes');
});
await t('chat 思考：reasoning_content → supported', async () => {
  const r = await probeReasoning({ baseURL: base, api: 'openai-completions', model: 'm', key: KEY });
  assert.equal(r.verdict, 'supported');
});
await t('anthropic 思考：content[].thinking → supported', async () => {
  const r = await probeReasoning({ baseURL: base, api: 'anthropic-messages', model: 'm', key: KEY });
  assert.equal(r.verdict, 'supported');
});
await t('thinkingFormat 矩阵命中 openai', async () => {
  const r = await probeThinkingFormat({ baseURL: base, api: 'openai-completions', model: 'm', key: KEY });
  assert.equal(r.verdict, 'supported');
  assert.equal(r.format, 'openai');
});
await t('非 completions 时 thinkingFormat 为 not-applicable', async () => {
  const r = await probeThinkingFormat({ baseURL: base, api: 'openai-responses', model: 'm', key: KEY });
  assert.equal(r.verdict, 'not-applicable');
});
await t('多模态图片被接受', async () => {
  const r = await probeImage({ baseURL: base, api: 'openai-responses', model: 'm', key: KEY });
  assert.equal(r.verdict, 'supported');
});
await t('模型列表容量解析（三种字段名）', async () => {
  const r = await probeModelList({ baseURL: base, api: 'openai-responses', key: KEY });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.table['deepseek-v4.1-flash'].contextWindow, 1000000);
  assert.equal(r.table['deepseek-v4.1-flash'].maxTokens, 384000);
});
await t('全维度探测 + 评分 → recommended', async () => {
  const r = await probeModelProtocol({ route: 'laiyifen', model: 'deepseek-v4.1-flash', protocol: 'openai-responses', baseURL: base, key: KEY, runId: 'test' });
  assert.equal(r.endpoint.verdict, 'exists');
  assert.equal(r.model.verdict, 'ok');
  assert.equal(r.reasoning.verdict, 'supported');
  assert.equal(r.verdict, 'recommended');
  assert.ok(r.score > 0.5, 'score ' + r.score);
});

await new Promise((resolve) => server.close(resolve));

console.log('\n' + '='.repeat(40));
console.log('pass ' + pass + ' · fail ' + fail);
if (fail > 0) process.exitCode = 1;
/**
 * dsh-model-protocol-matrix 测试台。
 *
 * 纯函数层（compat / planner）不依赖 DSH 运行时，直接 node 跑：
 *   node scripts/harness.mjs
 * 后续接入 mock ctx（configEditor / llm / webServer）后可在此跑 apply 通道。
 */
import assert from 'node:assert/strict';
import { clipCompat, normalizeBaseURL, assertGateForModel, COMPAT_GATES } from '../lib/compat.js';
import { plan, mergeProviders, deriveRouteName } from '../lib/planner.js';
import { applyIntent, normalizeIntent, validateProviders, managedRoutesAfter } from '../lib/apply.js';

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  \u2713 ' + name);
  } catch (error) {
    fail += 1;
    failures.push([name, error]);
    console.log('  \u2717 ' + name);
    console.log('      ' + String(error?.message ?? error).split('\n')[0]);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  \u2713 ' + name);
  } catch (error) {
    fail += 1;
    failures.push([name, error]);
    console.log('  \u2717 ' + name);
    console.log('      ' + String(error?.message ?? error).split('\n')[0]);
  }
}

function group(title) {
  console.log('\n' + title);
}

// ----------------------------------------------------------------- 测试夹具

const LAIYIFEN = {
  laiyifen: {
    displayName: '来伊份大模型',
    apiKeyEnv: 'LAIYIFEN_API_KEY',
    api: 'openai-completions',
    baseURL: 'https://ai-model.laiyifen.com/v1',
    compat: { supportsDeveloperRole: false, thinkingFormat: 'deepseek' },
    models: [
      {
        id: 'glm-5.3-flash',
        contextWindow: 1000000,
        maxTokens: 131000,
        input: ['text', 'image'],
        reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: true, thinkingFormat: 'zai' },
      },
      {
        id: 'deepseek-v4.1-flash',
        contextWindow: 1000000,
        maxTokens: 384000,
        input: ['text', 'image'],
        reasoningEfforts: { off: 'none', low: 'low', high: 'high', max: 'max' },
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: true, thinkingFormat: 'deepseek' },
      },
    ],
  },
};

// ----------------------------------------------------------------- compat

group('compat 裁剪');
test('responses 不接受 thinkingFormat → 裁掉并标记可疑', () => {
  const r = clipCompat('openai-responses', { supportsDeveloperRole: false, thinkingFormat: 'zai' });
  assert.deepEqual(r.compat, { supportsDeveloperRole: false });
  assert.deepEqual(r.dropped, ['thinkingFormat']);
  assert.deepEqual(r.suspicious, ['thinkingFormat']);
});
test('completions 保留 thinkingFormat', () => {
  const r = clipCompat('openai-completions', { thinkingFormat: 'zai', supportsReasoningEffort: true });
  assert.deepEqual(r.compat, { thinkingFormat: 'zai', supportsReasoningEffort: true });
  assert.deepEqual(r.dropped, []);
});
test('未声明字段进 unknown 而不是 dropped', () => {
  const r = clipCompat('openai-completions', { totallyMadeUp: true });
  assert.deepEqual(r.unknown, ['totallyMadeUp']);
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.compat, {});
});
test('anthropic 只接受它自己的 7 个开关', () => {
  const ok = clipCompat('anthropic-messages', { supportsTemperature: true, supportsStrictTools: true, thinkingFormat: 'zai' });
  assert.deepEqual(ok.compat, { supportsTemperature: true, supportsStrictTools: true });
  assert.deepEqual(ok.dropped, ['thinkingFormat']);
});
test('assertGateForModel 对非法字段报错', () => {
  const msg = assertGateForModel('openai-responses', { thinkingFormat: 'zai' }, 'laiyifen/deepseek-v4.1-flash');
  assert.ok(msg && msg.includes('thinkingFormat'), 'should name the field');
  assert.equal(assertGateForModel('openai-responses', { supportsDeveloperRole: false }, 'x'), null);
});
test('gate 表三协议字段数与 pi-ai 一致（19 / 4 / 7）', () => {
  assert.equal(COMPAT_GATES['openai-completions'].size, 19);
  assert.equal(COMPAT_GATES['openai-responses'].size, 4);
  assert.equal(COMPAT_GATES['anthropic-messages'].size, 7);
});

group('baseURL 归一化');
test('completions 缺 /v1 → 补上并报原因', () => {
  const r = normalizeBaseURL('openai-completions', 'https://gw.example.com');
  assert.equal(r.ok, false);
  assert.equal(r.value, 'https://gw.example.com/v1');
});
test('responses 自带 /v1 → 通过', () => {
  assert.equal(normalizeBaseURL('openai-responses', 'https://gw.example.com/v1').ok, true);
});
test('anthropic 带 /v1 → 去掉', () => {
  const r = normalizeBaseURL('anthropic-messages', 'https://gw.example.com/v1');
  assert.equal(r.ok, false);
  assert.equal(r.value, 'https://gw.example.com');
});
test('anthropic 不带 /v1 → 通过', () => {
  assert.equal(normalizeBaseURL('anthropic-messages', 'https://gw.example.com').ok, true);
});

// ----------------------------------------------------------------- planner

group('planner · 边界');
test('全部模型同协议 = 原 api → diff 为空', () => {
  const r = plan(LAIYIFEN, { routes: {} }, { managedRoutes: {} });
  assert.deepEqual(r.diff, []);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.nextProviders, LAIYIFEN);
});
test('全部模型同协议 ≠ 原 api → 只改原路由，不新增', () => {
  const intent = { routes: { laiyifen: { models: {
    'glm-5.3-flash': { protocol: 'openai-responses' },
    'deepseek-v4.1-flash': { protocol: 'openai-responses' },
  } } } };
  const r = plan(LAIYIFEN, intent, { managedRoutes: {} });
  assert.deepEqual(Object.keys(r.nextProviders), ['laiyifen']);
  assert.equal(r.nextProviders.laiyifen.api, 'openai-responses');
  assert.equal(r.diff.length, 1);
  assert.equal(r.diff[0].kind, 'update');
  assert.equal(r.conflicts.length, 0);
});
test('派生路由名：与 gearbox 同款后缀', () => {
  assert.equal(deriveRouteName('laiyifen', 'openai-responses'), 'laiyifen-responses');
  assert.equal(deriveRouteName('laiyifen', 'anthropic-messages'), 'laiyifen-anthropic');
});

group('planner · 拆分');
const MIXED_INTENT = { routes: { laiyifen: { models: { 'deepseek-v4.1-flash': { protocol: 'openai-responses' } } } } };
test('混合协议 → 生成一条派生路由，模型归属正确', () => {
  const r = plan(LAIYIFEN, MIXED_INTENT, { managedRoutes: {} });
  assert.deepEqual(Object.keys(r.nextProviders).sort(), ['laiyifen', 'laiyifen-responses']);
  assert.deepEqual(r.nextProviders.laiyifen.models.map((m) => m.id), ['glm-5.3-flash']);
  assert.deepEqual(r.nextProviders['laiyifen-responses'].models.map((m) => m.id), ['deepseek-v4.1-flash']);
  assert.equal(r.nextProviders['laiyifen-responses'].api, 'openai-responses');
  assert.equal(r.nextProviders['laiyifen-responses'].baseURL, 'https://ai-model.laiyifen.com/v1');
  assert.equal(r.nextProviders['laiyifen-responses'].apiKeyEnv, 'LAIYIFEN_API_KEY');
  const created = r.diff.find((d) => d.kind === 'create');
  assert.equal(created.route, 'laiyifen-responses');
  assert.equal(created.parent, 'laiyifen');
});
test('派生路由自包含：无 modelOverrides，models 非空', () => {
  const r = plan(LAIYIFEN, MIXED_INTENT, { managedRoutes: {} });
  const derived = r.nextProviders['laiyifen-responses'];
  assert.equal(derived.modelOverrides, undefined);
  assert.ok(Array.isArray(derived.models) && derived.models.length > 0);
  assert.ok(r.notes.every((n) => n.code !== 'not-self-contained'), JSON.stringify(r.notes));
});
test('thinkingFormat 在派生 responses 路由上被裁掉（模型级 + 路由级）', () => {
  const r = plan(LAIYIFEN, MIXED_INTENT, { managedRoutes: {} });
  const derived = r.nextProviders['laiyifen-responses'];
  assert.equal(derived.compat?.thinkingFormat, undefined);
  assert.equal(derived.models[0].compat?.thinkingFormat, undefined);
  assert.ok(r.notes.some((n) => n.code === 'compat-dropped'), 'should report the dropped switch');
  assert.ok(r.notes.some((n) => n.code === 'thinking-format-mismatch'), 'should flag the mismatch');
});
test('父路由保留自己的 thinkingFormat', () => {
  const r = plan(LAIYIFEN, MIXED_INTENT, { managedRoutes: {} });
  assert.equal(r.nextProviders.laiyifen.compat.thinkingFormat, 'deepseek');
  assert.equal(r.nextProviders.laiyifen.models[0].compat.thinkingFormat, 'zai');
});
test('未知协议 → error note 且回退原协议', () => {
  const intent = { routes: { laiyifen: { models: { 'glm-5.3-flash': { protocol: 'gemini-native' } } } } };
  const r = plan(LAIYIFEN, intent, { managedRoutes: {} });
  assert.ok(r.notes.some((n) => n.code === 'unknown-protocol'));
  assert.deepEqual(Object.keys(r.nextProviders), ['laiyifen']);
});

group('planner · 冲突与收敛');
test('只有 modelOverrides 的路由原样穿过并给出提示', () => {
  const live = { openai: { apiKeyEnv: 'OPENAI_API_KEY', modelOverrides: { 'gpt-5.6': { maxTokens: 128000 } } } };
  const r = plan(live, { routes: { openai: { models: { 'gpt-5.6': { protocol: 'openai-responses' } } } } }, { managedRoutes: {} });
  assert.deepEqual(r.nextProviders.openai, live.openai);
  assert.ok(r.notes.some((n) => n.code === 'no-models-list'));
});
test('目标路由名被非托管路由占用 → 冲突且不生成', () => {
  const live = { ...LAIYIFEN, 'laiyifen-responses': { api: 'openai-completions', apiKeyEnv: 'OTHER', baseURL: 'https://x/v1', models: [{ id: 'other' }] } };
  const r = plan(live, MIXED_INTENT, { managedRoutes: {} });
  assert.ok(r.conflicts.some((c) => c.code === 'route-name-taken'));
  assert.equal(r.nextProviders['laiyifen-responses'].api, 'openai-completions');
});
test('托管路由可被复用（update 而不是冲突）', () => {
  const live = { ...LAIYIFEN, 'laiyifen-responses': { api: 'openai-responses', apiKeyEnv: 'LAIYIFEN_API_KEY', baseURL: 'https://ai-model.laiyifen.com/v1', models: [{ id: 'stale' }] } };
  const r = plan(live, MIXED_INTENT, { managedRoutes: { 'laiyifen-responses': { owner: 'plugin', parent: 'laiyifen' } } });
  assert.equal(r.conflicts.length, 0);
  assert.ok(r.diff.some((d) => d.kind === 'update' && d.route === 'laiyifen-responses'));
});
test('不再需要的托管路由 → 删除（自动收敛）', () => {
  const live = { ...LAIYIFEN, 'laiyifen-responses': { api: 'openai-responses', apiKeyEnv: 'LAIYIFEN_API_KEY', baseURL: 'https://ai-model.laiyifen.com/v1', models: [{ id: 'deepseek-v4.1-flash' }] } };
  const r = plan(live, { routes: {} }, { managedRoutes: { 'laiyifen-responses': { owner: 'plugin' } } });
  assert.equal(r.nextProviders['laiyifen-responses'], undefined);
  assert.ok(r.diff.some((d) => d.kind === 'delete' && d.route === 'laiyifen-responses'));
});

group('mergeProviders');
test('bundle 层 + profile 层合并，profile 覆盖同名字段', () => {
  const inherited = { providers: { a: { api: 'openai-completions', baseURL: 'https://x/v1', models: [{ id: 'm1' }] } } };
  const current = { providers: { a: { apiKeyEnv: 'K' }, b: { api: 'openai-responses', baseURL: 'https://y/v1', models: [{ id: 'm2' }] } } };
  const merged = mergeProviders(inherited, current);
  assert.equal(merged.a.api, 'openai-completions');
  assert.equal(merged.a.apiKeyEnv, 'K');
  assert.equal(merged.a.baseURL, 'https://x/v1');
  assert.equal(merged.b.api, 'openai-responses');
});

// ----------------------------------------------------------------- 写入通道（mock configEditor）

function makeEditor(initialProviders) {
  const entry = { options: { name: '@deepseek-ai/dsh-llm-pi-ai', id: 'llm-pi-ai', config: {} } };
  const state = { override: { providers: structuredClone(initialProviders) }, inherited: {} };
  const editor = {
    entry,
    entries: () => [entry],
    configuration: () => [{ entry, inherited: structuredClone(state.inherited), override: structuredClone(state.override) }],
    edit: async (_entry, change) => {
      const next = change(structuredClone(state.override), structuredClone(state.inherited));
      if (next === undefined) throw new Error('change returned undefined');
      state.override = structuredClone(next);
    },
    state,
  };
  return editor;
}

function makeStore() {
  const s = {
    intent: { version: 1, routes: {} },
    manifest: { version: 1, managedRoutes: {}, baseline: {}, lastApply: null },
    backups: [],
  };
  return {
    readIntent: () => structuredClone(s.intent),
    readManifest: () => structuredClone(s.manifest),
    writeIntent: (intent) => { s.intent = structuredClone(intent); },
    writeManifest: (manifest) => { s.manifest = structuredClone(manifest); },
    backup: (providers) => { s.backups.push(structuredClone(providers)); return { at: 'test', snapshot: 'mem://backup' }; },
    state: s,
  };
}

group('写入通道 · 应用与回滚');
await testAsync('混合协议意图：写入配置、更新清单、备份一次', async () => {
  const editor = makeEditor(LAIYIFEN);
  const store = makeStore();
  const out = await applyIntent({
    editor, entry: editor.entry, store,
    input: { plan: { 'laiyifen/deepseek-v4.1-flash': 'openai-responses' } },
  });
  assert.equal(out.ok, true);
  assert.equal(out.changed, true);
  assert.equal(store.state.backups.length, 1);
  const providers = editor.state.override.providers;
  assert.ok(providers['laiyifen-responses']);
  assert.equal(providers['laiyifen-responses'].api, 'openai-responses');
  assert.deepEqual(providers.laiyifen.models.map((m) => m.id), ['glm-5.3-flash']);
  assert.ok(store.state.intent.routes.laiyifen.models['deepseek-v4.1-flash']);
  assert.ok(store.state.manifest.managedRoutes['laiyifen-responses']);
});
await testAsync('相同意图再次 apply 是幂等的（不写、不备份）', async () => {
  const editor = makeEditor(LAIYIFEN);
  const store = makeStore();
  const input = { plan: { 'laiyifen/deepseek-v4.1-flash': 'openai-responses' } };
  await applyIntent({ editor, entry: editor.entry, store, input });
  const before = JSON.stringify(editor.state.override);
  const out = await applyIntent({ editor, entry: editor.entry, store, input });
  assert.equal(out.changed, false);
  assert.equal(store.state.backups.length, 1);
  assert.equal(JSON.stringify(editor.state.override), before);
});
await testAsync('检测到 gearbox → 返回 GEARBOX_CONFLICT 且不写', async () => {
  const editor = makeEditor(LAIYIFEN);
  const store = makeStore();
  const out = await applyIntent({ editor, entry: editor.entry, store, gearbox: true, input: { plan: {} } });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'GEARBOX_CONFLICT');
  assert.equal(store.state.backups.length, 0);
});
await testAsync('目标路由名被占用 → CONFLICT 且不写', async () => {
  const live = { ...LAIYIFEN, 'laiyifen-responses': { api: 'openai-completions', apiKeyEnv: 'X', baseURL: 'https://x/v1', models: [{ id: 'other' }] } };
  const editor = makeEditor(live);
  const store = makeStore();
  const out = await applyIntent({ editor, entry: editor.entry, store, input: { plan: { 'laiyifen/deepseek-v4.1-flash': 'openai-responses' } } });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'CONFLICT');
  assert.equal(store.state.backups.length, 0);
});
await testAsync('回读不一致 → READBACK_MISMATCH 并回滚', async () => {
  const editor = makeEditor(LAIYIFEN);
  const store = makeStore();
  const realEdit = editor.edit;
  let calls = 0;
  editor.edit = async (entry, change) => {
    calls += 1;
    if (calls === 1) {
      await realEdit(entry, () => ({ providers: { tampered: { api: 'openai-completions', baseURL: 'https://t/v1', models: [{ id: 'x' }] } } }));
      return;
    }
    await realEdit(entry, change);
  };
  const out = await applyIntent({ editor, entry: editor.entry, store, input: { plan: { 'laiyifen/deepseek-v4.1-flash': 'openai-responses' } } });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'READBACK_MISMATCH');
  assert.ok(editor.state.override.providers.laiyifen, 'should roll back to original');
});
test('normalizeIntent：null 清除选择，未知协议被忽略', () => {
  const base = { version: 1, routes: { laiyifen: { models: { a: { protocol: 'openai-responses' } } } } };
  const cleared = normalizeIntent({ plan: { 'laiyifen/a': null } }, base);
  assert.equal(cleared.routes.laiyifen.models.a, undefined);
  const ignored = normalizeIntent({ plan: { 'laiyifen/a': 'gemini-native' } }, { version: 1, routes: {} });
  assert.equal(ignored.routes.laiyifen?.models?.a, undefined);
});
test('validateProviders 拦住模型级非法 compat', () => {
  const bad = {
    r: {
      api: 'openai-responses', baseURL: 'https://x/v1',
      models: [{ id: 'm', compat: { thinkingFormat: 'zai' } }],
    },
  };
  const rejected = validateProviders(bad, {});
  assert.ok(rejected.some((r) => r.field === 'compat.thinkingFormat'));
  assert.equal(validateProviders(LAIYIFEN, {}).length, 0);
});
test('managedRoutesAfter：create 记录、delete 清理', () => {
  const next = { 'r-responses': { api: 'openai-responses', models: [{ id: 'm' }] } };
  const after = managedRoutesAfter(
    [{ kind: 'create', route: 'r-responses', parent: 'r' }, { kind: 'delete', route: 'r-anthropic' }],
    next,
    { 'r-anthropic': { owner: 'plugin' } },
  );
  assert.equal(after['r-responses'].parent, 'r');
  assert.equal(after['r-anthropic'], undefined);
});

// ----------------------------------------------------------------- 汇总

console.log('\n' + '='.repeat(48));
console.log(`pass ${pass} · fail ${fail}`);
if (fail > 0) {
  console.log('\n失败详情：');
  for (const [name, error] of failures) console.log('- ' + name + '\n  ' + String(error?.message ?? error));
  process.exitCode = 1;
}
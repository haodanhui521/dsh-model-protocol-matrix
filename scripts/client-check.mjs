/**
 * 客户端半的装配检查：
 *  - 文件被 classic-script 加载时只调用 window.__ModuleLoader__.load({ id, factory })
 *  - factory(require) 返回 { apply, inject }
 *  - apply 注册 settings.section 与 locale，且任何异常不外泄
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

let loaded = null;
const sandbox = {
  window: { __ModuleLoader__: { load: (def) => { loaded = def; } } },
  console,
  Symbol,
  Object,
  Array,
  String,
  navigator: { language: 'zh-CN' },
};
sandbox.globalThis = sandbox;
runInNewContext(source, sandbox, { filename: 'lib/client.js' });

assert.ok(loaded, 'must call window.__ModuleLoader__.load');
assert.equal(loaded.id, 'dsh-model-protocol-matrix');

const React = { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {} };
const mod = loaded.factory(() => React);
assert.equal(typeof mod.apply, 'function');
assert.equal(JSON.stringify(mod.inject), JSON.stringify(['slots', 'locale']));

const calls = [];
const ctx = {
  locale: { register: (...args) => calls.push(['locale', ...args]) },
  slots: { inject: (name, fn) => { calls.push(['inject', name]); return fn(); }, register: (spec, component) => { calls.push(['register', spec.name, spec.id, typeof component]); return () => {}; } },
  effect: (fn) => { fn(); return () => {}; },
  logger: { info: () => {}, warn: () => {} },
};
mod.apply(ctx, {});
assert.ok(calls.some((c) => c[0] === 'locale' && c[1] === 'dsh-model-protocol-matrix'), 'locale registered');
assert.ok(calls.some((c) => c[0] === 'register' && c[1] === 'settings.section' && c[2] === 'dsh-model-protocol-matrix'), 'section registered');

// 缺 slots 时不能抛
const bare = { locale: undefined, logger: { warn: () => {} } };
mod.apply(bare, {});
console.log('CLIENT CHECK OK');
console.log(JSON.stringify(calls, null, 2));
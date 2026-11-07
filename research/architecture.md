# 设计决策记录

## 1. 为什么模型级协议必须“拆路由”

`dsh-llm-pi-ai` 的 `resolveRouteModels → resolveEntry`：

```ts
const api = request.api ?? base?.api ?? routeApi;   // 路由级 api 优先级最高
```

同一路由下所有模型最终共享同一个 `api`。因此“模型级协议”只能表达为“按协议分组路由”。

## 2. 路由重组语义（对齐 dsh-gearbox）

- suffix：`completions` / `responses` / `anthropic`
- 与父路由同协议的模型留在原位；其余组克隆成 `<route>-<suffix>`
- 克隆时剔除 `models` / `modelOverrides` / `api`，保留连接事实
- `displayName` = `<原名> · <suffix>`

本插件增量：
1. **托管路由归还**：规划前把派生路由的模型合并回父路由，否则第二轮会把派生路由误判为“不再需要”。
2. **manifest 所有权**：记录 `parent` / `models`，冲突时停止写入。
3. **自包含校验**：派生路由不在安装目录里，必须 `api + baseURL + models`，且不能带 `modelOverrides`。

## 3. compat 裁剪的硬依据

`COMPAT_GATES` 抄自 pi-ai 0.2.2-rc.1：

- completions：19 个 offer 字段（含 `thinkingFormat`）
- responses：4 个（`supportsDeveloperRole` / `supportsMaxOutputTokens` / `supportsStrictMode` / `supportsLongCacheRetention`）
- anthropic：7 个

模型级 compat 不在 gate 内 → pi-ai 抛错并让**整份配置保存失败**，所以必须裁剪；
路由级 compat 会被跳过，但整条路由没有模型接受时同样报错。

## 4. 写入契约（@deepseek-ai/dsh-config-editor）

```ts
editor.edit(entry, (current, inherited) => next)   // change 必须同步
```

- `hmr.runExclusive` + `withFileLock(profile/package.json)` 串行。
- 返回值**整体替换**该条目的 `config` 键。
- `next` 与 `inherited` 深相等时删除该条目的 `config`（回到继承）。
- 写盘后只重载该 entry（`reconcileProfilePatches(..., [entry.options.id])`）。
- 失败恢复原文档并重载旧 patch。

结论：写 `llm-pi-ai` 不会重载本插件；写本插件自己的条目才会。因此热状态放外部 JSON。

## 5. 可见性实现

`buildModelCatalog` 与 `dsh-tool-subagent` 都调用 `ctx.llm.listModels`。
包装它一处即可覆盖 composer（`modelDirectories → remote.session.modelCatalog`）、
子代理、官方模型页。包装用实例属性遮蔽 + `ctx.effect` 自动还原，并用
`Symbol.for('dsh-model-protocol-matrix/listModels')` 防重复包装。

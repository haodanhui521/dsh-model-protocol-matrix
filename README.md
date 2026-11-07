# dsh-model-protocol-matrix

让 DeepSeek Harness 里**每个模型单独选择请求协议**，并对三种协议做真实探测；三协议都不可用的模型可以一键从选择器隐藏。

> ⚠️ **与 [dsh-gearbox](https://github.com/ctianye/dsh_gearbox) 二选一。**
> 两者都通过“重组 llm-pi-ai 路由”实现模型级协议。gearbox 的协议切换每次 apply 都基于
> live providers 全量重算、没有路由所有权概念，同时写入必然互相覆盖。本插件检测到
> gearbox 的 loader 条目时会进入**只读模式**（只能浏览与探测，不写配置）。

## 它解决什么

`api` 在 `llm-pi-ai` 里是**提供商路由级**字段（`providers[].api`），`models[]` 条目没有
`api`。所以“每个模型一个协议”只能通过拆分路由实现：

```yaml
providers:
  laiyifen:                       # glm 系列走 Chat Completions
    apiKeyEnv: LAIYIFEN_API_KEY
    api: openai-completions
    baseURL: https://ai-model.laiyifen.com/v1
    models: [{ id: glm-5.3-flash, ... }]

  laiyifen-responses:             # ds-4.1 走 Responses（插件自动派生）
    displayName: 来伊份大模型 · responses
    apiKeyEnv: LAIYIFEN_API_KEY
    api: openai-responses
    baseURL: https://ai-model.laiyifen.com/v1
    models: [{ id: deepseek-v4.1-flash, ... }]
```

本插件把这件事自动化、可预览、可回滚，并在拆分时处理两条硬约束：

| 硬约束 | 处理 |
|---|---|
| `thinkingFormat` 只被 `openai-completions` 接受；写到 responses 的**模型级** compat 会让整份配置保存失败 | 按 `COMPAT_GATES` 逐字段裁剪，裁剪结果作为 note 回报，不静默丢 |
| completions / responses 的 `baseURL` 必须自带 `/v1`；anthropic 不能带 | `normalizeBaseURL` 校验并给出调整值，记进 diff |

## 功能

1. **模型级协议**：设置页每个模型一个下拉（继承路由 / Chat / Responses / Anthropic），保存即重组路由。
2. **三协议探测**：端点存在性、鉴权、模型可服务、思考是否生效、thinkingFormat、多模态、容量、流式。
   - 思考判定用**对照探针**：合法 effort vs 故意非法 effort。非法值被拒 = 端点确实解析该字段。
   - “不支持”必须来自确凿信号；其余一律 `unknown`，**绝不擅自改写配置**。
3. **隐藏不可用模型**：包装 `ctx.llm.listModels`，一处生效覆盖 composer、子代理模型选择、官方模型页。
   - 隐藏 ≠ 禁用：正在使用该模型的会话不受影响。
   - 本插件页面始终能看到全部模型（它读 `configEditor` 配置，不经过 `listModels`），可在那里恢复。
4. **备份与回滚**：每次写入前双备份（命名空间快照 + `cordis.patch.yml` 副本），失败自动还原。

## 安装

```sh
# 1) 本地目录（开发）
dsh plugin --profile desktop add /Users/huayuanheshang/DS-HARNESS/dsh-model-protocol-matrix

# 2) npm（发布后）
dsh plugin --profile desktop add dsh-model-protocol-matrix

# 3) GitHub
dsh plugin --profile desktop add github:<owner>/dsh-model-protocol-matrix
#    本机 GitHub 直连超时时：走已装 dshmarket（china 区 gh-proxy），或
#    git config --global url."https://gh-proxy.com/https://github.com/".insteadOf "https://github.com/"
```

bundle 层只在启动时组合：**首次安装需要重启一次**；此后所有配置写入走 HMR，不重启。

### 手动安装（等价）

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": { "dsh-model-protocol-matrix": "link:/Users/huayuanheshang/DS-HARNESS/dsh-model-protocol-matrix" },
  "dsh": { "profile": { "bundles": [ "...", "dsh-model-protocol-matrix" ] } }
}
```

然后 `pnpm install` 并重启。

## 使用

打开 **`http://127.0.0.1:<DSH 端口>/protocol-matrix/ui`**（或从 DSH 插件页进入）。

| 操作 | 说明 |
|---|---|
| 协议下拉 | 选完点「应用变更」；「预览 Diff」先看新增路由、模型迁移、compat 裁剪、备份路径 |
| 探测 | 行级「探测」或顶部「探测全部模型」；结论按三协议展示，证据可展开 |
| 隐藏 | 勾选后立即生效（所有模型选择器），本页仍可见、可恢复 |
| 回滚 | 「回滚到最近备份」用最近一次快照覆盖 `llm-pi-ai` |

## 为什么意图/清单不放在 patch 里

写自己的 loader 条目会触发该条目重载 → 插件重新激活 → 若状态没稳定会再写一次。
gearbox 用“写入前 preview + deepEqual 短路”压住这个循环；本插件把变更频繁的
意图表 / 清单 / 隐藏列表放到：

```
~/.dsh/profiles/desktop/.dsh-model-protocol-matrix/
├─ intent.json        # 每个模型的目标协议
├─ manifest.json      # 插件派生的路由（所有权 + models）
├─ probe-cache.json   # 探测结论（仅手动刷新，不自动过期）
└─ backups/           # 写入前快照
```

patch 里只留静态设置（`enabled`、`probe.timeoutMs` 等）。

## 边界与冲突

- **只支持 desktop profile**（`~/.dsh/profiles/desktop`）。
- 只有 `modelOverrides`、没有 `models` 列表的路由不拆分；UI 会提示先物化模型。
- 目标路由名被非托管路由占用 → 冲突，不写。
- 用户手改派生路由 → manifest 比对不上，停止写入并提示。
- 三协议全不可用 → 红色报错 + 提供隐藏，不静默降级。
- 探测仅手动触发，不启动定时器；结论不会自动过期（只提示“建议重测”）。

## 探测的请求边界

- 凭据经 `ctx.credentials.resolve(apiKeyEnv)`，不落盘、不打印。
- 单次探测最多约 14 个请求（端点+对照、鉴权、两次思考对照、≤7 个 format、图片、列表）。
- `max_tokens=8`、1×1 PNG、20s 超时、429/5xx 退避重试 2 次。
- 所有请求带 `X-DSH-Probe: model-protocol-matrix/0.1`，便于网关侧审计。

## 开发

```sh
node scripts/harness.mjs      # 纯函数 + mock configEditor 的集成测试（31 项）
node --check lib/*.js         # 语法检查
```

模块：

| 文件 | 职责 |
|---|---|
| `lib/index.js` | host 入口：HTTP 路由、可见性包装、gearbox 互斥 |
| `lib/apply.js` | 意图归一化、影子校验、写入/回读/回滚（可 mock 单测） |
| `lib/planner.js` | 纯函数：providers + 意图 → 目标 providers + diff |
| `lib/compat.js` | COMPAT_GATES、按协议裁剪、baseURL 归一化 |
| `lib/probe.js` | 三协议裸 HTTP 探测 + 对照探针 + 评分 |
| `lib/store.js` | 意图/清单/缓存/备份 |
| `lib/settings-page.js` | 自带 HTML 页面 |
| `scripts/harness.mjs` | 测试台 |

## Roadmap

- 设置分节（client 半 `ctx.slots`）内嵌该页面。
- 发布 npm 并向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
  提 PR（`data/plugins/<owner>__dsh-model-protocol-matrix.yml`，category `model`）。

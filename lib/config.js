/**
 * 插件自身配置（schemastery）。
 *
 * 只放“静态设置”。变更频繁的意图表 / 清单 / 隐藏列表放在
 * ~/.dsh/profiles/desktop/.dsh-model-protocol-matrix/*.json：
 * 写自己的 loader 条目会触发该条目重载 → 本插件重新激活 → 再写入；
 * 把热数据移出 patch 可以彻底避开这条自激路径。
 */
import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  enabled: z.boolean()
    .description('总开关。关闭后不注册路由、不包装 llm.listModels、不改任何配置')
    .default(true),
  probe: z.object({
    timeoutMs: z.number()
      .description('单次探测请求超时（毫秒）。思考模型在繁忙网关可能长时间不返回')
      .default(20000),
    concurrency: z.number()
      .description('全池探测时的并发上限（默认 2），避免触发网关限流')
      .default(2),
  }).description('探测参数'),
  ui: z.object({
    path: z.string()
      .description('自带设置页路径（默认 /protocol-matrix/ui）')
      .default('/protocol-matrix/ui'),
  }).description('界面'),
});

export default Config;

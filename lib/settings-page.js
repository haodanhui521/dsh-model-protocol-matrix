/**
 * 页面读取器：**从磁盘读** lib/settings-page.html（带 mtime 缓存）。
 *
 * 为什么不让页面继续由 JS 内联生成：
 *   index.js 一旦被 import，模块就被缓存；改内联模板必须重启 DSH 才能生效。
 *   页面是纯静态 HTML，改成读盘后，UI 迭代只需要改 html + 刷新浏览器。
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, 'settings-page.html');

let cache = { mtime: 0, html: '' };

export function settingsPage() {
  try {
    const mtime = statSync(PAGE).mtimeMs;
    if (mtime !== cache.mtime || cache.html === '') {
      cache = { mtime, html: readFileSync(PAGE, 'utf8') };
    }
    return cache.html;
  } catch (error) {
    return cache.html !== ''
      ? cache.html
      : '<!doctype html><meta charset="utf-8"><p style="font:13px system-ui;padding:20px">settings-page.html 读取失败：'
        + String(error?.message ?? error).replace(/[<>&]/g, '')
        + '</p>';
  }
}

export default settingsPage;

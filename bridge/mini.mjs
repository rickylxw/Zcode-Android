// mini 看板启动器：读取桥接配置，优先用 Edge/Chrome 的 --app 模式开一个无地址栏的
// 独立小窗口（观感接近桌面小工具），找不到浏览器时退回系统默认浏览器。
// 桥接本体请先用 npm start 启动；token 从 URL # 片段带给页面（不会发到服务器）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'bridge.config.json'), 'utf8'));
const port = Number(process.env.BRIDGE_PORT) || cfg.port;
const token = process.env.BRIDGE_TOKEN || cfg.token;
const url = `http://127.0.0.1:${port}/mini#${encodeURIComponent(token)}`;

const up = await new Promise((resolve) => {
  const s = net.createConnection(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});
if (!up) console.log(`⚠ 桥接服务似乎没在运行（127.0.0.1:${port} 连不上）。先 npm start，再运行本命令。`);

const candidates = [
  process.env.MINI_BROWSER,
  path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean);
const browser = candidates.find((p) => fs.existsSync(p));

if (browser) {
  spawn(browser, [`--app=${url}`, '--window-size=440,720'], { detached: true, stdio: 'ignore' }).unref();
  console.log('已在独立窗口打开 mini 看板：', url);
} else if (process.platform === 'darwin') {
  spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  console.log('已用默认浏览器打开 mini 看板：', url);
} else if (process.platform === 'linux') {
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  console.log('已用默认浏览器打开 mini 看板：', url);
} else {
  console.log('请用浏览器打开 mini 看板：', url);
}

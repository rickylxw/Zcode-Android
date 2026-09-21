// 移除诊断样式 + 双截图（渲染器 + 手机屏幕）
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import WebSocket from '../../bridge/node_modules/ws/index.js';

const adb = 'E:/Android/Sdk/platform-tools/adb.exe';
const D = process.argv[2] || '10.203.213.100:41559';
const exec = (cmd) => new Promise((res) => execFile(adb, ['shell', cmd], { timeout: 20000 }, (e, so) => res(so?.trim() ?? '')));

const pid = (await exec('pidof com.zcode.mobile')).split(/\s+/)[0];
await exec(`forward --remove tcp:9222`);
await exec(`forward tcp:9222 localabstract:webview_devtools_remote_${pid}`);

async function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

const list = await getJson('/json');
const page = list.filter((t) => t.type === 'page')[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));

let mid = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => { const xid = ++mid; pending.set(xid, res); ws.send(JSON.stringify({ id: xid, method, params })); });
await send('Page.enable');

// 移除诊断样式（如存在）
await send('Runtime.evaluate', { expression: `document.getElementById('k90-diag')?.remove()` });

// 渲染器截图
await new Promise((r) => setTimeout(r, 800));
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.result?.data) {
  fs.writeFileSync('E:' + path.sep + 'Documents' + path.sep + 'GitHub' + path.sep + 'ZCode Android' + path.sep + 'bridge' + path.sep + 'renderer-clean.png', Buffer.from(shot.result.data, 'base64'));
  console.log('渲染器截图: renderer-clean.png,', Math.round(shot.result.data.length * 3 / 4 / 1024), 'KB');
}
ws.close();

// 手机屏幕截图
await new Promise((r) => setTimeout(r, 500));
await new Promise((res) => execFile(adb, ['-s', D, 'exec-out', 'screencap', '-p'], { timeout: 30000, maxBuffer: 20 * 1024 * 1024 }, (e, so) => {
  fs.writeFileSync('E:' + path.sep + 'Documents' + path.sep + 'GitHub' + path.sep + 'ZCode Android' + path.sep + 'bridge' + path.sep + 'phone-screen.png', so);
  console.log('屏幕截图: phone-screen.png,', Math.round(so.length / 1024), 'KB');
}));

process.exit(0);

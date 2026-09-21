// 决定性测试：浅色配色模拟 + 重载 + 渲染器截图
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
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));

let mid = 0;
const pending = new Map();
const events = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown')
    events.push(['EXCEPTION', String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 300)]);
  else if (m.method === 'Runtime.consoleAPICalled')
    events.push(['console/' + m.params.type, m.params.args?.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 150)]);
});

await new Promise((r) => ws.on('open', r));
const send = (method, params = {}) => new Promise((res) => { const xid = ++mid; pending.set(xid, res); ws.send(JSON.stringify({ id: xid, method, params })); });
await send('Page.enable');
await send('Runtime.enable');

// 强制浅色配色方案
await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'light' }],
});
await send('Page.reload', { ignoreCache: true });
console.log('已按浅色方案重载，等待 12 秒…');
await new Promise((r) => setTimeout(r, 12000));

// 渲染器截图
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.data) {
  fs.writeFileSync('E:' + path.sep + 'Documents' + path.sep + 'GitHub' + path.sep + 'ZCode Android' + path.sep + 'bridge' + path.sep + 'renderer-light.png', Buffer.from(shot.data, 'base64'));
  console.log('浅色方案渲染截图: renderer-light.png,', Math.round(shot.data.length * 3 / 4 / 1024), 'KB');
}

// 状态
const st = await send('Runtime.evaluate', { expression: `JSON.stringify({rs: document.readyState, text: document.body ? document.body.innerText.slice(0, 120) : '', bg: getComputedStyle(document.body).backgroundColor})`, returnByValue: true });
console.log('页面状态:', st?.result?.result?.value ?? '(失败)');
console.log('--- 事件 ---');
events.slice(-8).forEach((e) => console.log(e.join(' | ')));

ws.close();
process.exit(0);

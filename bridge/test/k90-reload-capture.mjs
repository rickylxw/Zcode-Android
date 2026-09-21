// 重载页面并从头捕获所有控制台输出与异常
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
  if (m.method === 'Runtime.consoleAPICalled')
    events.push(['console/' + m.params.type, m.params.args?.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200)]);
  else if (m.method === 'Runtime.exceptionThrown')
    events.push(['EXCEPTION', String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 400)]);
  else if (m.method === 'Log.entryAdded')
    events.push(['log/' + m.params.entry.level, String(m.params.entry.text).slice(0, 200)]);
});
await new Promise((r) => ws.on('open', r));
const send = (method, params = {}) => new Promise((res) => { const xid = ++mid; pending.set(xid, res); ws.send(JSON.stringify({ id: xid, method, params })); });

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Page.reload', { ignoreCache: true });
console.log('页面已重载，收集 20 秒内全部 JS 事件…');
await new Promise((r) => setTimeout(r, 20000));

console.log('=== 事件（' + events.length + ' 条）===');
events.forEach((e) => console.log(e.join(' | ')));

// 重载后的 DOM 状态
const state = await send('Runtime.evaluate', { expression: `JSON.stringify({rs: document.readyState, len: document.body ? document.body.innerHTML.length : -1, text: document.body ? document.body.innerText.slice(0, 150) : ''})`, returnByValue: true });
console.log('重载后状态:', state?.result?.result?.value ?? '(失败)');

ws.close();
process.exit(0);

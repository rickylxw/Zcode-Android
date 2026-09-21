// K90 WebView 状态检查：页面状态 + App 保存的链接
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import WebSocket from '../../bridge/node_modules/ws/index.js';

const adb = 'E:/Android/Sdk/platform-tools/adb.exe';
const D = process.argv[2] || '10.203.213.100:41559';
const exec = (cmd) => new Promise((res) => execFile(adb, ['shell', cmd], { timeout: 20000 }, (e, so) => res(so?.trim() ?? '')));

const pid = (await exec('pidof com.zcode.mobile')).split(/\s+/)[0];
console.log('pid:', pid);
await exec(`forward --remove tcp:9222`);
await exec(`forward tcp:9222 localabstract:webview_devtools_remote_${pid}`);

async function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad json: ' + d.slice(0, 80))); } });
    }).on('error', reject);
  });
}

const list = await getJson('/json');
for (const p of list.filter((t) => t.type === 'page')) {
  console.log('页面:', p.title.slice(0, 30), '|', p.url.slice(0, 110));
}

const page = list.find((t) => t.type === 'page');
if (!page) process.exit(1);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));

let mid = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const ev = (expr) => {
  const xid = ++mid;
  ws.send(JSON.stringify({ id: xid, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  return new Promise((res) => {
    const h = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id === xid) { ws.off('message', h); res(m.result?.result?.value ?? '(无返回)'); }
    };
    ws.on('message', h);
  });
};

console.log('readyState:', await ev('document.readyState'));
console.log('title:', await ev('document.title'));
console.log('href:', await ev('location.href'));
console.log('body 文本:', await ev('document.body ? document.body.innerText.slice(0, 300) : "(无)"'));

// App DataStore 保存的链接（run-as 读 debuggable 应用的私有文件）
const saved = await exec('run-as com.zcode.mobile sh -c "cat files/datastore/zcode_settings.preferences_pb 2>/dev/null" ');
const m = saved.match(/https:\/\/zcode\.z\.ai[^\x00-\x1f"']*/g);
console.log('=== App DataStore 里的链接 ===');
console.log(m ? m.join('\n') : '(未找到)');

ws.close();
process.exit(0);

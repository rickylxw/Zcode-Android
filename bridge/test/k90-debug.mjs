// K90 真机诊断：直达 WebView 页面 → 深度检查（渲染器截图/DOM/黑屏成因）
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import WebSocket from '../../bridge/node_modules/ws/index.js';

const adb = 'E:/Android/Sdk/platform-tools/adb.exe';
const D = '10.203.213.100:35541';
const exec = async (cmd) => {
  const r = await import('node:child_process').then(({ execFile }) => new Promise((res) => execFile(adb, ['shell', cmd], { timeout: 20000 }, (e, so, se) => res({ e, so, se }))));
  return r.so?.trim() ?? '';
};

const URL_REMOTE = 'https://zcode.z.ai/remote/v4?sid=d_MroomYVuMfXFi85eiKsChH&hash=5iYbWQtgCEchgSYZ5F2qsL4uD2gaF%2BW0zzKtDVSri4';

// 1) 带单引号保护启动（设备端 shell 不截断 &）
await exec(`am start -n com.zcode.mobile/.MainActivity --es remote '${URL_REMOTE}'`);
await new Promise((r) => setTimeout(r, 4000));
// 2) 点「在应用内打开」（配置页布局在真机上的位置：保存按钮约在 62% 高度）
await exec(`input tap 540 1590`);
await new Promise((r) => setTimeout(r, 14000));

// 3) DevTools 检查
const pid = (await exec(`pidof com.zcode.mobile`)).trim();
console.log('pid:', pid);
await exec(`forward --remove tcp:9222`);
await exec(`forward tcp:9222 localabstract:webview_devtools_remote_${pid}`);

async function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad json: ' + d.slice(0, 100))); } });
    }).on('error', reject);
  });
}

const list = await getJson('/json');
const page = list.filter((t) => t.type === 'page')[0];
if (!page) { console.log('无 WebView 页面'); process.exit(1); }
console.log('页面:', page.title.slice(0, 40), '|', page.url.slice(0, 60));

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const events = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Runtime.consoleAPICalled')
    events.push(['console/' + m.params.type, m.params.args?.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 180)]);
  else if (m.method === 'Log.entryAdded')
    events.push(['log/' + m.params.entry.level, String(m.params.entry.text).slice(0, 180)]);
  else if (m.method === 'Runtime.exceptionThrown')
    events.push(['exception', String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 250)]);
});
await new Promise((r) => ws.on('open', r));
const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');

const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r?.result?.result?.value ?? '(eval 失败)';
};

// 渲染器截图
await new Promise((r) => setTimeout(r, 1500));
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.data) {
  fs.writeFileSync('E:' + path.sep + 'Documents' + path.sep + 'GitHub' + path.sep + 'ZCode Android' + path.sep + 'bridge' + path.sep + 'renderer-k90.png', Buffer.from(shot.data, 'base64'));
  console.log('渲染器截图已存 renderer-k90.png,', Math.round(shot.data.length * 3 / 4 / 1024), 'KB');
} else {
  console.log('渲染器截图失败');
}

// 页面状态诊断
console.log('readyState:', await q('document.readyState'));
console.log('title:', await q('document.title'));
console.log('body 文本前200:', await q('document.body ? document.body.innerText.slice(0,200) : "(无)"'));
console.log('--- 控制台/异常 ---');
await new Promise((r) => setTimeout(r, 2000));
events.slice(-10).forEach((e) => console.log(e.join(' | ')));
if (!events.length) console.log('(无)');
process.exit(0);

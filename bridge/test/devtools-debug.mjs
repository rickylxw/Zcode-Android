// WebView 渲染器深度调试：渲染器截图 + 控制台/异常收集 + 黑屏常见原因排查
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import WebSocket from '../../bridge/node_modules/ws/index.js';

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
if (!page) { console.log('无页面'); process.exit(1); }
console.log('目标:', page.title.slice(0, 40), '|', page.url.slice(0, 70));

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

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });

// 1) 渲染器视角截图（绕过显示合成层）
await new Promise((r) => setTimeout(r, 1500));
const shotResp = await send('Page.captureScreenshot', { format: 'png' });
if (shotResp?.result?.data) {
  fs.writeFileSync('E:' + path.sep + 'Documents' + path.sep + 'GitHub' + path.sep + 'ZCode Android' + path.sep + 'bridge' + path.sep + 'renderer-now.png', Buffer.from(shotResp.result.data, 'base64'));
  console.log('渲染器截图已存 renderer-now.png,', Math.round(shotResp.result.data.length * 3 / 4 / 1024), 'KB');
} else {
  console.log('渲染器截图失败:', JSON.stringify(shotResp).slice(0, 200));
}

// 2) 页面结构与黑屏常见原因统计
const q = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r?.result?.result?.value ?? '(eval 失败: ' + JSON.stringify(r).slice(0, 150) + ')';
};
console.log('readyState:', await q('document.readyState'));
console.log('canvas/video 元素:', await q('document.querySelectorAll("canvas,video").length'));
console.log('backdrop-filter 元素:', await q('(()=>{let n=0;document.querySelectorAll("*").forEach(e=>{const s=getComputedStyle(e);if((s.backdropFilter&&s.backdropFilter!=="none")||(s.webkitBackdropFilter&&s.webkitBackdropFilter!=="none"))n++});return n})()'));
console.log('带 filter 的元素:', await q('(()=>{let n=0;document.querySelectorAll("*").forEach(e=>{const s=getComputedStyle(e);if(s.filter&&s.filter!=="none")n++});return n})()'));
console.log('固定定位元素:', await q('document.querySelectorAll("*").length ? [...document.querySelectorAll("div,section,main")].filter(e=>getComputedStyle(e).position==="fixed").length : 0'));
console.log('opacity<0.1 的大元素:', await q('(()=>{let n=0;document.querySelectorAll("div,section,main").forEach(e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);if(r.width>200&&r.height>400&&parseFloat(s.opacity)<0.1)n++});return n})()'));
console.log('meta color-scheme:', await q('document.querySelector("meta[name=color-scheme]")?.content || "(无)"'));
console.log('html 背景:', await q('getComputedStyle(document.documentElement).backgroundColor'));
console.log('body 背景:', await q('getComputedStyle(document.body).backgroundColor'));

// 3) 控制台与异常
await new Promise((r) => setTimeout(r, 2500));
console.log('--- 控制台/日志/异常（最近 15 条）---');
events.slice(-15).forEach((e) => console.log(e.join(' | ')));
if (!events.length) console.log('(无任何控制台输出)');

process.exit(0);

// K90 绘制失败活体诊断：查文字元素绘制状态 + 注入测试样式验证
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
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => { const xid = ++mid; pending.set(xid, res); ws.send(JSON.stringify({ id: xid, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r?.result?.result?.value ?? '(eval 失败: ' + JSON.stringify(r).slice(0, 120) + ')';
};

// 1) 找到正文文字所在元素的绘制状态
console.log('--- 文字元素绘制状态 ---');
console.log(await ev(`(()=>{
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node, out = [];
  while ((node = walker.nextNode())) {
    const t = node.textContent.trim();
    if (t.length > 3) {
      const el = node.parentElement;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      out.push(el.tagName + ' "' + t.slice(0, 16) + '" rect=' + Math.round(r.width) + 'x' + Math.round(r.height) + ' color=' + s.color + ' bg=' + s.backgroundColor + ' fontSize=' + s.fontSize + ' display=' + s.display + ' visibility=' + s.visibility);
      if (out.length >= 6) break;
    }
  }
  return out.join('\\n') || '(无文字元素)';
})()`));

// 2) 注入极端测试样式：全部强制红底黄字
console.log('--- 注入测试样式 ---');
await ev(`(()=>{
  const st = document.createElement('style');
  st.id = 'k90-diag';
  st.textContent = '* { color: yellow !important; background: red !important; border: 2px solid cyan !important; }';
  document.head.appendChild(st);
})()`);
await new Promise((r) => setTimeout(r, 1000));

// 3) 渲染器截图看注入后是否可见
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.data) {
  const p = 'E:' + path.sep + 'Documents' + path.sep + 'GitHub' + path.sep + 'ZCode Android' + path.sep + 'bridge' + path.sep + 'renderer-diag.png';
  fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));
  console.log('注入后渲染器截图已存 renderer-diag.png');
}
process.exit(0);

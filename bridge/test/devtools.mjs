// 通过 DevTools 协议检查/导航 WebView
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import WebSocket from '../../bridge/node_modules/ws/index.js';

const cmd = process.argv[2] || 'inspect'; // inspect | nav
const target = process.argv[3] || '';
const mode = process.argv[4] || 'debug';

async function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9222, path }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const list = await getJson('/json');
const pages = list.filter((t) => t.type === 'page');
console.log('WebView 页面数:', pages.length);
pages.forEach((p, i) => console.log(` [${i}]`, p.title.slice(0, 40), '|', p.url.slice(0, 90)));

const page = pages[0];
if (!page) process.exit(1);

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0;
const pending = new Map();

function send(method, params) {
  return new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params: params ?? {} }));
  });
}

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result ?? m.error);
    pending.delete(m.id);
  }
});

const connected = new Promise((r) => ws.on('open', r));
await connected;

if (cmd === 'nav') {
  await send('Page.enable');
  await send('Page.navigate', { url: target });
  console.log('已导航到:', target.slice(0, 60));
  await new Promise((r) => setTimeout(r, 12000));
}

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r?.result?.value;
};

console.log('readyState:', await ev('document.readyState'));
console.log('location:', await ev('location.href'));
console.log('title:', await ev('document.title'));
console.log('body 长度:', await ev('document.body ? document.body.innerHTML.length : -1'));
console.log('body 文本前200:', await ev('document.body ? document.body.innerText.slice(0,200) : "(无)"'));

if (mode === 'full') {
  console.log('全文:', await ev('document.body ? document.body.innerText : ""'));
}
process.exit(0);

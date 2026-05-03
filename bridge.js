#!/usr/bin/env node
// WebSocket ↔ Telnet 桥接：浏览器走 WebSocket（UTF-8 文本），
// 与北大侠客行 MUD 服务器走 TCP（GBK 字节 + Telnet IAC 协议）。
//
// 用法：
//   npm install
//   node bridge.js                       # 默认 ws://0.0.0.0:8765 → mud.pkuxkx.net:8081
//   PORT=9000 MUD_HOST=mud.pkuxkx.net MUD_PORT=8080 node bridge.js

const http = require('http');
const net = require('net');
const { WebSocketServer } = require('ws');
const iconv = require('iconv-lite');

const PORT     = parseInt(process.env.PORT, 10) || 8765;
const MUD_HOST = process.env.MUD_HOST || 'mud.pkuxkx.net';
const MUD_PORT = parseInt(process.env.MUD_PORT, 10) || 8081;

// Telnet 协议常量
const IAC  = 0xFF, DONT = 0xFE, DO = 0xFD, WONT = 0xFC, WILL = 0xFB;
const SB   = 0xFA, SE   = 0xF0;

// 解析并剥离 Telnet IAC 序列；对常见协商做出最小化回应（一律拒绝）。
// 状态保存在 ctx 中，因为 IAC 序列可能跨 TCP 包到达。
function makeTelnetStripper(replyBack) {
  const ctx = { state: 0, cmd: 0, sb: [] };
  return function strip(buf) {
    const out = [];
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      switch (ctx.state) {
        case 0: // 普通数据
          if (b === IAC) ctx.state = 1; else out.push(b);
          break;
        case 1: // 已读到 IAC，等待命令字节
          if (b === IAC) { out.push(IAC); ctx.state = 0; }       // 转义的 0xFF
          else if (b === SB) { ctx.state = 3; ctx.sb.length = 0; }
          else if (b === WILL || b === WONT || b === DO || b === DONT) {
            ctx.cmd = b; ctx.state = 2;
          } else { ctx.state = 0; }                              // 其它命令忽略
          break;
        case 2: // WILL/WONT/DO/DONT 后的选项字节
          // 一律拒绝以保持简单：服务器 WILL → 我们 DONT；服务器 DO → 我们 WONT。
          if (ctx.cmd === WILL)      replyBack(Buffer.from([IAC, DONT, b]));
          else if (ctx.cmd === DO)   replyBack(Buffer.from([IAC, WONT, b]));
          ctx.state = 0;
          break;
        case 3: // 子协商内容，直到 IAC SE
          if (b === IAC) ctx.state = 4; else ctx.sb.push(b);
          break;
        case 4: // 子协商中收到 IAC
          if (b === SE) ctx.state = 0;
          else if (b === IAC) { ctx.sb.push(IAC); ctx.state = 3; }
          else ctx.state = 3;
          break;
      }
    }
    return Buffer.from(out);
  };
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('PKUXKX WebSocket ↔ Telnet 桥接运行中。请用 WebSocket 连接此地址。\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const peer = req.socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] 浏览器接入 ${peer}，代连 ${MUD_HOST}:${MUD_PORT}`);

  const tcp = net.createConnection({ host: MUD_HOST, port: MUD_PORT });
  const decoder = iconv.getDecoder('gbk');
  const stripper = makeTelnetStripper(b => { try { tcp.write(b); } catch (_) {} });

  tcp.setNoDelay(true);

  tcp.on('connect', () => {
    if (ws.readyState === ws.OPEN) ws.send('\x1b[32m[桥接] 已连接到 ' + MUD_HOST + ':' + MUD_PORT + '\x1b[0m\r\n');
  });

  tcp.on('data', (data) => {
    const clean = stripper(data);
    if (clean.length === 0) return;
    const text = decoder.write(clean);
    if (text && ws.readyState === ws.OPEN) ws.send(text);
  });

  tcp.on('close', () => {
    if (ws.readyState === ws.OPEN) {
      ws.send('\r\n\x1b[33m[桥接] 与 MUD 服务器的连接已关闭\x1b[0m\r\n');
      ws.close();
    }
  });

  tcp.on('error', (err) => {
    if (ws.readyState === ws.OPEN) {
      ws.send('\r\n\x1b[31m[桥接] TCP 错误：' + err.message + '\x1b[0m\r\n');
      ws.close();
    }
  });

  ws.on('message', (msg, isBinary) => {
    const text = isBinary ? msg.toString('utf8') : msg.toString();
    const buf = iconv.encode(text, 'gbk');
    if (!tcp.destroyed) tcp.write(buf);
  });

  ws.on('close', () => {
    console.log(`[${new Date().toISOString()}] 浏览器 ${peer} 断开`);
    if (!tcp.destroyed) tcp.destroy();
  });

  ws.on('error', (err) => {
    console.error('WebSocket 错误：', err.message);
    if (!tcp.destroyed) tcp.destroy();
  });
});

server.listen(PORT, () => {
  console.log(`PKUXKX 桥接已启动：ws://0.0.0.0:${PORT}  →  ${MUD_HOST}:${MUD_PORT}`);
  console.log('在浏览器中打开 index.html，连接地址填 ws://localhost:' + PORT);
});

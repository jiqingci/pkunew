#!/usr/bin/env node
// WebSocket ↔ Telnet 桥接：浏览器走 WebSocket（UTF-8 文本），
// 与北大侠客行 MUD 服务器走 TCP（GBK 字节 + Telnet IAC 协议）。
//
// 双重身份：
//   1. 命令行入口：node bridge.js
//   2. 模块导出：require('./bridge.js').startBridge({...})  ← Electron 主进程使用

const http = require('http');
const net = require('net');
const { WebSocketServer } = require('ws');
const iconv = require('iconv-lite');

// Telnet 协议常量
const IAC  = 0xFF, DONT = 0xFE, DO = 0xFD, WONT = 0xFC, WILL = 0xFB;
const SB   = 0xFA, SE   = 0xF0;
// Telnet 选项：MXP (MUD eXtension Protocol) = 91
const OPT_MXP = 91;

// 解析并剥离 Telnet IAC 序列；接受 MXP，其它选项一律拒绝。
// 状态保存在 ctx 中，因为 IAC 序列可能跨 TCP 包到达。
function makeTelnetStripper(replyBack, onMxpEnabled) {
  const ctx = { state: 0, cmd: 0 };
  return function strip(buf) {
    const out = [];
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      switch (ctx.state) {
        case 0:
          if (b === IAC) ctx.state = 1; else out.push(b);
          break;
        case 1:
          if (b === IAC) { out.push(IAC); ctx.state = 0; }
          else if (b === SB) { ctx.state = 3; }
          else if (b === WILL || b === WONT || b === DO || b === DONT) {
            ctx.cmd = b; ctx.state = 2;
          } else { ctx.state = 0; }
          break;
        case 2:
          if (ctx.cmd === WILL) {
            if (b === OPT_MXP) { replyBack(Buffer.from([IAC, DO, b])); onMxpEnabled && onMxpEnabled(); }
            else replyBack(Buffer.from([IAC, DONT, b]));
          } else if (ctx.cmd === DO) {
            if (b === OPT_MXP) { replyBack(Buffer.from([IAC, WILL, b])); onMxpEnabled && onMxpEnabled(); }
            else replyBack(Buffer.from([IAC, WONT, b]));
          }
          ctx.state = 0;
          break;
        case 3:
          if (b === IAC) ctx.state = 4;
          break;
        case 4:
          if (b === SE) ctx.state = 0;
          else if (b === IAC) ctx.state = 3;
          else ctx.state = 3;
          break;
      }
    }
    return Buffer.from(out);
  };
}

// 启动一个桥接服务，返回 Promise<http.Server>。
// opts: { host='0.0.0.0', port=8765, mudHost='mud.pkuxkx.net', mudPort=8080, log? }
function startBridge(opts = {}) {
  const HOST     = opts.host     || '0.0.0.0';
  const PORT     = opts.port     != null ? opts.port : 8765;
  const MUD_HOST = opts.mudHost  || 'mud.pkuxkx.net';
  const MUD_PORT = opts.mudPort  || 8080;
  const log      = opts.log || (() => {});

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('PKUXKX WebSocket ↔ Telnet 桥接运行中。\n');
  });
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const peer = (req.socket && req.socket.remoteAddress) || '?';
    log(`浏览器接入 ${peer}，代连 ${MUD_HOST}:${MUD_PORT}`);

    const tcp = net.createConnection({ host: MUD_HOST, port: MUD_PORT });
    const decoder = iconv.getDecoder('gbk');
    const stripper = makeTelnetStripper(
      b => { try { tcp.write(b); } catch (_) {} },
      () => log(`${peer} 已协商 MXP`)
    );
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
      log(`浏览器 ${peer} 断开`);
      if (!tcp.destroyed) tcp.destroy();
    });
    ws.on('error', (err) => {
      log('WebSocket 错误：' + err.message);
      if (!tcp.destroyed) tcp.destroy();
    });
  });

  return new Promise((resolve) => {
    server.listen(PORT, HOST, () => resolve(server));
  });
}

module.exports = { startBridge, makeTelnetStripper };

// 命令行入口
if (require.main === module) {
  const port = parseInt(process.env.PORT, 10) || 8765;
  startBridge({
    port,
    mudHost: process.env.MUD_HOST || 'mud.pkuxkx.net',
    mudPort: parseInt(process.env.MUD_PORT, 10) || 8080,
    log: (m) => console.log(`[${new Date().toISOString()}] ${m}`)
  }).then(server => {
    const addr = server.address();
    console.log(`PKUXKX 桥接已启动：ws://${addr.address}:${addr.port} → mud.pkuxkx.net:8080`);
    console.log('在浏览器打开 index.html，连接地址填 ws://localhost:' + addr.port);
  });
}

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

// 常见 Telnet 选项名（用于日志）
const OPTION_NAMES = {
  0: 'BINARY', 1: 'ECHO', 3: 'SGA', 5: 'STATUS', 6: 'TM', 18: 'LOGOUT',
  24: 'TTYPE', 25: 'EOR', 31: 'NAWS', 32: 'TSPEED', 33: 'LFLOW',
  34: 'LINEMODE', 36: 'ENVIRON', 39: 'NEW-ENVIRON', 42: 'CHARSET',
  69: 'MSDP', 70: 'MSSP', 85: 'MCCP1', 86: 'MCCP2', 90: 'MSP',
  91: 'MXP', 93: 'ZMP', 200: 'ATCP', 201: 'GMCP'
};
function optName(b)  { return OPTION_NAMES[b] || ('OPT_' + b); }
function cmdName(b)  { return b === WILL ? 'WILL' : b === WONT ? 'WONT'
                            : b === DO   ? 'DO'   : b === DONT ? 'DONT' : 'CMD_' + b; }

// 解析并剥离 Telnet IAC 序列；接受 MXP，其它选项一律拒绝。
// onTelnetEvent({dir:'recv'|'send', desc:'IAC WILL MXP'}) — 通知调用者每个协商动作
function makeTelnetStripper(replyBack, onMxpEnabled, onTelnetEvent) {
  const ctx = { state: 0, cmd: 0 };
  const evt = onTelnetEvent || (() => {});
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
          else if (b === SB) { ctx.state = 3; evt({ dir: 'recv', desc: 'IAC SB ...' }); }
          else if (b === WILL || b === WONT || b === DO || b === DONT) {
            ctx.cmd = b; ctx.state = 2;
          } else { ctx.state = 0; }
          break;
        case 2: {
          evt({ dir: 'recv', desc: `IAC ${cmdName(ctx.cmd)} ${optName(b)}` });
          if (ctx.cmd === WILL) {
            if (b === OPT_MXP) {
              replyBack(Buffer.from([IAC, DO, b]));
              evt({ dir: 'send', desc: `IAC DO ${optName(b)}` });
              onMxpEnabled && onMxpEnabled();
            } else {
              replyBack(Buffer.from([IAC, DONT, b]));
              evt({ dir: 'send', desc: `IAC DONT ${optName(b)}` });
            }
          } else if (ctx.cmd === DO) {
            if (b === OPT_MXP) {
              replyBack(Buffer.from([IAC, WILL, b]));
              evt({ dir: 'send', desc: `IAC WILL ${optName(b)}` });
              onMxpEnabled && onMxpEnabled();
            } else {
              replyBack(Buffer.from([IAC, WONT, b]));
              evt({ dir: 'send', desc: `IAC WONT ${optName(b)}` });
            }
          }
          ctx.state = 0;
          break;
        }
        case 3:
          if (b === IAC) ctx.state = 4;
          break;
        case 4:
          if (b === SE) { ctx.state = 0; evt({ dir: 'recv', desc: 'IAC SE' }); }
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

    // 通过二进制 ws 消息把元数据（IAC 协商、连接状态、错误）推给浏览器，
    // 与文本数据通道分离，便于客户端记录到「传输日记」。
    const sendMeta = (obj) => {
      if (ws.readyState !== ws.OPEN) return;
      try { ws.send(Buffer.from(JSON.stringify(obj), 'utf8'), { binary: true }); } catch (_) {}
    };

    const tcp = net.createConnection({ host: MUD_HOST, port: MUD_PORT });
    const decoder = iconv.getDecoder('gbk');
    const stripper = makeTelnetStripper(
      b => { try { tcp.write(b); } catch (_) {} },
      () => { log(`${peer} 已协商 MXP`); sendMeta({ type: 'event', kind: 'mxp', desc: 'MXP 已协商成功' }); },
      ev => { sendMeta({ type: 'telnet', dir: ev.dir, desc: ev.desc, ts: Date.now() }); }
    );
    tcp.setNoDelay(true);

    tcp.on('connect', () => {
      sendMeta({ type: 'event', kind: 'tcp', desc: '已连接到 ' + MUD_HOST + ':' + MUD_PORT, ts: Date.now() });
      if (ws.readyState === ws.OPEN) {
        ws.send('\x1b[32m[桥接] 已连接到 ' + MUD_HOST + ':' + MUD_PORT + '\x1b[0m\r\n');
      }
      // 主动 announce MXP 支持（PKUXKX 在 8080 上有时不主动发 IAC WILL MXP，
      // 客户端先 announce 能让服务器进入 MXP 模式）
      try {
        tcp.write(Buffer.from([IAC, WILL, OPT_MXP]));
        sendMeta({ type: 'telnet', dir: 'send', desc: 'IAC WILL MXP (主动)', ts: Date.now() });
      } catch (_) {}
    });
    tcp.on('data', (data) => {
      const clean = stripper(data);
      if (clean.length === 0) return;
      const text = decoder.write(clean);
      if (text && ws.readyState === ws.OPEN) ws.send(text);
    });
    tcp.on('close', () => {
      sendMeta({ type: 'event', kind: 'tcp', desc: 'MUD 连接已关闭', ts: Date.now() });
      if (ws.readyState === ws.OPEN) {
        ws.send('\r\n\x1b[33m[桥接] 与 MUD 服务器的连接已关闭\x1b[0m\r\n');
        ws.close();
      }
    });
    tcp.on('error', (err) => {
      sendMeta({ type: 'event', kind: 'error', desc: 'TCP 错误：' + err.message, ts: Date.now() });
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

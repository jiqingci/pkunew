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
const { StringDecoder } = require('string_decoder');

// 编解码工厂：UTF-8 走 Node 原生 StringDecoder（处理半字符接续），其它走 iconv-lite。
function makeCodec(charset) {
  const name = String(charset || 'utf8').toLowerCase().replace(/-/g, '');
  if (name === 'utf8') {
    const dec = new StringDecoder('utf8');
    return { name: 'utf8', decode: (b) => dec.write(b), encode: (t) => Buffer.from(t, 'utf8') };
  }
  const dec = iconv.getDecoder(name);
  return { name, decode: (b) => dec.write(b), encode: (t) => iconv.encode(t, name) };
}

// Telnet 协议常量
const IAC  = 0xFF, DONT = 0xFE, DO = 0xFD, WONT = 0xFC, WILL = 0xFB;
const SB   = 0xFA, SE   = 0xF0;
// Telnet 选项：MXP=91, TTYPE=24, NAWS=31, GMCP=201
const OPT_MXP = 91, OPT_TTYPE = 24, OPT_NAWS = 31, OPT_GMCP = 201;
// TTYPE 子协商：IS=0, SEND=1
const TTYPE_IS = 0, TTYPE_SEND = 1;

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

// 解析并剥离 Telnet IAC 序列；接受 MXP / TTYPE / NAWS / GMCP，其它选项一律拒绝。
// PKUXKX 在 8080 上根据 TTYPE 决定是否启用 MXP；GMCP 给现代客户端推结构化数据。
// onTelnetEvent({dir, desc}) — 协商动作通知
// onSubneg(Buffer)  — 子协商内容（去除外层 IAC SB...IAC SE，含选项码与负载）
// onOptionEnabled(optCode) — 协商成功后通知（MXP/GMCP 用于触发后续动作）
function makeTelnetStripper(replyBack, onTelnetEvent, onSubneg, onOptionEnabled) {
  const ctx = { state: 0, cmd: 0, sb: [] };
  const evt = onTelnetEvent || (() => {});
  const enabled = onOptionEnabled || (() => {});
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
          else if (b === SB) { ctx.state = 3; ctx.sb.length = 0; evt({ dir: 'recv', desc: 'IAC SB' }); }
          else if (b === WILL || b === WONT || b === DO || b === DONT) {
            ctx.cmd = b; ctx.state = 2;
          } else { ctx.state = 0; }
          break;
        case 2: {
          evt({ dir: 'recv', desc: `IAC ${cmdName(ctx.cmd)} ${optName(b)}` });
          if (ctx.cmd === WILL) {
            // 服务器愿意做 X：MXP / GMCP 都接受
            if (b === OPT_MXP || b === OPT_GMCP) {
              replyBack(Buffer.from([IAC, DO, b]));
              evt({ dir: 'send', desc: `IAC DO ${optName(b)}` });
              enabled(b);
            } else {
              replyBack(Buffer.from([IAC, DONT, b]));
              evt({ dir: 'send', desc: `IAC DONT ${optName(b)}` });
            }
          } else if (ctx.cmd === DO) {
            // 服务器希望我们做 X：MXP / TTYPE / NAWS / GMCP 都接受
            if (b === OPT_MXP || b === OPT_TTYPE || b === OPT_NAWS || b === OPT_GMCP) {
              replyBack(Buffer.from([IAC, WILL, b]));
              evt({ dir: 'send', desc: `IAC WILL ${optName(b)}` });
              if (b === OPT_NAWS) {
                const naws = Buffer.from([IAC, SB, OPT_NAWS, 0, 80, 0, 24, IAC, SE]);
                replyBack(naws);
                evt({ dir: 'send', desc: 'IAC SB NAWS 80x24 IAC SE' });
              }
              if (b === OPT_MXP || b === OPT_GMCP) enabled(b);
            } else {
              replyBack(Buffer.from([IAC, WONT, b]));
              evt({ dir: 'send', desc: `IAC WONT ${optName(b)}` });
            }
          }
          ctx.state = 0;
          break;
        }
        case 3: // SB body
          if (b === IAC) ctx.state = 4;
          else ctx.sb.push(b);
          break;
        case 4: // IAC inside SB
          if (b === SE) {
            evt({ dir: 'recv', desc: 'IAC SE' });
            onSubneg && onSubneg(Buffer.from(ctx.sb));
            ctx.sb.length = 0;
            ctx.state = 0;
          } else if (b === IAC) {
            ctx.sb.push(IAC); ctx.state = 3;
          } else {
            ctx.state = 3;
          }
          break;
      }
    }
    return Buffer.from(out);
  };
}

// 启动一个桥接服务，返回 Promise<http.Server>。
// opts: { host, port, mudHost, mudPort, charset='utf8', log? }
// 客户端可在 ws URL 加 ?charset=gbk 覆盖默认值
function startBridge(opts = {}) {
  const HOST     = opts.host     || '0.0.0.0';
  const PORT     = opts.port     != null ? opts.port : 8765;
  const MUD_HOST = opts.mudHost  || 'mud.pkuxkx.net';
  const MUD_PORT = opts.mudPort  || 8080;
  const DEFAULT_CHARSET = (opts.charset || 'utf8').toLowerCase();
  const log      = opts.log || (() => {});

  const server = http.createServer((req, res) => {
    // CORS 预检
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version'
      });
      return res.end();
    }
    // AI 反向代理：浏览器 POST {url, headers, body} → 桥接转发到上游 → 原样回传
    // 解决浏览器直调 OpenAI/Anthropic 的 CORS 问题。
    if (req.method === 'POST' && req.url === '/ai-proxy') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', c => { body += c; if (body.length > 2 * 1024 * 1024) req.destroy(); });
      req.on('end', async () => {
        try {
          const r = JSON.parse(body);
          if (!r.url || typeof r.url !== 'string') throw new Error('missing url');
          // 简单白名单：只允许 https / 本机 http（Ollama）
          if (!/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost))/i.test(r.url)) {
            throw new Error('only https or local http allowed');
          }
          const upstream = await fetch(r.url, {
            method: r.method || 'POST',
            headers: r.headers || {},
            body: r.body == null ? undefined : (typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
          });
          const text = await upstream.text();
          res.writeHead(upstream.status, {
            'Content-Type': upstream.headers.get('content-type') || 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          return res.end(text);
        } catch (e) {
          res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          return res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end('PKUXKX WebSocket ↔ Telnet 桥接运行中。WebSocket: /  · AI proxy: POST /ai-proxy\n');
  });
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const peer = (req.socket && req.socket.remoteAddress) || '?';
    // 解析 ws URL 查询参数：?charset=utf8|gbk|big5
    let charset = DEFAULT_CHARSET;
    try {
      const u = new URL(req.url, 'http://x');
      const c = u.searchParams.get('charset');
      if (c) charset = c.toLowerCase();
    } catch (_) {}
    let codec;
    try { codec = makeCodec(charset); }
    catch (e) { codec = makeCodec('utf8'); charset = 'utf8'; }
    log(`浏览器接入 ${peer}，编码 ${codec.name}，代连 ${MUD_HOST}:${MUD_PORT}`);

    // 通过二进制 ws 消息把元数据（IAC 协商、连接状态、错误）推给浏览器，
    // 与文本数据通道分离，便于客户端记录到「传输日记」。
    const sendMeta = (obj) => {
      if (ws.readyState !== ws.OPEN) return;
      try { ws.send(Buffer.from(JSON.stringify(obj), 'utf8'), { binary: true }); } catch (_) {}
    };

    sendMeta({ type: 'event', kind: 'tcp', desc: '编码 ' + codec.name, ts: Date.now() });

    const tcp = net.createConnection({ host: MUD_HOST, port: MUD_PORT });
    // PKUXKX 通过 TTYPE 识别客户端：报告 "Mudlet" 让服务器认为是现代客户端（启用 MXP/GMCP）
    // RFC 1091 的 TTYPE cycle：服务器多次 SEND，客户端依次回 IS "Mudlet" / "ANSI-256COLOR" / "MTTS 13"
    const TTYPE_LIST = ['Mudlet', 'ANSI-256COLOR', 'MTTS 13'];
    let ttypeIdx = 0;

    // GMCP 发送辅助：IAC SB GMCP <package> SP <json> IAC SE
    function sendGmcp(pkg, data) {
      const json = (data === undefined) ? '' : JSON.stringify(data);
      const payload = json ? (pkg + ' ' + json) : pkg;
      const out = Buffer.concat([
        Buffer.from([IAC, SB, OPT_GMCP]),
        Buffer.from(payload, 'utf8'),
        Buffer.from([IAC, SE])
      ]);
      try { tcp.write(out); } catch (_) {}
      sendMeta({ type: 'telnet', dir: 'send',
                 desc: `IAC SB GMCP ${pkg}${json ? ' ' + json.slice(0, 80) : ''} IAC SE`, ts: Date.now() });
    }

    const stripper = makeTelnetStripper(
      b => { try { tcp.write(b); } catch (_) {} },
      ev => { sendMeta({ type: 'telnet', dir: ev.dir, desc: ev.desc, ts: Date.now() }); },
      sb => {
        // 子协商：sb[0] = 选项码
        if (sb.length >= 2 && sb[0] === OPT_TTYPE && sb[1] === TTYPE_SEND) {
          // TTYPE cycle
          const isFirst = ttypeIdx === 0;
          const name = TTYPE_LIST[Math.min(ttypeIdx, TTYPE_LIST.length - 1)];
          if (ttypeIdx < TTYPE_LIST.length - 1) ttypeIdx++;
          const reply = Buffer.concat([
            Buffer.from([IAC, SB, OPT_TTYPE, TTYPE_IS]),
            Buffer.from(name, 'ascii'),
            Buffer.from([IAC, SE])
          ]);
          try { tcp.write(reply); } catch (_) {}
          sendMeta({ type: 'telnet', dir: 'send', desc: `IAC SB TTYPE IS "${name}" IAC SE`, ts: Date.now() });
          if (isFirst) {
            try { tcp.write(Buffer.from([IAC, WILL, OPT_MXP])); } catch (_) {}
            sendMeta({ type: 'telnet', dir: 'send', desc: 'IAC WILL MXP (报 TTYPE 后)', ts: Date.now() });
          }
        } else if (sb.length >= 1 && sb[0] === OPT_GMCP) {
          // GMCP: 选项码后是 "package SP json" 文本
          const txt = sb.slice(1).toString('utf8');
          const sepIdx = txt.indexOf(' ');
          let pkg, jsonStr;
          if (sepIdx >= 0) { pkg = txt.slice(0, sepIdx); jsonStr = txt.slice(sepIdx + 1); }
          else { pkg = txt; jsonStr = ''; }
          let parsed = jsonStr;
          try { if (jsonStr.length) parsed = JSON.parse(jsonStr); } catch (_) {}
          sendMeta({ type: 'gmcp', package: pkg, data: parsed, raw: jsonStr, ts: Date.now() });
        }
      },
      opt => {
        // 协商成功通知
        if (opt === OPT_MXP) {
          log(`${peer} 已协商 MXP`);
          sendMeta({ type: 'event', kind: 'mxp', desc: 'MXP 已协商成功', ts: Date.now() });
        } else if (opt === OPT_GMCP) {
          log(`${peer} 已协商 GMCP`);
          sendMeta({ type: 'event', kind: 'gmcp', desc: 'GMCP 已协商成功', ts: Date.now() });
          // GMCP 标准握手：客户端 announce 自己 + 订阅常用包
          sendGmcp('Core.Hello', { client: 'PKUXKX-Web', version: '1.0' });
          sendGmcp('Core.Supports.Set', [
            'Char 1', 'Char.Vitals 1', 'Char.Status 1',
            'Room 1', 'Room.Info 1',
            'Comm 1', 'Comm.Channel 1'
          ]);
        }
      }
    );
    tcp.setNoDelay(true);

    tcp.on('connect', () => {
      sendMeta({ type: 'event', kind: 'tcp', desc: '已连接到 ' + MUD_HOST + ':' + MUD_PORT, ts: Date.now() });
      if (ws.readyState === ws.OPEN) {
        ws.send('\x1b[32m[桥接] 已连接到 ' + MUD_HOST + ':' + MUD_PORT + '\x1b[0m\r\n');
      }
      // 不在 connect 时主动 WILL MXP——会被 PKUXKX 在 TTYPE 协商前拒绝。
      // 改为在我们回报 TTYPE="Mudlet" 之后再 announce（见 onSubneg）。
    });
    tcp.on('data', (data) => {
      const clean = stripper(data);
      if (clean.length === 0) return;
      const text = codec.decode(clean);
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
      const buf = codec.encode(text);
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

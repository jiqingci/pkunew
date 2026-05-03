// 自定义自动更新：查询 GitHub Releases → 下载新 exe → batch 脚本替换重启
// 用 batch 脚本是因为 portable exe 自身被 OS 锁定，必须等当前进程退出后才能覆盖。
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, dialog } = require('electron');

const REPO = process.env.PKUXKX_UPDATE_REPO || 'jiqingci/pkunew';
const UA = 'PKUXKX-Updater/' + app.getVersion();

function fetchJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        return resolve(fetchJson(res.headers.location, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('GitHub API HTTP ' + res.statusCode));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function downloadFile(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'application/octet-stream' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        return resolve(downloadFile(res.headers.location, dest, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('Download HTTP ' + res.statusCode));
      }
      const total = parseInt(res.headers['content-length'], 10) || 0;
      let received = 0;
      const file = fs.createWriteStream(dest);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress(received, total);
      });
      res.pipe(file);
      file.on('finish', () => file.close((e) => e ? reject(e) : resolve()));
      file.on('error', reject);
    }).on('error', reject);
  });
}

function compareVersions(a, b) {
  // semver 子集：MAJOR.MINOR.PATCH[-PRE]；预发版小于正式版
  const split = (v) => {
    const clean = String(v).replace(/^v/i, '');
    const [main, pre] = clean.split('-', 2);
    return { main: main.split('.').map(n => parseInt(n, 10) || 0), pre: pre || '' };
  };
  const A = split(a), B = split(b);
  for (let i = 0; i < Math.max(A.main.length, B.main.length); i++) {
    const x = A.main[i] || 0, y = B.main[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  if (A.pre && !B.pre) return -1;
  if (!A.pre && B.pre) return 1;
  if (A.pre < B.pre) return -1;
  if (A.pre > B.pre) return 1;
  return 0;
}

async function checkForUpdates(win, { manual = false } = {}) {
  try {
    if (!app.isPackaged && !manual) {
      console.log('[updater] dev 模式，自动检查跳过');
      return;
    }
    console.log('[updater] 检查更新…');
    const release = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!release || !release.tag_name) {
      if (manual) await dialog.showMessageBox(win, { type: 'info', message: '尚未发布过 Release。' });
      return;
    }
    const latest = release.tag_name;
    const current = app.getVersion();
    if (compareVersions(latest, current) <= 0) {
      console.log(`[updater] 当前 v${current} 已是最新（远端 ${latest}）`);
      if (manual) await dialog.showMessageBox(win, { type: 'info', title: '已是最新版', message: `当前版本 v${current} 已是最新。` });
      return;
    }
    const asset = release.assets && release.assets.find(a => /\.exe$/i.test(a.name));
    if (!asset) {
      console.log('[updater] release 不含 .exe 资产');
      if (manual) await dialog.showMessageBox(win, { type: 'warning', message: 'GitHub Release 中未找到 exe 文件。' });
      return;
    }
    const choice = await dialog.showMessageBox(win, {
      type: 'info',
      title: '发现新版本',
      message: `发现新版本 ${latest}\n当前版本 v${current}\n\n是否立即下载更新？`,
      detail: (release.body || '').slice(0, 800),
      buttons: ['立即更新', '稍后'],
      defaultId: 0,
      cancelId: 1
    });
    if (choice.response !== 0) return;

    // 下载到临时文件
    const tmpDir = app.getPath('temp');
    const tmpExe = path.join(tmpDir, `pkuxkx-update-${Date.now()}.exe`);
    const startTs = Date.now();
    await downloadFile(asset.browser_download_url, tmpExe, (received, total) => {
      if (win.isDestroyed()) return;
      if (total > 0) {
        win.setProgressBar(received / total);
        win.setTitle(`下载更新中 ${(received / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB · 北大侠客行`);
      } else {
        win.setProgressBar(2); // indeterminate
      }
    });
    if (!win.isDestroyed()) {
      win.setProgressBar(-1);
      win.setTitle('北大侠客行');
    }
    console.log(`[updater] 下载完成 (${((Date.now() - startTs) / 1000).toFixed(1)}s) → ${tmpExe}`);

    // 写 batch 脚本：等当前进程退出 → 替换 exe → 启动新版 → 自删
    const exePath = process.execPath;
    const batPath = path.join(tmpDir, `pkuxkx-update-${Date.now()}.bat`);
    const bat = [
      '@echo off',
      'chcp 65001 >nul',
      ':wait',
      'tasklist /FI "PID eq ' + process.pid + '" 2>nul | find "' + process.pid + '" >nul',
      'if not errorlevel 1 (',
      '  ping -n 2 127.0.0.1 >nul',
      '  goto wait',
      ')',
      'move /y "' + tmpExe + '" "' + exePath + '" >nul',
      'if errorlevel 1 (',
      '  echo 替换失败，请手动用 "' + tmpExe + '" 覆盖 "' + exePath + '"',
      '  pause',
      '  exit /b 1',
      ')',
      'start "" "' + exePath + '"',
      '(goto) 2>nul & del "%~f0"'
    ].join('\r\n');
    fs.writeFileSync(batPath, bat, { encoding: 'utf8' });

    spawn('cmd.exe', ['/c', 'start', '""', '/min', batPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref();

    setTimeout(() => app.quit(), 500);
  } catch (e) {
    console.error('[updater] 失败：', e.message);
    if (manual) {
      try {
        await dialog.showMessageBox(win, {
          type: 'error',
          title: '检查更新失败',
          message: e.message
        });
      } catch (_) {}
    }
  }
}

module.exports = { checkForUpdates, compareVersions };

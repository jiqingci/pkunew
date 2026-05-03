// Electron 主进程：启动内嵌桥接 + 创建窗口加载 index.html + 触发自动更新检查
const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');
const { startBridge } = require('../bridge.js');
const { checkForUpdates } = require('./updater');

// 单实例锁，防止双开抢端口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); return; }

let mainWindow = null;
let bridgeServer = null;

async function createWindow() {
  // 启动内嵌桥接，绑定 127.0.0.1 随机端口（仅本机可达）
  bridgeServer = await startBridge({
    host: '127.0.0.1',
    port: 0,
    mudHost: 'mud.pkuxkx.net',
    mudPort: 8080,
    log: (m) => console.log('[bridge]', m)
  });
  const port = bridgeServer.address().port;
  console.log('[bridge] 内嵌桥接已启动 ws://127.0.0.1:' + port);

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 720,
    minHeight: 480,
    title: '北大侠客行',
    autoHideMenuBar: true,
    backgroundColor: '#FFFFFF',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // 把内嵌桥接端口与"自动连接"标志通过 URL 参数传给页面
  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'), {
    query: { ws: `ws://127.0.0.1:${port}`, autoconnect: '1' }
  });

  // 外部链接走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  Menu.setApplicationMenu(null);
}

ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('app:check-update', () => mainWindow && checkForUpdates(mainWindow, { manual: true }));

app.whenReady().then(async () => {
  await createWindow();
  // 启动 3s 后静默检查更新（避免阻塞首屏）
  setTimeout(() => mainWindow && checkForUpdates(mainWindow, { manual: false }), 3000);
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  try { bridgeServer && bridgeServer.close(); } catch (_) {}
  app.quit();
});

const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 1000,
    minWidth: 450,
    minHeight: 650,
    backgroundColor: '#d1d5db',
    webPreferences: {
      nodeIntegration: false,      // Keep renderer secure
      contextIsolation: true,      // Isolate context for security
      preload: path.join(__dirname, 'preload.js') // Optional minimal preload
    },
    show: false,
    frame: true,                   // Standard window frame (can be hidden if desired)
    title: 'Minimal Notebook'
  });

  // Load the HTML file
  win.loadFile('index.html');

  // Show window when ready to avoid flicker
  win.once('ready-to-show', () => {
    win.show();
  });

  // Optional: Remove default Electron menu for a cleaner look
  Menu.setApplicationMenu(null);
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
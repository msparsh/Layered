const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises'); // Use promise-based FS

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


app.whenReady().then(() => {
    const baseDir = path.join(app.getPath('documents'), 'MinimalBujo');
    const trashDir = path.join(baseDir, 'trash');

    // 🛡️ SECURITY: Strict Path Resolution
    function getSafePath(relativePath) {
        // Resolve creates an absolute path, normalizing away any ../
        const targetPath = path.resolve(baseDir, relativePath);
        // Ensure the absolute target path still starts with the absolute base directory
        if (!targetPath.startsWith(path.resolve(baseDir))) {
            console.error(`🚨 SECURITY ALERT: Path Traversal Attempt Blocked: ${relativePath}`);
            throw new Error('Unauthorized path access');
        }
        return targetPath;
    }

    ipcMain.handle('read-json', async (event, relativePath) => {
        try {
            const safePath = getSafePath(relativePath);
            const data = await fs.readFile(safePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            return null;
        }
    });

    ipcMain.handle('write-json-atomic', async (event, relativePath, data) => {
        try {
            const targetPath = getSafePath(relativePath);
            const tmpPath = targetPath + '.tmp';

            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
            await fs.rename(tmpPath, targetPath);
            return true;
        } catch (error) {
            console.error(`Error writing ${relativePath}:`, error);
            return false;
        }
    });

    // 🗑️ CLEANUP: Safely move deleted spreads to the trash folder
    ipcMain.handle('trash-json', async (event, relativePath) => {
        try {
            const targetPath = getSafePath(relativePath);
            await fs.mkdir(trashDir, { recursive: true });
            
            const fileName = path.basename(targetPath);
            const timestamp = Date.now();
            const trashPath = path.join(trashDir, `${timestamp}-${fileName}`);

            // Move the file instead of permanently deleting, just in case!
            await fs.rename(targetPath, trashPath);
            return true;
        } catch (error) {
            if (error.code === 'ENOENT') return true; // Already gone
            console.error(`Error trashing ${relativePath}:`, error);
            return false;
        }
    });
});
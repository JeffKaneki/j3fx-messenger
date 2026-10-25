const { app, BrowserWindow, shell, session } = require('electron')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

function isAppOrigin(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'file:') {
      return path.resolve(fileURLToPath(url)) === path.resolve(__dirname, '..', 'dist', 'index.html')
    }
    return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
  } catch {
    return false
  }
}

function isLocalFileOrigin(value) {
  if (value === 'file://') return true
  try {
    return new URL(value).protocol === 'file:'
  } catch {
    return false
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#f4f7fb',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('mailto:')) void shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) =>
    permission === 'media'
      && isAppOrigin(webContents.getURL())
      && (isLocalFileOrigin(requestingOrigin) || isAppOrigin(requestingOrigin)))
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details?.requestingUrl ?? webContents.getURL()
    const mediaTypes = details?.mediaTypes ?? []
    const supportedMedia = mediaTypes.every((type) => type === 'audio' || type === 'video')
    callback(permission === 'media' && supportedMedia && isAppOrigin(requestingUrl))
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

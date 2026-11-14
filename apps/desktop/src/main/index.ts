import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, screen } from 'electron'
import { mkdirSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve, join, sep, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { commands, type Command } from '../shared/contracts'
import { CHANNEL, CHANGED, BEFORE_QUIT, QUIT_READY } from '../shared/channels'
import { Database } from './storage/client'
import { DouyinEngine } from './douyin/engine'
import { safeMediaUrl } from './douyin/parse'
import { Application } from './application'
import { AppError, publicError } from './errors'
import { COVER_CACHE_MAX_BYTES, coverCacheName, imageContentType, resolveCoverCacheDir } from './cover-cache'
import { restoreWindowState } from './window-state'

protocol.registerSchemesAsPrivileged([
  { scheme: 'mylike', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])
// DComp can retain a stale video presentation rectangle after clean-mode
// relayout on Windows; resizing the native window clears it. Use Chromium's
// regular presentation path while retaining GPU rendering and video decoding.
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-direct-composition')
app.setName('MyLike')
const data = process.env.MYLIKE_USER_DATA
if (data && isAbsolute(data)) app.setPath('userData', data)
else app.setPath('userData', join(app.getPath('appData'), 'MyLikeElectron'))
let mainWindow: BrowserWindow | null = null
let service: Application | null = null
let quitting = false
let closePrompt = false
let backgroundRestored = false
function isUiUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol === 'mylike:' && url.hostname === 'ui' && !url.username && !url.password) return true
    return (
      !app.isPackaged &&
      !!process.env.ELECTRON_RENDERER_URL &&
      url.origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
    )
  } catch {
    return false
  }
}
let quitFlush: { nonce: string; resolve: () => void } | null = null
ipcMain.on(QUIT_READY, (event, nonce: unknown) => {
  if (
    mainWindow &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame &&
    nonce === quitFlush?.nonce
  )
    quitFlush?.resolve()
})
async function flushRenderer(): Promise<void> {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      quitFlush = null
      resolve()
    }
    const timer = setTimeout(done, 1200),
      nonce = randomUUID()
    quitFlush = { nonce, resolve: done }
    win.webContents.send(BEFORE_QUIT, nonce)
  })
}
/**
 * A writeback may still be walking the platform queue when the user closes the
 * window. Closing the window would stop the main process, so ask first: keep
 * running hidden until the current queue finishes, or stop this sync and quit.
 */
async function promptWritebackClose(win: BrowserWindow): Promise<void> {
  if (closePrompt) return
  closePrompt = true
  try {
    if (process.env.MYLIKE_HEADLESS === '1') {
      app.quit()
      return
    }
    const pending = service ? await service.pendingFavoriteWrites().catch(() => 0) : 0
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      title: '写回仍在进行',
      message: '写回仍在进行',
      detail: `${pending ? `还有约 ${pending} 项待写回。` : '平台写回尚未结束。'}请选择本次执行的操作：\n\n· 后台继续进行：隐藏应用，写回结束后自动退出。\n· 关闭本次同步：停止写回并退出，未完成的操作会保留在队列中。`,
      buttons: ['后台继续进行', '关闭本次同步'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (response === 1) {
      app.quit()
      return
    }
    backgroundRestored = false
    win.hide()
    const idle = service?.whenFavoriteSyncIdle()
    if (!idle) {
      app.quit()
      return
    }
    void idle.then(() => {
      if (!quitting && !backgroundRestored) app.quit()
    })
  } finally {
    closePrompt = false
  }
}
const changed = () => {
  if (!quitting && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CHANGED)
}

async function bootstrap(): Promise<void> {
  const db = new Database(join(app.getPath('userData'), 'mylike.sqlite'))
  await db.ready
  const preferences = await db.call('appPreferences', {})
  const remembered = preferences.rememberWindow
    ? restoreWindowState(
        await db.call('windowState', {}),
        screen.getAllDisplays().map((d) => d.workArea)
      )
    : null
  const root = resolve(__dirname, '../renderer')
  const uiSession = session.fromPartition('persist:mylike-ui')
  const coverInflight = new Map<string, Promise<Buffer>>()
  const coverDirectory = async (): Promise<string> => {
    const current = await db.call('appPreferences', {})
    return resolveCoverCacheDir(current.coverCachePath, app.getPath('userData'))
  }
  const downloadCover = async (remote: string): Promise<Buffer> => {
    const inflight = coverInflight.get(remote)
    if (inflight) return inflight
    const task = (async () => {
      // Use the UI session so covers share its network stack and webRequest
      // headers; the app's tests also intercept this session.
      const response = await uiSession.fetch(remote, {
        headers: { Referer: 'https://www.douyin.com/' }
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const type = response.headers.get('content-type') ?? ''
      if (!type.startsWith('image/')) throw new Error(`not an image (${type || 'unknown'})`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!bytes.length || bytes.length > COVER_CACHE_MAX_BYTES) throw new Error('image too large')
      if (!imageContentType(bytes).startsWith('image/')) throw new Error('unsupported image')
      try {
        const directory = await coverDirectory()
        await mkdir(directory, { recursive: true })
        const file = join(directory, coverCacheName(remote))
        const temporary = `${file}.${randomUUID()}.tmp`
        await writeFile(temporary, bytes)
        await rename(temporary, file)
      } catch (error) {
        // A broken custom directory must not stop covers from rendering.
        console.warn(`[cover] cache write failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return bytes
    })()
    coverInflight.set(remote, task)
    void task
      .catch(() => {})
      .finally(() => {
        if (coverInflight.get(remote) === task) coverInflight.delete(remote)
      })
    return task
  }
  const coverResponse = async (url: URL): Promise<Response> => {
    const remote = safeMediaUrl(url.searchParams.get('url'))
    if (!remote) return new Response('Forbidden', { status: 403 })
    let bytes: Buffer
    try {
      bytes = await readFile(join(await coverDirectory(), coverCacheName(remote)))
    } catch {
      bytes = await downloadCover(remote)
    }
    const type = imageContentType(bytes)
    if (!type.startsWith('image/')) return new Response('Not an image', { status: 502 })
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': type,
        'Cache-Control': 'private, max-age=31536000, immutable'
      }
    })
  }
  uiSession.protocol.handle('mylike', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname === 'cover') {
        try {
          return await coverResponse(url)
        } catch (error) {
          console.warn(
            `[cover] ${url.searchParams.get('url') ?? ''}: ${error instanceof Error ? error.message : String(error)}`
          )
          return new Response('Cover unavailable', { status: 502 })
        }
      }
      if (url.hostname !== 'ui') return new Response('Not found', { status: 404 })
      const file = resolve(
        root,
        '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
      )
      if (!file.startsWith(root + sep)) return new Response('Forbidden', { status: 403 })
      return net.fetch(pathToFileURL(file).toString())
    } catch {
      return new Response('Invalid path', { status: 400 })
    }
  })
  uiSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(
      permission === 'fullscreen' &&
        contents === mainWindow?.webContents &&
        'isMainFrame' in details &&
        details.isMainFrame &&
        isUiUrl(details.requestingUrl)
    )
  })
  uiSession.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      permission === 'fullscreen' &&
      contents === mainWindow?.webContents &&
      details.isMainFrame &&
      isUiUrl(details.requestingUrl ?? contents.getURL())
  )
  uiSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (['image', 'media'].includes(details.resourceType) && safeMediaUrl(details.url))
      details.requestHeaders.Referer = 'https://www.douyin.com/'
    callback({ requestHeaders: details.requestHeaders })
  })
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 920,
    minHeight: 640,
    ...(remembered
      ? { x: remembered.x, y: remembered.y, width: remembered.width, height: remembered.height }
      : {}),
    show: false,
    title: 'MyLike',
    icon: join(app.getAppPath(), 'assets/icon.png'),
    backgroundColor: '#0d1018',
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#0d1018', symbolColor: '#c7cad3', height: 30 }
        }
      : {}),
    webPreferences: {
      session: uiSession,
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const win = mainWindow
  win.webContents.setZoomFactor(preferences.zoom)
  if (remembered?.maximized) win.maximize()
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    if (service?.favoriteSyncRunning) {
      void promptWritebackClose(win)
      return
    }
    app.quit()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.on('closed', () => {
    mainWindow = null
  })
  service = new Application(db, new DouyinEngine(changed, () => mainWindow), changed, () => mainWindow)
  ipcMain.handle(CHANNEL, async (event, command: unknown, input: unknown) => {
    try {
      const frameUrl = event.senderFrame?.url
      const trusted = frameUrl && isUiUrl(frameUrl)
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !trusted)
        throw new AppError('FORBIDDEN', '此页面无权调用应用能力。')
      if (typeof command !== 'string' || !Object.hasOwn(commands, command))
        throw new AppError('INVALID_COMMAND', '不支持的操作。')
      const parsed = commands[command as Command].safeParse(input)
      if (!parsed.success) throw new AppError('INVALID_INPUT', '操作参数无效。')
      return { ok: true, data: await service!.execute(command as Command, parsed.data) }
    } catch (error) {
      return { ok: false, error: publicError(error) }
    }
  })
  mkdirSync(app.getPath('userData'), { recursive: true })
  await service.applyAppearance()
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)
    await win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await win.loadURL('mylike://ui/index.html')
  if (process.env.MYLIKE_HEADLESS !== '1') win.show()
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    // Relaunching the app while a background writeback is running restores the
    // window instead of leaving the user with an invisible process.
    backgroundRestored = true
    mainWindow?.show()
    mainWindow?.focus()
  })
  void app
    .whenReady()
    .then(() => {
      mkdirSync(app.getPath('userData'), { recursive: true })
      return bootstrap()
    })
    .catch((error) => {
      if (process.env.MYLIKE_HEADLESS !== '1')
        dialog.showErrorBox(
          'MyLike 未能启动',
          '无法加载应用资源或数据库。原数据未重置，请检查文件权限、磁盘与版本。'
        )
      console.error(
        '[MyLike] Startup failed; user data was not reset.',
        error instanceof Error ? error.message : 'unknown error'
      )
      app.exit(1)
    })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void flushRenderer()
      .then(() => service?.close())
      .catch(() => console.error('[MyLike] Shutdown persistence failure.'))
      .finally(() => app.quit())
  })
}

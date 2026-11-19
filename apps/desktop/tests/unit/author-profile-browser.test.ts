import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  partition: {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    on: vi.fn()
  },
  webContents: {
    setWindowOpenHandler: vi.fn(),
    on: vi.fn()
  },
  createdOptions: [] as { webPreferences?: { session?: unknown } }[],
  loadURL: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  on: vi.fn(),
  isDestroyed: vi.fn(),
  destroy: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = mocks.webContents
    loadURL = mocks.loadURL
    show = mocks.show
    focus = mocks.focus
    on = mocks.on
    isDestroyed = mocks.isDestroyed
    destroy = mocks.destroy

    constructor(options: { webPreferences?: { session?: unknown } }) {
      mocks.createdOptions.push(options)
    }
  },
  session: { fromPartition: mocks.fromPartition }
}))

import { DouyinEngine } from '../../src/main/douyin/engine'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createdOptions.length = 0
  mocks.fromPartition.mockReturnValue(mocks.partition)
  mocks.loadURL.mockResolvedValue(undefined)
  mocks.isDestroyed.mockReturnValue(false)
})

it('opens an author profile in the current account browser session', async () => {
  const engine = new DouyinEngine(
    () => {},
    () => null
  )

  await engine.openAuthorProfile('account-a', 'author_123')

  expect(mocks.fromPartition).toHaveBeenCalledWith('persist:mylike-account-a')
  expect(mocks.createdOptions[0]?.webPreferences?.session).toBe(mocks.partition)
  expect(mocks.loadURL).toHaveBeenCalledWith('https://www.douyin.com/user/author_123')
  expect(mocks.show).toHaveBeenCalledOnce()
})

it('reuses and focuses the same window for repeated author clicks', async () => {
  const engine = new DouyinEngine(
    () => {},
    () => null
  )

  await engine.openAuthorProfile('account-a', 'author_123')
  await engine.openAuthorProfile('account-a', 'author_123')

  expect(mocks.createdOptions).toHaveLength(1)
  expect(mocks.loadURL).toHaveBeenCalledOnce()
  expect(mocks.show).toHaveBeenCalledTimes(2)
  expect(mocks.focus).toHaveBeenCalledOnce()
})

it('navigates to another author in the existing window', async () => {
  const engine = new DouyinEngine(
    () => {},
    () => null
  )

  await engine.openAuthorProfile('account-a', 'author_123')
  await engine.openAuthorProfile('account-a', 'author_456')

  expect(mocks.createdOptions).toHaveLength(1)
  expect(mocks.loadURL).toHaveBeenNthCalledWith(2, 'https://www.douyin.com/user/author_456')
})

it('keeps the newer navigation when an earlier load is cancelled', async () => {
  let rejectFirstLoad!: (error: Error) => void
  mocks.loadURL.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectFirstLoad = reject
      })
  )
  const engine = new DouyinEngine(
    () => {},
    () => null
  )

  const firstOpen = engine.openAuthorProfile('account-a', 'author_123')
  await engine.openAuthorProfile('account-a', 'author_456')
  rejectFirstLoad(new Error('ERR_ABORTED'))

  await expect(firstOpen).resolves.toBeUndefined()
  expect(mocks.createdOptions).toHaveLength(1)
  expect(mocks.destroy).not.toHaveBeenCalled()
})

it('destroys a failed author window and reports a clear error', async () => {
  mocks.loadURL.mockRejectedValue(new Error('network unavailable'))
  const engine = new DouyinEngine(
    () => {},
    () => null
  )

  await expect(engine.openAuthorProfile('account-a', 'author_123')).rejects.toMatchObject({
    code: 'OPEN_BROWSER_FAILED'
  })
  expect(mocks.destroy).toHaveBeenCalledOnce()
  expect(mocks.show).not.toHaveBeenCalled()
})

it('rejects invalid author ids before creating a browser window', async () => {
  const engine = new DouyinEngine(
    () => {},
    () => null
  )

  await expect(engine.openAuthorProfile('account-a', 'bad/id')).rejects.toMatchObject({
    code: 'INVALID_INPUT'
  })
  expect(mocks.fromPartition).not.toHaveBeenCalled()
})

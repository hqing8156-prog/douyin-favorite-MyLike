import { useEffect, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import type { DataInfo, Snapshot } from '../../shared/contracts'
import { call, type Perform } from './api'
import { formatBytes as size } from './format'

function formatMaintenanceFailureReasons(failureReasons: { reason: string; count: number }[]): string {
  return failureReasons.map(({ reason, count }) => `${reason} ${count} 条`).join('；') || '无'
}

export function DataPanel({
  accountId,
  perform,
  coverRefresh,
  durationRefresh,
  authorIdRefresh,
  coverCachePath,
  updateCoverCachePath
}: {
  accountId: string | null
  perform: Perform
  coverRefresh: Snapshot['coverRefresh']
  durationRefresh: Snapshot['durationRefresh']
  authorIdRefresh: Snapshot['authorIdRefresh']
  coverCachePath: string
  updateCoverCachePath: (path: string) => void
}) {
  const [info, setInfo] = useState<DataInfo | null>(null),
    [error, setError] = useState(''),
    [fetchingCovers, setFetchingCovers] = useState(false),
    [stoppingCovers, setStoppingCovers] = useState(false),
    [coverFetchResult, setCoverFetchResult] = useState(''),
    [coverFetchError, setCoverFetchError] = useState(''),
    [syncingDurations, setSyncingDurations] = useState(false),
    [stoppingDurationSync, setStoppingDurationSync] = useState(false),
    [durationSyncResult, setDurationSyncResult] = useState(''),
    [durationSyncError, setDurationSyncError] = useState(''),
    [syncingAuthorIds, setSyncingAuthorIds] = useState(false),
    [stoppingAuthorIdSync, setStoppingAuthorIdSync] = useState(false),
    [resettingAuthorIds, setResettingAuthorIds] = useState(false),
    [authorIdSyncResult, setAuthorIdSyncResult] = useState(''),
    [authorIdSyncError, setAuthorIdSyncError] = useState('')
  const sequence = useRef(0)
  const refresh = async () => {
    const current = ++sequence.current
    try {
      const next = await call(window.mylike.invoke('dataInfo', { accountId }))
      if (current === sequence.current) {
        setInfo(next)
        setError('')
      }
    } catch (e) {
      if (current === sequence.current) setError(e instanceof Error ? e.message : '数据占用读取失败。')
    }
  }
  useEffect(() => {
    setInfo(null)
    void refresh()
    return () => {
      sequence.current++
    }
  }, [accountId])
  return (
    <section className="panel">
      <h2>数据与备份</h2>
      {info && (
        <dl className="diagnostics">
          <dt>数据目录</dt>
          <dd className="data-path">{info.folder}</dd>
          <dt>元数据文件</dt>
          <dd>{size(info.metadataBytes)}</dd>
          <dt>数据库备份</dt>
          <dd>
            {info.backupsCount} 份 · {size(info.backupsBytes)}
          </dd>
        </dl>
      )}
      {error && (
        <p role="alert" className="task-error">
          {error}
        </p>
      )}
      <div className="panel-actions">
        <button
          onClick={() =>
            void perform('打开数据目录', () =>
              call(window.mylike.invoke('openDataFolder', { target: 'data' }))
            )
          }
        >
          打开数据目录
        </button>
        <button
          onClick={() =>
            void perform('打开备份目录', () =>
              call(window.mylike.invoke('openDataFolder', { target: 'backups' }))
            )
          }
        >
          打开备份目录
        </button>
        <button onClick={() => void refresh()}>刷新占用</button>
      </div>
      <h2>封面缓存</h2>
      <p className="settings-description">
        收藏夹与差异核对中的封面会按需下载到本机，避免云端地址失效后裂图。留空时使用应用数据目录下的 covers
        文件夹。
      </p>
      <dl className="diagnostics cover-cache-location">
        <dt>缓存目录</dt>
        <dd className="data-path cover-cache-location-value">
          <span>{coverCachePath || '默认：应用数据目录\\covers'}</span>
          <div className="cover-cache-actions">
            <button
              onClick={() =>
                void perform('选择封面缓存目录', async () => {
                  const path = await call(window.mylike.invoke('pickCoverCacheDirectory', {}))
                  if (path) updateCoverCachePath(path)
                })
              }
            >
              选择缓存目录
            </button>
            {coverCachePath ? <button onClick={() => updateCoverCachePath('')}>恢复默认目录</button> : null}
          </div>
        </dd>
      </dl>
      <section className="data-maintenance">
        <div className="data-maintenance-main">
          <div className="data-maintenance-copy">
            <h3>补齐缺失封面</h3>
            <p className="settings-description">
              仅处理成功采集且缺少封面的作品，逐条读取作品详情，约每秒请求一次；需保持抖音登录，遇到验证或限制会保留进度。
            </p>
          </div>
          <div className="panel-actions">
            <button
              className="icon-button"
              title="用记事本打开封面获取日志"
              aria-label="用记事本打开封面获取日志"
              onClick={() =>
                void perform('打开封面获取日志', () =>
                  call(window.mylike.invoke('openLogFile', { name: 'cover-refresh' }))
                )
              }
            >
              <FileText size={16} />
            </button>
            <button
              disabled={
                !accountId ||
                fetchingCovers ||
                coverRefresh?.status === 'running' ||
                syncingDurations ||
                durationRefresh?.status === 'running' ||
                syncingAuthorIds ||
                authorIdRefresh?.status === 'running'
              }
              onClick={() => {
                if (!accountId || fetchingCovers) return
                setFetchingCovers(true)
                setCoverFetchResult('')
                setCoverFetchError('')
                void call(window.mylike.invoke('fetchMissingCovers', { accountId }))
                  .then((result) => {
                    setCoverFetchResult(
                      result.deferred + result.failed === 0
                        ? '没有尚未补齐封面的成功采集作品。'
                        : `${result.stopped ? '已手动停止；' : result.needsVerification ? '抖音要求登录或验证；' : result.deferred ? '抖音暂时限制详情读取；' : ''}当前还有 ${result.deferred + result.failed} 条成功采集的作品未补齐封面，其中 ${result.deferred} 条待处理，${result.failed} 条失败（${formatMaintenanceFailureReasons(result.failureReasons)}）。`
                    )
                  })
                  .catch((cause) =>
                    setCoverFetchError(cause instanceof Error ? cause.message : '获取封面未完成。')
                  )
                  .finally(() => setFetchingCovers(false))
              }}
            >
              {fetchingCovers || coverRefresh?.status === 'running'
                ? '正在获取缩略图…'
                : coverRefresh?.status === 'paused'
                  ? '继续获取缺失封面'
                  : '获取缺失封面'}
            </button>
            {(fetchingCovers || coverRefresh?.status === 'running') && (
              <button
                disabled={!accountId || stoppingCovers}
                onClick={() => {
                  if (!accountId || stoppingCovers) return
                  setStoppingCovers(true)
                  setCoverFetchError('')
                  void call(window.mylike.invoke('stopMissingCovers', { accountId }))
                    .catch((cause) =>
                      setCoverFetchError(cause instanceof Error ? cause.message : '停止封面获取失败。')
                    )
                    .finally(() => setStoppingCovers(false))
                }}
              >
                {stoppingCovers ? '正在停止…' : '停止获取'}
              </button>
            )}
          </div>
        </div>
        {(coverRefresh || coverFetchResult) && (
          <p className="settings-description" role="status">
            {coverRefresh?.status === 'running'
              ? `当前还有 ${Math.max(0, coverRefresh.total - coverRefresh.current) + coverRefresh.failed} 条成功采集的作品未补齐封面，其中 ${coverRefresh.failed} 条因详情读取失败。`
              : coverFetchResult ||
                (coverRefresh?.pauseReason === 'verification'
                  ? `抖音要求登录或验证；当前还有 ${Math.max(0, coverRefresh.total - coverRefresh.current) + coverRefresh.failed} 条成功采集的作品未补齐封面，其中 ${coverRefresh.failed} 条因详情读取失败。`
                  : coverRefresh?.status === 'paused'
                    ? coverRefresh.pauseReason === 'manual'
                      ? `已手动停止；当前还有 ${Math.max(0, coverRefresh.total - coverRefresh.current) + coverRefresh.failed} 条成功采集的作品未补齐封面，其中 ${coverRefresh.failed} 条因详情读取失败。`
                      : coverRefresh.pauseReason === 'interrupted'
                        ? `应用上次关闭后任务已暂停；当前还有 ${Math.max(0, coverRefresh.total - coverRefresh.current) + coverRefresh.failed} 条成功采集的作品未补齐封面，其中 ${coverRefresh.failed} 条因详情读取失败。`
                        : `抖音暂时限制详情读取；当前还有 ${Math.max(0, coverRefresh.total - coverRefresh.current) + coverRefresh.failed} 条成功采集的作品未补齐封面，其中 ${coverRefresh.failed} 条因详情读取失败。`
                    : null)}
          </p>
        )}
        {coverFetchError && (
          <p className="task-error" role="alert">
            {coverFetchError}
          </p>
        )}
      </section>
      <section className="data-maintenance">
        <div className="data-maintenance-main">
          <div className="data-maintenance-copy">
            <h3>同步视频时长</h3>
            <p className="settings-description">
              仅处理成功采集且缺少时长的视频（不含图集和文字），约每秒读取一条详情；遇到验证、限制或手动停止会保留进度。
            </p>
          </div>
          <div className="panel-actions">
            <button
              className="icon-button"
              title="用记事本打开时长同步日志"
              aria-label="用记事本打开时长同步日志"
              onClick={() =>
                void perform('打开时长同步日志', () =>
                  call(window.mylike.invoke('openLogFile', { name: 'duration-refresh' }))
                )
              }
            >
              <FileText size={16} />
            </button>
            <button
              disabled={
                !accountId ||
                syncingDurations ||
                durationRefresh?.status === 'running' ||
                coverRefresh?.status === 'running' ||
                syncingAuthorIds ||
                authorIdRefresh?.status === 'running'
              }
              onClick={() => {
                if (!accountId || syncingDurations) return
                setSyncingDurations(true)
                setDurationSyncResult('')
                setDurationSyncError('')
                void call(window.mylike.invoke('syncVideoDurations', { accountId }))
                  .then((result) => {
                    setDurationSyncResult(
                      result.deferred + result.failed === 0
                        ? '没有尚未同步时长的成功采集视频。'
                        : `${result.stopped ? '已手动停止；' : result.needsVerification ? '抖音要求登录或验证；' : result.deferred ? '抖音暂时限制详情读取；' : ''}当前还有 ${result.deferred + result.failed} 条成功采集的视频未同步时长，其中 ${result.deferred} 条待处理，${result.failed} 条失败（${formatMaintenanceFailureReasons(result.failureReasons)}）。`
                    )
                  })
                  .catch((cause) =>
                    setDurationSyncError(cause instanceof Error ? cause.message : '视频时长同步未完成。')
                  )
                  .finally(() => setSyncingDurations(false))
              }}
            >
              {syncingDurations || durationRefresh?.status === 'running'
                ? '正在同步视频时长…'
                : durationRefresh
                  ? '继续同步视频时长'
                  : '同步视频时长'}
            </button>
            {(syncingDurations || durationRefresh?.status === 'running') && (
              <button
                disabled={!accountId || stoppingDurationSync}
                onClick={() => {
                  if (!accountId || stoppingDurationSync) return
                  setStoppingDurationSync(true)
                  setDurationSyncError('')
                  void call(window.mylike.invoke('stopVideoDurationSync', { accountId }))
                    .catch((cause) =>
                      setDurationSyncError(cause instanceof Error ? cause.message : '停止视频时长同步失败。')
                    )
                    .finally(() => setStoppingDurationSync(false))
                }}
              >
                {stoppingDurationSync ? '正在停止…' : '停止同步'}
              </button>
            )}
          </div>
        </div>
        {(syncingDurations || durationRefresh || durationSyncResult) && (
          <p className="settings-description" role="status">
            {durationRefresh?.status === 'running'
              ? `当前还有 ${Math.max(0, durationRefresh.total - durationRefresh.current) + durationRefresh.failed} 条成功采集的视频未同步时长，其中 ${durationRefresh.failed} 条因详情读取失败。${durationRefresh.stopping ? '正在停止。' : ''}`
              : durationSyncResult ||
                (durationRefresh
                  ? durationRefresh.pauseReason === 'verification'
                    ? `抖音要求登录或验证；当前还有 ${Math.max(0, durationRefresh.total - durationRefresh.current) + durationRefresh.failed} 条成功采集的视频未同步时长，其中 ${durationRefresh.failed} 条因详情读取失败。`
                    : durationRefresh.pauseReason === 'limited'
                      ? `抖音暂时限制详情读取；当前还有 ${Math.max(0, durationRefresh.total - durationRefresh.current) + durationRefresh.failed} 条成功采集的视频未同步时长，其中 ${durationRefresh.failed} 条因详情读取失败。`
                      : durationRefresh.pauseReason === 'manual'
                        ? `已手动停止；当前还有 ${Math.max(0, durationRefresh.total - durationRefresh.current) + durationRefresh.failed} 条成功采集的视频未同步时长，其中 ${durationRefresh.failed} 条因详情读取失败。`
                        : `应用中断，任务已暂停；当前还有 ${Math.max(0, durationRefresh.total - durationRefresh.current) + durationRefresh.failed} 条成功采集的视频未同步时长，其中 ${durationRefresh.failed} 条因详情读取失败。`
                  : '正在准备同步任务…')}
          </p>
        )}
        {durationSyncError && (
          <p className="task-error" role="alert">
            {durationSyncError}
          </p>
        )}
      </section>
      <section className="data-maintenance">
        <div className="data-maintenance-main">
          <div className="data-maintenance-copy">
            <h3>补全缺失作者 ID</h3>
            <p className="settings-description">
              扫描当前账号喜欢与收藏中作者 ID 缺失或无效、以及缺少封面或时长的作品，
              逐条读取详情，顺带补齐作者 ID、封面、视频时长和主页链接；遇到验证、限制或手动停止会保留进度。
            </p>
          </div>
          <div className="panel-actions">
            <button
              disabled={
                !accountId ||
                syncingAuthorIds ||
                authorIdRefresh?.status === 'running' ||
                coverRefresh?.status === 'running' ||
                durationRefresh?.status === 'running'
              }
              onClick={() => {
                if (!accountId || syncingAuthorIds) return
                setSyncingAuthorIds(true)
                setAuthorIdSyncResult('')
                setAuthorIdSyncError('')
                void call(window.mylike.invoke('syncMissingAuthorIds', { accountId }))
                  .then((result) => {
                    setAuthorIdSyncResult(
                      result.deferred + result.failed === 0
                        ? '没有需要补全详情的成功采集作品。'
                        : `${result.stopped ? '已手动停止；' : result.needsVerification ? '抖音要求登录或验证；' : result.deferred ? '抖音暂时限制详情读取；' : ''}当前还有 ${result.deferred + result.failed} 条成功采集的作品未补全详情，其中 ${result.deferred} 条待处理，${result.failed} 条失败（${formatMaintenanceFailureReasons(result.failureReasons)}）。`
                    )
                  })
                  .catch((cause) =>
                    setAuthorIdSyncError(cause instanceof Error ? cause.message : '作者 ID 补全未完成。')
                  )
                  .finally(() => setSyncingAuthorIds(false))
              }}
            >
              {syncingAuthorIds || authorIdRefresh?.status === 'running'
                ? '正在补全作者 ID…'
                : authorIdRefresh
                  ? '继续补全缺失作者 ID'
                  : '补全缺失作者 ID'}
            </button>
            {(syncingAuthorIds || authorIdRefresh?.status === 'running') && (
              <button
                disabled={!accountId || stoppingAuthorIdSync}
                onClick={() => {
                  if (!accountId || stoppingAuthorIdSync) return
                  setStoppingAuthorIdSync(true)
                  setAuthorIdSyncError('')
                  void call(window.mylike.invoke('stopMissingAuthorIds', { accountId }))
                    .catch((cause) =>
                      setAuthorIdSyncError(cause instanceof Error ? cause.message : '停止作者 ID 补全失败。')
                    )
                    .finally(() => setStoppingAuthorIdSync(false))
                }}
              >
                {stoppingAuthorIdSync ? '正在停止…' : '停止补全'}
              </button>
            )}
            {authorIdRefresh && authorIdRefresh.status !== 'running' && (
              <button
                disabled={!accountId || resettingAuthorIds || syncingAuthorIds}
                title="清除当前暂停的补全断点，下次点击会按当前缺失情况重新统计"
                onClick={() => {
                  if (!accountId || resettingAuthorIds) return
                  setResettingAuthorIds(true)
                  setAuthorIdSyncResult('')
                  setAuthorIdSyncError('')
                  void call(window.mylike.invoke('resetMissingAuthorIds', { accountId }))
                    .then(() => setAuthorIdSyncResult('已清除补全断点，下次点击会重新统计缺失作品。'))
                    .catch((cause) =>
                      setAuthorIdSyncError(cause instanceof Error ? cause.message : '清除补全断点失败。')
                    )
                    .finally(() => setResettingAuthorIds(false))
                }}
              >
                {resettingAuthorIds ? '正在清除…' : '重置断点'}
              </button>
            )}
          </div>
        </div>
        {(syncingAuthorIds || authorIdRefresh || authorIdSyncResult) && (
          <p className="settings-description" role="status">
            {authorIdRefresh
              ? authorIdRefresh.status === 'running'
                ? `当前还有 ${Math.max(0, authorIdRefresh.total - authorIdRefresh.current) + authorIdRefresh.failed} 条成功采集的作品未补全详情，其中 ${authorIdRefresh.failed} 条因详情读取失败。${authorIdRefresh.stopping ? '正在停止。' : ''}`
                : authorIdRefresh.pauseReason === 'verification'
                  ? `抖音要求登录或验证；当前还有 ${Math.max(0, authorIdRefresh.total - authorIdRefresh.current) + authorIdRefresh.failed} 条成功采集的作品未补全详情，其中 ${authorIdRefresh.failed} 条因详情读取失败。`
                  : authorIdRefresh.pauseReason === 'limited'
                    ? `抖音暂时限制详情读取；当前还有 ${Math.max(0, authorIdRefresh.total - authorIdRefresh.current) + authorIdRefresh.failed} 条成功采集的作品未补全详情，其中 ${authorIdRefresh.failed} 条因详情读取失败。`
                    : authorIdRefresh.pauseReason === 'manual'
                      ? `已手动停止；当前还有 ${Math.max(0, authorIdRefresh.total - authorIdRefresh.current) + authorIdRefresh.failed} 条成功采集的作品未补全详情，其中 ${authorIdRefresh.failed} 条因详情读取失败。`
                      : `应用中断，任务已暂停；当前还有 ${Math.max(0, authorIdRefresh.total - authorIdRefresh.current) + authorIdRefresh.failed} 条成功采集的作品未补全详情，其中 ${authorIdRefresh.failed} 条因详情读取失败。`
              : authorIdSyncResult || '正在准备作者 ID 补全任务…'}
          </p>
        )}
        {authorIdSyncError && (
          <p className="task-error" role="alert">
            {authorIdSyncError}
          </p>
        )}
      </section>
    </section>
  )
}

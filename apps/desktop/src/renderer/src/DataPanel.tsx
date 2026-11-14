import { useEffect, useRef, useState } from 'react'
import type { DataInfo } from '../../shared/contracts'
import { call, type Perform } from './api'
import { formatBytes as size } from './format'

export function DataPanel({
  accountId,
  perform,
  coverCachePath,
  updateCoverCachePath
}: {
  accountId: string | null
  perform: Perform
  coverCachePath: string
  updateCoverCachePath: (path: string) => void
}) {
  const [info, setInfo] = useState<DataInfo | null>(null),
    [error, setError] = useState('')
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
      <dl className="diagnostics">
        <dt>缓存目录</dt>
        <dd className="data-path">{coverCachePath || '默认：应用数据目录\\covers'}</dd>
      </dl>
      <div className="panel-actions">
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
    </section>
  )
}

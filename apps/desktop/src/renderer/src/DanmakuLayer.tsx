import { useEffect, useRef, useState, type RefObject } from 'react'
import type { DanmakuItem } from '../../shared/contracts'

type Box = { left: number; top: number; width: number; height: number }
type Placed = {
  text: string
  color: string | null
  start: number
  width: number
  lane: number
  pxPerSec: number
}
type Props = {
  video: RefObject<HTMLVideoElement | null>
  items: DanmakuItem[]
  opacity: number
  size: 'small' | 'medium' | 'large'
  speed: number
  region: 'quarter' | 'half' | 'full'
  rotation: number
}
const BASE_CROSS_SECONDS = 8
const fontFor = (size: number) => `700 ${size}px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`

/**
 * Canvas danmaku overlay. Position is a pure function of the layer's own
 * item list and the video clock, so pausing, seeking, rate changes and window
 * changes stay in sync without per-item animation state.
 */
export function DanmakuLayer({ video, items, opacity, size, speed, region, rotation }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const placed = useRef<Placed[]>([])
  const geometry = useRef({ width: 0, height: 0, fontSize: 16, lineHeight: 22 })
  const [rect, setRect] = useState<Box | null>(null)

  useEffect(() => {
    const stage = canvas.current?.parentElement
    const node = video.current
    if (!stage || !node) return
    const measure = () => {
      const box = node.getBoundingClientRect()
      const stageBox = stage.getBoundingClientRect()
      const width = node.videoWidth,
        height = node.videoHeight
      if (!width || !height || !box.width || !box.height) {
        setRect((current) => (current === null ? current : null))
        return
      }
      const scale = Math.min(box.width / width, box.height / height)
      const content: Box = {
        left: box.left - stageBox.left + (box.width - width * scale) / 2,
        top: box.top - stageBox.top + (box.height - height * scale) / 2,
        width: width * scale,
        height: height * scale
      }
      // Portrait videos leave wide side bars. The web player runs danmaku across
      // the whole player width there instead of squeezing them into the video
      // column, which would force a large font and many crowded lanes.
      const next: Box =
        content.width >= stageBox.width * 0.72 ? content : { ...content, left: 0, width: stageBox.width }
      setRect((current) =>
        current &&
        Math.abs(current.left - next.left) < 0.5 &&
        Math.abs(current.top - next.top) < 0.5 &&
        Math.abs(current.width - next.width) < 0.5 &&
        Math.abs(current.height - next.height) < 0.5
          ? current
          : next
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    observer.observe(stage)
    node.addEventListener('loadedmetadata', measure)
    node.addEventListener('loadeddata', measure)
    window.addEventListener('resize', measure)
    const timer = setInterval(measure, 1000)
    return () => {
      observer.disconnect()
      node.removeEventListener('loadedmetadata', measure)
      node.removeEventListener('loadeddata', measure)
      window.removeEventListener('resize', measure)
      clearInterval(timer)
    }
  }, [video])

  useEffect(() => {
    const node = canvas.current
    if (!node || !rect) return
    const ratio = Math.min(2, window.devicePixelRatio || 1)
    node.width = Math.max(1, Math.round(rect.width * ratio))
    node.height = Math.max(1, Math.round(rect.height * ratio))
    node.style.left = `${rect.left}px`
    node.style.top = `${rect.top}px`
    node.style.width = `${rect.width}px`
    node.style.height = `${rect.height}px`
  }, [rect])

  useEffect(() => {
    const node = canvas.current
    if (!node || !rect || rotation !== 0) {
      placed.current = []
      return
    }
    const context = node.getContext('2d')
    if (!context) return
    // Scale from the layer width, not its height: a tall portrait video would
    // otherwise produce oversized text once it fills the stage vertically.
    const factor = size === 'small' ? 0.013 : size === 'large' ? 0.021 : 0.0165
    const fontSize = Math.max(12, Math.min(28, Math.round(rect.width * factor)))
    const lineHeight = Math.round(fontSize * 1.35)
    const regionFactor = region === 'quarter' ? 0.28 : region === 'full' ? 0.92 : 0.54
    const laneLimit = region === 'quarter' ? 3 : region === 'half' ? 4 : 16
    const laneCount = Math.max(1, Math.min(laneLimit, Math.floor((rect.height * regionFactor) / lineHeight)))
    context.font = fontFor(fontSize)
    const freeAt = new Array<number>(laneCount).fill(Number.NEGATIVE_INFINITY)
    // Constant pixel speed keeps long and short comments moving together.
    const pxPerSec = (rect.width / BASE_CROSS_SECONDS) * Math.max(0.25, speed)
    const next: Placed[] = []
    for (const item of [...items].sort((a, b) => a.timeMs - b.timeMs)) {
      const textWidth = context.measureText(item.text).width + fontSize
      const start = item.timeMs / 1000
      let lane = -1
      for (let index = 0; index < laneCount; index++) {
        if (freeAt[index]! <= start) {
          lane = index
          break
        }
      }
      // The web player drops what does not fit rather than piling comments on
      // top of each other across the whole video.
      if (lane < 0) continue
      freeAt[lane] = start + (rect.width + textWidth) / pxPerSec + 0.12
      next.push({
        text: item.text,
        color: item.color,
        start,
        width: textWidth,
        lane,
        pxPerSec
      })
    }
    placed.current = next
    geometry.current = { width: rect.width, height: rect.height, fontSize, lineHeight }
  }, [rect, items, size, speed, region, rotation])

  useEffect(() => {
    let frame = 0
    const draw = () => {
      frame = requestAnimationFrame(draw)
      const node = canvas.current
      if (!node) return
      const context = node.getContext('2d')
      if (!context) return
      const ratio = Math.min(2, window.devicePixelRatio || 1)
      const { width, height, fontSize, lineHeight } = geometry.current
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)
      if (rotation !== 0) return
      const seconds = video.current?.currentTime
      if (seconds == null || !Number.isFinite(seconds)) return
      context.globalAlpha = opacity
      context.textBaseline = 'middle'
      context.lineJoin = 'round'
      context.font = fontFor(fontSize)
      context.lineWidth = Math.max(1.5, fontSize / 14)
      context.strokeStyle = 'rgba(0, 0, 0, 0.72)'
      for (const item of placed.current) {
        const elapsed = seconds - item.start
        if (elapsed < 0) continue
        const x = width - elapsed * item.pxPerSec
        if (x + item.width < 0) continue
        const y = (item.lane + 0.5) * lineHeight + 1
        context.strokeText(item.text, x, y)
        context.fillStyle = item.color ?? '#ffffff'
        context.fillText(item.text, x, y)
      }
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [video, opacity, rotation])

  return <canvas ref={canvas} className="danmaku-layer" aria-hidden="true" />
}

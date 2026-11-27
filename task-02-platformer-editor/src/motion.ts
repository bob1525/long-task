import type { Point } from './schema'

export const PLATFORM_THICKNESS = 10

export interface Pose {
  x: number
  y: number
  w: number
  h: number
}

/** Snap a drawn waypoint onto a horizontal or vertical segment from the previous point. */
export function snapAxisPoint(previous: Point, x: number, y: number): Point {
  if (x === previous.x || y === previous.y) return { x, y }
  if (Math.abs(x - previous.x) >= Math.abs(y - previous.y)) return { x, y: previous.y }
  return { x: previous.x, y }
}

export function segmentLength(points: readonly Point[]): number {
  let length = 0
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!
    const b = points[i]!
    length += Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
  }
  return length
}

export function pointAlong(points: readonly Point[], distance: number): Point {
  const first = points[0]
  if (!first) return { x: 0, y: 0 }
  let left = Math.max(0, distance)
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!
    const b = points[i]!
    const span = Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
    if (left <= span || i === points.length - 1) {
      const t = span === 0 ? 0 : Math.min(1, left / span)
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
    left -= span
  }
  return { x: first.x, y: first.y }
}

/** Ping-pong distance along a polyline. A zero-length path stays on the first point. */
export function pingPongPoint(points: readonly Point[], speed: number, time: number): Point {
  const first = points[0]
  if (!first) return { x: 0, y: 0 }
  const length = segmentLength(points)
  if (length < 1e-6 || speed <= 0 || time <= 0) return { x: first.x, y: first.y }
  const cycle = length * 2
  const phase = (time * speed) % cycle
  const distance = phase <= length ? phase : cycle - phase
  return pointAlong(points, distance)
}

export function platformPose(pathTiles: readonly Point[], widthTiles: number, tileSize: number, speed: number, time: number): Pose {
  const pixels = pathTiles.map((point) => ({ x: point.x * tileSize, y: point.y * tileSize }))
  const point = pingPongPoint(pixels, speed, time)
  return {
    x: point.x,
    y: point.y,
    w: Math.max(1, widthTiles) * tileSize,
    h: PLATFORM_THICKNESS,
  }
}

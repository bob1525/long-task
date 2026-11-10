import type { Tile, TileType } from './schema'

export const FIXED_DT = 1 / 120
export const MAX_FRAME_DT = 0.05
export const MAX_STEPS_PER_FRAME = 6
export const PLAYER_W = 18
export const PLAYER_H = 28
export const ENEMY_W = 24
export const ENEMY_H = 24

export const COYOTE_TIME = 0.1
export const JUMP_BUFFER = 0.12
export const GROUND_ACCEL = 5200
export const AIR_ACCEL = 3400
export const FALL_GRAVITY_MULTIPLIER = 1.25
export const RELEASE_GRAVITY_MULTIPLIER = 2.6
export const MAX_FALL_SPEED = 1500

const SKIN = 0.02
const SIDE_INSET = 0.3
const ONE_WAY_SLOP = 0.75

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Body extends Rect {
  vx: number
  vy: number
}

export interface TileWorld {
  tileSize: number
  width: number
  height: number
  tiles: readonly Tile[]
}

export class TileIndex {
  readonly tileSize: number
  readonly width: number
  readonly height: number
  readonly pixelWidth: number
  readonly pixelHeight: number
  private readonly map = new Map<string, TileType>()

  constructor(world: TileWorld) {
    this.tileSize = world.tileSize
    this.width = world.width
    this.height = world.height
    this.pixelWidth = world.width * world.tileSize
    this.pixelHeight = world.height * world.tileSize
    for (const tile of world.tiles) {
      this.map.set(`${tile.x},${tile.y}`, tile.type)
    }
  }

  get(tx: number, ty: number): TileType | undefined {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return undefined
    return this.map.get(`${tx},${ty}`)
  }
}

export interface MoveResult {
  onGround: boolean
  hitCeiling: boolean
  hitWall: boolean
  hazard: boolean
}

export function overlaps(a: Rect, b: Rect, eps = 0.05): boolean {
  return a.x + a.w > b.x + eps && b.x + b.w > a.x + eps && a.y + a.h > b.y + eps && b.y + b.h > a.y + eps
}

export function sweptRect(x0: number, y0: number, x1: number, y1: number, w: number, h: number): Rect {
  const x = Math.min(x0, x1)
  const y = Math.min(y0, y1)
  return { x, y, w: Math.abs(x1 - x0) + w, h: Math.abs(y1 - y0) + h }
}

function forTilesIn(rect: Rect, world: TileIndex, visit: (tx: number, ty: number, type: TileType) => void): void {
  const ts = world.tileSize
  const minX = Math.floor(rect.x / ts)
  const maxX = Math.floor((rect.x + rect.w - 1e-4) / ts)
  const minY = Math.floor(rect.y / ts)
  const maxY = Math.floor((rect.y + rect.h - 1e-4) / ts)
  for (let ty = minY; ty <= maxY; ty += 1) {
    for (let tx = minX; tx <= maxX; tx += 1) {
      const type = world.get(tx, ty)
      if (type) visit(tx, ty, type)
    }
  }
}

export function overlapsSolid(rect: Rect, world: TileIndex): boolean {
  const probe = { x: rect.x + 0.05, y: rect.y + 0.05, w: Math.max(0, rect.w - 0.1), h: Math.max(0, rect.h - 0.1) }
  let hit = false
  forTilesIn(probe, world, (tx, ty, type) => {
    if (type !== 'solid' || hit) return
    const tile = { x: tx * world.tileSize, y: ty * world.tileSize, w: world.tileSize, h: world.tileSize }
    if (overlaps(probe, tile, 0)) hit = true
  })
  return hit
}

export function rectHitsHazard(rect: Rect, world: TileIndex): boolean {
  const probe = { x: rect.x + 0.2, y: rect.y + 0.2, w: Math.max(0, rect.w - 0.4), h: Math.max(0, rect.h - 0.4) }
  let hit = false
  forTilesIn(probe, world, (tx, ty, type) => {
    if (type !== 'hazard' || hit) return
    const tile = { x: tx * world.tileSize, y: ty * world.tileSize, w: world.tileSize, h: world.tileSize }
    if (overlaps(probe, tile, 0)) hit = true
  })
  return hit
}

function horizontalOverlap(body: Rect, tileLeft: number, tileRight: number): boolean {
  return body.x + body.w > tileLeft + SKIN && body.x < tileRight - SKIN
}

interface YResolution {
  dy: number
  onGround: boolean
  hitCeiling: boolean
}

function resolveX(body: Rect, dx: number, world: TileIndex): { dx: number; hit: boolean } {
  if (dx === 0) return { dx: 0, hit: false }
  const ts = world.tileSize
  const dir = Math.sign(dx)
  let allowed = dx
  let hit = false
  const minY = Math.floor((body.y + SIDE_INSET) / ts)
  const maxY = Math.floor((body.y + body.h - SIDE_INSET) / ts)
  const minX = Math.floor((Math.min(body.x, body.x + dx) - 1) / ts)
  const maxX = Math.floor((Math.max(body.x + body.w, body.x + body.w + dx) + 1) / ts)

  for (let ty = minY; ty <= maxY; ty += 1) {
    for (let tx = minX; tx <= maxX; tx += 1) {
      if (world.get(tx, ty) !== 'solid') continue
      const left = tx * ts
      const right = left + ts
      if (dir > 0) {
        const dist = left - (body.x + body.w)
        if (dist >= -SKIN && dist < allowed) {
          allowed = Math.max(dist - SKIN, dist >= 0 ? 0 : dist)
          if (dist >= 0) allowed = Math.max(0, dist - SKIN)
          hit = true
        }
      } else {
        const dist = right - body.x
        if (dist <= SKIN && dist > allowed) {
          allowed = dist <= 0 ? Math.min(0, dist + SKIN) : 0
          hit = true
        }
      }
    }
  }

  if (body.x + allowed < 0) {
    allowed = -body.x
    hit = true
  }
  const maxLeft = world.pixelWidth - body.w
  if (body.x + allowed > maxLeft) {
    allowed = maxLeft - body.x
    hit = true
  }
  return { dx: allowed, hit }
}

function resolveY(body: Rect, dy: number, world: TileIndex, ignoreOneWay: boolean): YResolution {
  if (dy === 0) return { dy: 0, onGround: false, hitCeiling: false }
  const ts = world.tileSize
  const prevTop = body.y
  const prevBottom = body.y + body.h
  const minX = Math.floor(body.x / ts)
  const maxX = Math.floor((body.x + body.w - 1e-4) / ts)

  if (dy > 0) {
    let limitBottom = prevBottom + dy
    let onGround = false
    const minY = Math.floor(prevBottom / ts) - 1
    const maxY = Math.floor((prevBottom + dy) / ts) + 1
    for (let ty = minY; ty <= maxY; ty += 1) {
      for (let tx = minX; tx <= maxX; tx += 1) {
        const type = world.get(tx, ty)
        if (type !== 'solid' && type !== 'oneWay') continue
        if (type === 'oneWay' && ignoreOneWay) continue
        const top = ty * ts
        if (!horizontalOverlap(body, tx * ts, tx * ts + ts)) continue
        const slop = type === 'oneWay' ? ONE_WAY_SLOP : SKIN
        if (prevBottom <= top + slop && top < limitBottom) {
          limitBottom = top
          onGround = true
        }
      }
    }
    return { dy: limitBottom - prevBottom, onGround, hitCeiling: false }
  }

  let limitTop = prevTop + dy
  let hitCeiling = false
  const minY = Math.floor((prevTop + dy) / ts) - 1
  const maxY = Math.floor(prevTop / ts) + 1
  for (let ty = minY; ty <= maxY; ty += 1) {
    for (let tx = minX; tx <= maxX; tx += 1) {
      if (world.get(tx, ty) !== 'solid') continue
      const bottom = (ty + 1) * ts
      if (!horizontalOverlap(body, tx * ts, tx * ts + ts)) continue
      if (prevTop >= bottom - SKIN && bottom > limitTop) {
        limitTop = bottom + SKIN
        hitCeiling = true
      }
    }
  }
  return { dy: limitTop - prevTop, onGround: false, hitCeiling }
}

export function moveBody(body: Body, dx: number, dy: number, world: TileIndex, options?: { ignoreOneWay?: boolean }): MoveResult {
  const result: MoveResult = { onGround: false, hitCeiling: false, hitWall: false, hazard: false }
  const x0 = body.x
  const y0 = body.y
  const resolvedX = resolveX(body, dx, world)
  body.x += resolvedX.dx
  result.hitWall = resolvedX.hit && Math.abs(resolvedX.dx - dx) > 1e-4
  if (rectHitsHazard(sweptRect(x0, y0, body.x, y0, body.w, body.h), world)) result.hazard = true

  const y1 = body.y
  const resolvedY = resolveY(body, dy, world, options?.ignoreOneWay ?? false)
  body.y += resolvedY.dy
  result.onGround = resolvedY.onGround
  result.hitCeiling = resolvedY.hitCeiling
  if (rectHitsHazard(sweptRect(body.x, y1, body.x, body.y, body.w, body.h), world)) result.hazard = true
  return result
}

export function separateUpward(body: Body, world: TileIndex): void {
  for (let i = 0; i < world.tileSize * 6; i += 1) {
    if (!overlapsSolid(body, world)) return
    body.y -= 1
  }
}

export function probeGroundBody(body: Body, world: TileIndex): boolean {
  const copy: Body = { x: body.x, y: body.y, w: body.w, h: body.h, vx: 0, vy: 0 }
  const moved = moveBody(copy, 0, 2, world)
  return moved.onGround && copy.y <= body.y + 0.01
}

export function jumpSpeed(gravity: number, jumpHeight: number): number {
  return Math.sqrt(2 * gravity * jumpHeight)
}

export function advanceAccumulator(
  accumulator: number,
  frameDt: number,
  fixedDt = FIXED_DT,
  maxSteps = MAX_STEPS_PER_FRAME,
): { steps: number; accumulator: number } {
  const dt = Math.min(Math.max(frameDt, 0), MAX_FRAME_DT)
  let acc = accumulator + dt
  let steps = 0
  while (acc >= fixedDt - 1e-9 && steps < maxSteps) {
    acc -= fixedDt
    steps += 1
  }
  if (steps >= maxSteps && acc >= fixedDt) acc = 0
  if (acc < 0 && acc > -1e-9) acc = 0
  return { steps, accumulator: acc }
}

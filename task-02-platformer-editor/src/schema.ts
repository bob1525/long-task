export const LEVEL_FORMAT_VERSION = 1
export const TILE_SIZE = 32

export const DEFAULT_PHYSICS: PhysicsConfig = {
  gravity: 1800,
  jumpHeight: 128,
  moveSpeed: 200,
}

export type TileType = 'solid' | 'oneWay' | 'hazard'

export interface PhysicsConfig {
  gravity: number
  jumpHeight: number
  moveSpeed: number
}

export interface Tile {
  x: number
  y: number
  type: TileType
}

export interface Point {
  x: number
  y: number
}

export interface EnemyDef {
  id: string
  x: number
  y: number
  left: number
  right: number
  speed: number
}

export interface GoalDef extends Point {
  requireCoins: number
  requireKeys: number
}

export interface Level {
  version: number
  id: string
  name: string
  width: number
  height: number
  tileSize: number
  physics: PhysicsConfig
  start: Point
  goal: GoalDef
  tiles: Tile[]
  coins: Point[]
  keys: Point[]
  enemies: EnemyDef[]
}

export class LevelValidationError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(issues.join('\n'))
    this.name = 'LevelValidationError'
    this.issues = issues
  }
}

const TILE_TYPES: readonly TileType[] = ['solid', 'oneWay', 'hazard']
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

export function cloneLevel(level: Level): Level {
  return structuredClone(level)
}

function comparePoint(a: Point, b: Point): number {
  return a.y - b.y || a.x - b.x
}

export function canonicalize(level: Level): Level {
  return {
    version: LEVEL_FORMAT_VERSION,
    id: level.id,
    name: level.name,
    width: level.width,
    height: level.height,
    tileSize: level.tileSize,
    physics: {
      gravity: level.physics.gravity,
      jumpHeight: level.physics.jumpHeight,
      moveSpeed: level.physics.moveSpeed,
    },
    start: { x: level.start.x, y: level.start.y },
    goal: {
      x: level.goal.x,
      y: level.goal.y,
      requireCoins: level.goal.requireCoins,
      requireKeys: level.goal.requireKeys,
    },
    tiles: level.tiles
      .map((tile) => ({ x: tile.x, y: tile.y, type: tile.type }))
      .sort((a, b) => comparePoint(a, b) || a.type.localeCompare(b.type)),
    coins: level.coins.map((point) => ({ x: point.x, y: point.y })).sort(comparePoint),
    keys: level.keys.map((point) => ({ x: point.x, y: point.y })).sort(comparePoint),
    enemies: level.enemies
      .map((enemy) => ({
        id: enemy.id,
        x: enemy.x,
        y: enemy.y,
        left: enemy.left,
        right: enemy.right,
        speed: enemy.speed,
      }))
      .sort((a, b) => comparePoint(a, b) || a.id.localeCompare(b.id)),
  }
}

export function serializeLevel(level: Level): string {
  return `${JSON.stringify(canonicalize(level), null, 2)}\n`
}

function pushIssue(issues: string[], message: string): void {
  if (issues.length < 20) issues.push(message)
}

function readPoint(value: unknown, path: string, issues: string[], width: number, height: number): Point | null {
  if (!isRecord(value)) {
    pushIssue(issues, `${path} 必须是包含 x、y 的对象`)
    return null
  }
  if (!integer(value.x) || !integer(value.y)) {
    pushIssue(issues, `${path}.x 和 ${path}.y 必须是整数`)
    return null
  }
  if (value.x < 0 || value.y < 0 || value.x >= width || value.y >= height) {
    pushIssue(issues, `${path} 坐标 (${value.x}, ${value.y}) 超出关卡范围 ${width}×${height}`)
    return null
  }
  return { x: value.x, y: value.y }
}

export function parseLevel(input: unknown): Level {
  let data: unknown = input
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input) as unknown
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new LevelValidationError([`JSON 无法解析：${detail}`])
    }
  }

  const issues: string[] = []
  if (!isRecord(data)) {
    throw new LevelValidationError(['关卡数据必须是 JSON 对象'])
  }

  if (!integer(data.version)) {
    pushIssue(issues, '缺少整数版本号 version')
  } else if (data.version !== LEVEL_FORMAT_VERSION) {
    pushIssue(
      issues,
      `不支持的关卡版本 ${data.version}，当前只支持版本 ${LEVEL_FORMAT_VERSION}`,
    )
  }

  if (typeof data.id !== 'string' || !ID_PATTERN.test(data.id)) {
    pushIssue(issues, 'id 必须是 1–64 位的字母、数字、下划线或连字符')
  }
  if (typeof data.name !== 'string' || data.name.trim().length === 0 || data.name.trim().length > 48) {
    pushIssue(issues, 'name 必须是 1–48 个字符的关卡名称')
  }
  if (!integer(data.width) || data.width < 8 || data.width > 200) {
    pushIssue(issues, 'width 必须是 8–200 的整数')
  }
  if (!integer(data.height) || data.height < 8 || data.height > 80) {
    pushIssue(issues, 'height 必须是 8–80 的整数')
  }
  if (data.tileSize !== TILE_SIZE) {
    pushIssue(issues, `tileSize 必须是 ${TILE_SIZE}`)
  }

  const width = integer(data.width) ? data.width : 0
  const height = integer(data.height) ? data.height : 0

  let physics: PhysicsConfig | null = null
  if (!isRecord(data.physics)) {
    pushIssue(issues, 'physics 必须是对象，包含 gravity、jumpHeight、moveSpeed')
  } else {
    const gravity = data.physics.gravity
    const jumpHeight = data.physics.jumpHeight
    const moveSpeed = data.physics.moveSpeed
    if (!finiteNumber(gravity) || gravity < 200 || gravity > 6000) {
      pushIssue(issues, 'physics.gravity 必须是 200–6000 之间的数字（像素/秒²）')
    }
    if (!finiteNumber(jumpHeight) || jumpHeight < 16 || jumpHeight > 480) {
      pushIssue(issues, 'physics.jumpHeight 必须是 16–480 之间的数字（像素）')
    }
    if (!finiteNumber(moveSpeed) || moveSpeed < 40 || moveSpeed > 800) {
      pushIssue(issues, 'physics.moveSpeed 必须是 40–800 之间的数字（像素/秒）')
    }
    if (
      finiteNumber(gravity) &&
      finiteNumber(jumpHeight) &&
      finiteNumber(moveSpeed) &&
      gravity >= 200 &&
      gravity <= 6000 &&
      jumpHeight >= 16 &&
      jumpHeight <= 480 &&
      moveSpeed >= 40 &&
      moveSpeed <= 800
    ) {
      physics = { gravity, jumpHeight, moveSpeed }
    }
  }

  const start = width > 0 && height > 0 ? readPoint(data.start, 'start', issues, width, height) : null
  let goal: GoalDef | null = null
  if (!isRecord(data.goal)) {
    pushIssue(issues, 'goal 必须是对象')
  } else if (width > 0 && height > 0) {
    const point = readPoint(data.goal, 'goal', issues, width, height)
    const requireCoins = data.goal.requireCoins
    const requireKeys = data.goal.requireKeys
    if (!integer(requireCoins) || requireCoins < 0 || requireCoins > 999) {
      pushIssue(issues, 'goal.requireCoins 必须是 0–999 的整数')
    }
    if (!integer(requireKeys) || requireKeys < 0 || requireKeys > 999) {
      pushIssue(issues, 'goal.requireKeys 必须是 0–999 的整数')
    }
    if (point && integer(requireCoins) && integer(requireKeys) && requireCoins >= 0 && requireKeys >= 0 && requireCoins <= 999 && requireKeys <= 999) {
      goal = { ...point, requireCoins, requireKeys }
    }
  }

  const tiles: Tile[] = []
  const seenTiles = new Set<string>()
  if (!Array.isArray(data.tiles)) {
    pushIssue(issues, 'tiles 必须是数组')
  } else {
    data.tiles.forEach((entry, index) => {
      const path = `tiles[${index}]`
      if (!isRecord(entry)) {
        pushIssue(issues, `${path} 必须是对象`)
        return
      }
      if (!integer(entry.x) || !integer(entry.y)) {
        pushIssue(issues, `${path}.x 和 ${path}.y 必须是整数`)
        return
      }
      if (width > 0 && height > 0 && (entry.x < 0 || entry.y < 0 || entry.x >= width || entry.y >= height)) {
        pushIssue(issues, `${path} 坐标 (${entry.x}, ${entry.y}) 超出关卡范围`)
        return
      }
      if (typeof entry.type !== 'string' || !TILE_TYPES.includes(entry.type as TileType)) {
        pushIssue(issues, `${path}.type 必须是 solid、oneWay 或 hazard`)
        return
      }
      const key = `${entry.x},${entry.y}`
      if (seenTiles.has(key)) {
        pushIssue(issues, `${path} 与另一块地形重叠于 (${entry.x}, ${entry.y})`)
        return
      }
      seenTiles.add(key)
      tiles.push({ x: entry.x, y: entry.y, type: entry.type as TileType })
    })
  }

  const readPoints = (value: unknown, label: string): Point[] => {
    const points: Point[] = []
    const seen = new Set<string>()
    if (!Array.isArray(value)) {
      pushIssue(issues, `${label} 必须是数组`)
      return points
    }
    value.forEach((entry, index) => {
      if (width <= 0 || height <= 0) return
      const point = readPoint(entry, `${label}[${index}]`, issues, width, height)
      if (!point) return
      const key = `${point.x},${point.y}`
      if (seen.has(key)) {
        pushIssue(issues, `${label}[${index}] 与另一个收集物重叠于 (${point.x}, ${point.y})`)
        return
      }
      seen.add(key)
      points.push(point)
    })
    return points
  }

  const coins = readPoints(data.coins, 'coins')
  const keys = readPoints(data.keys, 'keys')

  const enemies: EnemyDef[] = []
  const seenEnemyIds = new Set<string>()
  const seenEnemyCells = new Set<string>()
  if (!Array.isArray(data.enemies)) {
    pushIssue(issues, 'enemies 必须是数组')
  } else {
    data.enemies.forEach((entry, index) => {
      const path = `enemies[${index}]`
      if (!isRecord(entry)) {
        pushIssue(issues, `${path} 必须是对象`)
        return
      }
      if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) {
        pushIssue(issues, `${path}.id 必须是 1–64 位的字母、数字、下划线或连字符`)
        return
      }
      if (seenEnemyIds.has(entry.id)) {
        pushIssue(issues, `${path}.id「${entry.id}」重复`)
        return
      }
      if (!integer(entry.x) || !integer(entry.y)) {
        pushIssue(issues, `${path}.x 和 ${path}.y 必须是整数`)
        return
      }
      if (width > 0 && height > 0 && (entry.x < 0 || entry.y < 0 || entry.x >= width || entry.y >= height)) {
        pushIssue(issues, `${path} 坐标超出关卡范围`)
        return
      }
      if (!integer(entry.left) || entry.left < 0 || entry.left > 40) {
        pushIssue(issues, `${path}.left 必须是 0–40 的整数`)
        return
      }
      if (!integer(entry.right) || entry.right < 0 || entry.right > 40) {
        pushIssue(issues, `${path}.right 必须是 0–40 的整数`)
        return
      }
      if (!finiteNumber(entry.speed) || entry.speed < 0 || entry.speed > 400) {
        pushIssue(issues, `${path}.speed 必须是 0–400 之间的数字`)
        return
      }
      const cell = `${entry.x},${entry.y}`
      if (seenEnemyCells.has(cell)) {
        pushIssue(issues, `${path} 与另一个敌人重叠于 (${entry.x}, ${entry.y})`)
        return
      }
      seenEnemyIds.add(entry.id)
      seenEnemyCells.add(cell)
      enemies.push({
        id: entry.id,
        x: entry.x,
        y: entry.y,
        left: entry.left,
        right: entry.right,
        speed: entry.speed,
      })
    })
  }

  if (issues.length > 0 || !physics || !start || !goal || typeof data.id !== 'string' || typeof data.name !== 'string' || !integer(data.width) || !integer(data.height)) {
    if (issues.length === 0) pushIssue(issues, '关卡数据不完整')
    throw new LevelValidationError(issues)
  }

  return canonicalize({
    version: LEVEL_FORMAT_VERSION,
    id: data.id,
    name: data.name.trim(),
    width: data.width,
    height: data.height,
    tileSize: TILE_SIZE,
    physics,
    start,
    goal,
    tiles,
    coins,
    keys,
    enemies,
  })
}

export function createLevelId(): string {
  const time = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `lvl-${time}-${rand}`
}

export function sameLevel(a: Level, b: Level): boolean {
  return serializeLevel(a) === serializeLevel(b)
}

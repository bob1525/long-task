import { TILE_SIZE, cloneLevel, type EnemyDef, type Level, type TileType } from './schema'

export type Tool =
  | 'select'
  | 'solid'
  | 'oneWay'
  | 'hazard'
  | 'coin'
  | 'key'
  | 'enemy'
  | 'tracker'
  | 'checkpoint'
  | 'platform'
  | 'start'
  | 'goal'
  | 'erase'

export interface Cell {
  x: number
  y: number
}

export type Selection =
  | { kind: 'tile'; x: number; y: number }
  | { kind: 'coin'; x: number; y: number }
  | { kind: 'key'; x: number; y: number }
  | { kind: 'enemy'; id: string }
  | { kind: 'platform'; id: string }
  | { kind: 'checkpoint'; id: string }
  | { kind: 'start' }
  | { kind: 'goal' }

export interface Layers {
  terrain: boolean
  collect: boolean
  enemy: boolean
  markers: boolean
}

export const ALL_LAYERS: Layers = {
  terrain: true,
  collect: true,
  enemy: true,
  markers: true,
}

export function cellFromWorld(x: number, y: number, tileSize = TILE_SIZE): Cell {
  return { x: Math.floor(x / tileSize), y: Math.floor(y / tileSize) }
}

export function inBounds(level: Level, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < level.width && y < level.height
}

function sameCell(a: { x: number; y: number }, x: number, y: number): boolean {
  return a.x === x && a.y === y
}

function nextId(used: Set<string>, prefix: string): string {
  let n = used.size + 1
  let id = `${prefix}-${n}`
  while (used.has(id)) {
    n += 1
    id = `${prefix}-${n}`
  }
  return id
}

export function paintInto(level: Level, tool: Tool, x: number, y: number): boolean {
  if (!inBounds(level, x, y)) return false
  if (tool === 'solid' || tool === 'oneWay' || tool === 'hazard') {
    const existing = level.tiles.find((tile) => sameCell(tile, x, y))
    if (existing) {
      if (existing.type === tool) return false
      existing.type = tool
      return true
    }
    level.tiles.push({ x, y, type: tool })
    return true
  }
  if (tool === 'coin') {
    if (level.coins.some((coin) => sameCell(coin, x, y))) return false
    level.coins.push({ x, y })
    return true
  }
  if (tool === 'key') {
    if (level.keys.some((key) => sameCell(key, x, y))) return false
    level.keys.push({ x, y })
    return true
  }
  if (tool === 'enemy' || tool === 'tracker') {
    if (level.enemies.some((enemy) => sameCell(enemy, x, y))) return false
    const tracker = tool === 'tracker'
    level.enemies.push({
      id: nextId(new Set(level.enemies.map((enemy) => enemy.id)), tracker ? 'tracker' : 'enemy'),
      x,
      y,
      left: tracker ? 4 : 2,
      right: tracker ? 4 : 2,
      speed: tracker ? 90 : 70,
      kind: tracker ? 'tracker' : 'patrol',
      sight: tracker ? 8 : 0,
    })
    return true
  }
  if (tool === 'checkpoint') {
    if (level.checkpoints.some((point) => sameCell(point, x, y))) return false
    level.checkpoints.push({
      id: nextId(new Set(level.checkpoints.map((point) => point.id)), 'checkpoint'),
      x,
      y,
    })
    return true
  }
  if (tool === 'platform') {
    if (level.platforms.some((platform) => platform.x === x && platform.y === y)) return false
    const endX = Math.min(level.width - 1, x + 4)
    if (endX === x) return false
    level.platforms.push({
      id: nextId(new Set(level.platforms.map((platform) => platform.id)), 'platform'),
      x,
      y,
      width: 3,
      speed: 48,
      path: [{ x, y }, { x: endX, y }],
    })
    return true
  }
  if (tool === 'start') {
    if (level.start.x === x && level.start.y === y) return false
    level.start = { x, y }
    return true
  }
  if (tool === 'goal') {
    if (level.goal.x === x && level.goal.y === y) return false
    level.goal = { ...level.goal, x, y }
    return true
  }
  if (tool === 'erase') return eraseAt(level, x, y)
  return false
}

export function eraseAt(level: Level, x: number, y: number): boolean {
  const before = level.tiles.length + level.coins.length + level.keys.length + level.enemies.length + level.platforms.length + level.checkpoints.length
  level.tiles = level.tiles.filter((tile) => !sameCell(tile, x, y))
  level.coins = level.coins.filter((coin) => !sameCell(coin, x, y))
  level.keys = level.keys.filter((key) => !sameCell(key, x, y))
  level.enemies = level.enemies.filter((enemy) => !sameCell(enemy, x, y))
  level.checkpoints = level.checkpoints.filter((point) => !sameCell(point, x, y))
  level.platforms = level.platforms.flatMap((platform) => {
    if (platform.x === x && platform.y === y) return []
    const path = platform.path.filter((point, index) => index === 0 || !sameCell(point, x, y))
    if (path.length === platform.path.length) return [platform]
    if (path.length < 2) return []
    return [{ ...platform, path, x: path[0]!.x, y: path[0]!.y }]
  })
  const after = level.tiles.length + level.coins.length + level.keys.length + level.enemies.length + level.platforms.length + level.checkpoints.length
  return after !== before
}

export function pickAt(level: Level, x: number, y: number): Selection | null {
  const checkpoint = level.checkpoints.find((entry) => sameCell(entry, x, y))
  if (checkpoint) return { kind: 'checkpoint', id: checkpoint.id }
  const platform = level.platforms.find((entry) => entry.path.some((point) => sameCell(point, x, y)) || (entry.x === x && entry.y === y))
  if (platform) return { kind: 'platform', id: platform.id }
  const enemy = level.enemies.find((entry) => sameCell(entry, x, y))
  if (enemy) return { kind: 'enemy', id: enemy.id }
  if (level.keys.some((key) => sameCell(key, x, y))) return { kind: 'key', x, y }
  if (level.coins.some((coin) => sameCell(coin, x, y))) return { kind: 'coin', x, y }
  if (level.goal.x === x && level.goal.y === y) return { kind: 'goal' }
  if (level.start.x === x && level.start.y === y) return { kind: 'start' }
  if (level.tiles.some((tile) => sameCell(tile, x, y))) return { kind: 'tile', x, y }
  return null
}

export function moveSelection(level: Level, selection: Selection, x: number, y: number): boolean {
  if (!inBounds(level, x, y)) return false
  if (selection.kind === 'start') {
    if (level.start.x === x && level.start.y === y) return false
    level.start = { x, y }
    return true
  }
  if (selection.kind === 'goal') {
    if (level.goal.x === x && level.goal.y === y) return false
    level.goal = { ...level.goal, x, y }
    return true
  }
  if (selection.kind === 'coin') {
    if (selection.x === x && selection.y === y) return false
    if (level.coins.some((coin) => sameCell(coin, x, y))) return false
    const coin = level.coins.find((entry) => sameCell(entry, selection.x, selection.y))
    if (!coin) return false
    coin.x = x
    coin.y = y
    return true
  }
  if (selection.kind === 'key') {
    if (selection.x === x && selection.y === y) return false
    if (level.keys.some((key) => sameCell(key, x, y))) return false
    const key = level.keys.find((entry) => sameCell(entry, selection.x, selection.y))
    if (!key) return false
    key.x = x
    key.y = y
    return true
  }
  if (selection.kind === 'enemy') {
    const enemy = level.enemies.find((entry) => entry.id === selection.id)
    if (!enemy) return false
    if (enemy.x === x && enemy.y === y) return false
    if (level.enemies.some((entry) => entry.id !== enemy.id && sameCell(entry, x, y))) return false
    enemy.x = x
    enemy.y = y
    return true
  }
  if (selection.kind === 'checkpoint') {
    const checkpoint = level.checkpoints.find((entry) => entry.id === selection.id)
    if (!checkpoint || (checkpoint.x === x && checkpoint.y === y)) return false
    checkpoint.x = x
    checkpoint.y = y
    return true
  }
  if (selection.kind === 'platform') return false
  const tile = level.tiles.find((entry) => sameCell(entry, selection.x, selection.y))
  if (!tile) return false
  if (tile.x === x && tile.y === y) return false
  if (level.tiles.some((entry) => sameCell(entry, x, y))) return false
  tile.x = x
  tile.y = y
  return true
}

export function resizeLevel(level: Level, width: number, height: number): void {
  const nextWidth = Math.max(8, Math.min(200, Math.round(width)))
  const nextHeight = Math.max(8, Math.min(80, Math.round(height)))
  level.width = nextWidth
  level.height = nextHeight
  const inside = (point: { x: number; y: number }) => point.x < nextWidth && point.y < nextHeight
  level.tiles = level.tiles.filter(inside)
  level.coins = level.coins.filter(inside)
  level.keys = level.keys.filter(inside)
  level.enemies = level.enemies.filter(inside)
  level.checkpoints = level.checkpoints.filter(inside)
  level.platforms = level.platforms.flatMap((platform) => {
    const path = platform.path.filter(inside)
    if (path.length < 2) return []
    const origin = path[0]!
    if (origin.x + platform.width > nextWidth) return []
    return [{ ...platform, path, x: origin.x, y: origin.y }]
  })
  if (!inside(level.start)) level.start = { x: 1, y: Math.min(nextHeight - 2, level.start.y) }
  if (!inside(level.goal)) {
    level.goal = { ...level.goal, x: Math.min(nextWidth - 2, Math.max(0, level.goal.x)), y: Math.min(nextHeight - 2, Math.max(0, level.goal.y)) }
  }
}

export function guideLines(level: Level, cell: Cell): { cols: number[]; rows: number[] } {
  const cols = new Set<number>()
  const rows = new Set<number>()
  const points: Array<{ x: number; y: number }> = [
    level.start,
    level.goal,
    ...level.tiles,
    ...level.coins,
    ...level.keys,
    ...level.enemies,
    ...level.checkpoints,
    ...level.platforms.flatMap((platform) => platform.path),
  ]
  for (const point of points) {
    if (point.x === cell.x && point.y === cell.y) continue
    if (point.x === cell.x) cols.add(point.x)
    if (point.y === cell.y) rows.add(point.y)
  }
  return { cols: [...cols], rows: [...rows] }
}

export function enemyById(level: Level, id: string): EnemyDef | undefined {
  return level.enemies.find((enemy) => enemy.id === id)
}

export function requirementWarning(level: Level): string | null {
  if (level.goal.requireKeys > level.keys.length && level.goal.requireCoins > level.coins.length) {
    return `终点需要 ${level.goal.requireKeys} 把钥匙和 ${level.goal.requireCoins} 枚金币，关卡里的数量不够，目前无法通关。`
  }
  if (level.goal.requireKeys > level.keys.length) {
    return `终点需要 ${level.goal.requireKeys} 把钥匙，但关卡里只有 ${level.keys.length} 把。`
  }
  if (level.goal.requireCoins > level.coins.length) {
    return `终点需要 ${level.goal.requireCoins} 枚金币，但关卡里只有 ${level.coins.length} 枚。`
  }
  return null
}

export function duplicateLevel(level: Level, id: string, name: string): Level {
  const copy = cloneLevel(level)
  copy.id = id
  copy.name = name
  return copy
}

export function tileLabel(type: TileType): string {
  if (type === 'solid') return '固体'
  if (type === 'oneWay') return '单向平台'
  return '危险区'
}

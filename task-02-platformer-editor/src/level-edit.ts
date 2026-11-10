import { TILE_SIZE, cloneLevel, type EnemyDef, type Level, type TileType } from './schema'

export type Tool =
  | 'select'
  | 'solid'
  | 'oneWay'
  | 'hazard'
  | 'coin'
  | 'key'
  | 'enemy'
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

function nextEnemyId(level: Level): string {
  let n = level.enemies.length + 1
  let id = `enemy-${n}`
  const used = new Set(level.enemies.map((enemy) => enemy.id))
  while (used.has(id)) {
    n += 1
    id = `enemy-${n}`
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
  if (tool === 'enemy') {
    if (level.enemies.some((enemy) => sameCell(enemy, x, y))) return false
    level.enemies.push({ id: nextEnemyId(level), x, y, left: 2, right: 2, speed: 70 })
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
  const before = level.tiles.length + level.coins.length + level.keys.length + level.enemies.length
  level.tiles = level.tiles.filter((tile) => !sameCell(tile, x, y))
  level.coins = level.coins.filter((coin) => !sameCell(coin, x, y))
  level.keys = level.keys.filter((key) => !sameCell(key, x, y))
  level.enemies = level.enemies.filter((enemy) => !sameCell(enemy, x, y))
  const after = level.tiles.length + level.coins.length + level.keys.length + level.enemies.length
  return after !== before
}

export function pickAt(level: Level, x: number, y: number): Selection | null {
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

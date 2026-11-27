import { snapAxisPoint } from './motion'
import { cloneLevel, type CheckpointDef, type EnemyDef, type Level, type MovingPlatformDef, type Point, type Tile } from './schema'

export type ItemRef =
  | { kind: 'tile'; x: number; y: number }
  | { kind: 'coin'; x: number; y: number }
  | { kind: 'key'; x: number; y: number }
  | { kind: 'enemy'; id: string }
  | { kind: 'platform'; id: string }
  | { kind: 'checkpoint'; id: string }
  | { kind: 'start' }
  | { kind: 'goal' }

export interface Clipboard {
  anchorX: number
  anchorY: number
  tiles: Tile[]
  coins: Point[]
  keys: Point[]
  enemies: EnemyDef[]
  platforms: MovingPlatformDef[]
  checkpoints: CheckpointDef[]
}

function inside(x: number, y: number, x0: number, y0: number, x1: number, y1: number): boolean {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1
}

function bounds(level: Level, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < level.width && y < level.height
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

export function selectInRect(level: Level, ax: number, ay: number, bx: number, by: number): ItemRef[] {
  const x0 = Math.min(ax, bx)
  const x1 = Math.max(ax, bx)
  const y0 = Math.min(ay, by)
  const y1 = Math.max(ay, by)
  const items: ItemRef[] = []
  for (const tile of level.tiles) if (inside(tile.x, tile.y, x0, y0, x1, y1)) items.push({ kind: 'tile', x: tile.x, y: tile.y })
  for (const coin of level.coins) if (inside(coin.x, coin.y, x0, y0, x1, y1)) items.push({ kind: 'coin', x: coin.x, y: coin.y })
  for (const key of level.keys) if (inside(key.x, key.y, x0, y0, x1, y1)) items.push({ kind: 'key', x: key.x, y: key.y })
  for (const enemy of level.enemies) if (inside(enemy.x, enemy.y, x0, y0, x1, y1)) items.push({ kind: 'enemy', id: enemy.id })
  for (const platform of level.platforms) if (inside(platform.x, platform.y, x0, y0, x1, y1)) items.push({ kind: 'platform', id: platform.id })
  for (const checkpoint of level.checkpoints) if (inside(checkpoint.x, checkpoint.y, x0, y0, x1, y1)) items.push({ kind: 'checkpoint', id: checkpoint.id })
  if (inside(level.start.x, level.start.y, x0, y0, x1, y1)) items.push({ kind: 'start' })
  if (inside(level.goal.x, level.goal.y, x0, y0, x1, y1)) items.push({ kind: 'goal' })
  return items
}

export function copyItems(level: Level, items: readonly ItemRef[]): Clipboard {
  const tiles: Tile[] = []
  const coins: Point[] = []
  const keys: Point[] = []
  const enemies: EnemyDef[] = []
  const platforms: MovingPlatformDef[] = []
  const checkpoints: CheckpointDef[] = []
  const points: Point[] = []
  for (const item of items) {
    if (item.kind === 'tile') {
      const tile = level.tiles.find((entry) => entry.x === item.x && entry.y === item.y)
      if (tile) {
        tiles.push({ ...tile })
        points.push(tile)
      }
    } else if (item.kind === 'coin') {
      const coin = level.coins.find((entry) => entry.x === item.x && entry.y === item.y)
      if (coin) {
        coins.push({ ...coin })
        points.push(coin)
      }
    } else if (item.kind === 'key') {
      const key = level.keys.find((entry) => entry.x === item.x && entry.y === item.y)
      if (key) {
        keys.push({ ...key })
        points.push(key)
      }
    } else if (item.kind === 'enemy') {
      const enemy = level.enemies.find((entry) => entry.id === item.id)
      if (enemy) {
        enemies.push(cloneLevel({ ...level, enemies: [enemy] }).enemies[0]!)
        points.push(enemy)
      }
    } else if (item.kind === 'platform') {
      const platform = level.platforms.find((entry) => entry.id === item.id)
      if (platform) {
        platforms.push(structuredClone(platform))
        points.push(platform)
      }
    } else if (item.kind === 'checkpoint') {
      const checkpoint = level.checkpoints.find((entry) => entry.id === item.id)
      if (checkpoint) {
        checkpoints.push({ ...checkpoint })
        points.push(checkpoint)
      }
    }
  }
  const anchorX = points.reduce((min, point) => Math.min(min, point.x), points[0]?.x ?? 0)
  const anchorY = points.reduce((min, point) => Math.min(min, point.y), points[0]?.y ?? 0)
  return { anchorX, anchorY, tiles, coins, keys, enemies, platforms, checkpoints }
}

export function pasteItems(level: Level, clipboard: Clipboard, atX: number, atY: number): ItemRef[] {
  const dx = atX - clipboard.anchorX
  const dy = atY - clipboard.anchorY
  const created: ItemRef[] = []
  const occupiedTiles = new Set(level.tiles.map((tile) => `${tile.x},${tile.y}`))
  for (const tile of clipboard.tiles) {
    const x = tile.x + dx
    const y = tile.y + dy
    const key = `${x},${y}`
    if (!bounds(level, x, y) || occupiedTiles.has(key)) continue
    level.tiles.push({ x, y, type: tile.type })
    occupiedTiles.add(key)
    created.push({ kind: 'tile', x, y })
  }
  const occupiedCoins = new Set(level.coins.map((coin) => `${coin.x},${coin.y}`))
  for (const coin of clipboard.coins) {
    const x = coin.x + dx
    const y = coin.y + dy
    const key = `${x},${y}`
    if (!bounds(level, x, y) || occupiedCoins.has(key)) continue
    level.coins.push({ x, y })
    occupiedCoins.add(key)
    created.push({ kind: 'coin', x, y })
  }
  const occupiedKeys = new Set(level.keys.map((entry) => `${entry.x},${entry.y}`))
  for (const key of clipboard.keys) {
    const x = key.x + dx
    const y = key.y + dy
    const id = `${x},${y}`
    if (!bounds(level, x, y) || occupiedKeys.has(id)) continue
    level.keys.push({ x, y })
    occupiedKeys.add(id)
    created.push({ kind: 'key', x, y })
  }
  const enemyIds = new Set(level.enemies.map((enemy) => enemy.id))
  const enemyCells = new Set(level.enemies.map((enemy) => `${enemy.x},${enemy.y}`))
  for (const enemy of clipboard.enemies) {
    const x = enemy.x + dx
    const y = enemy.y + dy
    const cell = `${x},${y}`
    if (!bounds(level, x, y) || enemyCells.has(cell)) continue
    const id = nextId(enemyIds, 'enemy')
    enemyIds.add(id)
    enemyCells.add(cell)
    level.enemies.push({ ...structuredClone(enemy), id, x, y })
    created.push({ kind: 'enemy', id })
  }
  const platformIds = new Set(level.platforms.map((platform) => platform.id))
  for (const platform of clipboard.platforms) {
    const path = platform.path.map((point) => ({ x: point.x + dx, y: point.y + dy }))
    if (path.some((point) => !bounds(level, point.x, point.y))) continue
    const origin = path[0]
    if (!origin || origin.x + platform.width > level.width) continue
    const id = nextId(platformIds, 'platform')
    platformIds.add(id)
    level.platforms.push({ ...structuredClone(platform), id, x: origin.x, y: origin.y, path })
    created.push({ kind: 'platform', id })
  }
  const checkpointIds = new Set(level.checkpoints.map((point) => point.id))
  const checkpointCells = new Set(level.checkpoints.map((point) => `${point.x},${point.y}`))
  for (const checkpoint of clipboard.checkpoints) {
    const x = checkpoint.x + dx
    const y = checkpoint.y + dy
    const cell = `${x},${y}`
    if (!bounds(level, x, y) || checkpointCells.has(cell)) continue
    const id = nextId(checkpointIds, 'checkpoint')
    checkpointIds.add(id)
    checkpointCells.add(cell)
    level.checkpoints.push({ id, x, y })
    created.push({ kind: 'checkpoint', id })
  }
  return created
}

function shiftPoint(point: Point, dx: number, dy: number, level: Level): Point | null {
  const next = { x: point.x + dx, y: point.y + dy }
  return bounds(level, next.x, next.y) ? next : null
}

export function moveItems(level: Level, items: readonly ItemRef[], dx: number, dy: number): ItemRef[] | null {
  if (dx === 0 && dy === 0) return items.map((item) => ({ ...item }))
  const tileTargets = new Map<string, string>()
  const nextItems: ItemRef[] = []
  for (const item of items) {
    if (item.kind === 'tile') {
      const moved = shiftPoint(item, dx, dy, level)
      if (!moved) return null
      tileTargets.set(`${item.x},${item.y}`, `${moved.x},${moved.y}`)
      nextItems.push({ kind: 'tile', x: moved.x, y: moved.y })
    } else if (item.kind === 'coin' || item.kind === 'key') {
      const moved = shiftPoint(item, dx, dy, level)
      if (!moved) return null
      const list = item.kind === 'coin' ? level.coins : level.keys
      const moving = new Set(items.flatMap((entry) => entry.kind === item.kind && (entry.kind === 'coin' || entry.kind === 'key') ? [`${entry.x},${entry.y}`] : []))
      if (list.some((point) => point.x === moved.x && point.y === moved.y && !moving.has(`${point.x},${point.y}`))) return null
      nextItems.push({ kind: item.kind, x: moved.x, y: moved.y })
    } else if (item.kind === 'enemy') {
      const enemy = level.enemies.find((entry) => entry.id === item.id)
      const moved = enemy ? shiftPoint(enemy, dx, dy, level) : null
      if (!moved) return null
      if (level.enemies.some((entry) => entry.id !== item.id && entry.x === moved.x && entry.y === moved.y && !items.some((selected) => selected.kind === 'enemy' && selected.id === entry.id))) return null
      nextItems.push({ kind: 'enemy', id: item.id })
    } else if (item.kind === 'platform') {
      const platform = level.platforms.find((entry) => entry.id === item.id)
      if (!platform) return null
      const path = platform.path.map((point) => shiftPoint(point, dx, dy, level))
      if (path.some((point) => point === null)) return null
      const origin = path[0]
      if (!origin || origin.x + platform.width > level.width) return null
      nextItems.push({ kind: 'platform', id: item.id })
    } else if (item.kind === 'checkpoint') {
      const checkpoint = level.checkpoints.find((entry) => entry.id === item.id)
      const moved = checkpoint ? shiftPoint(checkpoint, dx, dy, level) : null
      if (!moved) return null
      nextItems.push({ kind: 'checkpoint', id: item.id })
    } else if (item.kind === 'start') {
      if (!shiftPoint(level.start, dx, dy, level)) return null
      nextItems.push({ kind: 'start' })
    } else if (!shiftPoint(level.goal, dx, dy, level)) return null
    else nextItems.push({ kind: 'goal' })
  }
  const tileDestinations = new Set<string>()
  for (const destination of tileTargets.values()) {
    if (tileDestinations.has(destination)) return null
    tileDestinations.add(destination)
  }
  for (const tile of level.tiles) {
    const from = `${tile.x},${tile.y}`
    if (tileTargets.has(from)) continue
    if (tileDestinations.has(from)) return null
  }
  const tilePlan = items.flatMap((item) => {
    if (item.kind !== 'tile') return []
    const tile = level.tiles.find((entry) => entry.x === item.x && entry.y === item.y)
    return tile ? [{ tile, x: item.x + dx, y: item.y + dy }] : []
  })
  const coinPlan = items.flatMap((item) => {
    if (item.kind !== 'coin') return []
    const coin = level.coins.find((entry) => entry.x === item.x && entry.y === item.y)
    return coin ? [{ coin, x: item.x + dx, y: item.y + dy }] : []
  })
  const keyPlan = items.flatMap((item) => {
    if (item.kind !== 'key') return []
    const key = level.keys.find((entry) => entry.x === item.x && entry.y === item.y)
    return key ? [{ key, x: item.x + dx, y: item.y + dy }] : []
  })
  const enemyPlan = items.flatMap((item) => {
    if (item.kind !== 'enemy') return []
    const enemy = level.enemies.find((entry) => entry.id === item.id)
    return enemy ? [{ enemy, x: enemy.x + dx, y: enemy.y + dy }] : []
  })
  const platformPlan = items.flatMap((item) => {
    if (item.kind !== 'platform') return []
    const platform = level.platforms.find((entry) => entry.id === item.id)
    return platform ? [platform] : []
  })
  const checkpointPlan = items.flatMap((item) => {
    if (item.kind !== 'checkpoint') return []
    const checkpoint = level.checkpoints.find((entry) => entry.id === item.id)
    return checkpoint ? [{ checkpoint, x: checkpoint.x + dx, y: checkpoint.y + dy }] : []
  })
  if (tilePlan.length !== items.filter((item) => item.kind === 'tile').length) return null
  for (const plan of tilePlan) {
    plan.tile.x = plan.x
    plan.tile.y = plan.y
  }
  for (const plan of coinPlan) {
    plan.coin.x = plan.x
    plan.coin.y = plan.y
  }
  for (const plan of keyPlan) {
    plan.key.x = plan.x
    plan.key.y = plan.y
  }
  for (const plan of enemyPlan) {
    plan.enemy.x = plan.x
    plan.enemy.y = plan.y
  }
  for (const platform of platformPlan) {
    platform.path = platform.path.map((point) => ({ x: point.x + dx, y: point.y + dy }))
    platform.x = platform.path[0]?.x ?? platform.x
    platform.y = platform.path[0]?.y ?? platform.y
  }
  for (const plan of checkpointPlan) {
    plan.checkpoint.x = plan.x
    plan.checkpoint.y = plan.y
  }
  if (items.some((item) => item.kind === 'start')) level.start = { x: level.start.x + dx, y: level.start.y + dy }
  if (items.some((item) => item.kind === 'goal')) level.goal = { ...level.goal, x: level.goal.x + dx, y: level.goal.y + dy }
  return nextItems
}

export function extendPlatformPath(platform: MovingPlatformDef, x: number, y: number, width: number, height: number): boolean {
  const last = platform.path[platform.path.length - 1]
  if (!last) return false
  if (x < 0 || y < 0 || x >= width || y >= height) return false
  const snapped = snapAxisPoint(last, x, y)
  if (snapped.x < 0 || snapped.y < 0 || snapped.x >= width || snapped.y >= height) return false
  if (snapped.x === last.x && snapped.y === last.y) return false
  if (snapped.x !== last.x && snapped.y !== last.y) return false
  platform.path.push(snapped)
  return true
}

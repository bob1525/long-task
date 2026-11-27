import type { Level, Point } from './schema'

export interface LevelIssue {
  message: string
  x: number
  y: number
}

const TILE = 32

function cellKey(x: number, y: number): string {
  return `${x},${y}`
}

function tileAt(level: Level, x: number, y: number): string | undefined {
  return level.tiles.find((tile) => tile.x === x && tile.y === y)?.type
}

function platformFootholds(level: Level): Map<string, string> {
  const owners = new Map<string, string>()
  for (const platform of level.platforms) {
    const points = platform.path.length > 0 ? platform.path : [{ x: platform.x, y: platform.y }]
    for (let index = 0; index < points.length; index += 1) {
      const start = points[index]!
      const end = points[Math.min(points.length - 1, index + 1)]!
      const steps = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y))
      for (let step = 0; step <= steps; step += 1) {
        const t = steps === 0 ? 0 : step / steps
        const px = Math.round(start.x + (end.x - start.x) * t)
        const py = Math.round(start.y + (end.y - start.y) * t)
        for (let span = 0; span < platform.width; span += 1) {
          const footholdX = px + span
          const footholdY = py - 1
          if (footholdX < 0 || footholdY < 0 || footholdX >= level.width || footholdY >= level.height) continue
          owners.set(cellKey(footholdX, footholdY), platform.id)
        }
      }
    }
  }
  return owners
}

function supported(level: Level, x: number, y: number, platforms: Map<string, string>): boolean {
  if (platforms.has(cellKey(x, y))) return true
  const below = tileAt(level, x, y + 1)
  return below === 'solid' || below === 'oneWay'
}

function blocked(level: Level, x: number, y: number): boolean {
  return tileAt(level, x, y) === 'solid'
}

function harmful(level: Level, x: number, y: number): boolean {
  return tileAt(level, x, y) === 'hazard'
}

function jumpLimits(level: Level): { rise: number; run: number } {
  const jumpTiles = Math.max(1, Math.round(level.physics.jumpHeight / TILE))
  const rise = jumpTiles + (level.physics.doubleJump ? jumpTiles : 0)
  const airTime = Math.sqrt((2 * level.physics.jumpHeight) / level.physics.gravity) * (1 + 1 / Math.sqrt(1.25))
  const run = Math.max(3, Math.ceil((level.physics.moveSpeed * airTime) / TILE) + (level.physics.doubleJump ? 2 : 0))
  return { rise, run }
}

function rectangleClear(level: Level, from: Point, to: Point): boolean {
  const x0 = Math.min(from.x, to.x)
  const x1 = Math.max(from.x, to.x)
  const y0 = Math.min(from.y, to.y)
  const y1 = Math.max(from.y, to.y)
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if ((x === from.x && y === from.y) || (x === to.x && y === to.y)) continue
      if (blocked(level, x, y)) return false
    }
  }
  return true
}

export function goalReachable(level: Level): boolean {
  if (level.start.x === level.goal.x && level.start.y === level.goal.y) return true
  const platforms = platformFootholds(level)
  const footholds = new Set<string>()
  for (let y = 0; y < level.height; y += 1) {
    for (let x = 0; x < level.width; x += 1) {
      if (blocked(level, x, y) || harmful(level, x, y)) continue
      if (supported(level, x, y, platforms)) footholds.add(cellKey(x, y))
    }
  }
  if (!blocked(level, level.start.x, level.start.y)) footholds.add(cellKey(level.start.x, level.start.y))
  const { rise, run } = jumpLimits(level)
  const visited = new Set<string>()
  const queue: Point[] = [{ x: level.start.x, y: level.start.y }]
  visited.add(cellKey(level.start.x, level.start.y))

  const visit = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= level.width || y >= level.height) return
    const key = cellKey(x, y)
    if (visited.has(key) || !footholds.has(key)) return
    visited.add(key)
    queue.push({ x, y })
  }

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!
    if (current.x === level.goal.x && current.y === level.goal.y) return true
    if (current.x === level.goal.x && current.y === level.goal.y - 1) return true
    visit(current.x - 1, current.y)
    visit(current.x + 1, current.y)

    for (let y = current.y + 1; y < level.height; y += 1) {
      if (blocked(level, current.x, y) || harmful(level, current.x, y)) break
      if (footholds.has(cellKey(current.x, y))) visit(current.x, y)
    }

    for (let y = Math.max(0, current.y - rise); y < level.height; y += 1) {
      for (let x = Math.max(0, current.x - run); x <= Math.min(level.width - 1, current.x + run); x += 1) {
        if (x === current.x && y === current.y) continue
        const climbed = current.y - y
        if (climbed > rise) continue
        if (!footholds.has(cellKey(x, y))) continue
        if (!rectangleClear(level, current, { x, y })) continue
        visit(x, y)
      }
    }

    const platformId = platforms.get(cellKey(current.x, current.y))
    if (platformId) {
      for (const [key, owner] of platforms) {
        if (owner !== platformId) continue
        const [xText, yText] = key.split(',')
        visit(Number(xText), Number(yText))
      }
    }
  }

  return visited.has(cellKey(level.goal.x, level.goal.y)) || visited.has(cellKey(level.goal.x, level.goal.y - 1))
}

export function assessLevel(level: Level): LevelIssue[] {
  const issues: LevelIssue[] = []
  const startInside = level.start.x >= 0 && level.start.y >= 0 && level.start.x < level.width && level.start.y < level.height
  const goalInside = level.goal.x >= 0 && level.goal.y >= 0 && level.goal.x < level.width && level.goal.y < level.height
  if (!startInside) {
    issues.push({ message: '关卡缺少有效起点。', x: 0, y: 0 })
  }
  if (!goalInside) {
    issues.push({ message: '关卡缺少有效终点。', x: 0, y: 0 })
  } else if (level.goal.requireKeys > level.keys.length) {
    issues.push({
      message: `终点 (${level.goal.x}, ${level.goal.y}) 需要 ${level.goal.requireKeys} 把钥匙，关卡里只有 ${level.keys.length} 把。`,
      x: level.goal.x,
      y: level.goal.y,
    })
  }
  if (startInside && goalInside && !goalReachable(level)) {
    issues.push({
      message: `终点 (${level.goal.x}, ${level.goal.y}) 从起点 (${level.start.x}, ${level.start.y}) 到不了。`,
      x: level.goal.x,
      y: level.goal.y,
    })
  }
  return issues
}

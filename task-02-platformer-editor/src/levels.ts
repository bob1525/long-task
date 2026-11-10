import {
  DEFAULT_PHYSICS,
  LEVEL_FORMAT_VERSION,
  TILE_SIZE,
  cloneLevel,
  createLevelId,
  parseLevel,
  type Level,
  type Tile,
  type TileType,
} from './schema'

function row(type: TileType, y: number, x0: number, x1: number, skip: number[] = []): Tile[] {
  const skipSet = new Set(skip)
  const tiles: Tile[] = []
  for (let x = x0; x <= x1; x += 1) {
    if (!skipSet.has(x)) tiles.push({ x, y, type })
  }
  return tiles
}

function build(level: Level): Level {
  return parseLevel(cloneLevel(level))
}

const meadow = build({
  version: LEVEL_FORMAT_VERSION,
  id: 'builtin-meadow',
  name: '晨间小路',
  width: 52,
  height: 16,
  tileSize: TILE_SIZE,
  physics: { ...DEFAULT_PHYSICS },
  start: { x: 2, y: 12 },
  goal: { x: 46, y: 12, requireCoins: 0, requireKeys: 0 },
  tiles: [
    ...row('solid', 13, 0, 51, [20, 21]),
    { x: 20, y: 13, type: 'hazard' },
    { x: 21, y: 13, type: 'hazard' },
    { x: 30, y: 11, type: 'oneWay' },
    { x: 31, y: 11, type: 'oneWay' },
    { x: 32, y: 11, type: 'oneWay' },
  ],
  coins: [
    { x: 8, y: 12 },
    { x: 14, y: 12 },
    { x: 26, y: 12 },
    { x: 36, y: 12 },
  ],
  keys: [],
  enemies: [],
})

const bridge = build({
  version: LEVEL_FORMAT_VERSION,
  id: 'builtin-bridge',
  name: '断桥钥匙',
  width: 58,
  height: 18,
  tileSize: TILE_SIZE,
  physics: { ...DEFAULT_PHYSICS },
  start: { x: 3, y: 14 },
  goal: { x: 50, y: 14, requireCoins: 0, requireKeys: 1 },
  tiles: [
    ...row('solid', 15, 0, 57, [24, 25, 26, 27, 28]),
    ...[24, 25, 26, 27, 28].map((x) => ({ x, y: 15, type: 'hazard' as const })),
    ...row('oneWay', 13, 20, 34),
  ],
  coins: [
    { x: 10, y: 14 },
    { x: 44, y: 14 },
  ],
  keys: [{ x: 40, y: 14 }],
  enemies: [],
})

const patrol = build({
  version: LEVEL_FORMAT_VERSION,
  id: 'builtin-patrol',
  name: '巡逻哨岗',
  width: 60,
  height: 16,
  tileSize: TILE_SIZE,
  physics: { ...DEFAULT_PHYSICS },
  start: { x: 2, y: 12 },
  goal: { x: 52, y: 12, requireCoins: 0, requireKeys: 0 },
  tiles: [
    ...row('solid', 13, 0, 59, [44, 45]),
    { x: 44, y: 13, type: 'hazard' },
    { x: 45, y: 13, type: 'hazard' },
    ...row('oneWay', 11, 30, 33),
    ...row('solid', 10, 8, 10),
  ],
  coins: [
    { x: 12, y: 12 },
    { x: 36, y: 12 },
    { x: 48, y: 12 },
  ],
  keys: [],
  enemies: [{ id: 'sentry', x: 20, y: 12, left: 2, right: 2, speed: 42 }],
})

export const builtinLevels: Level[] = [meadow, bridge, patrol]

export function builtinById(id: string): Level | undefined {
  return builtinLevels.find((level) => level.id === id)
}

export function createEmptyLevel(name = '未命名关卡'): Level {
  return parseLevel({
    version: LEVEL_FORMAT_VERSION,
    id: createLevelId(),
    name,
    width: 28,
    height: 16,
    tileSize: TILE_SIZE,
    physics: { ...DEFAULT_PHYSICS },
    start: { x: 2, y: 11 },
    goal: { x: 20, y: 11, requireCoins: 0, requireKeys: 0 },
    tiles: row('solid', 12, 0, 27),
    coins: [],
    keys: [],
    enemies: [],
  })
}

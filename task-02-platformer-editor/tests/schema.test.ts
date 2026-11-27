import { describe, expect, it } from 'vitest'
import { builtinLevels, createEmptyLevel } from '../src/levels'
import { createSim, runFrames } from '../src/game'
import { LEVEL_FORMAT_VERSION, LevelValidationError, parseLevel, serializeLevel } from '../src/schema'

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: LEVEL_FORMAT_VERSION,
    id: 'sample-level',
    name: '样例',
    width: 12,
    height: 10,
    tileSize: 32,
    physics: { gravity: 1800, jumpHeight: 128, moveSpeed: 200 },
    start: { x: 1, y: 6 },
    goal: { x: 8, y: 6, requireCoins: 0, requireKeys: 0 },
    tiles: [{ x: 1, y: 7, type: 'solid' }],
    coins: [],
    keys: [],
    enemies: [],
    ...overrides,
  }
}

describe('level schema', () => {
  it('round-trips built-in levels and empty levels through JSON', () => {
    for (const level of [...builtinLevels, createEmptyLevel('往返')]) {
      const once = parseLevel(serializeLevel(level))
      const twice = parseLevel(serializeLevel(once))
      expect(twice).toEqual(once)
      expect(serializeLevel(twice)).toBe(serializeLevel(level))
      expect(once.version).toBe(LEVEL_FORMAT_VERSION)
    }
  })

  it('loads editor JSON in the simulator', () => {
    const edited = createEmptyLevel('编辑导出')
    edited.tiles.push({ x: 6, y: 10, type: 'hazard' })
    edited.coins.push({ x: 4, y: 11 })
    const loaded = parseLevel(serializeLevel(edited))
    const state = runFrames(loaded, { left: false, right: true, jump: false, down: false }, 30)
    expect(state.status).toBe('playing')
    expect(state.player.x).toBeGreaterThan(0)
    const sim = createSim(loaded)
    expect(sim.level.name).toBe('编辑导出')
  })

  it('sorts tiles so object key order in the file does not matter', () => {
    const a = parseLevel(base({ tiles: [{ x: 3, y: 4, type: 'hazard' }, { x: 1, y: 7, type: 'solid' }] }))
    const b = parseLevel(base({ tiles: [{ x: 1, y: 7, type: 'solid' }, { x: 3, y: 4, type: 'hazard' }] }))
    expect(serializeLevel(a)).toBe(serializeLevel(b))
  })

  it('reports a readable error for broken JSON', () => {
    expect(() => parseLevel('{')).toThrow(LevelValidationError)
    try {
      parseLevel('{')
    } catch (error) {
      expect(error).toBeInstanceOf(LevelValidationError)
      expect((error as LevelValidationError).message).toContain('JSON 无法解析')
    }
  })

  it('reports version, type, and range problems without throwing a raw exception type', () => {
    const cases: Array<{ input: unknown; text: string }> = [
      { input: null, text: 'JSON 对象' },
      { input: [], text: 'JSON 对象' },
      { input: base({ version: 9 }), text: '不支持的关卡版本 9' },
      { input: base({ version: '1' }), text: '版本号' },
      { input: base({ tileSize: 16 }), text: 'tileSize' },
      { input: base({ tiles: [{ x: 1, y: 7, type: 'lava' }] }), text: 'solid、oneWay 或 hazard' },
      { input: base({ tiles: [{ x: 1, y: 7, type: 'solid' }, { x: 1, y: 7, type: 'hazard' }] }), text: '重叠' },
      { input: base({ physics: { gravity: -1, jumpHeight: 128, moveSpeed: 200 } }), text: 'gravity' },
      { input: base({ enemies: [{ id: '!!', x: 1, y: 1, left: 0, right: 0, speed: 10 }] }), text: 'id' },
      { input: base({ name: '' }), text: 'name' },
      { input: base({ width: 3 }), text: 'width' },
    ]
    for (const entry of cases) {
      let caught: unknown
      try {
        parseLevel(entry.input)
      } catch (error) {
        caught = error
      }
      expect(caught, JSON.stringify(entry.input)).toBeInstanceOf(LevelValidationError)
      expect((caught as LevelValidationError).message).toContain(entry.text)
    }
  })

  it('rejects a non-level payload that would crash a naive cast', () => {
    expect(() => parseLevel('{"tiles":"nope"}')).toThrow(LevelValidationError)
    const bad = parseLevelSafe('{"tiles":"nope"}')
    expect(bad).toContain('tiles')
  })
})

function parseLevelSafe(input: string): string {
  try {
    parseLevel(input)
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

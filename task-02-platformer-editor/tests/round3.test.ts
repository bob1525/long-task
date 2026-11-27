import { describe, expect, it } from 'vitest'
import { copyItems, extendPlatformPath, moveItems, pasteItems, selectInRect } from '../src/edit-ops'
import { createSim, expandScript, runFrames, stepSim, type InputState } from '../src/game'
import { History } from '../src/history'
import { campaignLevels, createEmptyLevel } from '../src/levels'
import { snapAxisPoint } from '../src/motion'
import { FIXED_DT } from '../src/physics'
import { cloneLevel, parseLevel, sameLevel, serializeLevel, type Level } from '../src/schema'
import { LIFT_SCRIPT, MEADOW_SCRIPT } from '../src/scripts'
import { assessLevel } from '../src/validate'

const idle: InputState = { left: false, right: false, jump: false, down: false }
const right: InputState = { left: false, right: true, jump: false, down: false }
const down: InputState = { left: false, right: false, jump: false, down: true }

function floor(width: number, y = 8): Array<{ x: number; y: number; type: 'solid' }> {
  return Array.from({ length: width }, (_, x) => ({ x, y, type: 'solid' as const }))
}

function stage(overrides: Record<string, unknown> = {}): Level {
  return parseLevel({
    version: 1,
    id: 'round3-case',
    name: '用例',
    width: 18,
    height: 14,
    tileSize: 32,
    physics: { gravity: 1800, jumpHeight: 128, moveSpeed: 200 },
    start: { x: 2, y: 7 },
    goal: { x: 15, y: 7, requireCoins: 0, requireKeys: 0 },
    tiles: floor(18),
    coins: [],
    keys: [],
    enemies: [],
    ...overrides,
  })
}

function replay(level: Level, script: readonly InputState[]): ReturnType<typeof createSim> {
  const sim = createSim(level)
  for (const input of script) stepSim(sim, input, FIXED_DT)
  return sim
}

describe('schema v2 migration', () => {
  it('migrates a version 1 meadow and still clears it with the original script', () => {
    const meadow = campaignLevels.find((level) => level.id === 'builtin-meadow')
    if (!meadow) throw new Error('missing meadow')
    const raw = JSON.parse(serializeLevel(meadow)) as Record<string, unknown>
    raw.version = 1
    delete raw.platforms
    delete raw.checkpoints
    const physics = raw.physics as Record<string, unknown>
    delete physics.doubleJump
    const migrated = parseLevel(raw)
    expect(migrated.version).toBe(2)
    expect(migrated.platforms).toEqual([])
    expect(migrated.checkpoints).toEqual([])
    expect(migrated.physics.doubleJump).toBe(false)
    const sim = replay(migrated, expandScript(MEADOW_SCRIPT))
    expect(sim.state.status).toBe('won')
  })

  it('fills v2 defaults when a version 1 file omits the new fields', () => {
    const level = stage()
    expect(level.version).toBe(2)
    expect(level.physics.doubleJump).toBe(false)
    expect(level.platforms).toEqual([])
    expect(level.checkpoints).toEqual([])
  })

  it('treats a version 1 enemy without kind as a patrol with no sight', () => {
    const level = stage({
      enemies: [{ id: 'old-sentry', x: 6, y: 7, left: 2, right: 2, speed: 40 }],
    })
    expect(level.enemies[0]).toMatchObject({ kind: 'patrol', sight: 0, id: 'old-sentry' })
  })

  it('round-trips moving platforms, checkpoints, trackers, and double jump', () => {
    const level = stage({
      version: 2,
      physics: { gravity: 1800, jumpHeight: 128, moveSpeed: 200, doubleJump: true },
      enemies: [{ id: 'hunter', x: 8, y: 7, left: 3, right: 3, speed: 70, kind: 'tracker', sight: 6 }],
      platforms: [{ id: 'ferry', x: 3, y: 8, width: 3, speed: 40, path: [{ x: 3, y: 8 }, { x: 9, y: 8 }] }],
      checkpoints: [{ id: 'mid', x: 5, y: 7 }],
    })
    const again = parseLevel(serializeLevel(level))
    expect(again).toEqual(level)
    expect(again.physics.doubleJump).toBe(true)
    expect(again.enemies[0]?.kind).toBe('tracker')
    expect(again.platforms[0]?.path).toEqual([{ x: 3, y: 8 }, { x: 9, y: 8 }])
    expect(again.checkpoints[0]?.id).toBe('mid')
  })

  it('rejects a moving platform whose path is not axis-aligned', () => {
    expect(() => stage({
      version: 2,
      platforms: [{ id: 'slide', x: 2, y: 6, width: 2, speed: 40, path: [{ x: 2, y: 6 }, { x: 5, y: 8 }] }],
    })).toThrow(/水平或垂直/)
  })
})

describe('moving platforms, trackers, checkpoints, and double jump', () => {
  it('carries a standing player along a horizontal platform', () => {
    const level = stage({
      tiles: floor(18, 12),
      start: { x: 3, y: 7 },
      goal: { x: 15, y: 11, requireCoins: 0, requireKeys: 0 },
      platforms: [{ id: 'ferry', x: 2, y: 8, width: 4, speed: 60, path: [{ x: 2, y: 8 }, { x: 10, y: 8 }] }],
    })
    const sim = createSim(level)
    const startX = sim.state.player.x
    const startY = sim.state.player.y
    expect(sim.state.player.riding).toBe('ferry')
    for (let i = 0; i < 90; i += 1) stepSim(sim, idle, FIXED_DT)
    expect(sim.state.player.riding).toBe('ferry')
    expect(sim.state.player.x).toBeGreaterThan(startX + 25)
    expect(sim.state.player.y).toBeCloseTo(startY, 0)
  })

  it('carries a standing player on a vertical platform', () => {
    const level = stage({
      tiles: floor(18, 12),
      start: { x: 3, y: 9 },
      goal: { x: 15, y: 11, requireCoins: 0, requireKeys: 0 },
      platforms: [{ id: 'lift', x: 2, y: 10, width: 4, speed: 48, path: [{ x: 2, y: 10 }, { x: 2, y: 6 }] }],
    })
    const sim = createSim(level)
    const startY = sim.state.player.y
    expect(sim.state.player.riding).toBe('lift')
    for (let i = 0; i < 90; i += 1) stepSim(sim, idle, FIXED_DT)
    expect(sim.state.player.riding).toBe('lift')
    expect(sim.state.player.y).toBeLessThan(startY - 20)
  })

  it('lets the player walk off a moving platform', () => {
    const level = stage({
      tiles: floor(18, 12),
      start: { x: 2, y: 7 },
      platforms: [{ id: 'ferry', x: 2, y: 8, width: 2, speed: 0, path: [{ x: 2, y: 8 }, { x: 6, y: 8 }] }],
    })
    const sim = createSim(level)
    expect(sim.state.player.riding).toBe('ferry')
    for (let i = 0; i < 180; i += 1) stepSim(sim, right, FIXED_DT)
    expect(sim.state.player.riding).toBeNull()
    expect(sim.state.player.y).toBeGreaterThan(280)
    expect(sim.state.status).toBe('playing')
  })

  it('drops through a moving platform while down is held', () => {
    const level = stage({
      tiles: floor(18, 12),
      start: { x: 3, y: 7 },
      platforms: [{ id: 'ferry', x: 2, y: 8, width: 6, speed: 0, path: [{ x: 2, y: 8 }, { x: 8, y: 8 }] }],
    })
    const sim = createSim(level)
    const startY = sim.state.player.y
    for (let i = 0; i < 40; i += 1) stepSim(sim, down, FIXED_DT)
    expect(sim.state.player.riding).toBeNull()
    expect(sim.state.player.y).toBeGreaterThan(startY + 20)
  })

  it('makes a tracker chase the player inside its sight and vertical band', () => {
    const level = stage({
      start: { x: 2, y: 7 },
      enemies: [{ id: 'hunter', x: 10, y: 7, left: 8, right: 0, speed: 80, kind: 'tracker', sight: 10 }],
    })
    const sim = createSim(level)
    const origin = sim.state.enemies[0]!.x
    for (let i = 0; i < 120; i += 1) stepSim(sim, idle, FIXED_DT)
    expect(sim.state.enemies[0]!.x).toBeLessThan(origin - 40)
    expect(sim.state.enemies[0]!.x).toBeGreaterThanOrEqual(sim.state.enemies[0]!.minX)
  })

  it('keeps a tracker still when the player is outside its sight', () => {
    const level = stage({
      start: { x: 2, y: 7 },
      enemies: [{ id: 'hunter', x: 12, y: 7, left: 6, right: 2, speed: 80, kind: 'tracker', sight: 1 }],
    })
    const sim = createSim(level)
    const origin = sim.state.enemies[0]!.x
    for (let i = 0; i < 120; i += 1) stepSim(sim, idle, FIXED_DT)
    expect(sim.state.enemies[0]!.x).toBeCloseTo(origin, 5)
  })

  it('loses when a tracker overlaps the player', () => {
    const lost = runFrames(stage({
      enemies: [{ id: 'hunter', x: 2, y: 7, left: 0, right: 0, speed: 0, kind: 'tracker', sight: 4 }],
    }), idle, 5)
    expect(lost.status).toBe('lost')
    expect(lost.lossReason).toBe('enemy')
  })

  it('keeps patrol enemies on their route instead of chasing', () => {
    const level = stage({
      start: { x: 2, y: 7 },
      enemies: [{ id: 'sentry', x: 10, y: 7, left: 2, right: 2, speed: 80, kind: 'patrol', sight: 0 }],
    })
    const sim = createSim(level)
    const origin = sim.state.enemies[0]!.x
    for (let i = 0; i < 30; i += 1) stepSim(sim, idle, FIXED_DT)
    expect(sim.state.enemies[0]!.x).toBeGreaterThan(origin)
    expect(sim.state.enemies[0]!.x).toBeLessThanOrEqual(sim.state.enemies[0]!.maxX)
  })

  it('respawns at the latest checkpoint and keeps collected coins', () => {
    const tiles = floor(18).map((tile) => tile.x === 8 ? { ...tile, type: 'hazard' as const } : tile)
    const level = stage({
      tiles,
      coins: [{ x: 5, y: 7 }],
      checkpoints: [{ id: 'home', x: 2, y: 7 }],
    })
    const sim = createSim(level)
    for (let i = 0; i < 240 && sim.state.status === 'playing' && sim.state.coinsCollected === 0; i += 1) stepSim(sim, right, FIXED_DT)
    expect(sim.state.coinsCollected).toBe(1)
    expect(sim.state.activeCheckpoint).toBe('home')
    let respawned = false
    for (let i = 0; i < 360; i += 1) {
      const before = sim.state.player.x
      stepSim(sim, right, FIXED_DT)
      if (sim.state.player.x < before - 48) respawned = true
      if (respawned) break
    }
    expect(respawned).toBe(true)
    expect(sim.state.status).toBe('playing')
    expect(sim.state.coinsCollected).toBe(1)
    expect(sim.state.lossReason).toBeUndefined()
    expect(sim.state.player.x).toBeLessThan(level.tileSize * 4)
  })

  it('still loses on a hazard when no checkpoint has been touched', () => {
    const tiles = floor(18).map((tile) => tile.x === 6 ? { ...tile, type: 'hazard' as const } : tile)
    const lost = runFrames(stage({ tiles, start: { x: 4, y: 7 } }), right, 180)
    expect(lost.status).toBe('lost')
    expect(lost.lossReason).toBe('hazard')
  })

  it('reaches a higher apex when double jump is enabled', () => {
    const peak = (enabled: boolean, second: boolean): number => {
      const level = stage({
        height: 20,
        tiles: floor(18, 16),
        start: { x: 4, y: 15 },
        goal: { x: 12, y: 15, requireCoins: 0, requireKeys: 0 },
        physics: { gravity: 1800, jumpHeight: 128, moveSpeed: 200, doubleJump: enabled },
      })
      const sim = createSim(level)
      let best = sim.state.player.y
      let phase: 'first' | 'gap' | 'second' | 'done' = 'first'
      let held = 0
      for (let i = 0; i < 360; i += 1) {
        let jump = false
        if (phase === 'first') {
          jump = true
          held += 1
          if (held >= 12) {
            phase = 'gap'
            held = 0
          }
        } else if (phase === 'gap') {
          held += 1
          if (second && held > 2 && sim.state.player.vy > 20 && sim.state.player.airJumps > 0) {
            phase = 'second'
            held = 0
          } else if (held > 90) phase = 'done'
        } else if (phase === 'second') {
          jump = true
          held += 1
          if (held >= 16) phase = 'done'
        }
        stepSim(sim, { left: false, right: false, jump, down: false }, FIXED_DT)
        best = Math.min(best, sim.state.player.y)
      }
      return best
    }
    const single = peak(false, true)
    const doubled = peak(true, true)
    expect(doubled).toBeLessThan(single - 60)
  })

  it('ignores a second jump press when double jump is off', () => {
    const level = stage({ physics: { gravity: 1800, jumpHeight: 128, moveSpeed: 200, doubleJump: false } })
    const once = createSim(level)
    const twice = createSim(cloneLevel(level))
    let bestOnce = once.state.player.y
    let bestTwice = twice.state.player.y
    let fired = false
    for (let i = 0; i < 240; i += 1) {
      stepSim(once, { left: false, right: false, jump: i === 0, down: false }, FIXED_DT)
      const extra = !fired && i > 5 && twice.state.player.vy > 0 && !twice.state.player.onGround
      if (extra) fired = true
      stepSim(twice, { left: false, right: false, jump: i === 0 || extra, down: false }, FIXED_DT)
      bestOnce = Math.min(bestOnce, once.state.player.y)
      bestTwice = Math.min(bestTwice, twice.state.player.y)
    }
    expect(fired).toBe(true)
    expect(bestTwice).toBeCloseTo(bestOnce, 0)
  })
})

describe('editor selection, paths, and validation', () => {
  it('selects every object inside a dragged rectangle', () => {
    const level = stage({
      coins: [{ x: 4, y: 7 }, { x: 6, y: 7 }, { x: 12, y: 7 }],
      checkpoints: [{ id: 'home', x: 5, y: 7 }],
    })
    const selected = selectInRect(level, 4, 6, 6, 8)
    expect(selected).toEqual(expect.arrayContaining([
      { kind: 'coin', x: 4, y: 7 },
      { kind: 'coin', x: 6, y: 7 },
      { kind: 'checkpoint', id: 'home' },
    ]))
    expect(selected.some((item) => item.kind === 'coin' && item.x === 12)).toBe(false)
  })

  it('copies a selection and pastes it with new ids', () => {
    const level = stage({
      coins: [{ x: 4, y: 7 }],
      enemies: [{ id: 'sentry', x: 6, y: 7, left: 1, right: 1, speed: 40, kind: 'patrol', sight: 0 }],
    })
    const clipboard = copyItems(level, [
      { kind: 'coin', x: 4, y: 7 },
      { kind: 'enemy', id: 'sentry' },
    ])
    const pasted = pasteItems(level, clipboard, 10, 7)
    expect(level.coins).toEqual(expect.arrayContaining([{ x: 4, y: 7 }, { x: 10, y: 7 }]))
    expect(level.enemies).toHaveLength(2)
    expect(level.enemies.map((enemy) => enemy.id).sort()).not.toEqual(['sentry', 'sentry'])
    expect(pasted.some((item) => item.kind === 'enemy' && item.id !== 'sentry')).toBe(true)
  })

  it('moves a selection together and supports undo plus redo', () => {
    const level = stage({ coins: [{ x: 4, y: 7 }, { x: 6, y: 7 }] })
    const history = new History(level, 20, cloneLevel, sameLevel)
    history.begin()
    const moved = moveItems(history.current(), [
      { kind: 'coin', x: 4, y: 7 },
      { kind: 'coin', x: 6, y: 7 },
    ], 2, 0)
    history.end()
    expect(moved).toEqual([
      { kind: 'coin', x: 6, y: 7 },
      { kind: 'coin', x: 8, y: 7 },
    ])
    expect(history.undo()).toBe(true)
    expect(history.current().coins).toEqual([{ x: 4, y: 7 }, { x: 6, y: 7 }])
    expect(history.redo()).toBe(true)
    expect(history.current().coins).toEqual([{ x: 6, y: 7 }, { x: 8, y: 7 }])
  })

  it('snaps a drawn platform path onto a horizontal or vertical segment', () => {
    expect(snapAxisPoint({ x: 4, y: 10 }, 8, 7)).toEqual({ x: 8, y: 10 })
    expect(snapAxisPoint({ x: 4, y: 10 }, 5, 6)).toEqual({ x: 4, y: 6 })
    const level = stage({
      platforms: [{ id: 'ferry', x: 4, y: 10, width: 3, speed: 36, path: [{ x: 4, y: 10 }, { x: 8, y: 10 }] }],
    })
    const platform = level.platforms[0]!
    expect(extendPlatformPath(platform, 9, 6, level.width, level.height)).toBe(true)
    expect(platform.path[platform.path.length - 1]).toEqual({ x: 8, y: 6 })
    expect(extendPlatformPath(platform, 8, 6, level.width, level.height)).toBe(false)
  })

  it('names the goal cell when the goal cannot be reached from the start', () => {
    const level = stage({
      width: 24,
      start: { x: 1, y: 7 },
      goal: { x: 20, y: 7, requireCoins: 0, requireKeys: 0 },
      physics: { gravity: 1800, jumpHeight: 32, moveSpeed: 80, doubleJump: false },
      tiles: [{ x: 1, y: 8, type: 'solid' }, { x: 20, y: 8, type: 'solid' }],
    })
    const issues = assessLevel(level)
    const issue = issues.find((entry) => entry.message.includes('到不了'))
    expect(issue).toBeTruthy()
    expect(issue?.message).toContain('(20, 7)')
    expect(issue?.message).toContain('(1, 7)')
    expect(issue).toMatchObject({ x: 20, y: 7 })
  })

  it('names the goal when there are fewer keys than requireKeys', () => {
    const level = stage({ goal: { x: 15, y: 7, requireCoins: 0, requireKeys: 2 } })
    const issue = assessLevel(level).find((entry) => entry.message.includes('钥匙'))
    expect(issue?.message).toContain('(15, 7)')
    expect(issue?.message).toContain('2')
    expect(issue).toMatchObject({ x: 15, y: 7 })
  })

  it('accepts every built-in level and a fresh empty level', () => {
    for (const level of [...campaignLevels, createEmptyLevel('空白')]) {
      expect(assessLevel(level), level.name).toEqual([])
    }
    expect(campaignLevels.map((level) => level.id)).toContain('builtin-lift')
  })
})

describe('fourth built-in level', () => {
  it('clears 升降栈桥 twice with the same position and time', () => {
    const level = campaignLevels.find((entry) => entry.id === 'builtin-lift')
    if (!level) throw new Error('missing lift')
    expect(level.platforms.map((platform) => platform.id).sort()).toEqual(['ferry', 'lift'])
    expect(level.checkpoints).toEqual([{ id: 'mid', x: 24, y: 13 }])
    expect(level.enemies[0]).toMatchObject({ kind: 'tracker' })
    expect(level.physics.doubleJump).toBe(true)
    const play = () => {
      const sim = createSim(cloneLevel(level))
      let ferry = false
      let lift = false
      let checkpoint = false
      for (const input of expandScript(LIFT_SCRIPT)) {
        stepSim(sim, input, FIXED_DT)
        if (sim.state.player.riding === 'ferry') ferry = true
        if (sim.state.player.riding === 'lift') lift = true
        if (sim.state.activeCheckpoint === 'mid') checkpoint = true
      }
      return { sim, ferry, lift, checkpoint }
    }
    const first = play()
    const second = play()
    expect(first.ferry).toBe(true)
    expect(first.lift).toBe(true)
    expect(first.checkpoint).toBe(true)
    expect(first.sim.state.status).toBe('won')
    expect(second.sim.state.status).toBe('won')
    expect(second.sim.state.player.x).toBe(first.sim.state.player.x)
    expect(second.sim.state.player.y).toBe(first.sim.state.player.y)
    expect(second.sim.state.time).toBe(first.sim.state.time)
  })
})

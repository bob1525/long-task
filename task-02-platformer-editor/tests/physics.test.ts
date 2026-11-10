import { describe, expect, it } from 'vitest'
import { createSim, runFrames, stepSim, type InputState } from '../src/game'
import { builtinById } from '../src/levels'
import {
  FIXED_DT,
  PLAYER_H,
  PLAYER_W,
  TileIndex,
  advanceAccumulator,
  moveBody,
  type Body,
  type TileWorld,
} from '../src/physics'
import { parseLevel, type Tile } from '../src/schema'

const right: InputState = { left: false, right: true, jump: false, down: false }

function world(tiles: Tile[], width = 40, height = 30): TileIndex {
  const source: TileWorld = { tileSize: 32, width, height, tiles }
  return new TileIndex(source)
}

function body(x: number, y: number, vx = 0, vy = 0): Body {
  return { x, y, w: PLAYER_W, h: PLAYER_H, vx, vy }
}

describe('collision', () => {
  it('stops a high-speed horizontal move on a one-tile wall', () => {
    const index = world([{ x: 10, y: 5, type: 'solid' }])
    const actor = body(40, 5 * 32 + 2)
    const moved = moveBody(actor, 500, 0, index)
    expect(moved.hitWall).toBe(true)
    expect(actor.x + actor.w).toBeLessThanOrEqual(10 * 32)
    expect(actor.x + actor.w).toBeGreaterThan(10 * 32 - 1)
  })

  it('lands on a solid floor instead of tunneling through it', () => {
    const index = world([{ x: 4, y: 12, type: 'solid' }])
    const actor = body(4 * 32 + 4, 0)
    const moved = moveBody(actor, 0, 800, index)
    expect(moved.onGround).toBe(true)
    expect(actor.y + actor.h).toBeCloseTo(12 * 32, 2)
    expect(actor.y + actor.h).toBeLessThanOrEqual(12 * 32 + 0.01)
  })

  it('lands on a thin one-way platform during a high-speed fall', () => {
    const index = world([
      { x: 5, y: 10, type: 'oneWay' },
      { x: 5, y: 20, type: 'solid' },
    ])
    const actor = body(5 * 32 + 4, 40)
    const moved = moveBody(actor, 0, 900, index)
    expect(moved.onGround).toBe(true)
    expect(actor.y + actor.h).toBeCloseTo(10 * 32, 2)
    expect(moved.hazard).toBe(false)
  })

  it('passes upward through a one-way platform', () => {
    const top = 8 * 32
    const index = world([{ x: 3, y: 8, type: 'oneWay' }])
    const actor = body(3 * 32 + 4, top + 20)
    const moved = moveBody(actor, 0, -160, index)
    expect(moved.onGround).toBe(false)
    expect(moved.hitCeiling).toBe(false)
    expect(actor.y).toBeCloseTo(top + 20 - 160, 2)
    expect(actor.y + actor.h).toBeLessThan(top)
  })

  it('does not pull a body up onto a one-way platform from below', () => {
    const top = 8 * 32
    const index = world([{ x: 3, y: 8, type: 'oneWay' }])
    const startFeet = top + 24
    const actor = body(3 * 32 + 4, startFeet - PLAYER_H)
    const moved = moveBody(actor, 0, 40, index)
    expect(moved.onGround).toBe(false)
    expect(actor.y + actor.h).toBeCloseTo(startFeet + 40, 2)
  })

  it('blocks a jump with a solid ceiling', () => {
    const index = world([
      { x: 2, y: 4, type: 'solid' },
      { x: 2, y: 8, type: 'solid' },
    ])
    const actor = body(2 * 32 + 4, 8 * 32 - PLAYER_H)
    const moved = moveBody(actor, 0, -300, index)
    expect(moved.hitCeiling).toBe(true)
    expect(actor.y).toBeGreaterThanOrEqual(5 * 32 - 0.05)
  })

  it('drops through a one-way platform when ignoreOneWay is set', () => {
    const top = 6 * 32
    const index = world([{ x: 2, y: 6, type: 'oneWay' }])
    const actor = body(2 * 32 + 4, top - PLAYER_H)
    const moved = moveBody(actor, 0, 80, index, { ignoreOneWay: true })
    expect(moved.onGround).toBe(false)
    expect(actor.y + actor.h).toBeCloseTo(top + 80, 2)
  })

  it('kills when a fast fall sweeps through a hazard and does not treat hazard as solid', () => {
    const index = world([{ x: 6, y: 8, type: 'hazard' }])
    const actor = body(6 * 32 + 4, 8 * 32 - 180)
    const moved = moveBody(actor, 0, 360, index)
    expect(moved.hazard).toBe(true)
    expect(moved.onGround).toBe(false)
    expect(actor.y + actor.h).toBeGreaterThan(8 * 32 + 20)
  })

  it('does not count a hazard buried under a solid floor', () => {
    const index = world([
      { x: 3, y: 10, type: 'solid' },
      { x: 3, y: 11, type: 'hazard' },
    ])
    const actor = body(3 * 32 + 4, 10 * 32 - 240)
    const moved = moveBody(actor, 0, 500, index)
    expect(moved.onGround).toBe(true)
    expect(moved.hazard).toBe(false)
    expect(actor.y + actor.h).toBeCloseTo(10 * 32, 2)
  })

  it('keeps a constant foot line while running across tile seams', () => {
    const tiles: Tile[] = []
    for (let x = 0; x < 30; x += 1) tiles.push({ x, y: 10, type: 'solid' })
    const index = world(tiles, 40, 20)
    const actor = body(8, 10 * 32 - PLAYER_H)
    const feet = actor.y + actor.h
    for (let i = 0; i < 180; i += 1) {
      moveBody(actor, 3.2, 2, index)
    }
    expect(actor.y + actor.h).toBeCloseTo(feet, 2)
    expect(actor.x).toBeGreaterThan(400)
  })

  it('runs from solid ground onto a same-height one-way bridge', () => {
    const tiles: Tile[] = []
    for (let x = 0; x < 8; x += 1) tiles.push({ x, y: 10, type: 'solid' })
    for (let x = 8; x < 14; x += 1) tiles.push({ x, y: 10, type: 'oneWay' })
    for (let x = 14; x < 20; x += 1) tiles.push({ x, y: 10, type: 'solid' })
    const index = world(tiles, 30, 20)
    const actor = body(20, 10 * 32 - PLAYER_H)
    for (let i = 0; i < 200; i += 1) moveBody(actor, 2.4, 3, index)
    expect(actor.y + actor.h).toBeCloseTo(10 * 32, 2)
    expect(actor.x).toBeGreaterThan(14 * 32)
  })
})

describe('simulation rules', () => {
  it('loses when the player falls through a hazard', () => {
    const tiles: Tile[] = []
    for (let x = 0; x < 12; x += 1) tiles.push({ x, y: 7, type: 'hazard' })
    const hazard = parseLevel({
      version: 1,
      id: 'hazard-case',
      name: '危险',
      width: 12,
      height: 12,
      tileSize: 32,
      physics: { gravity: 1800, jumpHeight: 128, moveSpeed: 200 },
      start: { x: 4, y: 3 },
      goal: { x: 10, y: 2, requireCoins: 0, requireKeys: 0 },
      tiles,
      coins: [],
      keys: [],
      enemies: [],
    })
    const hazardState = runFrames(hazard, { ...right, right: false }, 120)
    expect(hazardState.status).toBe('lost')
    expect(hazardState.lossReason).toBe('hazard')
  })

  it('loses when the player overlaps an enemy or an enemy walks into them', () => {
    const tiles: Tile[] = []
    for (let x = 0; x < 16; x += 1) tiles.push({ x, y: 8, type: 'solid' })
    const overlap = parseLevel({
      version: 1,
      id: 'enemy-overlap',
      name: '敌人重叠',
      width: 16,
      height: 12,
      tileSize: 32,
      physics: { gravity: 1800, jumpHeight: 128, moveSpeed: 200 },
      start: { x: 4, y: 7 },
      goal: { x: 12, y: 7, requireCoins: 0, requireKeys: 0 },
      tiles,
      coins: [],
      keys: [],
      enemies: [{ id: 'e1', x: 4, y: 7, left: 0, right: 0, speed: 0 }],
    })
    const overlapped = runFrames(overlap, { ...right, right: false }, 3)
    expect(overlapped.status).toBe('lost')
    expect(overlapped.lossReason).toBe('enemy')

    const walker = parseLevel({
      ...overlap,
      id: 'enemy-walk',
      start: { x: 2, y: 7 },
      enemies: [{ id: 'e1', x: 6, y: 7, left: 4, right: 0, speed: 220 }],
    })
    const walked = runFrames(walker, { ...right, right: false }, 180)
    expect(walked.status).toBe('lost')
    expect(walked.lossReason).toBe('enemy')
  })

  it('loses when the player falls out of the level', () => {
    const pit = parseLevel({
      version: 1,
      id: 'pit-case',
      name: '坠坑',
      width: 16,
      height: 10,
      tileSize: 32,
      physics: { gravity: 1800, jumpHeight: 128, moveSpeed: 200 },
      start: { x: 2, y: 2 },
      goal: { x: 12, y: 6, requireCoins: 0, requireKeys: 0 },
      tiles: [{ x: 8, y: 9, type: 'solid' }],
      coins: [],
      keys: [],
      enemies: [],
    })
    const pitState = runFrames(pit, { ...right, right: false }, 240)
    expect(pitState.status).toBe('lost')
    expect(pitState.lossReason).toBe('fall')
  })

  it('lets the player jump over a stationary enemy', () => {
    const tiles: Tile[] = []
    for (let x = 0; x < 24; x += 1) tiles.push({ x, y: 10, type: 'solid' })
    const level = parseLevel({
      version: 1,
      id: 'jump-enemy',
      name: '越过敌人',
      width: 24,
      height: 14,
      tileSize: 32,
      physics: { gravity: 1800, jumpHeight: 128, moveSpeed: 200 },
      start: { x: 2, y: 9 },
      goal: { x: 20, y: 9, requireCoins: 0, requireKeys: 0 },
      tiles,
      coins: [],
      keys: [],
      enemies: [{ id: 'blocker', x: 8, y: 9, left: 0, right: 0, speed: 0 }],
    })
    const sim = createSim(level)
    const groundY = sim.state.player.y
    let apex = groundY
    for (let i = 0; i < 500 && sim.state.status === 'playing'; i += 1) {
      const close = sim.state.player.x > 8 * 32 - 48 && sim.state.player.x < 8 * 32 + 80
      const jumping = close && i < 420
      stepSim(sim, { ...right, jump: jumping && sim.state.player.onGround || (jumping && sim.state.player.y < groundY) })
      apex = Math.min(apex, sim.state.player.y)
    }
    expect(sim.state.status, sim.state.lossReason).toBe('won')
    expect(apex).toBeLessThan(groundY - 40)
  })

  it('collects coins and keys, and the goal stays shut until both requirements are met', () => {
    const tiles: Tile[] = []
    for (let x = 0; x < 22; x += 1) tiles.push({ x, y: 8, type: 'solid' })
    const blockedLevel = parseLevel({
      version: 1,
      id: 'goal-blocked',
      name: '未集齐',
      width: 22,
      height: 12,
      tileSize: 32,
      physics: { gravity: 1800, jumpHeight: 128, moveSpeed: 220 },
      start: { x: 1, y: 7 },
      goal: { x: 8, y: 7, requireCoins: 1, requireKeys: 1 },
      tiles,
      coins: [{ x: 4, y: 7 }],
      keys: [{ x: 14, y: 7 }],
      enemies: [],
    })
    const blockedSim = createSim(blockedLevel)
    let blocked: string | null = null
    for (let i = 0; i < 200; i += 1) {
      stepSim(blockedSim, right)
      if (blockedSim.state.goalBlocked) blocked = blockedSim.state.goalBlocked
    }
    expect(blockedSim.state.coinsCollected).toBe(1)
    expect(blockedSim.state.keysCollected).toBe(0)
    expect(blocked).toBe('keys')
    expect(blockedSim.state.status).toBe('playing')

    const clearLevel = parseLevel({
      ...blockedLevel,
      id: 'goal-clear',
      keys: [{ x: 6, y: 7 }],
    })
    const clearSim = createSim(clearLevel)
    for (let i = 0; i < 240 && clearSim.state.status === 'playing'; i += 1) stepSim(clearSim, right)
    expect(clearSim.state.coinsCollected).toBe(1)
    expect(clearSim.state.keysCollected).toBe(1)
    expect(clearSim.state.status).toBe('won')
  })

  it('reaches the chosen jump height and move speed', () => {
    const meadow = builtinById('builtin-meadow')
    if (!meadow) throw new Error('missing meadow')
    const jumpSim = createSim(meadow)
    const startFeet = jumpSim.state.player.y + jumpSim.state.player.h
    stepSim(jumpSim, { ...right, right: false, jump: true })
    let apex = jumpSim.state.player.y
    for (let i = 0; i < 90; i += 1) {
      stepSim(jumpSim, { left: false, right: false, jump: true, down: false })
      apex = Math.min(apex, jumpSim.state.player.y)
    }
    const height = startFeet - (apex + jumpSim.state.player.h)
    expect(height).toBeGreaterThan(120)
    expect(height).toBeLessThan(136)

    const runSim = createSim(meadow)
    const startX = runSim.state.player.x
    for (let i = 0; i < 120; i += 1) stepSim(runSim, right)
    const distance = runSim.state.player.x - startX
    expect(distance).toBeGreaterThan(190)
    expect(distance).toBeLessThan(210)
  })

  it('keeps the same displacement when a second of time is split into 30, 60, or 120 fps', () => {
    const meadow = builtinById('builtin-meadow')
    if (!meadow) throw new Error('missing meadow')
    const run = (frameDt: number, frames: number) => {
      const sim = createSim(meadow)
      let acc = 0
      for (let i = 0; i < frames; i += 1) {
        const advanced = advanceAccumulator(acc, frameDt)
        acc = advanced.accumulator
        for (let step = 0; step < advanced.steps; step += 1) stepSim(sim, right, FIXED_DT)
      }
      return sim.state.player.x
    }
    const fast = run(1 / 120, 120)
    const mid = run(1 / 60, 60)
    const slow = run(1 / 30, 30)
    expect(Math.abs(fast - mid)).toBeLessThan(2)
    expect(Math.abs(fast - slow)).toBeLessThan(2)
  })
})

import type { Level, PhysicsConfig } from './schema'
import {
  AIR_ACCEL,
  COYOTE_TIME,
  ENEMY_H,
  ENEMY_W,
  FALL_GRAVITY_MULTIPLIER,
  FIXED_DT,
  GROUND_ACCEL,
  JUMP_BUFFER,
  MAX_FALL_SPEED,
  PLAYER_H,
  PLAYER_W,
  RELEASE_GRAVITY_MULTIPLIER,
  TileIndex,
  jumpSpeed,
  moveBody,
  overlaps,
  probeGroundBody,
  separateUpward,
  sweptRect,
  type Body,
  type Rect,
} from './physics'

export interface InputState {
  left: boolean
  right: boolean
  jump: boolean
  down: boolean
}

export const IDLE_INPUT: InputState = { left: false, right: false, jump: false, down: false }

export interface PlayerState extends Body {
  facing: 1 | -1
  onGround: boolean
  coyote: number
  jumpBuffer: number
  jumpWasDown: boolean
}

export interface EnemyState extends Rect {
  id: string
  dir: 1 | -1
  minX: number
  maxX: number
  speed: number
}

export interface CollectibleState extends Rect {
  tileX: number
  tileY: number
  taken: boolean
}

export type LossReason = 'hazard' | 'enemy' | 'fall'

export interface GameState {
  player: PlayerState
  enemies: EnemyState[]
  coins: CollectibleState[]
  keys: CollectibleState[]
  coinsCollected: number
  keysCollected: number
  status: 'playing' | 'won' | 'lost'
  lossReason?: LossReason
  goalBlocked: 'coins' | 'keys' | null
  time: number
}

export interface Sim {
  level: Level
  physics: PhysicsConfig
  world: TileIndex
  state: GameState
}

function collectibleBox(tileX: number, tileY: number, tileSize: number): CollectibleState {
  const inset = 8
  return {
    x: tileX * tileSize + inset,
    y: tileY * tileSize + inset,
    w: tileSize - inset * 2,
    h: tileSize - inset * 2,
    tileX,
    tileY,
    taken: false,
  }
}

export function spawnEnemy(level: Level, id: string, tileX: number, tileY: number, left: number, right: number, speed: number): EnemyState {
  const tileSize = level.tileSize
  const x = tileX * tileSize + (tileSize - ENEMY_W) / 2
  const y = tileY * tileSize + tileSize - ENEMY_H
  const minX = (tileX - left) * tileSize
  const maxX = (tileX + right) * tileSize + (tileSize - ENEMY_W)
  return {
    id,
    x: Math.min(Math.max(x, minX), maxX),
    y,
    w: ENEMY_W,
    h: ENEMY_H,
    dir: 1,
    minX,
    maxX: Math.max(minX, maxX),
    speed,
  }
}

export function createGameState(level: Level): GameState {
  const world = new TileIndex(level)
  const player: PlayerState = {
    x: level.start.x * level.tileSize + (level.tileSize - PLAYER_W) / 2,
    y: level.start.y * level.tileSize + level.tileSize - PLAYER_H,
    w: PLAYER_W,
    h: PLAYER_H,
    vx: 0,
    vy: 0,
    facing: 1,
    onGround: false,
    coyote: 0,
    jumpBuffer: 0,
    jumpWasDown: false,
  }
  separateUpward(player, world)
  player.onGround = probeGround(player, world)
  player.coyote = player.onGround ? COYOTE_TIME : 0
  return {
    player,
    enemies: level.enemies.map((enemy) => spawnEnemy(level, enemy.id, enemy.x, enemy.y, enemy.left, enemy.right, enemy.speed)),
    coins: level.coins.map((coin) => collectibleBox(coin.x, coin.y, level.tileSize)),
    keys: level.keys.map((key) => collectibleBox(key.x, key.y, level.tileSize)),
    coinsCollected: 0,
    keysCollected: 0,
    status: 'playing',
    goalBlocked: null,
    time: 0,
  }
}

export function probeGround(body: Body, world: TileIndex): boolean {
  return probeGroundBody(body, world)
}

export function createSim(level: Level, physics: PhysicsConfig = level.physics): Sim {
  return {
    level,
    physics,
    world: new TileIndex(level),
    state: createGameState(level),
  }
}

function rectOf(body: Rect): Rect {
  return { x: body.x, y: body.y, w: body.w, h: body.h }
}

function enemyTouches(player: Rect, enemies: readonly EnemyState[]): boolean {
  return enemies.some((enemy) => overlaps(player, enemy, 0.1))
}

export function stepSim(sim: Sim, input: InputState, dt = FIXED_DT): void {
  const { state, world, level } = sim
  const physics = sim.physics
  if (state.status !== 'playing') return
  state.time += dt

  const jumpPressed = input.jump && !state.player.jumpWasDown
  state.player.jumpWasDown = input.jump
  if (jumpPressed) state.player.jumpBuffer = JUMP_BUFFER
  else state.player.jumpBuffer = Math.max(0, state.player.jumpBuffer - dt)

  const canJump = state.player.onGround || state.player.coyote > 0
  let jumped = false
  if (state.player.jumpBuffer > 0 && canJump && state.player.vy >= 0) {
    state.player.vy = -jumpSpeed(physics.gravity, physics.jumpHeight)
    state.player.jumpBuffer = 0
    state.player.coyote = 0
    state.player.onGround = false
    jumped = true
  }

  const target = (input.right ? 1 : 0) - (input.left ? 1 : 0)
  if (target > 0) state.player.facing = 1
  if (target < 0) state.player.facing = -1
  const desired = target * physics.moveSpeed
  const accel = (state.player.onGround ? GROUND_ACCEL : AIR_ACCEL) * dt
  if (state.player.vx < desired) state.player.vx = Math.min(desired, state.player.vx + accel)
  else if (state.player.vx > desired) state.player.vx = Math.max(desired, state.player.vx - accel)

  let gravity = physics.gravity
  if (!jumped && state.player.vy > 0) gravity *= FALL_GRAVITY_MULTIPLIER
  else if (!jumped && !input.jump && state.player.vy < 0) gravity *= RELEASE_GRAVITY_MULTIPLIER

  const vy0 = state.player.vy
  if (jumped) {
    state.player.vy = -jumpSpeed(physics.gravity, physics.jumpHeight)
  } else {
    state.player.vy = Math.min(MAX_FALL_SPEED, vy0 + gravity * dt)
  }
  const dy = jumped ? state.player.vy * dt : ((vy0 + state.player.vy) * 0.5) * dt
  const dx = state.player.vx * dt

  for (const enemy of state.enemies) {
    enemy.x += enemy.dir * enemy.speed * dt
    if (enemy.x <= enemy.minX) {
      enemy.x = enemy.minX
      enemy.dir = 1
    } else if (enemy.x >= enemy.maxX) {
      enemy.x = enemy.maxX
      enemy.dir = -1
    }
  }

  const prevX = state.player.x
  const prevY = state.player.y
  const moved = moveBody(state.player, dx, dy, world, { ignoreOneWay: input.down })
  if (moved.onGround && state.player.vy > 0) state.player.vy = 0
  if (moved.hitCeiling && state.player.vy < 0) state.player.vy = 0
  state.player.onGround = moved.onGround
  if (moved.onGround) state.player.coyote = COYOTE_TIME
  else if (!jumped) state.player.coyote = Math.max(0, state.player.coyote - dt)

  const horizontalSweep = sweptRect(prevX, prevY, state.player.x, prevY, state.player.w, state.player.h)
  const verticalSweep = sweptRect(state.player.x, prevY, state.player.x, state.player.y, state.player.w, state.player.h)
  const hitEnemy =
    enemyTouches(rectOf(state.player), state.enemies) ||
    state.enemies.some((enemy) => overlaps(horizontalSweep, enemy, 0.1) || overlaps(verticalSweep, enemy, 0.1))

  if (moved.hazard) {
    state.status = 'lost'
    state.lossReason = 'hazard'
    return
  }
  if (hitEnemy) {
    state.status = 'lost'
    state.lossReason = 'enemy'
    return
  }
  if (state.player.y > world.pixelHeight + 8) {
    state.status = 'lost'
    state.lossReason = 'fall'
    return
  }

  for (const coin of state.coins) {
    if (!coin.taken && overlaps(state.player, coin, 0)) {
      coin.taken = true
      state.coinsCollected += 1
    }
  }
  for (const key of state.keys) {
    if (!key.taken && overlaps(state.player, key, 0)) {
      key.taken = true
      state.keysCollected += 1
    }
  }

  const goal: Rect = {
    x: level.goal.x * level.tileSize,
    y: level.goal.y * level.tileSize,
    w: level.tileSize,
    h: level.tileSize,
  }
  if (overlaps(state.player, goal, 0)) {
    if (state.coinsCollected < level.goal.requireCoins) state.goalBlocked = 'coins'
    else if (state.keysCollected < level.goal.requireKeys) state.goalBlocked = 'keys'
    else {
      state.goalBlocked = null
      state.status = 'won'
    }
  } else {
    state.goalBlocked = null
  }
}

export interface ScriptSegment {
  frames: number
  left?: boolean
  right?: boolean
  jump?: boolean
  down?: boolean
}

export function expandScript(script: readonly ScriptSegment[]): InputState[] {
  const frames: InputState[] = []
  for (const segment of script) {
    const input: InputState = {
      left: Boolean(segment.left),
      right: Boolean(segment.right),
      jump: Boolean(segment.jump),
      down: Boolean(segment.down),
    }
    for (let i = 0; i < segment.frames; i += 1) frames.push(input)
  }
  return frames
}

export function compressInputs(frames: readonly InputState[]): ScriptSegment[] {
  const segments: ScriptSegment[] = []
  for (const frame of frames) {
    const last = segments[segments.length - 1]
    if (
      last &&
      Boolean(last.left) === frame.left &&
      Boolean(last.right) === frame.right &&
      Boolean(last.jump) === frame.jump &&
      Boolean(last.down) === frame.down
    ) {
      last.frames += 1
    } else {
      segments.push({
        frames: 1,
        left: frame.left,
        right: frame.right,
        jump: frame.jump,
        down: frame.down,
      })
    }
  }
  return segments
}

export interface SimTrace {
  state: GameState
  trace: string[]
}

export function simulate(level: Level, script: readonly ScriptSegment[], dt = FIXED_DT): SimTrace {
  const sim = createSim(level)
  const frames = expandScript(script)
  const trace: string[] = []
  const log = (index: number) => {
    const player = sim.state.player
    trace.push(
      `${index} x=${player.x.toFixed(1)} y=${player.y.toFixed(1)} vx=${player.vx.toFixed(1)} vy=${player.vy.toFixed(1)} g=${player.onGround ? 1 : 0} c=${sim.state.coinsCollected} k=${sim.state.keysCollected} ${sim.state.status}${sim.state.lossReason ? `:${sim.state.lossReason}` : ''}`,
    )
  }
  log(0)
  for (let i = 0; i < frames.length; i += 1) {
    stepSim(sim, frames[i]!, dt)
    if (i % 20 === 19 || sim.state.status !== 'playing') log(i + 1)
    if (sim.state.status !== 'playing') break
  }
  return { state: sim.state, trace }
}

export function runFrames(level: Level, input: InputState, steps: number, dt = FIXED_DT): GameState {
  const sim = createSim(level)
  for (let i = 0; i < steps; i += 1) {
    stepSim(sim, input, dt)
    if (sim.state.status !== 'playing') break
  }
  return sim.state
}

export function formatTrace(trace: SimTrace): string {
  const tail = trace.trace.slice(-12).join('\n')
  const state = trace.state
  return `${state.status}${state.lossReason ? ` (${state.lossReason})` : ''} coins=${state.coinsCollected} keys=${state.keysCollected}\n${tail}`
}

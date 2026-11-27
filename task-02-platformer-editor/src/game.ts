import { platformPose } from './motion'
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
  type Mover,
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
  airJumps: number
  riding: string | null
}

export interface EnemyState extends Rect {
  id: string
  dir: 1 | -1
  minX: number
  maxX: number
  speed: number
  kind: 'patrol' | 'tracker'
  sight: number
  originX: number
  originY: number
}

export interface PlatformActor extends Rect {
  id: string
  prevX: number
  prevY: number
}

export interface CheckpointActor extends Rect {
  id: string
  tileX: number
  tileY: number
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
  platforms: PlatformActor[]
  checkpoints: CheckpointActor[]
  activeCheckpoint: string | null
  respawnTimer: number
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

export function spawnEnemy(level: Level, id: string, tileX: number, tileY: number, left: number, right: number, speed: number, kind: 'patrol' | 'tracker' = 'patrol', sight = 0): EnemyState {
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
    kind,
    sight,
    originX: Math.min(Math.max(x, minX), maxX),
    originY: y,
  }
}

function placePlatforms(level: Level, time: number): PlatformActor[] {
  return level.platforms.map((platform) => {
    const pose = platformPose(platform.path, platform.width, level.tileSize, platform.speed, time)
    return { id: platform.id, x: pose.x, y: pose.y, w: pose.w, h: pose.h, prevX: pose.x, prevY: pose.y }
  })
}

function placeCheckpoints(level: Level): CheckpointActor[] {
  const tile = level.tileSize
  return level.checkpoints.map((point) => ({
    id: point.id,
    tileX: point.x,
    tileY: point.y,
    x: point.x * tile + 8,
    y: point.y * tile + 6,
    w: tile - 16,
    h: tile - 8,
  }))
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
    airJumps: 0,
    riding: null,
  }
  separateUpward(player, world)
  const platforms = placePlatforms(level, 0)
  player.onGround = probeGround(player, world)
  attachToPlatform(player, platforms)
  if (player.onGround) player.coyote = COYOTE_TIME
  if (player.onGround && level.physics.doubleJump) player.airJumps = 1
  return {
    player,
    enemies: level.enemies.map((enemy) => spawnEnemy(level, enemy.id, enemy.x, enemy.y, enemy.left, enemy.right, enemy.speed, enemy.kind === 'tracker' ? 'tracker' : 'patrol', enemy.sight ?? 0)),
    coins: level.coins.map((coin) => collectibleBox(coin.x, coin.y, level.tileSize)),
    keys: level.keys.map((key) => collectibleBox(key.x, key.y, level.tileSize)),
    coinsCollected: 0,
    keysCollected: 0,
    status: 'playing',
    goalBlocked: null,
    time: 0,
    platforms,
    checkpoints: placeCheckpoints(level),
    activeCheckpoint: null,
    respawnTimer: 0,
  }
}

function attachToPlatform(player: PlayerState, platforms: readonly PlatformActor[]): void {
  for (const platform of platforms) {
    const feet = player.y + player.h
    const overlapX = player.x + player.w > platform.x + 1 && player.x < platform.x + platform.w - 1
    if (!overlapX || Math.abs(feet - platform.y) > 2) continue
    player.y = platform.y - player.h
    player.onGround = true
    player.vy = 0
    player.riding = platform.id
    return
  }
}

function reviveAtCheckpoint(state: GameState, level: Level, world: TileIndex): void {
  const checkpoint = state.checkpoints.find((entry) => entry.id === state.activeCheckpoint)
  if (!checkpoint) {
    state.status = 'lost'
    return
  }
  const tile = level.tileSize
  state.player.x = checkpoint.tileX * tile + (tile - PLAYER_W) / 2
  state.player.y = checkpoint.tileY * tile + tile - PLAYER_H
  state.player.vx = 0
  state.player.vy = 0
  state.player.riding = null
  state.player.jumpBuffer = 0
  separateUpward(state.player, world)
  state.player.onGround = probeGround(state.player, world)
  attachToPlatform(state.player, state.platforms)
  state.player.coyote = state.player.onGround ? COYOTE_TIME : 0
  state.player.airJumps = state.player.onGround && level.physics.doubleJump ? 1 : 0
  for (const enemy of state.enemies) {
    enemy.x = enemy.originX
    enemy.y = enemy.originY
    enemy.dir = 1
  }
  state.respawnTimer = 1.2
  state.lossReason = undefined
  state.status = 'playing'
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

  const groundedJump = state.player.onGround || state.player.coyote > 0
  const extraJump = physics.doubleJump === true && !groundedJump && state.player.airJumps > 0
  let jumped = false
  if (state.player.jumpBuffer > 0 && ((groundedJump && state.player.vy >= 0) || extraJump)) {
    state.player.vy = -jumpSpeed(physics.gravity, physics.jumpHeight)
    state.player.jumpBuffer = 0
    state.player.coyote = 0
    state.player.onGround = false
    state.player.airJumps = extraJump ? state.player.airJumps - 1 : physics.doubleJump ? 1 : 0
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
    if (enemy.kind === 'tracker') {
      const playerCenter = state.player.x + state.player.w / 2
      const enemyCenter = enemy.x + enemy.w / 2
      const sameBand = Math.abs(state.player.y + state.player.h / 2 - (enemy.y + enemy.h / 2)) <= level.tileSize * 1.5
      const inSight = sameBand && Math.abs(playerCenter - enemyCenter) <= enemy.sight * level.tileSize
      if (inSight && Math.abs(playerCenter - enemyCenter) > 1) {
        enemy.dir = playerCenter >= enemyCenter ? 1 : -1
        enemy.x += enemy.dir * enemy.speed * dt
        if (enemy.x < enemy.minX) enemy.x = enemy.minX
        if (enemy.x > enemy.maxX) enemy.x = enemy.maxX
      }
    } else {
      enemy.x += enemy.dir * enemy.speed * dt
      if (enemy.x <= enemy.minX) {
        enemy.x = enemy.minX
        enemy.dir = 1
      } else if (enemy.x >= enemy.maxX) {
        enemy.x = enemy.maxX
        enemy.dir = -1
      }
    }
  }

  for (const platform of state.platforms) {
    const def = level.platforms.find((entry) => entry.id === platform.id)
    if (!def) continue
    const pose = platformPose(def.path, def.width, level.tileSize, def.speed, state.time)
    platform.prevX = platform.x
    platform.prevY = platform.y
    platform.x = pose.x
    platform.y = pose.y
    platform.w = pose.w
    platform.h = pose.h
  }
  if (state.player.riding && !input.down) {
    const ridden = state.platforms.find((platform) => platform.id === state.player.riding)
    if (ridden) {
      state.player.x += ridden.x - ridden.prevX
      state.player.y += ridden.y - ridden.prevY
    } else state.player.riding = null
  }
  if (jumped) state.player.riding = null

  const movers: Mover[] = state.platforms.map((platform) => ({ id: platform.id, x: platform.x, y: platform.y, w: platform.w, h: platform.h }))
  const prevX = state.player.x
  const prevY = state.player.y
  const moved = moveBody(state.player, dx, dy, world, { ignoreOneWay: input.down, movers })
  if (moved.onGround && state.player.vy > 0) state.player.vy = 0
  if (moved.hitCeiling && state.player.vy < 0) state.player.vy = 0
  state.player.onGround = moved.onGround
  if (!jumped && !input.down && moved.groundMover) {
    const platform = state.platforms.find((entry) => entry.id === moved.groundMover)
    if (platform) {
      state.player.y = platform.y - state.player.h
      state.player.vy = 0
      state.player.onGround = true
      state.player.riding = platform.id
    }
  } else if (!jumped && !input.down && state.player.riding) {
    const platform = state.platforms.find((entry) => entry.id === state.player.riding)
    const overlapX = platform ? state.player.x + state.player.w > platform.x + 1 && state.player.x < platform.x + platform.w - 1 : false
    const feet = state.player.y + state.player.h
    if (platform && overlapX && feet >= platform.y - 8 && feet <= platform.y + 6) {
      state.player.y = platform.y - state.player.h
      state.player.vy = 0
      state.player.onGround = true
    } else state.player.riding = null
  } else state.player.riding = null
  if (state.player.onGround) {
    state.player.coyote = COYOTE_TIME
    state.player.airJumps = physics.doubleJump ? 1 : 0
  } else if (!jumped) state.player.coyote = Math.max(0, state.player.coyote - dt)
  if (state.respawnTimer > 0) state.respawnTimer = Math.max(0, state.respawnTimer - dt)

  const horizontalSweep = sweptRect(prevX, prevY, state.player.x, prevY, state.player.w, state.player.h)
  const verticalSweep = sweptRect(state.player.x, prevY, state.player.x, state.player.y, state.player.w, state.player.h)
  const hitEnemy =
    enemyTouches(rectOf(state.player), state.enemies) ||
    state.enemies.some((enemy) => overlaps(horizontalSweep, enemy, 0.1) || overlaps(verticalSweep, enemy, 0.1))

  for (const checkpoint of state.checkpoints) {
    if (overlaps(state.player, checkpoint, 0)) state.activeCheckpoint = checkpoint.id
  }

  const fatal = moved.hazard ? 'hazard' as const : hitEnemy ? 'enemy' as const : state.player.y > world.pixelHeight + 8 ? 'fall' as const : null
  if (fatal) {
    if (state.activeCheckpoint) {
      reviveAtCheckpoint(state, level, world)
      return
    }
    state.status = 'lost'
    state.lossReason = fatal
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

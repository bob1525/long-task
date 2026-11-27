import { createSim, compressInputs, stepSim, type InputState, type ScriptSegment, type Sim } from './game'
import { FIXED_DT } from './physics'
import type { Level } from './schema'

const JUMP_HOLD_FRAMES = 46

export interface RecordResult {
  script: ScriptSegment[]
  won: boolean
  status: string
  lossReason?: string
  frames: number
  x: number
  y: number
}

/**
 * Deterministic recorder used to bake the built-in clear scripts.
 * It always runs right, and holds jump when a gap, wall, or enemy is close.
 */
export function recordClear(level: Level, maxFrames = 3600): RecordResult {
  const sim = createSim(level)
  const frames: InputState[] = []
  let hold = 0
  let stuck = 0
  let lastX = sim.state.player.x

  for (let i = 0; i < maxFrames && sim.state.status === 'playing'; i += 1) {
    const need = needsJump(sim)
    if (hold <= 0 && sim.state.player.onGround && (need || stuck > 25)) {
      hold = JUMP_HOLD_FRAMES
    }
    const jump = hold > 0
    if (hold > 0) hold -= 1
    const input: InputState = { left: false, right: true, jump, down: false }
    frames.push(input)
    stepSim(sim, input, FIXED_DT)
    if (sim.state.player.x < lastX + 0.15) stuck += 1
    else stuck = 0
    lastX = sim.state.player.x
  }

  return {
    script: compressInputs(frames),
    won: sim.state.status === 'won',
    status: sim.state.status,
    lossReason: sim.state.lossReason,
    frames: frames.length,
    x: sim.state.player.x,
    y: sim.state.player.y,
  }
}

function needsJump(sim: Sim): boolean {
  const player = sim.state.player
  const tile = sim.level.tileSize
  const feet = player.y + player.h
  const front = player.x + player.w

  const supported = (x: number): boolean => {
    const tx = Math.floor(x / tile)
    const ty = Math.floor((feet + 1) / tile)
    const type = sim.world.get(tx, ty)
    if (type !== 'solid' && type !== 'oneWay') return false
    const top = ty * tile
    return feet <= top + 2 && feet >= top - 2
  }

  let ahead = false
  for (const offset of [10, 28, 48]) {
    if (supported(front + offset)) ahead = true
  }
  const gap = !ahead

  const midY = player.y + player.h * 0.45
  const wallTx = Math.floor((front + 2) / tile)
  const wallTy = Math.floor(midY / tile)
  const wall = sim.world.get(wallTx, wallTy) === 'solid'

  const enemy = sim.state.enemies.some((entry) => {
    const dx = entry.x - front
    const vertical = entry.y < player.y + player.h - 2 && entry.y + entry.h > player.y + 4
    return vertical && dx < 36 && dx > -6
  })

  const pitSoon = !supported(front + 72) && supported(player.x + player.w * 0.4)
  const oneWayAbove = hasOneWayAbove(sim, front + 16, feet)

  return gap || wall || enemy || (pitSoon && oneWayAbove)
}

function hasOneWayAbove(sim: Sim, x: number, feet: number): boolean {
  const tile = sim.level.tileSize
  const tx = Math.floor(x / tile)
  for (let ty = Math.floor(feet / tile) - 1; ty >= Math.floor((feet - sim.physics.jumpHeight) / tile); ty -= 1) {
    if (sim.world.get(tx, ty) === 'oneWay' || sim.world.get(tx + 1, ty) === 'oneWay') return true
  }
  return false
}

export function scriptSource(name: string, script: ScriptSegment[]): string {
  return `export const ${name}: ScriptSegment[] = ${JSON.stringify(script, null, 2)}\n`
}

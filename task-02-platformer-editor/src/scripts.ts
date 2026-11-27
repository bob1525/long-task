import type { ScriptSegment } from './game'

/** Recorded with `npm run record`. Replays are deterministic fixed-timestep inputs. */
export const MEADOW_SCRIPT: ScriptSegment[] = [
  { frames: 327, left: false, right: true, jump: false, down: false },
  { frames: 46, left: false, right: true, jump: true, down: false },
  { frames: 459, left: false, right: true, jump: false, down: false },
]

export const BRIDGE_SCRIPT: ScriptSegment[] = [
  { frames: 347, left: false, right: true, jump: false, down: false },
  { frames: 46, left: false, right: true, jump: true, down: false },
  { frames: 203, left: false, right: true, jump: false, down: false },
  { frames: 46, left: false, right: true, jump: true, down: false },
  { frames: 248, left: false, right: true, jump: false, down: false },
]

export const PATROL_SCRIPT: ScriptSegment[] = [
  { frames: 327, left: false, right: true, jump: false, down: false },
  { frames: 46, left: false, right: true, jump: true, down: false },
  { frames: 415, left: false, right: true, jump: false, down: false },
  { frames: 46, left: false, right: true, jump: true, down: false },
  { frames: 113, left: false, right: true, jump: false, down: false },
]

/** Hand-tuned: board the ferry, ride to the far ledge, wait for the lift, rise above the upper floor, hop the tracker. */
export const LIFT_SCRIPT: ScriptSegment[] = [
  { frames: 171, left: false, right: true, jump: false, down: false },
  { frames: 816, left: false, right: false, jump: false, down: false },
  { frames: 179, left: false, right: true, jump: false, down: false },
  { frames: 507, left: false, right: false, jump: false, down: false },
  { frames: 5, left: false, right: true, jump: false, down: false },
  { frames: 745, left: false, right: false, jump: false, down: false },
  { frames: 162, left: false, right: true, jump: false, down: false },
  { frames: 22, left: false, right: true, jump: true, down: false },
  { frames: 122, left: false, right: true, jump: false, down: false },
]

export const BUILTIN_SCRIPTS: Record<string, ScriptSegment[]> = {
  'builtin-meadow': MEADOW_SCRIPT,
  'builtin-bridge': BRIDGE_SCRIPT,
  'builtin-patrol': PATROL_SCRIPT,
  'builtin-lift': LIFT_SCRIPT,
}

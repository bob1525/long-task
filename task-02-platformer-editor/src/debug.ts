import type { Layers } from './level-edit'
import type { Level, PhysicsConfig } from './schema'

export interface PublicState {
  status: 'playing' | 'won' | 'lost'
  player: { x: number; y: number; vx: number; vy: number; onGround: boolean }
  coins: number
  keys: number
  lossReason?: string
  goalBlocked: 'coins' | 'keys' | null
}

export interface Rgb {
  r: number
  g: number
  b: number
}

export interface GameDebugApi {
  getMode(): 'game' | 'editor'
  isPlaytesting(): boolean
  getLevel(): Level
  getState(): PublicState | null
  getPhysics(): PhysicsConfig
  getCustomLevels(): Array<{ id: string; name: string }>
  getLayers(): Layers
  getEditorCamera(): { x: number; y: number }
  getGuidesEnabled(): boolean
  getGridEnabled(): boolean
  sampleEditorTile(tx: number, ty: number): Rgb | null
  previewBuiltin(id: string, phase: 'playing' | 'won'): void
}

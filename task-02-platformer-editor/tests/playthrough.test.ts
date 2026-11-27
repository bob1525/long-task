import { describe, expect, it } from 'vitest'
import { formatTrace, simulate } from '../src/game'
import { builtinLevels } from '../src/levels'
import { BUILTIN_SCRIPTS } from '../src/scripts'

describe('built-in level clears', () => {
  for (const level of builtinLevels) {
    it(`plays ${level.name} to the goal with its recorded input`, () => {
      const script = BUILTIN_SCRIPTS[level.id]
      expect(script, level.id).toBeTruthy()
      const first = simulate(level, script!)
      const second = simulate(level, script!)
      expect(first.state.status, formatTrace(first)).toBe('won')
      expect(second.state.status).toBe('won')
      expect(second.state.player.x).toBeCloseTo(first.state.player.x, 4)
      expect(second.state.player.y).toBeCloseTo(first.state.player.y, 4)
      expect(second.state.time).toBeCloseTo(first.state.time, 4)
    })
  }

  it('uses three distinct built-in levels', () => {
    expect(builtinLevels).toHaveLength(3)
    expect(new Set(builtinLevels.map((level) => level.id)).size).toBe(3)
    const types = new Set(builtinLevels.flatMap((level) => level.tiles.map((tile) => tile.type)))
    expect(types.has('solid')).toBe(true)
    expect(types.has('oneWay')).toBe(true)
    expect(types.has('hazard')).toBe(true)
    expect(builtinLevels.some((level) => level.enemies.length > 0)).toBe(true)
    expect(builtinLevels.some((level) => level.keys.length > 0 && level.goal.requireKeys > 0)).toBe(true)
    expect(builtinLevels.some((level) => level.coins.length > 0)).toBe(true)
  })
})

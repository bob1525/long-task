import { describe, expect, it } from 'vitest'
import { History } from '../src/history'
import {
  cellFromWorld,
  eraseAt,
  guideLines,
  moveSelection,
  paintInto,
  pickAt,
  requirementWarning,
  resizeLevel,
} from '../src/level-edit'
import { createEmptyLevel } from '../src/levels'
import { cloneLevel, sameLevel } from '../src/schema'

describe('editor model', () => {
  it('snaps world pixels onto the tile grid', () => {
    expect(cellFromWorld(0, 0)).toEqual({ x: 0, y: 0 })
    expect(cellFromWorld(31.9, 64)).toEqual({ x: 0, y: 2 })
    expect(cellFromWorld(32, 95)).toEqual({ x: 1, y: 2 })
  })

  it('places, replaces, and erases terrain, collectibles, enemies, start, and goal', () => {
    const level = createEmptyLevel('编辑')
    expect(paintInto(level, 'coin', 4, 11)).toBe(true)
    expect(paintInto(level, 'coin', 4, 11)).toBe(false)
    expect(paintInto(level, 'key', 5, 11)).toBe(true)
    expect(paintInto(level, 'enemy', 6, 11)).toBe(true)
    expect(paintInto(level, 'hazard', 7, 12)).toBe(true)
    const replaced = level.tiles.find((tile) => tile.x === 7 && tile.y === 12)
    expect(replaced?.type).toBe('hazard')
    expect(paintInto(level, 'start', 3, 11)).toBe(true)
    expect(level.start).toEqual({ x: 3, y: 11 })
    expect(paintInto(level, 'goal', 9, 11)).toBe(true)
    expect(level.goal.x).toBe(9)
    expect(pickAt(level, 6, 11)?.kind).toBe('enemy')
    expect(eraseAt(level, 4, 11)).toBe(true)
    expect(level.coins).toHaveLength(0)
    expect(eraseAt(level, 6, 11)).toBe(true)
    expect(level.enemies).toHaveLength(0)
    expect(paintInto(level, 'solid', -1, 0)).toBe(false)
  })

  it('moves a selection and keeps start inside the level when resizing', () => {
    const level = createEmptyLevel('移动')
    paintInto(level, 'enemy', 8, 11)
    const selection = pickAt(level, 8, 11)
    if (selection?.kind !== 'enemy') throw new Error('expected enemy')
    expect(moveSelection(level, selection, 9, 11)).toBe(true)
    expect(level.enemies[0]?.x).toBe(9)
    resizeLevel(level, 8, 8)
    expect(level.width).toBe(8)
    expect(level.height).toBe(8)
    expect(level.start.x).toBeLessThan(8)
    expect(level.tiles.every((tile) => tile.x < 8 && tile.y < 8)).toBe(true)
    expect(level.enemies).toHaveLength(0)
  })

  it('draws alignment guides when a cell shares a row or column with another object', () => {
    const level = createEmptyLevel('辅助')
    level.tiles = []
    const guides = guideLines(level, { x: level.goal.x, y: 3 })
    expect(guides.cols).toContain(level.goal.x)
    const none = guideLines(level, { x: 7, y: 3 })
    expect(none.cols).toEqual([])
    expect(none.rows).toEqual([])
  })

  it('warns when the goal asks for more collectibles than the level contains', () => {
    const level = createEmptyLevel('要求')
    level.goal.requireKeys = 2
    expect(requirementWarning(level)).toContain('钥匙')
    level.keys.push({ x: 4, y: 11 }, { x: 5, y: 11 })
    expect(requirementWarning(level)).toBeNull()
  })

  it('keeps 20 paint strokes undoable', () => {
    const history = new History(createEmptyLevel('二十步'), 40, cloneLevel, sameLevel)
    for (let i = 0; i < 20; i += 1) {
      const next = cloneLevel(history.current())
      paintInto(next, 'coin', i, 8)
      history.commit(next)
    }
    expect(history.current().coins).toHaveLength(20)
    for (let i = 0; i < 20; i += 1) history.undo()
    expect(history.current().coins).toHaveLength(0)
    for (let i = 0; i < 20; i += 1) history.redo()
    expect(history.current().coins).toHaveLength(20)
  })
})

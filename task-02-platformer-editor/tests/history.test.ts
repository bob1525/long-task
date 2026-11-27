import { describe, expect, it } from 'vitest'
import { History } from '../src/history'
import { paintInto } from '../src/level-edit'
import { createEmptyLevel } from '../src/levels'
import { cloneLevel, sameLevel, type Level } from '../src/schema'

function stack(level: Level, limit = 50): History<Level> {
  return new History(level, limit, cloneLevel, sameLevel)
}

describe('undo history', () => {
  it('undoes and redoes more than 20 edits back to the original', () => {
    const history = stack(createEmptyLevel('原点'))
    const original = history.current().name
    for (let i = 0; i < 25; i += 1) {
      const next = cloneLevel(history.current())
      next.name = `步骤${i}`
      history.commit(next)
    }
    expect(history.undoSteps).toBe(25)
    expect(history.current().name).toBe('步骤24')
    for (let i = 0; i < 25; i += 1) expect(history.undo()).toBe(true)
    expect(history.current().name).toBe(original)
    expect(history.undo()).toBe(false)
    for (let i = 0; i < 25; i += 1) expect(history.redo()).toBe(true)
    expect(history.current().name).toBe('步骤24')
    expect(history.redo()).toBe(false)
  })

  it('drops the oldest entries past the limit and clears redo after a new edit', () => {
    const history = stack(createEmptyLevel('限制'), 20)
    for (let i = 0; i < 30; i += 1) {
      const next = cloneLevel(history.current())
      next.name = `n${i}`
      history.commit(next)
    }
    expect(history.undoSteps).toBe(20)
    history.undo()
    const next = cloneLevel(history.current())
    next.name = '分叉'
    history.commit(next)
    expect(history.redoSteps).toBe(0)
    expect(history.current().name).toBe('分叉')
  })

  it('groups a stroke of many paints into one undo step', () => {
    const history = stack(createEmptyLevel('笔画'))
    const before = history.current().tiles.length
    history.begin()
    const level = history.current()
    for (let x = 0; x < 12; x += 1) paintInto(level, 'hazard', x, 4)
    history.end()
    expect(history.undoSteps).toBe(1)
    expect(history.current().tiles.length).toBe(before + 12)
    history.undo()
    expect(history.current().tiles.length).toBe(before)
    history.redo()
    expect(history.current().tiles.filter((tile) => tile.type === 'hazard')).toHaveLength(12)
  })

  it('does not record an identical commit', () => {
    const history = stack(createEmptyLevel('相同'))
    history.commit(cloneLevel(history.current()))
    expect(history.undoSteps).toBe(0)
  })
})

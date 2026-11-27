import { describe, expect, it } from 'vitest'
import { createEmptyLevel } from '../src/levels'
import { cloneLevel, parseLevel } from '../src/schema'
import {
  ACTIVE_LEVEL_KEY,
  LEVEL_LIST_KEY,
  applyCurrentToList,
  loadActiveId,
  loadCustomLevels,
  parseLevelList,
  saveActiveId,
  saveCustomLevels,
  type KeyValueStore,
} from '../src/storage'

class MemoryStore implements KeyValueStore {
  private readonly data = new Map<string, string>()
  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value)
  }
  removeItem(key: string): void {
    this.data.delete(key)
  }
}

describe('level list storage', () => {
  it('saves and loads custom levels with unicode names', () => {
    const store = new MemoryStore()
    const level = createEmptyLevel('黄昏 · 桥')
    saveCustomLevels(store, [level])
    saveActiveId(store, level.id)
    const loaded = loadCustomLevels(store)
    expect(loaded.errors).toEqual([])
    expect(loaded.levels).toHaveLength(1)
    expect(loaded.levels[0]?.name).toBe('黄昏 · 桥')
    expect(parseLevel(JSON.stringify(loaded.levels[0]))).toEqual(loaded.levels[0])
    expect(loadActiveId(store)).toBe(level.id)
    expect(store.getItem(LEVEL_LIST_KEY)).toContain('黄昏')
    expect(store.getItem(ACTIVE_LEVEL_KEY)).toBe(level.id)
  })

  it('skips a corrupt entry and explains it instead of throwing', () => {
    const loaded = parseLevelList([{ nope: true }, createEmptyLevel('好关')])
    expect(loaded.levels.map((level) => level.name)).toEqual(['好关'])
    expect(loaded.errors[0]).toContain('第 1 个关卡无法读取')
  })

  it('explains a corrupted list payload', () => {
    const store = new MemoryStore()
    store.setItem(LEVEL_LIST_KEY, '{')
    const loaded = loadCustomLevels(store)
    expect(loaded.levels).toEqual([])
    expect(loaded.errors[0]).toContain('存档 JSON 损坏')
  })

  it('updates a level that is still in the list and does not resurrect a removed id', () => {
    const kept = createEmptyLevel('留下')
    const removed = createEmptyLevel('已删除')
    removed.name = '已删除但还在编辑器里'
    const afterDelete = applyCurrentToList([kept], removed)
    expect(afterDelete.map((level) => level.id)).toEqual([kept.id])

    const edited = cloneLevel(kept)
    edited.name = '留下-改名'
    const renamed = applyCurrentToList(afterDelete, edited)
    expect(renamed).toHaveLength(1)
    expect(renamed[0]?.name).toBe('留下-改名')
    expect(renamed[0]).not.toBe(edited)
    expect(afterDelete[0]?.name).toBe('留下')
  })

  it('rejects a list that is not an array', () => {
    const loaded = parseLevelList({ levels: [] })
    expect(loaded.levels).toEqual([])
    expect(loaded.errors[0]).toContain('不是关卡数组')
  })
})

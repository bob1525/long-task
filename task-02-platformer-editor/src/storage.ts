import { cloneLevel, parseLevel, serializeLevel, LevelValidationError, type Level } from './schema'

export const LEVEL_LIST_KEY = 'task02.platformer.levels.v1'
export const ACTIVE_LEVEL_KEY = 'task02.platformer.active.v1'

export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface LoadedLevels {
  levels: Level[]
  errors: string[]
}

export function parseLevelList(input: unknown): LoadedLevels {
  if (!Array.isArray(input)) {
    return { levels: [], errors: ['存档不是关卡数组，已忽略损坏的列表。'] }
  }
  const levels: Level[] = []
  const errors: string[] = []
  input.forEach((entry, index) => {
    try {
      levels.push(parseLevel(entry))
    } catch (error) {
      const detail = error instanceof LevelValidationError ? error.message : error instanceof Error ? error.message : String(error)
      errors.push(`第 ${index + 1} 个关卡无法读取：${detail}`)
    }
  })
  return { levels, errors }
}

export function loadCustomLevels(store: KeyValueStore): LoadedLevels {
  const raw = store.getItem(LEVEL_LIST_KEY)
  if (!raw) return { levels: [], errors: [] }
  try {
    return parseLevelList(JSON.parse(raw) as unknown)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { levels: [], errors: [`存档 JSON 损坏，已忽略：${detail}`] }
  }
}

export function saveCustomLevels(store: KeyValueStore, levels: readonly Level[]): void {
  store.setItem(LEVEL_LIST_KEY, JSON.stringify(levels.map((level) => JSON.parse(serializeLevel(level)) as unknown)))
}

/** Replace the stored copy of `current` when its id is already in the list. A missing id stays missing, so deleting a level cannot be undone by the next save. */
export function applyCurrentToList(levels: readonly Level[], current: Level): Level[] {
  const index = levels.findIndex((level) => level.id === current.id)
  if (index < 0) return levels.slice()
  const next = levels.slice()
  next[index] = cloneLevel(current)
  return next
}

export function loadActiveId(store: KeyValueStore): string | null {
  return store.getItem(ACTIVE_LEVEL_KEY)
}

export function saveActiveId(store: KeyValueStore, id: string): void {
  store.setItem(ACTIVE_LEVEL_KEY, id)
}

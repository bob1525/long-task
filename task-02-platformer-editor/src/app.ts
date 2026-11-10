import type { GameDebugApi, PublicState } from './debug'
import { createSim, expandScript, stepSim, type InputState, type Sim } from './game'
import { History } from './history'
import {
  ALL_LAYERS,
  cellFromWorld,
  enemyById,
  guideLines,
  eraseAt,
  moveSelection,
  paintInto,
  pickAt,
  requirementWarning,
  resizeLevel,
  type Layers,
  type Selection,
  type Tool,
} from './level-edit'
import { builtinById, builtinLevels, createEmptyLevel } from './levels'
import { advanceAccumulator, FIXED_DT, MAX_FRAME_DT } from './physics'
import { drawScene, resizeCanvas, type Camera } from './render'
import {
  LEVEL_FORMAT_VERSION,
  LevelValidationError,
  canonicalize,
  cloneLevel,
  createLevelId,
  parseLevel,
  sameLevel,
  serializeLevel,
  type Level,
  type PhysicsConfig,
} from './schema'
import { BUILTIN_SCRIPTS } from './scripts'
import { applyCurrentToList, loadActiveId, loadCustomLevels, saveActiveId, saveCustomLevels } from './storage'

const HISTORY_LIMIT = 80

const TOOL_KEYS: Record<string, Tool> = {
  Digit1: 'select',
  Digit2: 'solid',
  Digit3: 'oneWay',
  Digit4: 'hazard',
  Digit5: 'coin',
  Digit6: 'key',
  Digit7: 'enemy',
  Digit8: 'start',
  Digit9: 'goal',
  Digit0: 'erase',
}

function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`缺少界面元素 #${id}`)
  return element as T
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function typingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
}

export class PlatformerApp {
  private readonly gameView = must<HTMLElement>('game-view')
  private readonly editorView = must<HTMLElement>('editor-view')
  private readonly gameCanvas = must<HTMLCanvasElement>('game-canvas')
  private readonly editorCanvas = must<HTMLCanvasElement>('editor-canvas')
  private readonly gameCtx: CanvasRenderingContext2D
  private readonly editorCtx: CanvasRenderingContext2D
  private readonly playList = must<HTMLElement>('play-list')
  private readonly levelList = must<HTMLElement>('level-list')
  private readonly nameInput = must<HTMLInputElement>('level-name')
  private readonly widthInput = must<HTMLInputElement>('level-width')
  private readonly heightInput = must<HTMLInputElement>('level-height')
  private readonly coinsInput = must<HTMLInputElement>('require-coins')
  private readonly keysInput = must<HTMLInputElement>('require-keys')
  private readonly warning = must<HTMLElement>('requirement-warning')
  private readonly enemyProps = must<HTMLElement>('enemy-props')
  private readonly enemyLeft = must<HTMLInputElement>('enemy-left')
  private readonly enemyRight = must<HTMLInputElement>('enemy-right')
  private readonly enemySpeed = must<HTMLInputElement>('enemy-speed')
  private readonly gravity = must<HTMLInputElement>('gravity')
  private readonly jumpHeight = must<HTMLInputElement>('jump-height')
  private readonly moveSpeed = must<HTMLInputElement>('move-speed')
  private readonly gravityValue = must<HTMLElement>('gravity-value')
  private readonly jumpValue = must<HTMLElement>('jump-value')
  private readonly speedValue = must<HTMLElement>('speed-value')
  private readonly toastEl = must<HTMLElement>('toast')
  private readonly statusEl = must<HTMLElement>('editor-status')
  private readonly hudCoins = must<HTMLElement>('hud-coins')
  private readonly hudKeys = must<HTMLElement>('hud-keys')
  private readonly hudLevel = must<HTMLElement>('hud-level')
  private readonly hudHint = must<HTMLElement>('hud-hint')
  private readonly playHud = must<HTMLElement>('play-hud')
  private readonly gameOverlay = must<HTMLElement>('game-overlay')
  private readonly editorOverlay = must<HTMLElement>('editor-overlay')
  private readonly gameOverlayTitle = must<HTMLElement>('game-overlay-title')
  private readonly gameOverlayDetail = must<HTMLElement>('game-overlay-detail')
  private readonly editorOverlayTitle = must<HTMLElement>('editor-overlay-title')
  private readonly editorOverlayDetail = must<HTMLElement>('editor-overlay-detail')
  private readonly deleteConfirm = must<HTMLElement>('delete-confirm')
  private readonly playtestButton = must<HTMLButtonElement>('btn-playtest')
  private readonly stopButton = must<HTMLButtonElement>('btn-stop-playtest')
  private readonly playtestBanner = must<HTMLElement>('playtest-banner')
  private readonly undoButton = must<HTMLButtonElement>('btn-undo')
  private readonly redoButton = must<HTMLButtonElement>('btn-redo')
  private readonly deleteButton = must<HTMLButtonElement>('btn-delete')
  private readonly fileInput = must<HTMLInputElement>('file-import')
  private readonly layerTerrain = must<HTMLInputElement>('layer-terrain')
  private readonly layerCollect = must<HTMLInputElement>('layer-collect')
  private readonly layerEnemy = must<HTMLInputElement>('layer-enemy')
  private readonly layerMarkers = must<HTMLInputElement>('layer-markers')
  private readonly gridToggle = must<HTMLInputElement>('show-grid')
  private readonly guidesToggle = must<HTMLInputElement>('show-guides')

  private custom: Level[] = []
  private history: History<Level>
  private source: 'builtin' | 'custom' = 'builtin'
  private currentId = builtinLevels[0]!.id
  private mode: 'game' | 'editor' = 'game'
  private playtesting = false
  private frozen = false
  private sim: Sim | null = null
  private readonly session: PhysicsConfig = { gravity: 1800, jumpHeight: 128, moveSpeed: 200 }
  private readonly playCamera: Camera = { x: 0, y: 0 }
  private readonly editorCamera: Camera = { x: 0, y: 0 }
  private snapPlay = true
  private tool: Tool = 'solid'
  private layers: Layers = { ...ALL_LAYERS }
  private hover: { x: number; y: number } | null = null
  private selectedEnemyId: string | null = null
  private painting = false
  private erasing = false
  private drag: Selection | null = null
  private panning = false
  private panLast = { x: 0, y: 0 }
  private spaceDown = false
  private readonly keys = new Set<string>()
  private syncing = false
  private acc = 0
  private last = 0
  private toastTimer = 0
  private gameSize: { width: number; height: number; dpr: number } | null = null
  private editorSize: { width: number; height: number; dpr: number } | null = null

  constructor() {
    const gameCtx = this.gameCanvas.getContext('2d')
    const editorCtx = this.editorCanvas.getContext('2d')
    if (!gameCtx || !editorCtx) throw new Error('无法创建画布')
    this.gameCtx = gameCtx
    this.editorCtx = editorCtx
    this.history = new History(cloneLevel(builtinLevels[0]!), HISTORY_LIMIT, cloneLevel, sameLevel)
    this.bind()
    this.restore()
    this.selectLevel(this.currentId, this.source, false)
    this.setTool('solid')
    must<HTMLElement>('format-version').textContent = `关卡格式版本 ${LEVEL_FORMAT_VERSION}`
    window.__GAME__ = this.debugApi()
  }

  start(): void {
    this.last = performance.now()
    const loop = (now: number) => {
      const frameDt = Math.min(MAX_FRAME_DT, Math.max(0, (now - this.last) / 1000))
      this.last = now
      if ((this.mode === 'game' || this.playtesting) && this.sim && !this.frozen) {
        const advanced = advanceAccumulator(this.acc, frameDt)
        this.acc = advanced.accumulator
        for (let i = 0; i < advanced.steps; i += 1) stepSim(this.sim, this.readInput(), FIXED_DT)
        this.updatePlayCamera(frameDt)
      }
      this.renderFrame(now / 1000)
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }

  private bind(): void {
    must<HTMLButtonElement>('tab-game').addEventListener('click', () => this.showMode('game'))
    must<HTMLButtonElement>('tab-editor').addEventListener('click', () => this.showMode('editor'))
    must<HTMLButtonElement>('btn-new-level').addEventListener('click', () => this.createLevel())
    must<HTMLButtonElement>('btn-rename').addEventListener('click', () => {
      this.showMode('editor')
      this.nameInput.focus()
      this.nameInput.select()
    })
    this.deleteButton.addEventListener('click', () => {
      if (this.source !== 'custom') {
        this.toast('内置关卡不能删除。改动内置关卡时会自动另存为副本。')
        return
      }
      this.deleteConfirm.hidden = false
    })
    must<HTMLButtonElement>('btn-delete-confirm').addEventListener('click', () => this.deleteCurrent())
    must<HTMLButtonElement>('btn-delete-cancel').addEventListener('click', () => {
      this.deleteConfirm.hidden = true
    })
    this.undoButton.addEventListener('click', () => this.undo())
    this.redoButton.addEventListener('click', () => this.redo())
    must<HTMLButtonElement>('btn-save').addEventListener('click', () => this.saveExplicit())
    must<HTMLButtonElement>('btn-download').addEventListener('click', () => this.download())
    must<HTMLButtonElement>('btn-import').addEventListener('click', () => this.fileInput.click())
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0]
      this.fileInput.value = ''
      if (file) void this.importFile(file)
    })
    this.playtestButton.addEventListener('click', () => this.startPlaytest())
    this.stopButton.addEventListener('click', () => this.stopPlaytest())
    must<HTMLButtonElement>('btn-overlay-stop').addEventListener('click', () => this.stopPlaytest())
    must<HTMLButtonElement>('btn-overlay-retry').addEventListener('click', () => this.restart())
    must<HTMLButtonElement>('btn-restart').addEventListener('click', () => this.restart())
    must<HTMLButtonElement>('btn-overlay-restart').addEventListener('click', () => this.restart())

    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
      button.addEventListener('click', () => this.setTool(button.dataset.tool as Tool))
    }

    this.layerTerrain.addEventListener('change', () => { this.layers.terrain = this.layerTerrain.checked })
    this.layerCollect.addEventListener('change', () => { this.layers.collect = this.layerCollect.checked })
    this.layerEnemy.addEventListener('change', () => { this.layers.enemy = this.layerEnemy.checked })
    this.layerMarkers.addEventListener('change', () => { this.layers.markers = this.layerMarkers.checked })

    for (const slider of [this.gravity, this.jumpHeight, this.moveSpeed]) {
      slider.addEventListener('input', () => this.onSlider())
      slider.addEventListener('change', () => this.finishSlider())
      slider.addEventListener('pointerup', () => this.finishSlider())
      slider.addEventListener('keyup', () => this.finishSlider())
    }

    this.nameInput.addEventListener('input', () => this.onNameInput())
    this.nameInput.addEventListener('blur', () => this.finishTextStroke())
    this.widthInput.addEventListener('change', () => this.onResize())
    this.heightInput.addEventListener('change', () => this.onResize())
    this.coinsInput.addEventListener('change', () => this.onRequirement())
    this.keysInput.addEventListener('change', () => this.onRequirement())
    for (const input of [this.enemyLeft, this.enemyRight, this.enemySpeed]) {
      input.addEventListener('focus', () => { if (!this.syncing) this.beginEdit() })
      input.addEventListener('input', () => this.onEnemyInput())
      input.addEventListener('blur', () => this.finishTextStroke())
    }

    this.editorCanvas.addEventListener('contextmenu', (event) => event.preventDefault())
    this.editorCanvas.addEventListener('pointerdown', (event) => this.onPointerDown(event))
    this.editorCanvas.addEventListener('pointermove', (event) => this.onPointerMove(event))
    this.editorCanvas.addEventListener('pointerup', (event) => this.onPointerUp(event))
    this.editorCanvas.addEventListener('pointerleave', () => { if (!this.painting && !this.panning) this.hover = null })
    this.editorCanvas.addEventListener('wheel', (event) => {
      if (this.playtesting) return
      event.preventDefault()
      this.editorCamera.x += event.deltaX
      this.editorCamera.y += event.deltaY
      this.clampEditorCamera()
    }, { passive: false })

    window.addEventListener('keydown', (event) => this.onKeyDown(event))
    window.addEventListener('keyup', (event) => {
      this.keys.delete(event.code)
      if (event.code === 'Space') this.spaceDown = false
    })
    window.addEventListener('blur', () => {
      this.keys.clear()
      this.spaceDown = false
    })

    const observer = new ResizeObserver(() => this.renderFrame(performance.now() / 1000))
    observer.observe(this.gameView)
    observer.observe(this.editorView)
  }

  private restore(): void {
    try {
      const loaded = loadCustomLevels(localStorage)
      const seen = new Set(builtinLevels.map((level) => level.id))
      for (const level of loaded.levels) {
        if (seen.has(level.id)) level.id = createLevelId()
        seen.add(level.id)
        this.custom.push(level)
      }
      if (loaded.errors.length) this.toast(loaded.errors.join('\n'))
      const active = loadActiveId(localStorage)
      if (active && builtinById(active)) {
        this.currentId = active
        this.source = 'builtin'
      } else if (active && this.custom.some((level) => level.id === active)) {
        this.currentId = active
        this.source = 'custom'
      }
    } catch (error) {
      this.toast(`无法读取本地存档：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private showMode(mode: 'game' | 'editor'): void {
    const unchanged = this.mode === mode && !this.playtesting
    if (mode === 'game' && this.playtesting) this.stopPlaytest()
    this.mode = mode
    this.frozen = false
    this.gameView.hidden = mode !== 'game'
    this.editorView.hidden = mode !== 'editor'
    must<HTMLButtonElement>('tab-game').setAttribute('aria-pressed', mode === 'game' ? 'true' : 'false')
    must<HTMLButtonElement>('tab-editor').setAttribute('aria-pressed', mode === 'editor' ? 'true' : 'false')
    if (unchanged) return
    if (mode === 'game') this.bindSim(this.history.current())
    else this.copySession(this.history.current().physics)
    this.syncSliders()
    requestAnimationFrame(() => this.renderFrame(performance.now() / 1000))
  }

  private selectLevel(id: string, source: 'builtin' | 'custom', resetView = true): void {
    const level = source === 'builtin' ? builtinById(id) : this.custom.find((entry) => entry.id === id)
    if (!level) return
    if (this.history.stroking) this.history.end()
    this.playtesting = false
    this.frozen = false
    this.history = new History(cloneLevel(level), HISTORY_LIMIT, cloneLevel, sameLevel)
    this.source = source
    this.currentId = level.id
    this.selectedEnemyId = null
    this.deleteConfirm.hidden = true
    if (resetView) this.editorCamera.x = 0
    if (resetView) this.editorCamera.y = 0
    this.copySession(this.history.current().physics)
    if (this.mode === 'game') this.bindSim(this.history.current())
    this.syncProps()
    this.syncSliders()
    this.renderLists()
    this.remember()
    this.updatePlaytestButtons()
  }

  private createLevel(): void {
    const level = createEmptyLevel(`新关卡 ${this.custom.length + 1}`)
    this.custom.push(cloneLevel(level))
    this.showMode('editor')
    this.selectLevel(level.id, 'custom')
    this.persist()
    this.toast(`已新建「${level.name}」`, true)
  }

  private deleteCurrent(): void {
    this.deleteConfirm.hidden = true
    if (this.source !== 'custom') {
      this.toast('内置关卡不能删除。改动内置关卡时会自动另存为副本。')
      return
    }
    const removedName = this.history.current().name
    const removed = this.currentId
    this.custom = this.custom.filter((level) => level.id !== removed)
    const next = this.custom[0]
    if (next) this.selectLevel(next.id, 'custom')
    else this.selectLevel(builtinLevels[0]!.id, 'builtin')
    this.persist()
    this.toast(`已删除「${removedName}」`, true)
  }

  private saveExplicit(): void {
    if (this.source === 'builtin') {
      this.toast('内置关卡不用单独保存。改动会自动另存为副本。')
      return
    }
    this.finishTextStroke()
    this.persist()
    this.toast('已保存到浏览器', true)
  }

  private bindSim(level: Level): void {
    this.copySession(level.physics)
    this.sim = createSim(level, this.session)
    this.snapPlay = true
    this.acc = 0
  }

  private copySession(physics: PhysicsConfig): void {
    this.session.gravity = physics.gravity
    this.session.jumpHeight = physics.jumpHeight
    this.session.moveSpeed = physics.moveSpeed
  }

  private startPlaytest(): void {
    this.showMode('editor')
    this.playtesting = true
    this.frozen = false
    this.keys.clear()
    this.bindSim(this.history.current())
    this.updatePlaytestButtons()
  }

  private stopPlaytest(): void {
    this.playtesting = false
    this.keys.clear()
    this.copySession(this.history.current().physics)
    this.syncSliders()
    this.updatePlaytestButtons()
  }

  private restart(): void {
    this.frozen = false
    this.keys.clear()
    const level = this.history.current()
    this.sim = createSim(level, this.session)
    this.snapPlay = true
    this.acc = 0
  }

  private updatePlaytestButtons(): void {
    this.playtestButton.hidden = this.playtesting
    this.stopButton.hidden = !this.playtesting
    this.playtestBanner.hidden = !this.playtesting
    this.playHud.hidden = !this.playtesting
  }

  private beginEdit(): void {
    if (!this.history.stroking) this.history.begin()
  }

  private finishTextStroke(): void {
    const level = this.history.current()
    if (!level.name.trim()) level.name = '未命名关卡'
    if (this.history.stroking) this.history.end()
    this.captureBuiltinEdit()
    if (this.source === 'custom') this.persist()
    this.syncProps()
    this.renderLists()
  }

  private finishSlider(): void {
    if (this.history.stroking) this.history.end()
    this.captureBuiltinEdit()
    if (this.source === 'custom') this.persist()
  }

  private captureBuiltinEdit(): void {
    if (this.source !== 'builtin') return
    const original = builtinById(this.currentId)
    if (!original) return
    const edited = cloneLevel(this.history.current())
    if (sameLevel(edited, original)) return
    const id = createLevelId()
    const typed = edited.name.trim()
    edited.id = id
    edited.name = typed && typed !== original.name ? typed.slice(0, 48) : `${original.name} 副本`.slice(0, 48)
    const baseline = cloneLevel(original)
    baseline.id = id
    baseline.name = edited.name
    this.history = new History(baseline, HISTORY_LIMIT, cloneLevel, sameLevel)
    this.history.commit(edited)
    this.source = 'custom'
    this.currentId = id
    this.custom.push(cloneLevel(edited))
    this.persist()
    this.renderLists()
    this.syncProps()
    this.toast(`已复制为「${edited.name}」，内置关卡保持不变`, true)
  }

  private onSlider(): void {
    const gravity = Number(this.gravity.value)
    const jump = Number(this.jumpHeight.value)
    const speed = Number(this.moveSpeed.value)
    this.session.gravity = gravity
    this.session.jumpHeight = jump
    this.session.moveSpeed = speed
    if (this.mode === 'editor' && !this.playtesting) {
      if (!this.history.stroking) this.history.begin()
      const physics = this.history.current().physics
      physics.gravity = gravity
      physics.jumpHeight = jump
      physics.moveSpeed = speed
    }
    this.updateReadout()
  }

  private onNameInput(): void {
    if (this.syncing) return
    if (!this.history.stroking) this.history.begin()
    this.history.current().name = this.nameInput.value.trim().slice(0, 48) || '未命名关卡'
    this.renderLists()
  }

  private onResize(): void {
    if (this.syncing) return
    const next = cloneLevel(this.history.current())
    resizeLevel(next, Number(this.widthInput.value), Number(this.heightInput.value))
    this.history.commit(next)
    this.captureBuiltinEdit()
    this.persist()
    this.syncProps()
  }

  private onRequirement(): void {
    if (this.syncing) return
    const next = cloneLevel(this.history.current())
    next.goal.requireCoins = clamp(Math.round(Number(this.coinsInput.value) || 0), 0, 999)
    next.goal.requireKeys = clamp(Math.round(Number(this.keysInput.value) || 0), 0, 999)
    this.history.commit(next)
    this.captureBuiltinEdit()
    this.persist()
    this.syncProps()
  }

  private onEnemyInput(): void {
    if (this.syncing || !this.selectedEnemyId) return
    const enemy = enemyById(this.history.current(), this.selectedEnemyId)
    if (!enemy) return
    if (!this.history.stroking) this.history.begin()
    enemy.left = clamp(Math.round(Number(this.enemyLeft.value) || 0), 0, 40)
    enemy.right = clamp(Math.round(Number(this.enemyRight.value) || 0), 0, 40)
    enemy.speed = clamp(Number(this.enemySpeed.value) || 0, 0, 400)
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.playtesting || this.mode !== 'editor') return
    if (event.button === 1 || (event.button === 0 && this.spaceDown)) {
      this.panning = true
      this.panLast = { x: event.clientX, y: event.clientY }
      this.editorCanvas.setPointerCapture(event.pointerId)
      return
    }
    if (event.button !== 0 && event.button !== 2) return
    this.history.begin()
    this.painting = true
    this.erasing = event.button === 2 || this.tool === 'erase'
    this.editorCanvas.setPointerCapture(event.pointerId)
    this.applyPointer(event)
  }

  private onPointerMove(event: PointerEvent): void {
    const cell = this.cellFromEvent(event)
    this.hover = cell
    if (this.panning) {
      this.editorCamera.x -= event.clientX - this.panLast.x
      this.editorCamera.y -= event.clientY - this.panLast.y
      this.panLast = { x: event.clientX, y: event.clientY }
      this.clampEditorCamera()
      return
    }
    if (!this.painting || !cell) return
    this.applyCell(cell.x, cell.y)
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.panning) {
      this.panning = false
      return
    }
    if (!this.painting) return
    this.painting = false
    this.drag = null
    this.history.end()
    this.captureBuiltinEdit()
    if (this.source === 'custom') this.persist()
    this.syncEnemyProps()
    if (this.editorCanvas.hasPointerCapture(event.pointerId)) this.editorCanvas.releasePointerCapture(event.pointerId)
  }

  private applyPointer(event: PointerEvent): void {
    const cell = this.cellFromEvent(event)
    this.hover = cell
    if (!cell) return
    this.applyCell(cell.x, cell.y)
  }

  private applyCell(x: number, y: number): void {
    const level = this.history.current()
    if (this.tool === 'select' && !this.erasing) {
      if (!this.drag) {
        this.drag = pickAt(level, x, y)
        this.selectedEnemyId = this.drag?.kind === 'enemy' ? this.drag.id : null
        this.syncEnemyProps()
        return
      }
      if (moveSelection(level, this.drag, x, y) && (this.drag.kind === 'tile' || this.drag.kind === 'coin' || this.drag.kind === 'key')) {
        this.drag.x = x
        this.drag.y = y
      }
      return
    }
    if (this.erasing) eraseAt(level, x, y)
    else paintInto(level, this.tool, x, y)
    if (this.tool === 'enemy') {
      const enemy = level.enemies.find((entry) => entry.x === x && entry.y === y)
      if (enemy) this.selectedEnemyId = enemy.id
      this.syncEnemyProps()
    }
  }

  private cellFromEvent(event: PointerEvent): { x: number; y: number } | null {
    const rect = this.editorCanvas.getBoundingClientRect()
    if (rect.width < 2) return null
    const worldX = event.clientX - rect.left + this.editorCamera.x
    const worldY = event.clientY - rect.top + this.editorCamera.y
    return cellFromWorld(worldX, worldY, this.history.current().tileSize)
  }

  private onKeyDown(event: KeyboardEvent): void {
    const typing = typingTarget(event.target)
    if (!typing && (event.code === 'Space' || event.code.startsWith('Arrow'))) event.preventDefault()
    if (event.code === 'Escape' && this.playtesting) {
      this.stopPlaytest()
      return
    }
    if (event.code === 'Escape' && !this.deleteConfirm.hidden) {
      this.deleteConfirm.hidden = true
      return
    }
    if (!typing && event.code === 'KeyR' && (this.mode === 'game' || this.playtesting)) {
      this.restart()
      return
    }
    if (!typing && (event.ctrlKey || event.metaKey) && this.mode === 'editor' && !this.playtesting && (event.code === 'KeyZ' || event.code === 'KeyY')) {
      event.preventDefault()
      if (event.code === 'KeyY' || event.shiftKey) this.redo()
      else this.undo()
      return
    }
    if (!typing && this.mode === 'editor' && !this.playtesting && TOOL_KEYS[event.code]) {
      this.setTool(TOOL_KEYS[event.code]!)
      return
    }
    if (this.mode === 'editor' && !this.playtesting && event.code === 'Space' && !typing) {
      this.spaceDown = true
      return
    }
    if (!typing) this.keys.add(event.code)
    if (this.frozen && !typing) this.frozen = false
  }

  private readInput(): InputState {
    return {
      left: this.keys.has('ArrowLeft') || this.keys.has('KeyA'),
      right: this.keys.has('ArrowRight') || this.keys.has('KeyD'),
      jump: this.keys.has('Space') || this.keys.has('ArrowUp') || this.keys.has('KeyW'),
      down: this.keys.has('ArrowDown') || this.keys.has('KeyS'),
    }
  }

  private undo(): void {
    if (this.playtesting) return
    if (this.history.stroking) this.history.end()
    if (!this.history.undo()) return
    this.afterHistory()
  }

  private redo(): void {
    if (this.playtesting) return
    if (this.history.stroking) this.history.end()
    if (!this.history.redo()) return
    this.afterHistory()
  }

  private afterHistory(): void {
    this.selectedEnemyId = null
    if (this.source === 'custom') this.persist()
    this.copySession(this.history.current().physics)
    this.syncSliders()
    this.syncProps()
    this.renderLists()
  }

  private setTool(tool: Tool): void {
    this.tool = tool
    if (tool === 'solid' || tool === 'oneWay' || tool === 'hazard') this.layers.terrain = true
    if (tool === 'coin' || tool === 'key') this.layers.collect = true
    if (tool === 'enemy') this.layers.enemy = true
    if (tool === 'start' || tool === 'goal') this.layers.markers = true
    this.layerTerrain.checked = this.layers.terrain
    this.layerCollect.checked = this.layers.collect
    this.layerEnemy.checked = this.layers.enemy
    this.layerMarkers.checked = this.layers.markers
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
      button.setAttribute('aria-pressed', button.dataset.tool === tool ? 'true' : 'false')
    }
  }

  private renderLists(): void {
    this.fillList(this.playList)
    this.fillList(this.levelList)
    this.deleteButton.disabled = this.source !== 'custom'
    this.deleteButton.title = this.source === 'custom' ? '删除当前关卡' : '内置关卡不能删除'
    if (this.source !== 'custom') this.deleteConfirm.hidden = true
  }

  private fillList(list: HTMLElement): void {
    list.replaceChildren()
    const entries: Array<{ level: Level; source: 'builtin' | 'custom' }> = [
      ...builtinLevels.map((level) => ({ level, source: 'builtin' as const })),
      ...this.custom.map((level) => ({ level, source: 'custom' as const })),
    ]
    for (const entry of entries) {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      const current = this.history.current()
      const liveName = entry.source === 'custom' && entry.level.id === this.currentId
      button.append(document.createTextNode(liveName ? current.name : entry.level.name))
      const badge = document.createElement('small')
      badge.textContent = entry.source === 'builtin' ? '内置' : '自定义'
      button.append(badge)
      if (entry.level.id === this.currentId) button.setAttribute('aria-current', 'true')
      button.addEventListener('click', () => this.selectLevel(entry.level.id, entry.source))
      item.append(button)
      list.append(item)
    }
  }

  private syncProps(): void {
    const level = this.history.current()
    this.syncing = true
    if (document.activeElement !== this.nameInput) this.nameInput.value = level.name
    this.widthInput.value = String(level.width)
    this.heightInput.value = String(level.height)
    this.coinsInput.value = String(level.goal.requireCoins)
    this.keysInput.value = String(level.goal.requireKeys)
    this.syncing = false
    this.syncEnemyProps()
  }

  private syncEnemyProps(): void {
    const enemy = this.selectedEnemyId ? enemyById(this.history.current(), this.selectedEnemyId) : undefined
    this.enemyProps.hidden = !enemy
    if (!enemy || document.activeElement === this.enemyLeft || document.activeElement === this.enemyRight || document.activeElement === this.enemySpeed) return
    this.syncing = true
    this.enemyLeft.value = String(enemy.left)
    this.enemyRight.value = String(enemy.right)
    this.enemySpeed.value = String(enemy.speed)
    this.syncing = false
  }

  private syncSliders(): void {
    const physics = this.mode === 'editor' && !this.playtesting ? this.history.current().physics : this.session
    this.gravity.value = String(physics.gravity)
    this.jumpHeight.value = String(physics.jumpHeight)
    this.moveSpeed.value = String(physics.moveSpeed)
    this.updateReadout()
  }

  private updateReadout(): void {
    const physics = this.mode === 'editor' && !this.playtesting ? this.history.current().physics : this.session
    this.gravityValue.textContent = String(Math.round(physics.gravity))
    this.jumpValue.textContent = String(Math.round(physics.jumpHeight))
    this.speedValue.textContent = String(Math.round(physics.moveSpeed))
  }

  private updatePlayCamera(dt: number): void {
    if (!this.sim) return
    const view = this.mode === 'game' ? this.gameSize : this.editorSize
    if (!view) return
    const player = this.sim.state.player
    const level = this.sim.level
    const levelW = level.width * level.tileSize
    const levelH = level.height * level.tileSize
    let x = player.x + player.w / 2 - view.width / 2 + player.facing * 36
    let y = player.y + player.h / 2 - view.height * 0.62
    if (levelW <= view.width) x = (levelW - view.width) / 2
    else x = clamp(x, 0, levelW - view.width)
    if (levelH <= view.height) y = (levelH - view.height) / 2
    else y = clamp(y, 0, levelH - view.height)
    if (this.snapPlay) {
      this.playCamera.x = x
      this.playCamera.y = y
      this.snapPlay = false
      return
    }
    const blend = 1 - Math.exp(-10 * dt)
    this.playCamera.x += (x - this.playCamera.x) * blend
    this.playCamera.y += (y - this.playCamera.y) * blend
  }

  private clampEditorCamera(): void {
    const view = this.editorSize
    if (!view) return
    const level = this.history.current()
    const maxX = Math.max(0, level.width * level.tileSize - view.width) + 80
    const maxY = Math.max(0, level.height * level.tileSize - view.height) + 80
    this.editorCamera.x = clamp(this.editorCamera.x, -80, maxX)
    this.editorCamera.y = clamp(this.editorCamera.y, -80, maxY)
  }

  private renderFrame(time: number): void {
    this.gameSize = this.gameView.hidden ? this.gameSize : resizeCanvas(this.gameCanvas)
    this.editorSize = this.editorView.hidden ? this.editorSize : resizeCanvas(this.editorCanvas)
    const level = this.history.current()
    if (this.mode === 'game' && this.gameSize && this.sim) {
      drawScene(this.gameCtx, {
        level: this.sim.level,
        camera: this.playCamera,
        viewWidth: this.gameSize.width,
        viewHeight: this.gameSize.height,
        dpr: this.gameSize.dpr,
        time,
        mode: 'play',
        state: this.sim.state,
        layers: ALL_LAYERS,
        showGrid: false,
        guides: { cols: [], rows: [] },
        hover: null,
        ghost: null,
        selectedEnemyId: null,
      })
    }
    if (this.mode === 'editor' && this.editorSize) {
      const playing = this.playtesting && this.sim
      const guides = !playing && this.guidesToggle.checked && this.hover ? guideLines(level, this.hover) : { cols: [], rows: [] }
      drawScene(this.editorCtx, {
        level: playing ? this.sim!.level : level,
        camera: playing ? this.playCamera : this.editorCamera,
        viewWidth: this.editorSize.width,
        viewHeight: this.editorSize.height,
        dpr: this.editorSize.dpr,
        time,
        mode: playing ? 'play' : 'edit',
        state: playing ? this.sim!.state : undefined,
        layers: this.layers,
        showGrid: this.gridToggle.checked && !playing,
        guides,
        hover: playing ? null : this.hover,
        ghost: !playing && this.hover && this.tool !== 'select' && this.tool !== 'erase' ? { ...this.hover, tool: this.tool } : null,
        selectedEnemyId: this.selectedEnemyId,
      })
    }
    this.updateHud()
    this.updateStatus(level)
    this.undoButton.disabled = this.history.undoSteps === 0
    this.redoButton.disabled = this.history.redoSteps === 0
  }

  private updateHud(): void {
    const active = (this.mode === 'game' || this.playtesting) && this.sim ? this.sim : null
    const level = active ? active.level : this.history.current()
    const state = active?.state
    const coinText = level.goal.requireCoins > 0 ? `金币 ${state?.coinsCollected ?? 0}/${level.goal.requireCoins}` : `金币 ${state?.coinsCollected ?? level.coins.length}`
    const keyText = level.goal.requireKeys > 0 ? `钥匙 ${state?.keysCollected ?? 0}/${level.goal.requireKeys}` : `钥匙 ${state?.keysCollected ?? level.keys.length}`
    this.hudCoins.textContent = coinText
    this.hudKeys.textContent = keyText
    this.hudLevel.textContent = level.name
    this.hudHint.textContent = state?.goalBlocked === 'keys' ? '还需要钥匙' : state?.goalBlocked === 'coins' ? '还需要金币' : ''
    this.playHud.textContent = `${coinText}  ${keyText}`
    const ended = state && state.status !== 'playing'
    this.gameOverlay.hidden = !(this.mode === 'game' && ended)
    this.editorOverlay.hidden = !(this.playtesting && ended)
    if (ended && state) {
      const won = state.status === 'won'
      const title = won ? '过关' : '失败'
      const detail = won ? `你到达了终点。用时 ${state.time.toFixed(1)} 秒。` : lossText(state.lossReason)
      this.gameOverlayTitle.textContent = title
      this.editorOverlayTitle.textContent = title
      this.gameOverlayDetail.textContent = detail
      this.editorOverlayDetail.textContent = detail
    }
    const warning = requirementWarning(level)
    this.warning.hidden = !warning
    this.warning.textContent = warning ?? ''
  }

  private updateStatus(level: Level): void {
    const cell = this.hover ? `${this.hover.x}, ${this.hover.y}` : '—'
    this.statusEl.textContent = `${level.name} · ${level.width}×${level.height} · 光标 ${cell} · 已对齐到网格 · 地形 ${level.tiles.length} · 金币 ${level.coins.length} · 钥匙 ${level.keys.length} · 敌人 ${level.enemies.length} · 撤销 ${this.history.undoSteps} · 重做 ${this.history.redoSteps}`
  }

  private persist(): void {
    if (this.source === 'custom') this.custom = applyCurrentToList(this.custom, this.history.current())
    try {
      saveCustomLevels(localStorage, this.custom)
      saveActiveId(localStorage, this.currentId)
    } catch (error) {
      this.toast(`无法写入本地存档：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private remember(): void {
    try {
      saveActiveId(localStorage, this.currentId)
    } catch (error) {
      this.toast(`无法记录当前关卡：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private download(): void {
    const level = this.history.current()
    const blob = new Blob([serializeLevel(level)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    const safe = level.name.replace(/[\\/:*?"<>|]/g, ' ').trim() || 'level'
    link.download = `${safe}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  private async importFile(file: File): Promise<void> {
    try {
      const text = await file.text()
      const level = parseLevel(text)
      if (builtinById(level.id) || this.custom.some((entry) => entry.id === level.id)) level.id = createLevelId()
      this.custom.push(level)
      this.showMode('editor')
      this.selectLevel(level.id, 'custom')
      this.persist()
      this.toast(`已导入「${level.name}」`, true)
    } catch (error) {
      const message = error instanceof LevelValidationError ? error.message : `导入失败：${error instanceof Error ? error.message : String(error)}`
      this.toast(message)
    }
  }

  private toast(message: string, ok = false): void {
    this.toastEl.hidden = false
    this.toastEl.textContent = message
    this.toastEl.classList.toggle('ok', ok)
    window.clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => { this.toastEl.hidden = true }, 4200)
  }

  private debugApi(): GameDebugApi {
    return {
      getMode: () => this.mode,
      isPlaytesting: () => this.playtesting,
      getLevel: () => canonicalize(this.history.current()),
      getState: () => (this.sim && (this.mode === 'game' || this.playtesting) ? publicState(this.sim) : null),
      getPhysics: () => ({ ...(this.mode === 'editor' && !this.playtesting ? this.history.current().physics : this.session) }),
      getCustomLevels: () => this.custom.map((level) => ({ id: level.id, name: level.name })),
      getLayers: () => ({ ...this.layers }),
      getEditorCamera: () => ({ ...this.editorCamera }),
      getGuidesEnabled: () => this.guidesToggle.checked,
      getGridEnabled: () => this.gridToggle.checked,
      sampleEditorTile: (tx, ty) => this.sampleEditorTile(tx, ty),
      previewBuiltin: (id, phase) => this.previewBuiltin(id, phase),
    }
  }

  private sampleEditorTile(tx: number, ty: number): { r: number; g: number; b: number } | null {
    this.renderFrame(performance.now() / 1000)
    if (!this.editorSize) return null
    const ts = this.history.current().tileSize
    const camera = this.playtesting ? this.playCamera : this.editorCamera
    const x = Math.floor((tx * ts + ts / 2 - camera.x) * this.editorSize.dpr)
    const y = Math.floor((ty * ts + ts / 2 - camera.y) * this.editorSize.dpr)
    if (x < 0 || y < 0 || x >= this.editorCanvas.width || y >= this.editorCanvas.height) return null
    const pixel = this.editorCtx.getImageData(x, y, 1, 1).data
    return { r: pixel[0] ?? 0, g: pixel[1] ?? 0, b: pixel[2] ?? 0 }
  }

  private previewBuiltin(id: string, phase: 'playing' | 'won'): void {
    const level = builtinById(id)
    const script = BUILTIN_SCRIPTS[id]
    if (!level || !script) throw new Error(`没有示例关卡 ${id}`)
    this.mode = 'game'
    this.playtesting = false
    this.frozen = true
    this.gameView.hidden = false
    this.editorView.hidden = true
    must<HTMLButtonElement>('tab-game').setAttribute('aria-pressed', 'true')
    must<HTMLButtonElement>('tab-editor').setAttribute('aria-pressed', 'false')
    this.history = new History(cloneLevel(level), HISTORY_LIMIT, cloneLevel, sameLevel)
    this.source = 'builtin'
    this.currentId = level.id
    const sim = createSim(cloneLevel(level))
    const frames = expandScript(script)
    const spawnX = sim.state.player.x
    for (let i = 0; i < frames.length; i += 1) {
      stepSim(sim, frames[i]!, FIXED_DT)
      const playingShot = phase === 'playing' && sim.state.status === 'playing' && sim.state.time > 0.55 && sim.state.player.x > spawnX + 110
      if (playingShot || sim.state.status !== 'playing') break
    }
    this.copySession(level.physics)
    sim.physics = this.session
    this.sim = sim
    this.snapPlay = true
    this.gameSize = resizeCanvas(this.gameCanvas)
    this.updatePlayCamera(1)
    this.syncProps()
    this.syncSliders()
    this.renderLists()
    this.renderFrame(sim.state.time)
  }
}

function lossText(reason: Sim['state']['lossReason']): string {
  if (reason === 'hazard') return '碰到了危险区。'
  if (reason === 'enemy') return '被敌人碰到。'
  if (reason === 'fall') return '掉出了关卡。'
  return '失败了。'
}

function publicState(sim: Sim): PublicState {
  const state = sim.state
  return {
    status: state.status,
    player: {
      x: state.player.x,
      y: state.player.y,
      vx: state.player.vx,
      vy: state.player.vy,
      onGround: state.player.onGround,
    },
    coins: state.coinsCollected,
    keys: state.keysCollected,
    lossReason: state.lossReason,
    goalBlocked: state.goalBlocked,
  }
}

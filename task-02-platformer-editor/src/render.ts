import type { ItemRef } from './edit-ops'
import type { GameState } from './game'
import type { Layers, Tool } from './level-edit'
import { platformPose } from './motion'
import { ENEMY_H, ENEMY_W, PLAYER_H, PLAYER_W } from './physics'
import type { Level } from './schema'
import type { LevelIssue } from './validate'

export interface Camera {
  x: number
  y: number
}

export interface Scene {
  level: Level
  camera: Camera
  viewWidth: number
  viewHeight: number
  dpr: number
  time: number
  mode: 'play' | 'edit'
  state?: GameState
  layers: Layers
  showGrid: boolean
  guides: { cols: number[]; rows: number[] }
  hover: { x: number; y: number } | null
  ghost: { x: number; y: number; tool: Tool } | null
  selectedEnemyId: string | null
  selection?: ItemRef[]
  selectionBox?: { x: number; y: number; w: number; h: number } | null
  issues?: LevelIssue[]
}

export function resizeCanvas(canvas: HTMLCanvasElement): { width: number; height: number; dpr: number } | null {
  const rect = canvas.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return null
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const width = rect.width
  const height = rect.height
  const bitmapW = Math.max(1, Math.floor(width * dpr))
  const bitmapH = Math.max(1, Math.floor(height * dpr))
  if (canvas.width !== bitmapW || canvas.height !== bitmapH) {
    canvas.width = bitmapW
    canvas.height = bitmapH
  }
  return { width, height, dpr }
}

export function drawScene(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { viewWidth: w, viewHeight: h, dpr } = scene
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  drawSky(ctx, scene)
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, w, h)
  ctx.clip()
  ctx.translate(-Math.round(scene.camera.x), -Math.round(scene.camera.y))
  drawTiles(ctx, scene)
  drawPlatforms(ctx, scene)
  drawCheckpoints(ctx, scene)
  if (scene.mode === 'edit' && scene.showGrid) drawGrid(ctx, scene)
  drawCollectibles(ctx, scene)
  drawActors(ctx, scene)
  drawMarkers(ctx, scene)
  if (scene.mode === 'edit') drawEditorAids(ctx, scene)
  ctx.restore()
}

function drawSky(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { viewWidth: w, viewHeight: h } = scene
  const sky = ctx.createLinearGradient(0, 0, 0, h)
  sky.addColorStop(0, '#6eafd4')
  sky.addColorStop(0.55, '#d7ecf4')
  sky.addColorStop(1, '#f6e2bc')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = 'rgba(255,244,214,0.9)'
  ctx.beginPath()
  ctx.arc(w * 0.78, h * 0.18, Math.min(w, h) * 0.06, 0, Math.PI * 2)
  ctx.fill()
  hill(ctx, scene, '#9bb88a', 0.22, 0.62, 18, 0.004)
  hill(ctx, scene, '#6d8f5c', 0.42, 0.78, 28, 0.0065)
}

function hill(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  color: string,
  parallax: number,
  baseRatio: number,
  amp: number,
  freq: number,
): void {
  const { viewWidth: w, viewHeight: h, camera } = scene
  ctx.beginPath()
  ctx.moveTo(0, h)
  for (let x = 0; x <= w; x += 10) {
    const worldX = x + camera.x * parallax
    const y = h * baseRatio + Math.sin(worldX * freq) * amp + Math.sin(worldX * freq * 0.37) * amp * 0.45
    ctx.lineTo(x, y)
  }
  ctx.lineTo(w, h)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
}

function drawTiles(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const showTerrain = scene.mode === 'play' || scene.layers.terrain
  if (!showTerrain) return
  const ts = scene.level.tileSize
  for (const tile of scene.level.tiles) {
    const x = tile.x * ts
    const y = tile.y * ts
    if (tile.type === 'solid') drawSolid(ctx, x, y, ts)
    else if (tile.type === 'oneWay') drawOneWay(ctx, x, y, ts)
    else drawHazard(ctx, x, y, ts, scene.time)
  }
}

function drawSolid(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.fillStyle = '#6b4b32'
  ctx.fillRect(x, y, s, s)
  ctx.fillStyle = '#c7a27a'
  ctx.fillRect(x + 2, y + 2, s - 4, 7)
  ctx.fillStyle = '#8d6544'
  ctx.fillRect(x + 2, y + 11, s - 4, s - 15)
  ctx.fillStyle = 'rgba(80,52,32,0.35)'
  ctx.fillRect(x + 6, y + 16, 8, 2)
  ctx.strokeStyle = '#4a3120'
  ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1)
}

function drawOneWay(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.fillStyle = '#1e6d5c'
  ctx.fillRect(x, y, s, 7)
  ctx.fillStyle = '#b7f0dc'
  ctx.fillRect(x, y, s, 2)
  ctx.fillStyle = 'rgba(30,109,92,0.55)'
  for (let i = 5; i < s; i += 8) ctx.fillRect(x + i, y + 7, 2, 7)
}

function drawHazard(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, time: number): void {
  ctx.fillStyle = '#5c1d18'
  ctx.fillRect(x, y, s, s)
  const flicker = 0.75 + Math.sin(time * 6 + x) * 0.25
  ctx.fillStyle = `rgba(226, 90, 70, ${flicker})`
  const spikes = 4
  const span = s / spikes
  for (let i = 0; i < spikes; i += 1) {
    const left = x + i * span + 1
    ctx.beginPath()
    ctx.moveTo(left, y + s - 3)
    ctx.lineTo(left + span * 0.5, y + 7)
    ctx.lineTo(left + span - 1, y + s - 3)
    ctx.closePath()
    ctx.fill()
  }
}

function drawPlatforms(ctx: CanvasRenderingContext2D, scene: Scene): void {
  if (scene.mode === 'edit' && !scene.layers.terrain) return
  const actors = scene.state?.platforms
  if (actors && scene.mode === 'play') {
    for (const platform of actors) drawPlatformSlab(ctx, platform.x, platform.y, platform.w, platform.h)
    return
  }
  for (const platform of scene.level.platforms) {
    const pose = platformPose(platform.path, platform.width, scene.level.tileSize, platform.speed, scene.time)
    if (scene.mode === 'edit') {
      ctx.strokeStyle = 'rgba(90, 62, 32, 0.85)'
      ctx.setLineDash([5, 4])
      ctx.beginPath()
      platform.path.forEach((point, index) => {
        const x = point.x * scene.level.tileSize + pose.w / 2
        const y = point.y * scene.level.tileSize + 4
        if (index === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
      ctx.setLineDash([])
    }
    drawPlatformSlab(ctx, pose.x, pose.y, pose.w, pose.h)
  }
}

function drawPlatformSlab(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = '#8a5a32'
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = '#f0d2a4'
  ctx.fillRect(x, y, w, 3)
  ctx.strokeStyle = '#4e311c'
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
}

function drawCheckpoints(ctx: CanvasRenderingContext2D, scene: Scene): void {
  if (scene.mode === 'edit' && !scene.layers.markers) return
  const ts = scene.level.tileSize
  const active = scene.state?.activeCheckpoint
  const points = scene.state
    ? scene.state.checkpoints.map((point) => ({ id: point.id, x: point.tileX, y: point.tileY }))
    : scene.level.checkpoints
  for (const point of points) {
    const x = point.x * ts
    const y = point.y * ts
    const lit = active === point.id
    ctx.fillStyle = lit ? '#7dba6a' : '#2f6f86'
    ctx.fillRect(x + ts / 2 - 2, y + 8, 4, ts - 12)
    ctx.beginPath()
    ctx.moveTo(x + ts / 2, y + 8)
    ctx.lineTo(x + ts - 6, y + 14)
    ctx.lineTo(x + ts / 2, y + 20)
    ctx.fill()
  }
}

function drawCollectibles(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const show = scene.mode === 'play' || scene.layers.collect
  if (!show) return
  const ts = scene.level.tileSize
  if (scene.state) {
    for (const coin of scene.state.coins) if (!coin.taken) drawCoin(ctx, coin.tileX, coin.tileY, ts, scene.time)
    for (const key of scene.state.keys) if (!key.taken) drawKey(ctx, key.tileX, key.tileY, ts, scene.time)
    return
  }
  for (const coin of scene.level.coins) drawCoin(ctx, coin.x, coin.y, ts, scene.time)
  for (const key of scene.level.keys) drawKey(ctx, key.x, key.y, ts, scene.time)
}

function drawCoin(ctx: CanvasRenderingContext2D, tx: number, ty: number, ts: number, time: number): void {
  const bob = Math.sin(time * 5 + tx) * 2
  const cx = tx * ts + ts / 2
  const cy = ty * ts + ts / 2 + bob
  ctx.fillStyle = '#e2a12e'
  ctx.beginPath()
  ctx.arc(cx, cy, 8, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#fff0c2'
  ctx.fillRect(cx - 2, cy - 5, 3, 10)
}

function drawKey(ctx: CanvasRenderingContext2D, tx: number, ty: number, ts: number, time: number): void {
  const bob = Math.sin(time * 4 + ty) * 1.5
  const cx = tx * ts + ts / 2
  const cy = ty * ts + ts / 2 + bob
  ctx.fillStyle = '#e6b325'
  ctx.beginPath()
  ctx.arc(cx - 3, cy - 2, 5, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#6eafd4'
  ctx.beginPath()
  ctx.arc(cx - 3, cy - 2, 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#e6b325'
  ctx.fillRect(cx - 1, cy - 2, 12, 3)
  ctx.fillRect(cx + 7, cy + 1, 3, 4)
}

function drawActors(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const showEnemy = scene.mode === 'play' || scene.layers.enemy
  if (showEnemy) {
    const enemies = scene.state
      ? scene.state.enemies
      : scene.level.enemies.map((enemy) => ({
          id: enemy.id,
          x: enemy.x * scene.level.tileSize + (scene.level.tileSize - ENEMY_W) / 2,
          y: enemy.y * scene.level.tileSize + scene.level.tileSize - ENEMY_H,
          dir: 1 as const,
          minX: (enemy.x - enemy.left) * scene.level.tileSize,
          maxX: (enemy.x + enemy.right) * scene.level.tileSize + scene.level.tileSize,
        }))
    for (const enemy of enemies) {
      if (scene.mode === 'edit') {
        ctx.strokeStyle = 'rgba(196,72,58,0.8)'
        ctx.setLineDash([4, 3])
        ctx.beginPath()
        ctx.moveTo(enemy.minX, enemy.y + ENEMY_H + 3)
        ctx.lineTo(enemy.maxX, enemy.y + ENEMY_H + 3)
        ctx.stroke()
        ctx.setLineDash([])
      }
      const tracker = scene.level.enemies.find((entry) => entry.id === enemy.id)?.kind === 'tracker'
      drawEnemy(ctx, enemy.x, enemy.y, enemy.dir, scene.time, tracker)
      if (scene.selectedEnemyId && 'id' in enemy && enemy.id === scene.selectedEnemyId) {
        ctx.strokeStyle = '#e0a15a'
        ctx.lineWidth = 2
        ctx.strokeRect(enemy.x - 3, enemy.y - 3, ENEMY_W + 6, ENEMY_H + 6)
        ctx.lineWidth = 1
      }
    }
  }
  if (scene.state) drawPlayer(ctx, scene.state.player.x, scene.state.player.y, scene.state.player.facing, scene.state.player.vx, scene.time, scene.state.player.onGround)
  else if (scene.mode === 'edit' && scene.layers.markers) {
    const ts = scene.level.tileSize
    const x = scene.level.start.x * ts + (ts - PLAYER_W) / 2
    const y = scene.level.start.y * ts + ts - PLAYER_H
    ctx.save()
    ctx.globalAlpha = 0.45
    drawPlayer(ctx, x, y, 1, 0, scene.time, true)
    ctx.restore()
  }
}

function drawEnemy(ctx: CanvasRenderingContext2D, x: number, y: number, dir: number, time: number, tracker = false): void {
  const hop = Math.abs(Math.sin(time * 8)) * 2
  ctx.fillStyle = tracker ? '#1d4e89' : '#9a3412'
  ctx.fillRect(x + 2, y + 18 - hop, 8, 6)
  ctx.fillRect(x + 14, y + 18 - hop, 8, 6)
  ctx.fillStyle = tracker ? '#3d8bfd' : '#de4d3a'
  round(ctx, x, y - hop, ENEMY_W, 20, 6)
  ctx.fill()
  ctx.fillStyle = '#fff7ef'
  const eyeX = dir >= 0 ? x + 13 : x + 5
  ctx.beginPath()
  ctx.arc(eyeX, y + 8 - hop, 3, 0, Math.PI * 2)
  ctx.arc(eyeX + 6, y + 8 - hop, 3, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#2b2118'
  ctx.fillRect(eyeX + 1, y + 7 - hop, 2, 2)
  ctx.fillRect(eyeX + 7, y + 7 - hop, 2, 2)
}

function drawPlayer(ctx: CanvasRenderingContext2D, x: number, y: number, facing: number, vx: number, time: number, onGround: boolean): void {
  const stride = onGround ? Math.sin(time * 14) * Math.min(1, Math.abs(vx) / 80) * 4 : 0
  ctx.fillStyle = '#1f3348'
  ctx.fillRect(x + 2, y + 18, 5, 10 + stride)
  ctx.fillRect(x + 11, y + 18, 5, 10 - stride)
  ctx.fillStyle = '#e39b4a'
  round(ctx, x + 1, y + 10, PLAYER_W - 2, 12, 3)
  ctx.fill()
  ctx.fillStyle = '#f4d7b0'
  round(ctx, x + 2, y, PLAYER_W - 4, 12, 4)
  ctx.fill()
  ctx.fillStyle = '#2b2118'
  const eye = facing >= 0 ? x + 11 : x + 5
  ctx.fillRect(eye, y + 4, 2, 2)
}

function drawMarkers(ctx: CanvasRenderingContext2D, scene: Scene): void {
  if (scene.mode === 'edit' && !scene.layers.markers) return
  const ts = scene.level.tileSize
  const goal = scene.level.goal
  const locked = scene.state
    ? scene.state.coinsCollected < goal.requireCoins || scene.state.keysCollected < goal.requireKeys
    : goal.requireCoins > scene.level.coins.length || goal.requireKeys > scene.level.keys.length
  drawGoal(ctx, goal.x * ts, goal.y * ts, ts, locked, scene.time)
  if (scene.mode === 'edit' && scene.layers.markers) {
    ctx.fillStyle = '#2f6d4f'
    const sx = scene.level.start.x * ts
    const sy = scene.level.start.y * ts
    ctx.fillRect(sx + ts / 2 - 2, sy + 6, 4, ts - 10)
    ctx.beginPath()
    ctx.moveTo(sx + 8, sy + 8)
    ctx.lineTo(sx + ts - 8, sy + ts / 2)
    ctx.lineTo(sx + 8, sy + ts - 8)
    ctx.fill()
  }
}

function drawGoal(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, locked: boolean, time: number): void {
  ctx.fillStyle = '#f7f3ea'
  ctx.fillRect(x + 8, y + 4, 3, s - 6)
  ctx.fillStyle = locked ? '#8d8678' : '#e07a3d'
  const wave = Math.sin(time * 4) * 2
  ctx.beginPath()
  ctx.moveTo(x + 11, y + 6)
  ctx.lineTo(x + s - 4, y + 10 + wave)
  ctx.lineTo(x + 11, y + 16)
  ctx.closePath()
  ctx.fill()
}

function drawGrid(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const ts = scene.level.tileSize
  const x0 = Math.max(0, Math.floor(scene.camera.x / ts) * ts)
  const y0 = Math.max(0, Math.floor(scene.camera.y / ts) * ts)
  const x1 = Math.min(scene.level.width * ts, scene.camera.x + scene.viewWidth + ts)
  const y1 = Math.min(scene.level.height * ts, scene.camera.y + scene.viewHeight + ts)
  ctx.beginPath()
  for (let x = x0; x <= x1; x += ts) {
    ctx.moveTo(x + 0.5, y0)
    ctx.lineTo(x + 0.5, y1)
  }
  for (let y = y0; y <= y1; y += ts) {
    ctx.moveTo(x0, y + 0.5)
    ctx.lineTo(x1, y + 0.5)
  }
  ctx.strokeStyle = 'rgba(42, 32, 22, 0.18)'
  ctx.stroke()
  ctx.strokeStyle = 'rgba(42, 32, 22, 0.28)'
  ctx.strokeRect(0.5, 0.5, scene.level.width * ts - 1, scene.level.height * ts - 1)
}

function drawEditorAids(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const ts = scene.level.tileSize
  for (const col of scene.guides.cols) {
    ctx.fillStyle = 'rgba(224,161,90,0.35)'
    ctx.fillRect(col * ts, scene.camera.y, ts, scene.viewHeight)
  }
  for (const row of scene.guides.rows) {
    ctx.fillStyle = 'rgba(224,161,90,0.28)'
    ctx.fillRect(scene.camera.x, row * ts, scene.viewWidth, ts)
  }
  const cell = scene.hover
  if (cell && cell.x >= 0 && cell.y >= 0 && cell.x < scene.level.width && cell.y < scene.level.height) {
    ctx.strokeStyle = '#2a2118'
    ctx.strokeRect(cell.x * ts + 1, cell.y * ts + 1, ts - 2, ts - 2)
  }
  const tsBox = scene.level.tileSize
  for (const item of scene.selection ?? []) {
    const cell = itemCell(scene.level, item)
    if (!cell) continue
    ctx.strokeStyle = '#e0a15a'
    ctx.lineWidth = 2
    ctx.strokeRect(cell.x * tsBox + 2, cell.y * tsBox + 2, tsBox - 4, tsBox - 4)
    ctx.lineWidth = 1
  }
  if (scene.selectionBox && scene.selectionBox.w > 0 && scene.selectionBox.h > 0) {
    ctx.fillStyle = 'rgba(224,161,90,0.16)'
    ctx.fillRect(scene.selectionBox.x, scene.selectionBox.y, scene.selectionBox.w, scene.selectionBox.h)
    ctx.strokeStyle = '#e0a15a'
    ctx.strokeRect(scene.selectionBox.x, scene.selectionBox.y, scene.selectionBox.w, scene.selectionBox.h)
  }
  for (const issue of scene.issues ?? []) {
    ctx.strokeStyle = '#d15b52'
    ctx.lineWidth = 2
    ctx.strokeRect(issue.x * tsBox + 1, issue.y * tsBox + 1, tsBox - 2, tsBox - 2)
    ctx.lineWidth = 1
  }
  if (!scene.ghost) return
  ctx.save()
  ctx.globalAlpha = 0.55
  const x = scene.ghost.x * ts
  const y = scene.ghost.y * ts
  if (scene.ghost.tool === 'solid') drawSolid(ctx, x, y, ts)
  else if (scene.ghost.tool === 'oneWay') drawOneWay(ctx, x, y, ts)
  else if (scene.ghost.tool === 'hazard') drawHazard(ctx, x, y, ts, scene.time)
  else if (scene.ghost.tool === 'coin') drawCoin(ctx, scene.ghost.x, scene.ghost.y, ts, scene.time)
  else if (scene.ghost.tool === 'key') drawKey(ctx, scene.ghost.x, scene.ghost.y, ts, scene.time)
  else if (scene.ghost.tool === 'enemy') drawEnemy(ctx, x + (ts - ENEMY_W) / 2, y + ts - ENEMY_H, 1, scene.time)
  else if (scene.ghost.tool === 'tracker') drawEnemy(ctx, x + (ts - ENEMY_W) / 2, y + ts - ENEMY_H, 1, scene.time, true)
  else if (scene.ghost.tool === 'platform') drawPlatformSlab(ctx, x, y, ts * 3, 10)
  else ctx.strokeRect(x + 2, y + 2, ts - 4, ts - 4)
  ctx.restore()
}

function itemCell(level: Level, item: ItemRef): { x: number; y: number } | null {
  if (item.kind === 'tile' || item.kind === 'coin' || item.kind === 'key') return { x: item.x, y: item.y }
  if (item.kind === 'start') return level.start
  if (item.kind === 'goal') return level.goal
  if (item.kind === 'enemy') {
    const enemy = level.enemies.find((entry) => entry.id === item.id)
    return enemy ? { x: enemy.x, y: enemy.y } : null
  }
  if (item.kind === 'platform') {
    const platform = level.platforms.find((entry) => entry.id === item.id)
    return platform ? { x: platform.x, y: platform.y } : null
  }
  const checkpoint = level.checkpoints.find((entry) => entry.id === item.id)
  return checkpoint ? { x: checkpoint.x, y: checkpoint.y } : null
}

function round(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

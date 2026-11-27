import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

async function canvasPoint(page: Page, tx: number, ty: number): Promise<{ x: number; y: number }> {
  const canvas = page.locator('#editor-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('编辑画布不可见')
  const camera = await page.evaluate(() => {
    const api = window.__GAME__
    if (!api) throw new Error('游戏调试接口不存在')
    return api.getEditorCamera()
  })
  return { x: box.x + (tx + 0.5) * 32 - camera.x, y: box.y + (ty + 0.5) * 32 - camera.y }
}

async function dragTiles(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const start = await canvasPoint(page, from.x, from.y)
  const end = await canvasPoint(page, to.x, to.y)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 8 })
  await page.mouse.up()
}

test('框选两个金币后复制粘贴出新的金币', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '编辑器' }).click()
  await page.getByRole('button', { name: '新建关卡' }).click()
  await page.locator('#tool-coin').click()
  const first = await canvasPoint(page, 4, 11)
  const second = await canvasPoint(page, 6, 11)
  await page.mouse.click(first.x, first.y)
  await page.mouse.click(second.x, second.y)
  await page.locator('#tool-select').click()
  await dragTiles(page, { x: 3, y: 11 }, { x: 7, y: 11 })
  await expect(page.locator('#editor-status')).toContainText('已选 2')
  await page.getByRole('button', { name: '复制' }).click()
  await expect(page.locator('#toast')).toContainText('已复制')
  const pasteAt = await canvasPoint(page, 10, 11)
  await page.mouse.move(pasteAt.x, pasteAt.y, { steps: 8 })
  await expect(page.locator('#editor-status')).toContainText('光标 10, 11')
  await page.getByRole('button', { name: '粘贴' }).click()
  await expect.poll(() => page.evaluate(() => window.__GAME__?.getLevel().coins.map((coin) => `${coin.x},${coin.y}`).sort())).toEqual(['10,11', '12,11', '4,11', '6,11'])
})

test('钥匙不够时保存被拦住，刷新后仍是上一份合法关卡', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '编辑器' }).click()
  await page.getByRole('button', { name: '新建关卡' }).click()
  await page.locator('#require-keys').fill('3')
  await page.locator('#require-keys').blur()
  await expect(page.locator('#validation-list')).toContainText('钥匙')
  await expect(page.locator('#validation-list')).toContainText('20, 11')
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.locator('#toast')).toContainText('保存被拦住')
  await expect(page.locator('#toast')).toContainText('钥匙')
  await page.reload()
  await page.getByRole('button', { name: '编辑器' }).click()
  await expect.poll(() => page.evaluate(() => window.__GAME__?.getLevel().goal.requireKeys)).toBe(0)
})

test('第 4 关示例脚本能通关', async ({ page }) => {
  mkdirSync('e2e-screenshots', { recursive: true })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/')
  await page.evaluate(() => window.__GAME__?.previewBuiltin('builtin-lift', 'won'))
  await expect(page.locator('#game-overlay')).toContainText('你到达了终点')
  await page.screenshot({ path: 'e2e-screenshots/lift-win.png', fullPage: true })
})

test('导入版本 1 关卡后迁移到版本 2 并可以走到终点', async ({ page }) => {
  const tiles = Array.from({ length: 16 }, (_, x) => ({ x, y: 8, type: 'solid' }))
  const legacy = {
    version: 1,
    id: 'legacy-corridor',
    name: '旧走廊',
    width: 16,
    height: 12,
    tileSize: 32,
    physics: { gravity: 1800, jumpHeight: 128, moveSpeed: 220 },
    start: { x: 1, y: 7 },
    goal: { x: 13, y: 7, requireCoins: 0, requireKeys: 0 },
    tiles,
    coins: [],
    keys: [],
    enemies: [],
  }
  await page.goto('/')
  await page.getByRole('button', { name: '编辑器' }).click()
  await page.locator('#file-import').setInputFiles({
    name: 'legacy-corridor.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(legacy)),
  })
  await expect(page.locator('#toast')).toContainText('已导入')
  const migrated = await page.evaluate(() => window.__GAME__?.getLevel())
  expect(migrated?.version).toBe(2)
  expect(migrated?.name).toBe('旧走廊')
  expect(migrated?.platforms).toEqual([])
  expect(migrated?.checkpoints).toEqual([])
  expect(migrated?.physics.doubleJump).toBe(false)
  await page.getByRole('button', { name: '试玩' }).click()
  await page.keyboard.down('ArrowRight')
  await expect.poll(() => page.evaluate(() => window.__GAME__?.getState()?.status ?? 'missing'), { timeout: 8_000 }).toBe('won')
  await page.keyboard.up('ArrowRight')
})

test('移动台工具可以接上一条垂直路径', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '编辑器' }).click()
  await page.getByRole('button', { name: '新建关卡' }).click()
  await page.locator('#tool-platform').click()
  const origin = await canvasPoint(page, 4, 10)
  await page.mouse.click(origin.x, origin.y)
  const next = await canvasPoint(page, 8, 6)
  await page.mouse.click(next.x, next.y)
  const path = await page.evaluate(() => window.__GAME__?.getLevel().platforms[0]?.path ?? [])
  expect(path.length).toBeGreaterThanOrEqual(3)
  expect(path[path.length - 1]).toEqual({ x: 8, y: 6 })
})

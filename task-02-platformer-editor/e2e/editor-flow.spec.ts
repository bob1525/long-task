import { expect, test } from '@playwright/test'
import { clickTile } from './helpers'

test('新建关卡、编辑、保存、重新加载后内容一致，并在试玩中到达终点', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '编辑器' }).click()
  await page.getByRole('button', { name: '新建关卡' }).click()
  await page.locator('#level-name').fill('E2E 测试关')
  await page.locator('#level-name').blur()

  await page.locator('#tool-coin').click()
  await clickTile(page, 5, 11)
  await page.locator('#tool-goal').click()
  await clickTile(page, 8, 11)
  await page.locator('#tool-solid').click()
  await clickTile(page, 14, 9)
  await page.getByRole('button', { name: '保存' }).click()

  const before = await page.evaluate(() => {
    const api = window.__GAME__
    if (!api) throw new Error('游戏调试接口不存在')
    return api.getLevel()
  })
  expect(before.name).toBe('E2E 测试关')
  expect(before.goal).toMatchObject({ x: 8, y: 11, requireCoins: 0, requireKeys: 0 })
  expect(before.coins).toEqual([{ x: 5, y: 11 }])
  expect(before.tiles.some((tile) => tile.x === 14 && tile.y === 9 && tile.type === 'solid')).toBe(true)

  await page.reload()
  await page.getByRole('button', { name: '编辑器' }).click()
  const after = await page.evaluate(() => {
    const api = window.__GAME__
    if (!api) throw new Error('游戏调试接口不存在')
    return api.getLevel()
  })
  expect(after.name).toBe(before.name)
  expect(after.tiles).toEqual(before.tiles)
  expect(after.coins).toEqual(before.coins)
  expect(after.keys).toEqual(before.keys)
  expect(after.enemies).toEqual(before.enemies)
  expect(after.goal).toEqual(before.goal)
  expect(after.start).toEqual(before.start)
  expect(after.physics).toEqual(before.physics)
  expect(after.width).toBe(before.width)
  expect(after.height).toBe(before.height)

  await page.getByRole('button', { name: '试玩' }).click()
  await expect.poll(() => page.evaluate(() => window.__GAME__?.isPlaytesting())).toBe(true)
  await page.keyboard.down('ArrowRight')
  await expect.poll(() => page.evaluate(() => window.__GAME__?.getState()?.status ?? 'missing'), { timeout: 8_000 }).toBe('won')
  await page.keyboard.up('ArrowRight')
  await expect(page.locator('#editor-overlay')).toContainText('你到达了终点')
})

test('撤销和重做覆盖连续 20 次放置', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '编辑器' }).click()
  await page.getByRole('button', { name: '新建关卡' }).click()
  await page.locator('#tool-coin').click()
  for (let x = 0; x < 20; x += 1) await clickTile(page, x, 8)
  await expect.poll(() => page.evaluate(() => window.__GAME__?.getLevel().coins.length)).toBe(20)
  for (let i = 0; i < 20; i += 1) await page.getByRole('button', { name: '撤销' }).click()
  await expect.poll(() => page.evaluate(() => window.__GAME__?.getLevel().coins.length)).toBe(0)
  for (let i = 0; i < 20; i += 1) await page.getByRole('button', { name: '重做' }).click()
  await expect.poll(() => page.evaluate(() => window.__GAME__?.getLevel().coins.length)).toBe(20)
})

test('隐藏地形图层会改变画面，对齐辅助开关可切换', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '编辑器' }).click()
  const sample = await page.evaluate(() => {
    const api = window.__GAME__
    if (!api) throw new Error('游戏调试接口不存在')
    const level = api.getLevel()
    const camera = api.getEditorCamera()
    const tile = level.tiles.find((entry) => {
      const px = entry.x * 32 + 16 - camera.x
      const py = entry.y * 32 + 16 - camera.y
      return entry.type === 'solid' && px > 12 && py > 12 && px < 640 && py < 460
    })
    if (!tile) return null
    return { x: tile.x, y: tile.y, color: api.sampleEditorTile(tile.x, tile.y) }
  })
  expect(sample).not.toBeNull()
  expect(sample!.color).not.toBeNull()
  await page.locator('#layer-terrain').uncheck()
  const hidden = await page.evaluate(({ x, y }) => window.__GAME__?.sampleEditorTile(x, y) ?? null, sample!)
  expect(hidden).not.toBeNull()
  const diff = Math.abs(sample!.color!.r - hidden!.r) + Math.abs(sample!.color!.g - hidden!.g) + Math.abs(sample!.color!.b - hidden!.b)
  expect(diff).toBeGreaterThan(25)
  await expect.poll(() => page.evaluate(() => window.__GAME__?.getLayers().terrain)).toBe(false)
  await page.locator('#show-guides').uncheck()
  await expect.poll(() => page.evaluate(() => window.__GAME__?.getGuidesEnabled())).toBe(false)
  await page.locator('#show-guides').check()
  await expect.poll(() => page.evaluate(() => window.__GAME__?.getGuidesEnabled())).toBe(true)
  await page.locator('#show-grid').uncheck()
  await expect.poll(() => page.evaluate(() => window.__GAME__?.getGridEnabled())).toBe(false)
})

test('非法 JSON 给出可读错误且页面不崩溃，合法文件可以再导入', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '编辑器' }).click()
  await page.getByRole('button', { name: '新建关卡' }).click()
  await page.locator('#level-name').fill('导入源')
  await page.locator('#level-name').blur()
  await page.locator('#tool-key').click()
  await clickTile(page, 6, 11)
  await page.getByRole('button', { name: '保存' }).click()

  await page.locator('#file-import').setInputFiles({
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{', 'utf8'),
  })
  await expect(page.locator('#toast')).toContainText('JSON 无法解析')
  await expect(page.locator('#editor-canvas')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__GAME__?.getLevel().name)).toBe('导入源')

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '下载 JSON' }).click(),
  ])
  const downloaded = await download.path()
  if (!downloaded) throw new Error('没有下载到关卡文件')
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__GAME__?.getCustomLevels().some((level) => level.name === '导入源'))).toBe(false)

  await page.locator('#file-import').setInputFiles(downloaded)
  await expect(page.locator('#toast')).toContainText('已导入')
  const imported = await page.evaluate(() => window.__GAME__?.getLevel())
  expect(imported?.name).toBe('导入源')
  expect(imported?.keys).toEqual([{ x: 6, y: 11 }])
})

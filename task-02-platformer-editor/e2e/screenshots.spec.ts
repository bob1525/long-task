import { mkdirSync } from 'node:fs'
import { expect, test } from '@playwright/test'

test('保存内置关卡、通关、编辑器和试玩截图', async ({ page }) => {
  mkdirSync('e2e-screenshots', { recursive: true })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/')

  const shots: Array<[string, string]> = [
    ['builtin-meadow', 'e2e-screenshots/meadow-playing.png'],
    ['builtin-bridge', 'e2e-screenshots/bridge-playing.png'],
    ['builtin-patrol', 'e2e-screenshots/patrol-playing.png'],
  ]
  for (const [id, file] of shots) {
    await page.evaluate((levelId) => window.__GAME__?.previewBuiltin(levelId, 'playing'), id)
    await expect.poll(() => page.evaluate(() => window.__GAME__?.getState()?.status)).toBe('playing')
    const moved = await page.evaluate(() => window.__GAME__?.getState()?.player.x ?? 0)
    expect(moved).toBeGreaterThan(150)
    await page.screenshot({ path: file })
  }

  await page.evaluate(() => window.__GAME__?.previewBuiltin('builtin-meadow', 'won'))
  await expect(page.locator('#game-overlay')).toContainText('你到达了终点')
  await page.screenshot({ path: 'e2e-screenshots/win.png' })

  await page.getByRole('button', { name: '编辑器' }).click()
  await page.getByRole('button', { name: /晨间小路/ }).click()
  await expect(page.locator('#editor-canvas')).toBeVisible()
  await page.screenshot({ path: 'e2e-screenshots/editor.png' })

  await page.getByRole('button', { name: '试玩' }).click()
  await expect(page.locator('#playtest-banner')).toBeVisible()
  const startX = await page.evaluate(() => window.__GAME__?.getState()?.player.x ?? 0)
  await page.keyboard.down('ArrowRight')
  await expect.poll(() => page.evaluate(() => window.__GAME__?.getState()?.player.x ?? 0)).toBeGreaterThan(startX + 20)
  await page.keyboard.up('ArrowRight')
  await page.screenshot({ path: 'e2e-screenshots/editor-playtest.png' })
})

import { expect, test } from '@playwright/test'
import { assertInViewport, clickTile } from './helpers'

const viewports = [
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
] as const

for (const viewport of viewports) {
  test(`显示与操作 ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto('/')
    await expect(page.locator('#game-canvas')).toBeVisible()
    await assertInViewport(page, '#btn-restart', viewport)
    await assertInViewport(page, '#gravity', viewport)
    await assertInViewport(page, '#jump-height', viewport)
    await assertInViewport(page, '#move-speed', viewport)
    await assertInViewport(page, '#tab-editor', viewport)

    await page.locator('#btn-restart').click()
    const y0 = await page.evaluate(() => window.__GAME__?.getState()?.player.y ?? 0)
    await page.keyboard.down('Space')
    await expect.poll(() => page.evaluate(() => window.__GAME__?.getState()?.player.y ?? 0)).toBeLessThan(y0 - 20)
    await page.keyboard.up('Space')

    await page.locator('#btn-restart').click()
    const x0 = await page.evaluate(() => window.__GAME__?.getState()?.player.x ?? 0)
    await page.keyboard.down('ArrowRight')
    await expect.poll(() => page.evaluate(() => window.__GAME__?.getState()?.player.x ?? 0)).toBeGreaterThan(x0 + 15)
    await page.keyboard.up('ArrowRight')

    await page.locator('#gravity').evaluate((element: HTMLInputElement) => {
      element.value = '2500'
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await expect.poll(() => page.evaluate(() => window.__GAME__?.getPhysics().gravity)).toBe(2500)

    await page.getByRole('button', { name: '编辑器' }).click()
    for (const selector of ['#editor-canvas', '#btn-new-level', '#btn-playtest', '#btn-undo', '#btn-redo', '#tool-solid', '#level-name']) {
      await assertInViewport(page, selector, viewport)
    }
    const before = await page.evaluate(() => window.__GAME__?.getLevel().tiles.length ?? 0)
    await page.locator('#tool-solid').click()
    await clickTile(page, 3, 2)
    await expect.poll(() => page.evaluate(() => window.__GAME__?.getLevel().tiles.length ?? 0)).toBe(before + 1)

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
  })
}

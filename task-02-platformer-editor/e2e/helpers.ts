import { expect, type Page } from '@playwright/test'

export async function clickTile(page: Page, tx: number, ty: number): Promise<void> {
  const canvas = page.locator('#editor-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('编辑画布不可见')
  const camera = await page.evaluate(() => {
    const api = window.__GAME__
    if (!api) throw new Error('游戏调试接口不存在')
    return api.getEditorCamera()
  })
  await page.mouse.click(box.x + (tx + 0.5) * 32 - camera.x, box.y + (ty + 0.5) * 32 - camera.y)
}

export async function assertInViewport(page: Page, selector: string, viewport: { width: number; height: number }): Promise<void> {
  const box = await page.locator(selector).boundingBox()
  expect(box, selector).not.toBeNull()
  expect(box!.x, selector).toBeGreaterThanOrEqual(-1)
  expect(box!.y, selector).toBeGreaterThanOrEqual(-1)
  expect(box!.x + box!.width, selector).toBeLessThanOrEqual(viewport.width + 1)
  expect(box!.y + box!.height, selector).toBeLessThanOrEqual(viewport.height + 1)
}

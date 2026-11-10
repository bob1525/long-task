import { expect, test } from '@playwright/test';

async function runToEnd(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('btn-run').click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
}

test('阶乘可以单步、查看环境、回溯并得到 3628800', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'ready');
  await expect(page.getByTestId('editor')).toContainText('factorial');

  for (let count = 0; count < 40; count += 1) {
    const stack = await page.getByTestId('call-stack').innerText();
    if (stack.includes('factorial')) break;
    await page.getByTestId('btn-step').click();
  }
  await expect(page.getByTestId('call-stack')).toContainText('factorial');
  await expect(page.getByTestId('memory')).toContainText('栈深');
  await expect(page.getByTestId('memory')).toContainText('点对');
  await page.locator('[data-env-label="factorial"]').first().click();
  await expect(page.getByTestId('env-detail')).toContainText('n');
  await page.screenshot({
    path: '/opt/cursor/artifacts/factorial-step.png',
    fullPage: false,
  });

  const stepBefore = await page.getByTestId('step-index').innerText();
  await page.getByTestId('btn-back').click();
  await expect(page.getByTestId('step-index')).not.toHaveText(stepBefore);

  await page.getByTestId('history-slider').fill('0');
  await expect(page.getByTestId('step-index')).toHaveText('0');

  await runToEnd(page);
  await expect(page.getByTestId('result')).toHaveText('3628800');
  await expect(page.getByTestId('output')).toContainText('=> 3628800');

  await page.getByTestId('btn-reset').click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'ready');
  await expect(page.getByTestId('result')).toHaveText('');
});

test('斐波那契得到 55', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('example-select').selectOption('fibonacci');
  await runToEnd(page);
  await expect(page.getByTestId('result')).toHaveText('55');
});

test('列表反转得到 (5 4 3 2 1)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('example-select').selectOption('reverse');
  await runToEnd(page);
  await expect(page.getByTestId('result')).toHaveText('(5 4 3 2 1)');
});

test('手写 map 与 filter', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('example-select').selectOption('map-filter');
  await runToEnd(page);
  const output = await page.getByTestId('output').innerText();
  expect(output).toContain('(1 4 9 16)');
  expect(output).toContain('=> (2 4 6)');
  await expect(page.getByTestId('result')).toHaveText('(2 4 6)');
});

test('闭包示例输出捕获的值并得到 17', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('example-select').selectOption('closure');
  await runToEnd(page);
  const output = (await page.getByTestId('output').innerText()).replace(/\r/g, '');
  expect(output).toContain('8');
  expect(output).toContain('13');
  expect(output).toMatch(/8\s+13\s+1\s+2\s+1/);
  await expect(page.getByTestId('result')).toHaveText('17');
  await page.locator('[data-env-label="内置"]').click();
  await expect(page.getByTestId('env-detail')).toContainText('cons');
});

test('语法错误不会让页面崩溃，修正示例后仍能运行', async ({ page }) => {
  await page.goto('/');
  const editor = page.getByTestId('editor').locator('.cm-content');
  await editor.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await expect(editor).not.toContainText('define');
  await page.keyboard.insertText('(');
  await page.getByTestId('btn-run').click();
  await expect(page.getByTestId('error')).toBeVisible();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'error');
  await expect(page.getByTestId('error')).toContainText('语法错误');
  await expect(page.getByTestId('btn-step')).toBeDisabled();
  await page.locator('.cm-content').click();
  await page.keyboard.type('x');
  await expect(page.getByTestId('btn-step')).toBeEnabled();

  await page.getByTestId('example-select').selectOption('factorial');
  await runToEnd(page);
  await expect(page.getByTestId('result')).toHaveText('3628800');
});

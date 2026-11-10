import { copyFileSync, mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { MAX_HISTORY } from '../src/lisp/limits';

async function saveShot(page: Page, name: string): Promise<void> {
  mkdirSync('e2e-shots', { recursive: true });
  const local = `e2e-shots/${name}.png`;
  await page.screenshot({ path: local, fullPage: false });
  try {
    mkdirSync('/opt/cursor/artifacts', { recursive: true });
    copyFileSync(local, `/opt/cursor/artifacts/${name}.png`);
  } catch {
    // CI runners do not have the local artifact directory.
  }
}

async function runToEnd(page: Page): Promise<void> {
  await page.getByTestId('btn-run').click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
}

async function stepUntilStack(page: Page, name: string, max = 80): Promise<void> {
  for (let count = 0; count < max; count += 1) {
    const stack = await page.getByTestId('call-stack').innerText();
    if (stack.includes(name)) return;
    await page.getByTestId('btn-step').click();
  }
}

async function expectMaxStack(page: Page, depth: number): Promise<void> {
  const memory = await page.getByTestId('memory').innerText();
  expect(memory).toMatch(new RegExp(`最大栈深\\s*${depth}(?!\\d)`));
}

async function replaceEditor(page: Page, source: string): Promise<void> {
  const editor = page.getByTestId('editor').locator('.cm-content');
  await editor.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await expect(editor).not.toContainText('define');
  await page.keyboard.insertText(source);
}

async function openLiveFrame(page: Page, label: string, binding: RegExp): Promise<void> {
  const buttons = page.locator('[data-testid="live-frame"]');
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const text = await buttons.nth(index).innerText();
    if (text.includes(label) && binding.test(text)) {
      await buttons.nth(index).click();
      return;
    }
  }
  throw new Error(`没有找到存活帧 ${label} / ${binding}`);
}

test('阶乘可以单步、查看环境、回溯并得到 3628800', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'ready');
  await expect(page.getByTestId('editor')).toContainText('factorial');

  await stepUntilStack(page, 'factorial');
  await expect(page.getByTestId('call-stack')).toContainText('factorial');
  await expect(page.getByTestId('current-expr')).toContainText('if');
  await expect(page.getByTestId('memory')).toContainText('栈深');
  await expect(page.getByTestId('memory')).toContainText('点对');
  await page.locator('[data-env-label="factorial"]').first().click();
  await expect(page.getByTestId('env-detail')).toContainText(/n\s*=\s*10(?!\d)/);
  await saveShot(page, 'factorial-step');

  const stepBefore = await page.getByTestId('step-index').innerText();
  await page.getByTestId('btn-back').click();
  await expect(page.getByTestId('step-index')).not.toHaveText(stepBefore);

  await page.getByTestId('history-slider').fill('0');
  await expect(page.getByTestId('step-index')).toHaveText('0');

  await runToEnd(page);
  await expect(page.getByTestId('result')).toHaveText('3628800');
  await expect(page.getByTestId('output')).toContainText('=> 3628800');
  await expectMaxStack(page, 11);

  await page.getByTestId('btn-reset').click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'ready');
  await expect(page.getByTestId('result')).toHaveText('');
});

test('斐波那契单步能看到 fib 的参数，结果为 55', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('example-select').selectOption('fibonacci');
  await stepUntilStack(page, 'fib');
  await expect(page.getByTestId('call-stack')).toContainText('fib');
  await expect(page.getByTestId('current-expr')).toContainText('fib');
  await page.locator('[data-env-label="fib"]').first().click();
  await expect(page.getByTestId('env-detail')).toContainText(/n\s*=\s*10(?!\d)/);
  await saveShot(page, 'fibonacci-step');
  await runToEnd(page);
  await expect(page.getByTestId('result')).toHaveText('55');
});

test('列表反转单步可见尾调用，最大栈深保持 1', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('example-select').selectOption('reverse');
  await stepUntilStack(page, 'rev(');
  await expect(page.getByTestId('call-stack')).toContainText('rev(');
  await expect(page.getByTestId('current-expr')).toContainText('null?');
  await page.locator('[data-env-label="rev"]').first().click();
  await expect(page.getByTestId('env-detail')).toContainText('xs');
  await expect(page.getByTestId('env-detail')).toContainText('acc');
  await expectMaxStack(page, 1);
  for (let count = 0; count < 24; count += 1) {
    await page.getByTestId('btn-step').click();
    await expectMaxStack(page, 1);
  }
  await saveShot(page, 'reverse-step');
  await runToEnd(page);
  await expect(page.getByTestId('result')).toHaveText('(5 4 3 2 1)');
  await expectMaxStack(page, 1);
});

test('手写 map 与 filter 能看到 map 的参数', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('example-select').selectOption('map-filter');
  await stepUntilStack(page, 'map');
  await expect(page.getByTestId('call-stack')).toContainText('map');
  await expect(page.getByTestId('current-expr')).toContainText('map');
  await page.locator('[data-env-label="map"]').first().click();
  await expect(page.getByTestId('env-detail')).toContainText('f');
  await expect(page.getByTestId('env-detail')).toContainText('xs');
  await saveShot(page, 'map-filter-step');
  await runToEnd(page);
  const output = await page.getByTestId('output').innerText();
  expect(output).toContain('(1 4 9 16)');
  expect(output).toContain('=> (2 4 6)');
  await expect(page.getByTestId('result')).toHaveText('(2 4 6)');
});

test('闭包示例能查看捕获环境里的 n', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('example-select').selectOption('closure');
  await stepUntilStack(page, 'make-adder');
  await expect(page.getByTestId('current-expr')).toContainText('lambda');
  await page.locator('[data-env-label="make-adder"]').first().click();
  await expect(page.getByTestId('env-detail')).toContainText(/n\s*=\s*5(?!\d)/);
  await saveShot(page, 'closure-step');

  await runToEnd(page);
  const output = (await page.getByTestId('output').innerText()).replace(/\r/g, '');
  expect(output).toContain('8');
  expect(output).toContain('13');
  expect(output).toMatch(/8\s+13\s+1\s+2\s+1/);
  await expect(page.getByTestId('result')).toHaveText('17');

  await openLiveFrame(page, 'make-adder', /n=5(?!\d)/);
  await expect(page.getByTestId('env-detail')).toContainText(/n\s*=\s*5(?!\d)/);
  await openLiveFrame(page, 'make-adder', /n=10(?!\d)/);
  await expect(page.getByTestId('env-detail')).toContainText(/n\s*=\s*10(?!\d)/);
  await openLiveFrame(page, 'let', /n=2(?!\d)/);
  await expect(page.getByTestId('env-detail')).toContainText(/n\s*=\s*2(?!\d)/);
  await openLiveFrame(page, 'let', /n=1(?!\d)/);
  await expect(page.getByTestId('env-detail')).toContainText(/n\s*=\s*1(?!\d)/);

  await page.locator('[data-env-label="全局"]').click();
  await page.getByTestId('proc-add5').click();
  await expect(page.getByTestId('env-detail')).toContainText(/n\s*=\s*5(?!\d)/);
  await page.locator('[data-env-label="全局"]').click();
  await page.getByTestId('proc-add10').click();
  await expect(page.getByTestId('env-detail')).toContainText(/n\s*=\s*10(?!\d)/);
  await page.locator('[data-env-label="全局"]').click();
  await page.getByTestId('proc-a').click();
  await expect(page.getByTestId('env-detail')).toContainText(/n\s*=\s*2(?!\d)/);
  await page.locator('[data-env-label="全局"]').click();
  await page.getByTestId('proc-b').click();
  await expect(page.getByTestId('env-detail')).toContainText(/n\s*=\s*1(?!\d)/);

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
  await expect(page.getByTestId('error')).toContainText('第 1 行');
  await expect(page.getByTestId('error')).toContainText('第 1 列');
  await expect(page.locator('.cm-eval-error')).toBeVisible();
  await expect(page.getByTestId('btn-step')).toBeDisabled();
  await page.locator('.cm-content').click();
  await page.keyboard.type('x');
  await expect(page.getByTestId('btn-step')).toBeEnabled();

  await page.getByTestId('example-select').selectOption('factorial');
  await runToEnd(page);
  await expect(page.getByTestId('result')).toHaveText('3628800');
});

test('运行时错误显示行列并在编辑器里高亮', async ({ page }) => {
  await page.goto('/');
  await replaceEditor(page, '(define (f x)\n  (/ x 0))\n\n\n(f 1)');
  await page.getByTestId('btn-run').click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'error');
  await expect(page.getByTestId('error')).toContainText('除以零');
  await expect(page.getByTestId('error')).toContainText('第 2 行');
  await expect(page.getByTestId('error')).toContainText('第 3 列');
  await expect(page.getByTestId('error')).toHaveAttribute('data-line', '2');
  await expect(page.getByTestId('error')).toHaveAttribute('data-column', '3');
  await expect(page.locator('.cm-eval-error')).toBeVisible();
  await page.getByTestId('example-select').selectOption('factorial');
  await runToEnd(page);
  await expect(page.getByTestId('result')).toHaveText('3628800');
});

test('尾递归死循环会停住，历史只保留最近的步骤', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await replaceEditor(page, '(define (f)\n  (f))\n(f)');
  await page.getByTestId('btn-run').click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'error', { timeout: 45_000 });
  await expect(page.getByTestId('error')).toContainText('最大求值步数');
  await expect(page.getByTestId('error')).toContainText('第 2 行');
  await expect(page.getByTestId('error')).toContainText('第 3 列');
  await expectMaxStack(page, 1);
  await expect(page.getByTestId('history-note')).toContainText('只保留最近');
  await expect(page.getByTestId('history-note')).toContainText(String(MAX_HISTORY));
  await expect(page.getByTestId('history-note')).toContainText('已丢弃');
  await page.getByTestId('example-select').selectOption('factorial');
  await runToEnd(page);
  await expect(page.getByTestId('result')).toHaveText('3628800');
});

test('非尾失控递归会停住，之后阶乘仍能运行', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await replaceEditor(page, '(define (g)\n  (+ 1 (g)))\n(g)');
  await page.getByTestId('btn-run').click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'error', { timeout: 45_000 });
  await expect(page.getByTestId('error')).toContainText('非尾调用栈深度');
  await expect(page.getByTestId('error')).toContainText('第 2 行');
  await expect(page.getByTestId('error')).toContainText('第 8 列');
  await expect(page.locator('.cm-eval-error')).toBeVisible();
  await page.getByTestId('example-select').selectOption('factorial');
  await runToEnd(page);
  await expect(page.getByTestId('result')).toHaveText('3628800');
});

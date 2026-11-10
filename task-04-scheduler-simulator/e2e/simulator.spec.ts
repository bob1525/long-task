import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

interface Slice {
  pid: number | null;
  start: number;
  end: number;
}

interface ResultRow {
  pid: number;
  completionTime: number;
  turnaroundTime: number;
  waitingTime: number;
  responseTime: number;
}

interface Run {
  algorithm: string;
  slices: Slice[];
  results: ResultRow[];
}

interface FixtureCase {
  id: string;
  processes: { burstTime: number }[];
  runs: Run[];
}

const oracle = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/standard-cases.json'), 'utf8')) as {
  cases: FixtureCase[];
};

const caseA = oracle.cases.find((item) => item.id === 'A');
if (!caseA) throw new Error('缺少用例 A');

mkdirSync(path.join(process.cwd(), 'screenshots'), { recursive: true });

async function readSlices(page: Page): Promise<Slice[]> {
  return page.getByTestId('gantt-slice').evaluateAll((nodes) =>
    nodes.map((node) => ({
      pid: node.getAttribute('data-pid') === 'idle' ? null : Number(node.getAttribute('data-pid')),
      start: Number(node.getAttribute('data-start')),
      end: Number(node.getAttribute('data-end')),
    })),
  );
}

function average(rows: ResultRow[], key: 'waitingTime' | 'turnaroundTime' | 'responseTime'): string {
  return (rows.reduce((sum, row) => sum + row[key], 0) / rows.length).toFixed(2);
}

function signature(slices: Slice[]): string {
  return slices
    .map((slice) => (slice.pid === null ? `空闲[${slice.start},${slice.end})` : `P${slice.pid}[${slice.start},${slice.end})`))
    .join(' ');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app')).toBeVisible();
  await expect(page.getByTestId('rules-strip')).toContainText('越小越高');
});

for (const run of caseA.runs) {
  test(`用例 A 的 ${run.algorithm} 甘特图与手算片段一致`, async ({ page }) => {
    await page.getByTestId(`algo-${run.algorithm}`).click();
    await page.getByTestId('preset-A').click();
    await page.getByTestId('btn-run-to-end').click();
    await expect(page.getByTestId('sim-time')).toHaveText('16');
    await expect(page.getByTestId('gantt-slice')).toHaveCount(run.slices.length);
    expect(await readSlices(page)).toEqual(run.slices);
    await expect(page.getByTestId('gantt-signature')).toHaveText(signature(run.slices));
    await expect(page.getByTestId('metric-waiting')).toHaveText(average(run.results, 'waitingTime'));
    await expect(page.getByTestId('metric-turnaround')).toHaveText(average(run.results, 'turnaroundTime'));
    await expect(page.getByTestId('metric-response')).toHaveText(average(run.results, 'responseTime'));
    await expect(page.getByTestId('metric-cpu')).toHaveText('100.00%');
    const first = run.results[0];
    if (first) {
      await expect(page.getByTestId(`stat-${first.pid}-completion`)).toHaveText(String(first.completionTime));
      await expect(page.getByTestId(`stat-${first.pid}-waiting`)).toHaveText(String(first.waitingTime));
    }
    await page.getByTestId('gantt').screenshot({ path: `screenshots/gantt-${run.algorithm}.png` });
    await page.screenshot({ path: `screenshots/full-${run.algorithm}.png`, fullPage: true });
  });
}

test('单步执行时能看到当前进程和就绪队列', async ({ page }) => {
  await page.getByTestId('preset-A').click();
  await page.getByTestId('algo-fcfs').click();
  await page.getByTestId('btn-step').click();
  await page.getByTestId('btn-step').click();
  await page.getByTestId('btn-step').click();
  await expect(page.getByTestId('sim-time')).toHaveText('3');
  await expect(page.getByTestId('running-process')).toHaveText('P1');
  await expect(page.getByTestId('ready-pid')).toHaveAttribute('data-pid', '2');
  await expect(page.getByTestId('stat-1-waiting')).toHaveText('0');
  await expect(page.getByTestId('stat-2-waiting')).toHaveText('1');
  await page.getByTestId('stage').screenshot({ path: 'screenshots/step-ready-queue.png' });
});

test('暂停后时钟不动，继续后前进', async ({ page }) => {
  await page.getByTestId('preset-A').click();
  await page.getByTestId('btn-slow').click();
  await expect(page.getByTestId('sim-time')).toHaveText('1');
  await page.getByTestId('btn-pause').click();
  await page.waitForTimeout(600);
  await expect(page.getByTestId('sim-time')).toHaveText('1');
  await page.getByTestId('btn-normal').click();
  await expect(page.getByTestId('sim-time')).toHaveText('2');
  await page.getByTestId('btn-pause').click();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('sim-time')).toHaveText('2');
  await page.getByTestId('btn-fast').click();
  await expect(page.getByTestId('sim-time')).not.toHaveText('2');
  await page.getByTestId('btn-pause').click();
});

test('运行中动态加入的进程进入后续调度', async ({ page }) => {
  await page.getByTestId('preset-A').click();
  await page.getByTestId('algo-fcfs').click();
  await page.getByTestId('btn-step').click();
  await page.getByTestId('btn-step').click();
  await page.getByTestId('btn-step').click();
  await page.getByTestId('add-pid').fill('5');
  await page.getByTestId('add-arrival').fill('3');
  await page.getByTestId('add-burst').fill('2');
  await page.getByTestId('add-priority').fill('1');
  await page.getByTestId('btn-add-process').click();
  await expect(page.getByTestId('process-row-5')).toBeVisible();
  await page.getByTestId('btn-run-to-end').click();
  const slices = await readSlices(page);
  expect(slices).toContainEqual({ pid: 5, start: 11, end: 13 });
  await expect(page.getByTestId('stat-5-completion')).toHaveText('13');
  await expect(page.getByTestId('stat-5-waiting')).toHaveText('8');
});

test('同一组进程可以并排对比并导出', async ({ page }) => {
  await page.getByTestId('preset-A').click();
  await page.getByTestId('tab-compare').click();
  await page.getByTestId('btn-compare').click();
  await expect(page.getByTestId('compare-row-fcfs')).toBeVisible();
  await expect(page.getByTestId('compare-row-sjf')).toBeVisible();
  await expect(page.getByTestId('compare-row-srtf')).toBeVisible();
  await expect(page.getByTestId('compare-row-rr')).toBeVisible();
  await expect(page.getByTestId('compare-row-priority-np')).toBeVisible();
  await expect(page.getByTestId('compare-row-priority-p')).toBeVisible();
  await expect(page.getByTestId('compare-row-mlfq')).toBeVisible();
  await expect(page.getByTestId('compare-fcfs-waiting')).toHaveText('4.75');
  await expect(page.getByTestId('compare-sjf-waiting')).toHaveText('4.00');
  await expect(page.getByTestId('compare-srtf-waiting')).toHaveText('3.00');
  const fcfsSlices = caseA.runs.find((run) => run.algorithm === 'fcfs')?.slices ?? [];
  const sjfSlices = caseA.runs.find((run) => run.algorithm === 'sjf')?.slices ?? [];
  expect(fcfsSlices).not.toEqual(sjfSlices);
  await expect(page.getByTestId('compare-gantt-fcfs-signature')).toHaveText(signature(fcfsSlices));
  await expect(page.getByTestId('compare-gantt-sjf-signature')).toHaveText(signature(sjfSlices));
  await expect(page.getByTestId('compare-gantt-srtf-signature')).toHaveText(
    signature(caseA.runs.find((run) => run.algorithm === 'srtf')?.slices ?? []),
  );
  await page.getByTestId('compare-table').screenshot({ path: 'screenshots/comparison.png' });
  await page.getByTestId('compare-view').screenshot({ path: 'screenshots/comparison-full.png' });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('btn-export-compare').click(),
  ]);
  const filePath = await download.path();
  if (!filePath) throw new Error('没有下载到对比文件');
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { runs: { options: { algorithm: string } }[] };
  expect(parsed.runs.map((run) => run.options.algorithm)).toEqual([
    'fcfs',
    'sjf',
    'srtf',
    'rr',
    'priority-np',
    'priority-p',
    'mlfq',
  ]);
});

test('导出的 JSON 和 CSV 与屏幕上的甘特图一致', async ({ page }) => {
  const fcfs = caseA.runs.find((run) => run.algorithm === 'fcfs');
  if (!fcfs) throw new Error('缺少 FCFS');
  await page.getByTestId('preset-A').click();
  await page.getByTestId('algo-fcfs').click();
  await page.getByTestId('btn-run-to-end').click();
  const onScreen = await readSlices(page);

  const [jsonDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('btn-export-json').click(),
  ]);
  const jsonPath = await jsonDownload.path();
  if (!jsonPath) throw new Error('没有下载到 JSON');
  const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
    slices: Slice[];
    averages: { waiting: number };
  };
  expect(parsed.slices).toEqual(fcfs.slices);
  expect(parsed.slices).toEqual(onScreen);
  expect(parsed.averages.waiting).toBeCloseTo(4.75, 6);

  const [csvDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('btn-export-csv').click(),
  ]);
  const csvPath = await csvDownload.path();
  if (!csvPath) throw new Error('没有下载到 CSV');
  const csv = readFileSync(csvPath, 'utf8');
  expect(csv).toContain('record_type,algorithm,pid');
  expect(csv).toContain('makespan,cpu_utilization');
  expect(csv).toContain('slice,fcfs,1,');
  expect(csv).toContain('process,fcfs,2,');
  expect(csv).toContain('summary,fcfs,');
});

test('从时间片 1 切回用例 A 后仍按 q=2 手算', async ({ page }) => {
  const rr = caseA.runs.find((run) => run.algorithm === 'rr');
  if (!rr) throw new Error('缺少 RR');
  await page.getByTestId('algo-mlfq').click();
  await page.getByTestId('input-mlfq-0').fill('3');
  await page.getByTestId('input-mlfq-1').fill('3');
  await page.getByTestId('input-mlfq-2').fill('3');
  await page.getByTestId('algo-rr').click();
  await page.getByTestId('input-quantum').fill('1');
  await expect(page.getByTestId('input-quantum')).toHaveValue('1');
  await page.getByTestId('preset-A').click();
  await expect(page.getByTestId('input-quantum')).toHaveValue('2');
  await page.getByTestId('btn-run-to-end').click();
  expect(await readSlices(page)).toEqual(rr.slices);
  await page.getByTestId('algo-mlfq').click();
  await expect(page.getByTestId('input-mlfq-0')).toHaveValue('2');
  await expect(page.getByTestId('input-mlfq-1')).toHaveValue('4');
  await expect(page.getByTestId('input-mlfq-2')).toHaveValue('8');
});

test('I/O 示例会进入等待态', async ({ page }) => {
  await page.getByTestId('preset-IO').click();
  await page.getByTestId('btn-step').click();
  await page.getByTestId('btn-step').click();
  await expect(page.getByTestId('sim-time')).toHaveText('2');
  await expect(page.getByTestId('running-process')).toHaveText('空闲');
  await expect(page.getByTestId('waiting-pid')).toHaveAttribute('data-pid', '1');
  await expect(page.getByTestId('ready-pid')).toHaveAttribute('data-pid', '2');
  await expect(page.getByTestId('cpu-holding')).toContainText('P2');
  await expect(page.getByTestId('history-1')).toContainText('等待');
  await page.getByTestId('stage').screenshot({ path: 'screenshots/io-waiting.png' });
  await page.getByTestId('btn-run-to-end').click();
  expect(await readSlices(page)).toEqual([
    { pid: 1, start: 0, end: 2 },
    { pid: 2, start: 2, end: 5 },
    { pid: 1, start: 5, end: 7 },
  ]);
  await expect(page.getByTestId('metric-waiting')).toHaveText('1.00');
  await expect(page.getByTestId('stat-1-waiting')).toHaveText('0');
  await expect(page.getByTestId('stat-2-waiting')).toHaveText('2');
  await expect(page.getByTestId('waiting-empty')).toHaveText('无');
});

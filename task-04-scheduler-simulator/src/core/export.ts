import type { SimulationResult } from './types';

function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function resultToJson(result: SimulationResult): string {
  return JSON.stringify(result, null, 2);
}

export function comparisonToJson(results: readonly SimulationResult[]): string {
  return JSON.stringify({ runs: results }, null, 2);
}

export function comparisonToCsv(results: readonly SimulationResult[]): string {
  const header = ['algorithm', 'avg_waiting', 'avg_turnaround', 'avg_response', 'cpu_utilization', 'makespan'];
  const lines = [header.join(',')];
  for (const result of results) {
    lines.push(
      [
        result.options.algorithm,
        result.averages.waiting ?? '',
        result.averages.turnaround ?? '',
        result.averages.response ?? '',
        result.cpuUtilization,
        result.makespan,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

export function comparisonToHtml(results: readonly SimulationResult[]): string {
  const metric = (value: number | null): string => (value === null ? '—' : value.toFixed(2));
  const rows = results
    .map((result) => {
      const algorithm = result.options.algorithm;
      return `<tr><td>${algorithm}</td><td>${metric(result.averages.waiting)}</td><td>${metric(result.averages.turnaround)}</td><td>${metric(result.averages.response)}</td><td>${(result.cpuUtilization * 100).toFixed(2)}%</td><td>${result.makespan}</td></tr>`;
    })
    .join('');
  const maxWait = Math.max(1, ...results.map((result) => result.averages.waiting ?? 0));
  const bars = results
    .map((result) => {
      const width = (((result.averages.waiting ?? 0) / maxWait) * 100).toFixed(1);
      return `<div class="bar-row"><span>${result.options.algorithm}</span><i style="width:${width}%"></i><b>${metric(result.averages.waiting)}</b></div>`;
    })
    .join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>调度对比报告</title>
<style>
body { font-family: "Noto Sans CJK SC", sans-serif; margin: 24px; color: #17211c; }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid #d5ddd6; padding: 6px 8px; text-align: left; }
.bar-row { display: grid; grid-template-columns: 8rem 1fr 4rem; gap: 8px; align-items: center; margin: 6px 0; }
.bar-row i { display: block; height: 14px; background: #1d5c4d; }
@media print { body { margin: 0; } button { display: none; } }
</style>
</head>
<body>
<h1>调度对比报告</h1>
<p>同一组进程从 t=0 独立运行。等待、周转、响应是已完成进程的平均值。</p>
<table>
<thead><tr><th>算法</th><th>平均等待</th><th>平均周转</th><th>平均响应</th><th>CPU 利用率</th><th>完成时刻</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<h2>平均等待</h2>
${bars}
</body>
</html>
`;
}

export function resultToCsv(result: SimulationResult): string {
  const header = [
    'record_type',
    'algorithm',
    'pid',
    'arrival',
    'burst',
    'priority',
    'completion',
    'turnaround',
    'waiting',
    'response',
    'io_time',
    'slice_start',
    'slice_end',
    'makespan',
    'cpu_utilization',
  ];
  const lines = [header.join(',')];
  const algorithm = result.options.algorithm;
  for (const proc of result.processes) {
    lines.push(
      [
        'process',
        algorithm,
        proc.pid,
        proc.arrivalTime,
        proc.burstTime,
        proc.priority,
        proc.completionTime,
        proc.turnaroundTime,
        proc.waitingTime,
        proc.responseTime,
        proc.ioTime,
        '',
        '',
        '',
        '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  for (const slice of result.slices) {
    lines.push(
      [
        'slice',
        algorithm,
        slice.pid ?? 'idle',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        slice.start,
        slice.end,
        '',
        '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  lines.push(
    [
      'summary',
      algorithm,
      '',
      '',
      '',
      '',
      '',
      result.averages.turnaround,
      result.averages.waiting,
      result.averages.response,
      '',
      '',
      '',
      result.makespan,
      result.cpuUtilization,
    ]
      .map(csvCell)
      .join(','),
  );
  return `${lines.join('\n')}\n`;
}

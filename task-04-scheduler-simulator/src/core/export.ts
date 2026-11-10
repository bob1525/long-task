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
      result.makespan,
      result.cpuUtilization,
    ]
      .map(csvCell)
      .join(','),
  );
  return `${lines.join('\n')}\n`;
}

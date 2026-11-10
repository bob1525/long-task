import { describe, expect, it } from 'vitest';
import { resultToCsv, resultToJson, runToCompletion } from '../../src/core';

describe('导出', () => {
  it('JSON 和 CSV 都保留甘特图片段与指标', () => {
    const result = runToCompletion(
      [
        { pid: 1, arrivalTime: 0, burstTime: 5, priority: 5 },
        { pid: 2, arrivalTime: 0, burstTime: 1, priority: 1 },
      ],
      { algorithm: 'fcfs' },
    );
    const parsed = JSON.parse(resultToJson(result)) as typeof result;
    expect(parsed.slices).toEqual(result.slices);
    expect(parsed.processes.map((proc) => proc.waitingTime)).toEqual([0, 5]);
    expect(parsed.processes.every((proc) => proc.level === null)).toBe(true);
    const csv = resultToCsv(result);
    expect(csv.split('\n')[0]).toContain('record_type');
    expect(csv).toContain('process,fcfs,1,');
    expect(csv).toContain('slice,fcfs,1,');
    expect(csv).toContain('slice,fcfs,2,');
    expect(csv).toContain('summary,fcfs,');
    expect(csv.split('\n')[0]?.split(',')).toEqual([
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
    ]);
    const summary = csv.split('\n').find((line) => line.startsWith('summary,'));
    expect(summary?.split(',')).toEqual([
      'summary',
      'fcfs',
      '',
      '',
      '',
      '',
      '',
      '5.5',
      '2.5',
      '2.5',
      '',
      '',
      '',
      '6',
      '1',
    ]);
  });
});

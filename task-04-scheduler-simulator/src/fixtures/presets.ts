import type { AlgorithmId, ProcessSpec } from '../core';

export interface Preset {
  id: string;
  label: string;
  processes: ProcessSpec[];
  algorithm?: AlgorithmId;
  quantum?: number;
  mlfqQuantums?: number[];
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'A',
    label: '用例 A 错开到达',
    processes: [
      { pid: 1, arrivalTime: 0, burstTime: 7, priority: 2 },
      { pid: 2, arrivalTime: 2, burstTime: 4, priority: 1 },
      { pid: 3, arrivalTime: 4, burstTime: 1, priority: 3 },
      { pid: 4, arrivalTime: 5, burstTime: 4, priority: 2 },
    ],
  },
  {
    id: 'B',
    label: '用例 B 同时到达',
    processes: [
      { pid: 1, arrivalTime: 0, burstTime: 4, priority: 2 },
      { pid: 2, arrivalTime: 0, burstTime: 6, priority: 1 },
      { pid: 3, arrivalTime: 0, burstTime: 2, priority: 3 },
      { pid: 4, arrivalTime: 0, burstTime: 6, priority: 1 },
    ],
  },
  {
    id: 'C',
    label: '用例 C 单进程',
    processes: [{ pid: 1, arrivalTime: 4, burstTime: 5, priority: 2 }],
  },
  {
    id: 'Q1',
    label: '时间片为 1',
    algorithm: 'rr',
    quantum: 1,
    processes: [
      { pid: 1, arrivalTime: 0, burstTime: 3, priority: 1 },
      { pid: 2, arrivalTime: 0, burstTime: 2, priority: 1 },
      { pid: 3, arrivalTime: 1, burstTime: 2, priority: 1 },
    ],
  },
  {
    id: 'IO',
    label: 'I/O 等待示例',
    algorithm: 'fcfs',
    processes: [
      { pid: 1, arrivalTime: 0, burstTime: 4, priority: 1, ioBursts: [{ afterCpu: 2, duration: 3 }] },
      { pid: 2, arrivalTime: 0, burstTime: 3, priority: 1 },
    ],
  },
];

export function clonePresetProcesses(processes: readonly ProcessSpec[]): ProcessSpec[] {
  return processes.map((proc) => ({
    ...proc,
    ioBursts: proc.ioBursts?.map((burst) => ({ ...burst })),
  }));
}

import { describe, expect, it } from 'vitest';
import { SchedulerEngine, runToCompletion } from '../../src/core';

describe('等待态与 I/O', () => {
  it('FCFS 在 I/O 阻塞时把 CPU 让给已到达进程，等待时间不含阻塞', () => {
    const result = runToCompletion(
      [
        { pid: 1, arrivalTime: 0, burstTime: 4, priority: 1, ioBursts: [{ afterCpu: 2, duration: 3 }] },
        { pid: 2, arrivalTime: 0, burstTime: 3, priority: 1 },
      ],
      { algorithm: 'fcfs' },
    );
    expect(result.slices).toEqual([
      { pid: 1, start: 0, end: 2 },
      { pid: 2, start: 2, end: 5 },
      { pid: 1, start: 5, end: 7 },
    ]);
    const p1 = result.processes.find((proc) => proc.pid === 1);
    const p2 = result.processes.find((proc) => proc.pid === 2);
    expect(p1).toMatchObject({
      completionTime: 7,
      turnaroundTime: 7,
      waitingTime: 0,
      responseTime: 0,
      ioTime: 3,
    });
    expect(p1?.history.map((entry) => entry.state)).toEqual([
      'new',
      'ready',
      'running',
      'waiting',
      'ready',
      'running',
      'terminated',
    ]);
    expect(p2).toMatchObject({ completionTime: 5, turnaroundTime: 5, waitingTime: 2, responseTime: 2, ioTime: 0 });
    expect(result.cpuUtilization).toBeCloseTo(7 / 7, 9);
  });

  it('只有一个进程时，I/O 期间 CPU 空闲', () => {
    const result = runToCompletion(
      [
        {
          pid: 1,
          arrivalTime: 0,
          burstTime: 6,
          priority: 1,
          ioBursts: [
            { afterCpu: 2, duration: 1 },
            { afterCpu: 4, duration: 1 },
          ],
        },
      ],
      { algorithm: 'fcfs' },
    );
    expect(result.slices).toEqual([
      { pid: 1, start: 0, end: 2 },
      { pid: null, start: 2, end: 3 },
      { pid: 1, start: 3, end: 5 },
      { pid: null, start: 5, end: 6 },
      { pid: 1, start: 6, end: 8 },
    ]);
    expect(result.processes[0]).toMatchObject({ waitingTime: 0, ioTime: 2, completionTime: 8 });
    expect(result.cpuUtilization).toBeCloseTo(6 / 8, 9);
  });

  it('仿真过程中能观察到等待态', () => {
    const engine = new SchedulerEngine(
      [{ pid: 1, arrivalTime: 0, burstTime: 4, priority: 1, ioBursts: [{ afterCpu: 1, duration: 2 }] }],
      { algorithm: 'rr', quantum: 2 },
    );
    engine.step();
    const blocked = engine.getSnapshot();
    expect(blocked.processes[0]?.state).toBe('waiting');
    expect(blocked.waitingQueue).toEqual([1]);
    expect(blocked.holdingPid).toBeNull();
  });
});

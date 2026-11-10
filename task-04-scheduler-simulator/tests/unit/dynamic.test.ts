import { describe, expect, it } from 'vitest';
import { SchedulerEngine, runToCompletion, type ProcessSpec, type SchedulerOptions } from '../../src/core';
import { allCases, optionsFromRun } from '../helpers/oracle';

function runInjected(processes: readonly ProcessSpec[], options: SchedulerOptions) {
  const pending = processes
    .slice()
    .sort((a, b) => a.arrivalTime - b.arrivalTime || a.pid - b.pid);
  const engine = new SchedulerEngine([], options);
  let guard = 0;
  while (pending.length > 0 || !engine.isFinished()) {
    if (engine.processCount > 0 && engine.isFinished() && pending.length > 0) {
      engine.addProcess(pending.shift()!);
      continue;
    }
    while (pending.length > 0 && pending[0].arrivalTime <= engine.time) {
      engine.addProcess(pending.shift()!);
    }
    if (pending.length === 0 && engine.processCount === 0) break;
    if (pending.length === 0 && engine.isFinished()) break;
    engine.step();
    guard += 1;
    if (guard > 100_000) throw new Error('动态注入没有结束');
  }
  return engine.toResult();
}

describe('运行中动态添加进程', () => {
  for (const testCase of allCases()) {
    for (const run of testCase.runs) {
      it(`${testCase.id} ${run.algorithm} 在到达时刻注入，结果与一开始就提交相同`, () => {
        const dynamic = runInjected(testCase.processes, optionsFromRun(run));
        const stable = runToCompletion(testCase.processes, optionsFromRun(run));
        expect(dynamic.slices).toEqual(stable.slices);
        expect(dynamic.processes.map(({ pid, completionTime, waitingTime, responseTime }) => ({
          pid,
          completionTime,
          waitingTime,
          responseTime,
        }))).toEqual(
          stable.processes.map(({ pid, completionTime, waitingTime, responseTime }) => ({
            pid,
            completionTime,
            waitingTime,
            responseTime,
          })),
        );
      });
    }
  }

  it('FCFS 在 t=3 加入 P5，插到当时的就绪队列', () => {
    const engine = new SchedulerEngine(
      [
        { pid: 1, arrivalTime: 0, burstTime: 7, priority: 2 },
        { pid: 2, arrivalTime: 2, burstTime: 4, priority: 1 },
        { pid: 3, arrivalTime: 4, burstTime: 1, priority: 3 },
        { pid: 4, arrivalTime: 5, burstTime: 4, priority: 2 },
      ],
      { algorithm: 'fcfs' },
    );
    engine.step();
    engine.step();
    engine.step();
    expect(engine.time).toBe(3);
    const requested = { pid: 5, arrivalTime: 0, burstTime: 2, priority: 1 };
    engine.addProcess(requested);
    expect(requested.arrivalTime).toBe(0);
    const added = engine.getSnapshot().processes.find((proc) => proc.pid === 5);
    expect(added?.arrivalTime).toBe(3);
    expect(added?.state).toBe('new');
    while (!engine.isFinished()) engine.step();
    expect(engine.toResult().slices).toEqual([
      { pid: 1, start: 0, end: 7 },
      { pid: 2, start: 7, end: 11 },
      { pid: 5, start: 11, end: 13 },
      { pid: 3, start: 13, end: 14 },
      { pid: 4, start: 14, end: 18 },
    ]);
    const p5 = engine.toResult().processes.find((proc) => proc.pid === 5);
    expect(p5).toMatchObject({ completionTime: 13, turnaroundTime: 10, waitingTime: 8, responseTime: 8 });
  });

  it('SRTF 在 t=3 加入更短进程会抢占', () => {
    const engine = new SchedulerEngine([{ pid: 1, arrivalTime: 0, burstTime: 6, priority: 1 }], {
      algorithm: 'srtf',
    });
    engine.step();
    engine.step();
    engine.step();
    engine.addProcess({ pid: 2, arrivalTime: 3, burstTime: 2, priority: 1 });
    while (!engine.isFinished()) engine.step();
    expect(engine.toResult().slices).toEqual([
      { pid: 1, start: 0, end: 3 },
      { pid: 2, start: 3, end: 5 },
      { pid: 1, start: 5, end: 8 },
    ]);
  });

  it('当前进程都完成后，仍可追加一个未来到达的进程', () => {
    const engine = new SchedulerEngine([{ pid: 1, arrivalTime: 0, burstTime: 2, priority: 1 }], {
      algorithm: 'fcfs',
    });
    while (!engine.isFinished()) engine.step();
    expect(engine.time).toBe(2);
    engine.addProcess({ pid: 2, arrivalTime: 5, burstTime: 1, priority: 1 });
    expect(engine.isFinished()).toBe(false);
    while (!engine.isFinished()) engine.step();
    expect(engine.toResult().slices).toEqual([
      { pid: 1, start: 0, end: 2 },
      { pid: null, start: 2, end: 5 },
      { pid: 2, start: 5, end: 6 },
    ]);
  });
});

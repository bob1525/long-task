import { describe, expect, it } from 'vitest';
import { SchedulerEngine, normalizeOptions, runToCompletion } from '../../src/core';
import { expectSchedule, runsFor } from '../helpers/oracle';

describe('边界与平局', () => {
  for (const algorithm of ['fcfs', 'sjf', 'srtf', 'rr', 'priority-np', 'priority-p', 'mlfq'] as const) {
    for (const run of runsFor(algorithm, 'edges')) {
      it(`${run.caseId} ${run.title}`, () => {
        expectSchedule(run);
      });
    }
  }

  it('拒绝少于 3 级的 MLFQ、非法时间片和重复 PID', () => {
    expect(() => normalizeOptions({ algorithm: 'mlfq', mlfqQuantums: [1, 2] })).toThrow(/至少/);
    expect(() => normalizeOptions({ algorithm: 'rr', quantum: 0 })).toThrow(/时间片/);
    expect(() =>
      runToCompletion(
        [
          { pid: 1, arrivalTime: 0, burstTime: 1, priority: 1 },
          { pid: 1, arrivalTime: 0, burstTime: 1, priority: 1 },
        ],
        { algorithm: 'fcfs' },
      ),
    ).toThrow(/已存在/);
  });

  it('结束后再单步不会推动时钟', () => {
    const engine = new SchedulerEngine([{ pid: 1, arrivalTime: 0, burstTime: 2, priority: 1 }], {
      algorithm: 'fcfs',
    });
    engine.step();
    engine.step();
    expect(engine.time).toBe(2);
    expect(engine.isFinished()).toBe(true);
    const slices = engine.getSnapshot().slices;
    engine.step();
    expect(engine.time).toBe(2);
    expect(engine.getSnapshot().slices).toEqual(slices);
  });

  it('完成前平均指标为空，完成后才汇总', () => {
    const engine = new SchedulerEngine([{ pid: 1, arrivalTime: 1, burstTime: 2, priority: 1 }], {
      algorithm: 'sjf',
    });
    expect(engine.getSnapshot().averages.waiting).toBeNull();
    expect(engine.getSnapshot().cpuUtilization).toBeNull();
    engine.step();
    expect(engine.getSnapshot().cpuUtilization).toBe(0);
    engine.step();
    engine.step();
    const done = engine.getSnapshot();
    expect(done.finished).toBe(true);
    expect(done.averages.waiting).toBe(0);
    expect(done.averages.turnaround).toBe(2);
    expect(done.cpuUtilization).toBeCloseTo(2 / 3, 9);
  });
});

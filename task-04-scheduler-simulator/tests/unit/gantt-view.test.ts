import { describe, expect, it } from 'vitest';
import {
  SchedulerEngine,
  historySpans,
  runToCompletion,
  toGanttSegments,
} from '../../src/core';
import { optionsFromRun, standardCases } from '../helpers/oracle';

describe('甘特图视图与核心时间片一致', () => {
  it('视图模型不合并、不拆分、不丢段', () => {
    const slices = [
      { pid: 1, start: 0, end: 2 },
      { pid: 1, start: 2, end: 4 },
      { pid: null, start: 4, end: 6 },
    ];
    const segments = toGanttSegments(slices);
    expect(segments).toHaveLength(slices.length);
    segments.forEach((segment, index) => {
      expect(segment.pid).toBe(slices[index]?.pid);
      expect(segment.start).toBe(slices[index]?.start);
      expect(segment.end).toBe(slices[index]?.end);
    });
    expect(segments[0]?.label).toBe('P1');
    expect(segments[2]?.label).toBe('空闲');
  });

  it('标准用例的逐步回放与一次性运行得到同一组片段', () => {
    for (const testCase of standardCases()) {
      for (const run of testCase.runs) {
        const batch = runToCompletion(testCase.processes, optionsFromRun(run));
        const engine = new SchedulerEngine(testCase.processes, optionsFromRun(run));
        while (!engine.isFinished()) engine.step();
        const stepped = engine.toResult();
        expect(stepped.slices).toEqual(batch.slices);
        expect(toGanttSegments(stepped.slices).map(({ pid, start, end }) => ({ pid, start, end }))).toEqual(
          batch.slices,
        );
      }
    }
  });

  it('同一时刻的状态变迁在泳道上折叠为该时刻的最终状态', () => {
    const spans = historySpans(
      [
        { time: 0, state: 'new' },
        { time: 0, state: 'ready' },
        { time: 0, state: 'running' },
        { time: 2, state: 'ready' },
        { time: 4, state: 'running' },
        { time: 7, state: 'terminated' },
      ],
      7,
    );
    expect(spans).toEqual([
      { state: 'running', start: 0, end: 2 },
      { state: 'ready', start: 2, end: 4 },
      { state: 'running', start: 4, end: 7 },
    ]);
  });
});

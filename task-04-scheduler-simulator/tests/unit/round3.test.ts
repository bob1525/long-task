import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SchedulerEngine,
  comparisonToCsv,
  comparisonToHtml,
  generateProcesses,
  importProcesses,
  runToCompletion,
  sliceSignature,
  toGanttSegments,
  type ProcessSpec,
  type SchedulerOptions,
} from '../../src/core';
import { optionsFromRun, standardCases } from '../helpers/oracle';

interface RoundResult {
  pid: number;
  completionTime: number;
  turnaroundTime: number;
  waitingTime: number;
  responseTime: number;
  switchTime?: number;
}

interface RoundRun {
  algorithm: SchedulerOptions['algorithm'];
  quantum?: number;
  mlfqQuantums?: number[];
  contextSwitch?: number;
  agingInterval?: number;
  mlfqBoost?: number;
  slices: { pid: number | null; start: number; end: number; switch?: true }[];
  results: RoundResult[];
}

interface RoundCase {
  id: string;
  title: string;
  processes: ProcessSpec[];
  runs: RoundRun[];
}

const round3 = JSON.parse(
  readFileSync(path.join(process.cwd(), 'tests/fixtures/round3-cases.json'), 'utf8'),
) as { cases: RoundCase[] };

function findCase(id: string): RoundCase {
  const found = round3.cases.find((item) => item.id === id);
  if (!found) throw new Error(`缺少用例 ${id}`);
  return found;
}

function optionsOf(run: RoundRun): SchedulerOptions {
  const options: SchedulerOptions = { algorithm: run.algorithm };
  if (run.quantum !== undefined) options.quantum = run.quantum;
  if (run.mlfqQuantums !== undefined) options.mlfqQuantums = run.mlfqQuantums;
  if (run.contextSwitch !== undefined) options.contextSwitch = run.contextSwitch;
  if (run.agingInterval !== undefined) options.agingInterval = run.agingInterval;
  if (run.mlfqBoost !== undefined) options.mlfqBoost = run.mlfqBoost;
  return options;
}

function expectRun(testCase: RoundCase, run: RoundRun): void {
  const result = runToCompletion(testCase.processes, optionsOf(run));
  expect(result.slices).toEqual(run.slices);
  for (const row of run.results) {
    const got = result.processes.find((proc) => proc.pid === row.pid);
    expect(got?.completionTime).toBe(row.completionTime);
    expect(got?.turnaroundTime).toBe(row.turnaroundTime);
    expect(got?.waitingTime).toBe(row.waitingTime);
    expect(got?.responseTime).toBe(row.responseTime);
    expect(got?.switchTime).toBe(row.switchTime ?? 0);
    expect(got?.completionTime! - got!.arrivalTime - got!.burstTime - got!.ioTime - got!.switchTime).toBe(got?.waitingTime);
  }
  const busy = testCase.processes.reduce((sum, proc) => sum + proc.burstTime, 0);
  expect(result.cpuUtilization).toBeCloseTo(busy / result.makespan, 9);
}

describe('第三轮调度扩展', () => {
  it('显式关闭切换、老化和提升时，用例 A/B/C 与默认选项的片段相同', () => {
    for (const testCase of standardCases()) {
      for (const run of testCase.runs) {
        const base = runToCompletion(testCase.processes, optionsFromRun(run));
        const explicit = runToCompletion(testCase.processes, {
          ...optionsFromRun(run),
          contextSwitch: 0,
          agingInterval: 0,
          mlfqBoost: 0,
        });
        expect(explicit.slices).toEqual(base.slices);
        expect(explicit.processes.map((proc) => proc.waitingTime)).toEqual(
          base.processes.map((proc) => proc.waitingTime),
        );
      }
    }
  });

  it('用例 D 的 HRRN 与手算一致，并且不选最短作业', () => {
    const testCase = findCase('D');
    const hrrn = testCase.runs.find((run) => run.algorithm === 'hrrn');
    const sjf = testCase.runs.find((run) => run.algorithm === 'sjf');
    if (!hrrn || !sjf) throw new Error('缺少 D 的运行');
    expectRun(testCase, hrrn);
    expectRun(testCase, sjf);
    expect(hrrn.slices).not.toEqual(sjf.slices);
  });

  it('响应比相同且到达时间相同，HRRN 选更小的 PID', () => {
    const result = runToCompletion(
      [
        { pid: 1, arrivalTime: 0, burstTime: 5, priority: 1 },
        { pid: 2, arrivalTime: 2, burstTime: 4, priority: 1 },
        { pid: 3, arrivalTime: 2, burstTime: 4, priority: 1 },
      ],
      { algorithm: 'hrrn' },
    );
    expect(result.slices).toEqual([
      { pid: 1, start: 0, end: 5 },
      { pid: 2, start: 5, end: 9 },
      { pid: 3, start: 9, end: 13 },
    ]);
  });

  it('响应比相同但到达更早者优先于更短 PID 的后来者', () => {
    const result = runToCompletion(
      [
        { pid: 1, arrivalTime: 0, burstTime: 4, priority: 1 },
        { pid: 2, arrivalTime: 1, burstTime: 6, priority: 1 },
        { pid: 3, arrivalTime: 3, burstTime: 2, priority: 1 },
      ],
      { algorithm: 'hrrn' },
    );
    expect(result.slices).toEqual([
      { pid: 1, start: 0, end: 4 },
      { pid: 2, start: 4, end: 10 },
      { pid: 3, start: 10, end: 12 },
    ]);
  });

  it('用例 D 关闭老化时，非抢占优先级按原始数值选择', () => {
    const testCase = findCase('D');
    const run = testCase.runs.find((item) => item.algorithm === 'priority-np' && item.agingInterval === undefined);
    if (!run) throw new Error('缺少未老化的非抢占优先级');
    expectRun(testCase, run);
  });

  it('用例 D 关闭老化时，抢占优先级只在数值严格更小时抢占', () => {
    const testCase = findCase('D');
    const run = testCase.runs.find((item) => item.algorithm === 'priority-p' && item.agingInterval === undefined);
    if (!run) throw new Error('缺少未老化的抢占优先级');
    expectRun(testCase, run);
  });

  it('用例 D 非抢占老化让等待更久的低优先级超过后到的高优先级', () => {
    const testCase = findCase('D');
    const run = testCase.runs.find((item) => item.algorithm === 'priority-np' && item.agingInterval === 2);
    if (!run) throw new Error('缺少非抢占老化');
    expectRun(testCase, run);
    const plain = testCase.runs.find((item) => item.algorithm === 'priority-np' && item.agingInterval === undefined);
    expect(run.slices).not.toEqual(plain?.slices);
  });

  it('用例 D 抢占老化会在有效优先级严格变好时打断当前进程', () => {
    const testCase = findCase('D');
    const run = testCase.runs.find((item) => item.algorithm === 'priority-p' && item.agingInterval === 2);
    if (!run) throw new Error('缺少抢占老化');
    expectRun(testCase, run);
  });

  it('有效优先级仅仅追平当前进程时不抢占', () => {
    const processes = [
      { pid: 1, arrivalTime: 0, burstTime: 6, priority: 2 },
      { pid: 2, arrivalTime: 1, burstTime: 1, priority: 4 },
    ];
    const engine = new SchedulerEngine(processes, { algorithm: 'priority-p', agingInterval: 2 });
    while (engine.time < 5) engine.step();
    const snap = engine.getSnapshot();
    expect(snap.holdingPid).toBe(1);
    expect(snap.processes.find((proc) => proc.pid === 2)?.effectivePriority).toBe(2);
    while (!engine.isFinished()) engine.step();
    expect(engine.toResult().slices).toEqual([
      { pid: 1, start: 0, end: 6 },
      { pid: 2, start: 6, end: 7 },
    ]);
  });

  it('进程在运行期间不再累积就绪等待，老化不会自己变好', () => {
    const engine = new SchedulerEngine([{ pid: 1, arrivalTime: 0, burstTime: 4, priority: 3 }], {
      algorithm: 'priority-p',
      agingInterval: 1,
    });
    engine.step();
    engine.step();
    const running = engine.getSnapshot().processes[0];
    expect(running?.state).toBe('running');
    expect(running?.waitingTime).toBe(0);
    expect(running?.effectivePriority).toBe(3);
  });

  it('老化间隔为 0 时，用例 A 的抢占优先级片段不变', () => {
    const testCase = standardCases().find((item) => item.id === 'A');
    const run = testCase?.runs.find((item) => item.algorithm === 'priority-p');
    if (!testCase || !run) throw new Error('缺少用例 A');
    const base = runToCompletion(testCase.processes, optionsFromRun(run));
    const aged = runToCompletion(testCase.processes, { ...optionsFromRun(run), agingInterval: 0 });
    expect(aged.slices).toEqual(base.slices);
  });

  it('用例 F 的 MLFQ 提升把降级进程按原顺序送回 Q0', () => {
    const testCase = findCase('F');
    expectRun(testCase, testCase.runs[0]!);
  });

  it('提升周期为 0 时，同样两进程的 MLFQ 保持不提升的调度', () => {
    const boosted = runToCompletion(findCase('F').processes, {
      algorithm: 'mlfq',
      mlfqQuantums: [2, 4, 8],
      mlfqBoost: 0,
    });
    const plain = runToCompletion(findCase('F').processes, {
      algorithm: 'mlfq',
      mlfqQuantums: [2, 4, 8],
    });
    expect(boosted.slices).toEqual(plain.slices);
    expect(plain.slices).toEqual([
      { pid: 1, start: 0, end: 2 },
      { pid: 2, start: 2, end: 4 },
      { pid: 1, start: 4, end: 8 },
      { pid: 2, start: 8, end: 10 },
    ]);
  });

  it('提升发生时，尚未到达的进程仍留在新建态', () => {
    const engine = new SchedulerEngine(
      [
        { pid: 1, arrivalTime: 0, burstTime: 6, priority: 1 },
        { pid: 2, arrivalTime: 4, burstTime: 2, priority: 1 },
      ],
      { algorithm: 'mlfq', mlfqQuantums: [2, 4, 8], mlfqBoost: 4 },
    );
    while (engine.time < 4) engine.step();
    expect(engine.getSnapshot().processes.find((proc) => proc.pid === 2)?.state).toBe('new');
    engine.step();
    const snap = engine.getSnapshot();
    expect(snap.currentTime).toBe(5);
    expect(snap.processes.find((proc) => proc.pid === 2)?.state).not.toBe('new');
    expect(snap.logs.some((line) => line.includes('周期性提升'))).toBe(true);
  });

  it('正在等待 I/O 的进程在提升后回到 Q0，返回时进入最高队列', () => {
    const result = runToCompletion(
      [
        {
          pid: 1,
          arrivalTime: 0,
          burstTime: 4,
          priority: 1,
          ioBursts: [{ afterCpu: 2, duration: 3 }],
        },
      ],
      { algorithm: 'mlfq', mlfqQuantums: [2, 4, 8], mlfqBoost: 4 },
    );
    const proc = result.processes[0];
    expect(proc?.ioTime).toBe(3);
    expect(proc?.level).toBe(0);
    expect(result.slices.filter((slice) => slice.pid === 1).reduce((sum, slice) => sum + slice.end - slice.start, 0)).toBe(4);
  });

  it('用例 E 的 FCFS 在 c=1 时先切换再执行', () => {
    const testCase = findCase('E');
    const run = testCase.runs.find((item) => item.algorithm === 'fcfs');
    if (!run) throw new Error('缺少 FCFS 切换');
    expectRun(testCase, run);
    expect(sliceSignature(run.slices)).toBe('切换[0,1) P1[1,5) 切换[5,6) P2[6,9) 切换[9,10) P3[10,12)');
  });

  it('用例 E 的 RR 在 c=1、q=2 时每次重新分派都支付切换', () => {
    const testCase = findCase('E');
    const run = testCase.runs.find((item) => item.algorithm === 'rr');
    if (!run) throw new Error('缺少 RR 切换');
    expectRun(testCase, run);
    expect(resultCpu(testCase, run)).toBeCloseTo(9 / 14, 9);
  });

  it('c=0 与省略该选项得到同一组 FCFS 片段', () => {
    const processes = findCase('E').processes;
    const omitted = runToCompletion(processes, { algorithm: 'fcfs' });
    const zero = runToCompletion(processes, { algorithm: 'fcfs', contextSwitch: 0 });
    expect(zero.slices).toEqual(omitted.slices);
    expect(zero.slices.some((slice) => slice.switch)).toBe(false);
    expect(omitted.slices).toEqual([
      { pid: 1, start: 0, end: 4 },
      { pid: 2, start: 4, end: 7 },
      { pid: 3, start: 7, end: 9 },
    ]);
  });

  it('只剩自己时，时间片用尽后再次上场仍支付切换', () => {
    const result = runToCompletion([{ pid: 1, arrivalTime: 0, burstTime: 5, priority: 1 }], {
      algorithm: 'rr',
      quantum: 2,
      contextSwitch: 1,
    });
    expect(result.slices).toEqual([
      { pid: null, start: 0, end: 1, switch: true },
      { pid: 1, start: 1, end: 3 },
      { pid: null, start: 3, end: 4, switch: true },
      { pid: 1, start: 4, end: 6 },
      { pid: null, start: 6, end: 7, switch: true },
      { pid: 1, start: 7, end: 8 },
    ]);
    expect(result.processes[0]?.switchTime).toBe(3);
    expect(result.cpuUtilization).toBeCloseTo(5 / 8, 9);
  });

  it('CPU 利用率的分子只计服务时间，切换降低利用率', () => {
    const testCase = findCase('E');
    const run = testCase.runs.find((item) => item.algorithm === 'fcfs');
    if (!run) throw new Error('缺少 FCFS');
    const result = runToCompletion(testCase.processes, optionsOf(run));
    expect(result.busyTime).toBe(9);
    expect(result.makespan).toBe(12);
    expect(result.cpuUtilization).toBeCloseTo(0.75, 9);
  });

  it('切换片段在视图模型里标成切换，并且不和空闲合并', () => {
    const slices = [
      { pid: null, start: 0, end: 1, switch: true as const },
      { pid: 1, start: 1, end: 3 },
      { pid: null, start: 3, end: 5 },
    ];
    const segments = toGanttSegments(slices);
    expect(segments.map((segment) => segment.label)).toEqual(['切换', 'P1', '空闲']);
    expect(segments[0]?.switch).toBe(true);
    expect(segments[2]?.switch).toBe(false);
    expect(sliceSignature(slices)).toBe('切换[0,1) P1[1,3) 空闲[3,5)');
  });

  it('拒绝负数的切换耗时、老化间隔和提升周期', () => {
    expect(() => runToCompletion([{ pid: 1, arrivalTime: 0, burstTime: 1, priority: 1 }], { algorithm: 'fcfs', contextSwitch: -1 })).toThrow(/切换/);
    expect(() => runToCompletion([{ pid: 1, arrivalTime: 0, burstTime: 1, priority: 1 }], { algorithm: 'priority-p', agingInterval: -1 })).toThrow(/老化/);
    expect(() => runToCompletion([{ pid: 1, arrivalTime: 0, burstTime: 1, priority: 1 }], { algorithm: 'mlfq', mlfqBoost: -1 })).toThrow(/提升/);
  });

  it('HRRN 在到达时刻动态注入，结果与一开始提交相同', () => {
    const testCase = findCase('D');
    const stable = runToCompletion(testCase.processes, { algorithm: 'hrrn' });
    const dynamic = inject(testCase.processes, { algorithm: 'hrrn' });
    expect(dynamic.slices).toEqual(stable.slices);
  });

  it('带切换开销的 FCFS 在到达时刻动态注入，结果与一开始提交相同', () => {
    const testCase = findCase('E');
    const options = { algorithm: 'fcfs' as const, contextSwitch: 1 };
    expect(inject(testCase.processes, options).slices).toEqual(runToCompletion(testCase.processes, options).slices);
  });

  it('合法 CSV 导入进程，并接受别名表头', () => {
    const imported = importProcesses('pid,arrivalTime,burst,priority\n1,0,4,2\n2,3,1,1\n', 'csv');
    expect(imported.errors).toEqual([]);
    expect(imported.processes).toEqual([
      { pid: 1, arrivalTime: 0, burstTime: 4, priority: 2 },
      { pid: 2, arrivalTime: 3, burstTime: 1, priority: 1 },
    ]);
  });

  it('CSV 格式错误按行全部报出，并且不返回半截进程表', () => {
    const imported = importProcesses(
      ['pid,arrival,burst,priority', '1,0,4,2', 'x,1,3,1', '2,0,0,1', '1,2,2,2', ''].join('\n'),
      'csv',
    );
    expect(imported.processes).toEqual([]);
    expect(imported.errors.map((item) => item.line)).toEqual([3, 4, 5]);
    expect(imported.errors[0]?.message).toContain('PID');
    expect(imported.errors[1]?.message).toContain('服务时间');
    expect(imported.errors[2]?.message).toContain('重复');
  });

  it('JSON 对象和数组两种写法都能导入', () => {
    const wrapped = importProcesses(
      JSON.stringify({ processes: [{ pid: 2, arrival: 1, burst: 3, priority: 0 }] }),
      'json',
    );
    const array = importProcesses(JSON.stringify([{ pid: 2, arrivalTime: 1, burstTime: 3, priority: 0 }]), 'json');
    expect(wrapped.errors).toEqual([]);
    expect(wrapped.processes).toEqual(array.processes);
  });

  it('JSON 同时报出重复 PID 和非法服务时间', () => {
    const imported = importProcesses(
      JSON.stringify([
        { pid: 1, arrivalTime: 0, burstTime: 4, priority: 2 },
        { pid: 1, arrivalTime: 1, burstTime: 0, priority: 1 },
      ]),
      'json',
    );
    expect(imported.processes).toEqual([]);
    expect(imported.errors.map((item) => item.line)).toEqual([2, 2]);
    expect(imported.errors.some((item) => item.message.includes('重复'))).toBe(true);
    expect(imported.errors.some((item) => item.message.includes('服务时间'))).toBe(true);
  });

  it('无法解析的 JSON 给出第 1 行错误', () => {
    const imported = importProcesses('{', 'json');
    expect(imported.processes).toEqual([]);
    expect(imported.errors[0]?.line).toBe(1);
    expect(imported.errors[0]?.message).toContain('JSON');
  });

  it('缺少 CSV 表头时指出第 1 行', () => {
    const imported = importProcesses('1,0,4,2\n', 'csv');
    expect(imported.errors[0]?.line).toBe(1);
    expect(imported.errors[0]?.message).toContain('表头');
  });

  it('同一随机种子生成的进程表完全相同', () => {
    const first = generateProcesses({ seed: 42, count: 5 });
    const second = generateProcesses({ seed: 42, count: 5 });
    expect(second).toEqual(first);
    expect(first).toHaveLength(5);
  });

  it('不同种子生成的进程表不同', () => {
    const left = generateProcesses({ seed: 42, count: 6 });
    const right = generateProcesses({ seed: 43, count: 6 });
    expect(right).not.toEqual(left);
  });

  it('随机进程的 PID 连续，服务时间至少为 1', () => {
    const processes = generateProcesses({ seed: 7, count: 8, maxArrival: 3, maxBurst: 4, maxPriority: 2 });
    expect(processes.map((proc) => proc.pid)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(processes.every((proc) => proc.burstTime >= 1 && proc.burstTime <= 4)).toBe(true);
    expect(processes.every((proc) => proc.arrivalTime >= 0 && proc.arrivalTime <= 3)).toBe(true);
    expect(processes.every((proc) => proc.priority >= 0 && proc.priority <= 2)).toBe(true);
  });

  it('对比 CSV 写出每种算法的平均指标', () => {
    const results = [runToCompletion(findCase('D').processes, { algorithm: 'hrrn' }), runToCompletion(findCase('D').processes, { algorithm: 'sjf' })];
    const csv = comparisonToCsv(results);
    expect(csv.split('\n')[0]).toBe('algorithm,avg_waiting,avg_turnaround,avg_response,cpu_utilization,makespan');
    expect(csv).toContain('hrrn,');
    expect(csv).toContain('sjf,');
  });

  it('对比 HTML 可打印，并包含算法和平均等待', () => {
    const results = [runToCompletion(findCase('E').processes, { algorithm: 'fcfs', contextSwitch: 1 })];
    const html = comparisonToHtml(results);
    expect(html).toContain('@media print');
    expect(html).toContain('fcfs');
    expect(html).toContain('平均等待');
    expect(html).toContain('75.00%');
  });

  it('甘特图文字把切换和空闲区分开', () => {
    const run = findCase('E').runs.find((item) => item.algorithm === 'fcfs');
    if (!run) throw new Error('缺少片段');
    expect(sliceSignature(run.slices)).not.toContain('空闲');
    expect(sliceSignature(run.slices).startsWith('切换[0,1)')).toBe(true);
  });
});

function resultCpu(testCase: RoundCase, run: RoundRun): number {
  return runToCompletion(testCase.processes, optionsOf(run)).cpuUtilization;
}

function inject(processes: readonly ProcessSpec[], options: SchedulerOptions) {
  const pending = processes.slice().sort((a, b) => a.arrivalTime - b.arrivalTime || a.pid - b.pid);
  const engine = new SchedulerEngine([], options);
  let guard = 0;
  while (pending.length > 0 || !engine.isFinished()) {
    while (pending.length > 0 && pending[0]!.arrivalTime <= engine.time) engine.addProcess(pending.shift()!);
    if (pending.length === 0 && engine.processCount === 0) break;
    if (pending.length === 0 && engine.isFinished()) break;
    engine.step();
    guard += 1;
    if (guard > 100000) throw new Error('动态注入没有结束');
  }
  return engine.toResult();
}

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { expect } from 'vitest';
import {
  formatNumber,
  formatPercent,
  runToCompletion,
  sliceSignature,
  type AlgorithmId,
  type ProcessSpec,
  type SchedulerOptions,
  type SimulationResult,
} from '../../src/core';

export interface ExpectedProcess {
  pid: number;
  completionTime: number;
  turnaroundTime: number;
  waitingTime: number;
  responseTime: number;
}

export interface ExpectedRun {
  algorithm: AlgorithmId;
  quantum?: number;
  mlfqQuantums?: number[];
  slices: { pid: number | null; start: number; end: number }[];
  results: ExpectedProcess[];
}

export interface ExpectedCase {
  id: string;
  title: string;
  processes: ProcessSpec[];
  runs: ExpectedRun[];
}

interface OracleFile {
  cases: ExpectedCase[];
  edges: ExpectedCase[];
}

const oracle = JSON.parse(
  readFileSync(path.join(process.cwd(), 'tests/fixtures/standard-cases.json'), 'utf8'),
) as OracleFile;

export function standardCases(): ExpectedCase[] {
  return oracle.cases;
}

export function edgeCases(): ExpectedCase[] {
  return oracle.edges;
}

export function allCases(): ExpectedCase[] {
  return [...oracle.cases, ...oracle.edges];
}

export function optionsFromRun(run: ExpectedRun): SchedulerOptions {
  const options: SchedulerOptions = { algorithm: run.algorithm };
  if (run.quantum !== undefined) options.quantum = run.quantum;
  if (run.mlfqQuantums !== undefined) options.mlfqQuantums = run.mlfqQuantums;
  return options;
}

export interface FlatRun {
  caseId: string;
  title: string;
  processes: ProcessSpec[];
  run: ExpectedRun;
}

export function runsFor(algorithm: AlgorithmId, source: 'standard' | 'edges' | 'all' = 'standard'): FlatRun[] {
  const cases = source === 'standard' ? standardCases() : source === 'edges' ? edgeCases() : allCases();
  const found: FlatRun[] = [];
  for (const testCase of cases) {
    for (const run of testCase.runs) {
      if (run.algorithm === algorithm) {
        found.push({
          caseId: testCase.id,
          title: testCase.title,
          processes: testCase.processes,
          run,
        });
      }
    }
  }
  return found;
}

function assertOracleConsistent(testCase: ExpectedCase, run: ExpectedRun): void {
  const fail = (message: string): never => {
    throw new Error(`用例自洽失败 ${testCase.id} ${run.algorithm}：${message}`);
  };
  if (run.slices.length === 0) fail('没有甘特图片段');
  if (run.slices[0]?.start !== 0) fail('甘特图不是从 0 开始');
  for (let index = 1; index < run.slices.length; index += 1) {
    if (run.slices[index]?.start !== run.slices[index - 1]?.end) fail('甘特图不连续');
  }
  const makespan = run.slices[run.slices.length - 1]?.end ?? 0;
  for (const proc of testCase.processes) {
    const row = run.results.find((item) => item.pid === proc.pid);
    if (row === undefined) {
      throw new Error(`用例自洽失败 ${testCase.id} ${run.algorithm}：缺少 P${proc.pid} 的预期结果`);
    }
    if (row.turnaroundTime !== row.completionTime - proc.arrivalTime) fail(`P${proc.pid} 周转时间`);
    if (row.waitingTime !== row.turnaroundTime - proc.burstTime) fail(`P${proc.pid} 等待时间`);
    if (row.responseTime > row.waitingTime) fail(`P${proc.pid} 响应时间大于等待时间`);
    const owned = run.slices.filter((slice) => slice.pid === proc.pid);
    const ran = owned.reduce((sum, slice) => sum + slice.end - slice.start, 0);
    if (ran !== proc.burstTime) fail(`P${proc.pid} 片段长度 ${ran} ≠ 服务时间 ${proc.burstTime}`);
    const first = owned[0];
    const last = owned[owned.length - 1];
    if (!first || !last) fail(`P${proc.pid} 没有甘特图片段`);
    if (first.start !== proc.arrivalTime + row.responseTime) fail(`P${proc.pid} 响应时间与首段不一致`);
    if (last.end !== row.completionTime) fail(`P${proc.pid} 完成时间与末段不一致`);
    if (row.completionTime > makespan) fail(`P${proc.pid} 完成时间超出甘特图`);
  }
  if (Math.max(...run.results.map((row) => row.completionTime)) !== makespan) {
    fail('最后完成时间与甘特图终点不一致');
  }
}

export function averageLine(processes: ProcessSpec[], run: ExpectedRun): string {
  const count = run.results.length;
  const waiting = run.results.reduce((sum, row) => sum + row.waitingTime, 0) / count;
  const turnaround = run.results.reduce((sum, row) => sum + row.turnaroundTime, 0) / count;
  const response = run.results.reduce((sum, row) => sum + row.responseTime, 0) / count;
  const makespan = Math.max(...run.results.map((row) => row.completionTime));
  const busy = processes.reduce((sum, proc) => sum + proc.burstTime, 0);
  return `平均等待 ${formatNumber(waiting)}，平均周转 ${formatNumber(turnaround)}，平均响应 ${formatNumber(response)}，CPU ${formatPercent(busy / makespan)}`;
}

export function processLine(row: ExpectedProcess): string {
  return `P${row.pid} 完成${row.completionTime} 周转${row.turnaroundTime} 等待${row.waitingTime} 响应${row.responseTime}`;
}

export function lockLine(caseId: string, run: ExpectedRun, body: string): string {
  return `${caseId} ${run.algorithm} | ${body}`;
}

export function expectSchedule(flat: FlatRun): SimulationResult {
  const host: ExpectedCase = {
    id: flat.caseId,
    title: flat.title,
    processes: flat.processes,
    runs: [flat.run],
  };
  assertOracleConsistent(host, flat.run);
  const result = runToCompletion(flat.processes, optionsFromRun(flat.run));
  expect(result.slices, `${flat.caseId} ${flat.run.algorithm} 甘特图`).toEqual(flat.run.slices);
  expect(result.processes.map((proc) => proc.pid).sort((a, b) => a - b)).toEqual(
    flat.processes.map((proc) => proc.pid).sort((a, b) => a - b),
  );
  for (const row of flat.run.results) {
    const got = result.processes.find((proc) => proc.pid === row.pid);
    expect(got, `P${row.pid}`).toBeDefined();
    expect(got?.completionTime, `P${row.pid} 完成`).toBe(row.completionTime);
    expect(got?.turnaroundTime, `P${row.pid} 周转`).toBe(row.turnaroundTime);
    expect(got?.waitingTime, `P${row.pid} 等待`).toBe(row.waitingTime);
    expect(got?.responseTime, `P${row.pid} 响应`).toBe(row.responseTime);
    expect(got?.state).toBe('terminated');
    expect(got?.remainingTime).toBe(0);
  }
  const count = flat.run.results.length;
  const waiting = flat.run.results.reduce((sum, row) => sum + row.waitingTime, 0) / count;
  const turnaround = flat.run.results.reduce((sum, row) => sum + row.turnaroundTime, 0) / count;
  const response = flat.run.results.reduce((sum, row) => sum + row.responseTime, 0) / count;
  const makespan = Math.max(...flat.run.results.map((row) => row.completionTime));
  const busy = flat.processes.reduce((sum, proc) => sum + proc.burstTime, 0);
  expect(result.averages.waiting).toBeCloseTo(waiting, 9);
  expect(result.averages.turnaround).toBeCloseTo(turnaround, 9);
  expect(result.averages.response).toBeCloseTo(response, 9);
  expect(result.cpuUtilization).toBeCloseTo(busy / makespan, 9);
  expect(result.makespan).toBe(makespan);
  expect(sliceSignature(result.slices)).toBe(sliceSignature(flat.run.slices));
  return result;
}

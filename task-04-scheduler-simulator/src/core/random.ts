import type { ProcessSpec } from './types';

/** Deterministic generator. The same seed always yields the same sequence. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RandomProcessOptions {
  count: number;
  seed: number;
  /** Inclusive maximum arrival time. Default 12. */
  maxArrival?: number;
  /** Inclusive maximum burst time. Burst is at least 1. Default 8. */
  maxBurst?: number;
  /** Inclusive maximum priority. Default 4. */
  maxPriority?: number;
}

export function generateProcesses(options: RandomProcessOptions): ProcessSpec[] {
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 20) {
    throw new Error('随机进程数量必须是 1 到 20 的整数');
  }
  if (!Number.isInteger(options.seed)) throw new Error('随机种子必须是整数');
  const maxArrival = options.maxArrival ?? 12;
  const maxBurst = options.maxBurst ?? 8;
  const maxPriority = options.maxPriority ?? 4;
  if (!Number.isInteger(maxArrival) || maxArrival < 0) throw new Error('最大到达时间必须是大于等于 0 的整数');
  if (!Number.isInteger(maxBurst) || maxBurst < 1) throw new Error('最大服务时间必须是大于等于 1 的整数');
  if (!Number.isInteger(maxPriority) || maxPriority < 0) throw new Error('最大优先级必须是大于等于 0 的整数');
  const next = mulberry32(options.seed);
  const processes: ProcessSpec[] = [];
  for (let index = 0; index < options.count; index += 1) {
    processes.push({
      pid: index + 1,
      arrivalTime: Math.floor(next() * (maxArrival + 1)),
      burstTime: 1 + Math.floor(next() * maxBurst),
      priority: Math.floor(next() * (maxPriority + 1)),
    });
  }
  return processes;
}

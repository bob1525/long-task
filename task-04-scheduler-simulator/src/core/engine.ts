import type {
  AlgorithmId,
  EngineSnapshot,
  GanttSlice,
  IoBurst,
  MlfqQueueView,
  NormalizedOptions,
  ProcessResult,
  ProcessSpec,
  ProcessState,
  ReadyEntry,
  SchedulerOptions,
  SimulationAverages,
  SimulationResult,
  StateTransition,
} from './types';
import { ALGORITHM_IDS } from './types';

/**
 * Discrete-time scheduler.
 *
 * At integer time t the engine does, in order:
 * 1. Enqueue processes whose arrivalTime is t, ascending PID, at the tail.
 * 2. Preempt only when a ready process is strictly better on the primary key
 *    (remaining time for SRTF, priority number for preemptive priority,
 *    a higher MLFQ queue). Equal primary keys do not preempt.
 * 3. If the CPU is free, dispatch the next process.
 * 4. Run [t, t+1) or record idle.
 * 5. Then apply completion, I/O, or quantum expiry. Quantum expiry is therefore
 *    visible to arrivals at t+1, and the yielded process is queued before them.
 *
 * Tie-break when selecting among ready processes: earlier arrival, then smaller PID.
 * Priority: smaller number is higher.
 * A Gantt slice is one dispatch interval. Immediate re-dispatch is not merged.
 * Consecutive idle time is merged.
 */

interface IoRecord {
  afterCpu: number;
  duration: number;
  used: boolean;
}

interface Proc {
  pid: number;
  arrivalTime: number;
  burstTime: number;
  priority: number;
  remainingTime: number;
  state: ProcessState;
  cpuUsed: number;
  ioBursts: IoRecord[];
  ioRemaining: number;
  ioTime: number;
  readyWait: number;
  firstStart: number | null;
  completionTime: number | null;
  quantumUsed: number;
  level: number;
  history: StateTransition[];
}

const DEFAULT_QUANTUM = 2;
const DEFAULT_MLFQ = [2, 4, 8] as const;

export function normalizeOptions(options: SchedulerOptions): NormalizedOptions {
  if (!ALGORITHM_IDS.includes(options.algorithm)) {
    throw new Error(`未知算法：${String(options.algorithm)}`);
  }
  const quantum = options.quantum ?? DEFAULT_QUANTUM;
  const mlfqQuantums = [...(options.mlfqQuantums ?? DEFAULT_MLFQ)];
  if (options.algorithm === 'rr') {
    if (!Number.isInteger(quantum) || quantum < 1) {
      throw new Error('时间片必须是大于等于 1 的整数');
    }
  }
  if (options.algorithm === 'mlfq') {
    if (mlfqQuantums.length < 3) throw new Error('多级反馈队列至少需要 3 级');
    if (mlfqQuantums.some((value) => !Number.isInteger(value) || value < 1)) {
      throw new Error('每一级时间片都必须是大于等于 1 的整数');
    }
  }
  return { algorithm: options.algorithm, quantum, mlfqQuantums };
}

function assertSpec(spec: ProcessSpec): void {
  if (!Number.isInteger(spec.pid) || spec.pid <= 0) throw new Error('PID 必须是正整数');
  if (!Number.isInteger(spec.arrivalTime) || spec.arrivalTime < 0) {
    throw new Error('到达时间必须是大于等于 0 的整数');
  }
  if (!Number.isInteger(spec.burstTime) || spec.burstTime < 1) {
    throw new Error('服务时间必须是大于等于 1 的整数');
  }
  if (!Number.isInteger(spec.priority)) throw new Error('优先级必须是整数（数值越小越高）');
  const seen = new Set<number>();
  for (const burst of spec.ioBursts ?? []) {
    if (!Number.isInteger(burst.afterCpu) || burst.afterCpu < 1 || burst.afterCpu >= spec.burstTime) {
      throw new Error('I/O 触发点必须满足 1 ≤ afterCpu < 服务时间');
    }
    if (!Number.isInteger(burst.duration) || burst.duration < 1) {
      throw new Error('I/O 时长必须是大于等于 1 的整数');
    }
    if (seen.has(burst.afterCpu)) throw new Error('同一个 CPU 进度不能有两次 I/O');
    seen.add(burst.afterCpu);
  }
}

function cloneIo(bursts: readonly IoBurst[] | undefined): IoRecord[] {
  return (bursts ?? []).map((burst) => ({
    afterCpu: burst.afterCpu,
    duration: burst.duration,
    used: false,
  }));
}

function cmpArrivalPid(a: Proc, b: Proc): number {
  if (a.arrivalTime !== b.arrivalTime) return a.arrivalTime - b.arrivalTime;
  return a.pid - b.pid;
}

function cmpRemaining(a: Proc, b: Proc): number {
  if (a.remainingTime !== b.remainingTime) return a.remainingTime - b.remainingTime;
  return cmpArrivalPid(a, b);
}

function cmpPriority(a: Proc, b: Proc): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return cmpArrivalPid(a, b);
}

export class SchedulerEngine {
  readonly options: NormalizedOptions;
  private readonly procs: Proc[] = [];
  /** FIFO for FCFS / RR, unordered pool for SJF / SRTF / priority. Unused by MLFQ. */
  private readonly ready: Proc[] = [];
  /** Index 0 is the highest-priority MLFQ queue. */
  private readonly levels: Proc[][] = [];
  private running: Proc | null = null;
  private slices: GanttSlice[] = [];
  private logs: string[] = [];
  private currentTime = 0;
  private stepsTaken = 0;
  private continueDispatch = false;
  private justDispatched = false;
  private lastExecutedPid: number | null = null;
  private lastInterval: { start: number; end: number } | null = null;

  constructor(specs: readonly ProcessSpec[], options: SchedulerOptions) {
    this.options = normalizeOptions(options);
    if (this.options.algorithm === 'mlfq') {
      this.levels.push(...this.options.mlfqQuantums.map(() => [] as Proc[]));
    }
    for (const spec of specs) this.addProcess(spec);
  }

  get time(): number {
    return this.currentTime;
  }

  get processCount(): number {
    return this.procs.length;
  }

  isFinished(): boolean {
    return this.procs.length > 0 && this.procs.every((proc) => proc.state === 'terminated');
  }

  /**
   * Add a process. Before the first step, the given arrival time is kept.
   * After the clock has moved, an arrival earlier than the current time is
   * clamped to now so the process can enter on the next step. Future arrivals
   * stay in the new state until that time.
   */
  addProcess(spec: ProcessSpec): void {
    assertSpec(spec);
    if (this.procs.some((proc) => proc.pid === spec.pid)) {
      throw new Error(`PID ${spec.pid} 已存在`);
    }
    let arrival = spec.arrivalTime;
    let clamped = false;
    if (this.stepsTaken > 0 && arrival < this.currentTime) {
      arrival = this.currentTime;
      clamped = true;
    }
    const createdAt = this.stepsTaken > 0 ? this.currentTime : 0;
    const proc: Proc = {
      pid: spec.pid,
      arrivalTime: arrival,
      burstTime: spec.burstTime,
      priority: spec.priority,
      remainingTime: spec.burstTime,
      state: 'new',
      cpuUsed: 0,
      ioBursts: cloneIo(spec.ioBursts),
      ioRemaining: 0,
      ioTime: 0,
      readyWait: 0,
      firstStart: null,
      completionTime: null,
      quantumUsed: 0,
      level: 0,
      history: [{ time: createdAt, state: 'new' }],
    };
    this.procs.push(proc);
    const clampNote = clamped ? `（请求到达 ${spec.arrivalTime}，已调整为当前时间 ${arrival}）` : '';
    this.logs.push(
      `t=${createdAt} 加入 P${proc.pid}：到达 ${arrival}，服务 ${proc.burstTime}，优先级 ${proc.priority}${clampNote}`,
    );
  }

  step(): EngineSnapshot {
    if (this.isFinished()) return this.getSnapshot();
    const t = this.currentTime;
    this.schedule(t);
    this.execute(t);
    this.currentTime = t + 1;
    this.stepsTaken += 1;
    this.assertQueues();
    return this.getSnapshot();
  }

  getSnapshot(): EngineSnapshot {
    if (this.isFinished()) this.assertComplete();
    const busyTime = this.slices
      .filter((slice) => slice.pid !== null)
      .reduce((sum, slice) => sum + (slice.end - slice.start), 0);
    const processes = this.procs
      .slice()
      .sort((a, b) => a.pid - b.pid)
      .map((proc) => this.toView(proc));
    return {
      currentTime: this.currentTime,
      finished: this.isFinished(),
      holdingPid: this.running?.pid ?? null,
      lastExecutedPid: this.lastExecutedPid,
      lastInterval: this.lastInterval ? { ...this.lastInterval } : null,
      readyQueue: this.readyEntries(),
      mlfqQueues: this.mlfqView(),
      waitingQueue: this.procs
        .filter((proc) => proc.state === 'waiting')
        .map((proc) => proc.pid)
        .sort((a, b) => a - b),
      slices: this.slices.map((slice) => ({ ...slice })),
      processes,
      averages: this.averages(),
      cpuUtilization: this.currentTime === 0 ? null : busyTime / this.currentTime,
      busyTime,
      logs: [...this.logs],
      options: {
        algorithm: this.options.algorithm,
        quantum: this.options.quantum,
        mlfqQuantums: [...this.options.mlfqQuantums],
      },
    };
  }

  toResult(): SimulationResult {
    const snapshot = this.getSnapshot();
    return {
      options: snapshot.options,
      slices: snapshot.slices,
      processes: snapshot.processes,
      averages: snapshot.averages,
      cpuUtilization: snapshot.cpuUtilization ?? 0,
      busyTime: snapshot.busyTime,
      makespan: snapshot.currentTime,
      logs: snapshot.logs,
    };
  }

  private schedule(t: number): void {
    this.arrive(t);
    let preempted: Proc | null = null;
    if (this.running && this.shouldPreempt(this.running)) {
      preempted = this.running;
      this.running = null;
      this.continueDispatch = false;
      const where = this.options.algorithm === 'mlfq' ? 'front' : 'tail';
      this.enterReady(preempted, t, where);
      this.logs.push(
        `t=${t} 抢占 P${preempted.pid}（剩余 ${preempted.remainingTime}），插入${this.placeName(preempted, where)}`,
      );
    }
    if (!this.running) {
      const next = this.pick();
      if (next) {
        if (preempted && next.pid === preempted.pid) {
          throw new Error(`P${next.pid} 被抢占后立刻又被选中，比较器不一致`);
        }
        this.dispatch(next, t);
      }
    }
  }

  private arrive(t: number): void {
    const arriving = this.procs
      .filter((proc) => proc.state === 'new' && proc.arrivalTime === t)
      .sort((a, b) => a.pid - b.pid);
    for (const proc of arriving) {
      if (this.options.algorithm === 'mlfq') {
        proc.level = 0;
        proc.quantumUsed = 0;
      }
      this.enterReady(proc, t, 'tail');
      this.logs.push(`t=${t} P${proc.pid} 到达，进入${this.placeName(proc, 'tail')}`);
    }
  }

  private shouldPreempt(running: Proc): boolean {
    const algorithm = this.options.algorithm;
    if (algorithm === 'srtf') {
      const best = this.bestOf(this.ready, cmpRemaining);
      return best !== null && best.remainingTime < running.remainingTime;
    }
    if (algorithm === 'priority-p') {
      const best = this.bestOf(this.ready, cmpPriority);
      return best !== null && best.priority < running.priority;
    }
    if (algorithm === 'mlfq') {
      for (let level = 0; level < running.level; level += 1) {
        if (this.levels[level].length > 0) return true;
      }
    }
    return false;
  }

  private pick(): Proc | null {
    const algorithm = this.options.algorithm;
    if (algorithm === 'mlfq') {
      for (const queue of this.levels) {
        if (queue.length > 0) return queue.shift() ?? null;
      }
      return null;
    }
    if (algorithm === 'fcfs' || algorithm === 'rr') {
      return this.ready.shift() ?? null;
    }
    const cmp = algorithm === 'sjf' || algorithm === 'srtf' ? cmpRemaining : cmpPriority;
    return this.takeBest(this.ready, cmp);
  }

  private dispatch(proc: Proc, t: number): void {
    proc.state = 'running';
    if (proc.firstStart === null) proc.firstStart = t;
    this.pushHistory(proc, t, 'running');
    this.running = proc;
    this.justDispatched = true;
    const levelNote = this.options.algorithm === 'mlfq' ? `，Q${proc.level}` : '';
    this.logs.push(`t=${t} 分派 P${proc.pid}（剩余 ${proc.remainingTime}${levelNote}）`);
  }

  private execute(t: number): void {
    if (!this.running) {
      this.appendSlice(null, t);
      this.justDispatched = false;
      this.continueDispatch = false;
      this.lastExecutedPid = null;
      this.lastInterval = { start: t, end: t + 1 };
      this.accountNonRunning();
      this.releaseFinishedIo(t + 1);
      this.logs.push(`t=${t} CPU 空闲`);
      return;
    }

    const proc = this.running;
    this.appendSlice(proc.pid, t);
    this.justDispatched = false;
    this.continueDispatch = true;
    this.lastExecutedPid = proc.pid;
    this.lastInterval = { start: t, end: t + 1 };
    this.accountNonRunning();

    proc.remainingTime -= 1;
    proc.cpuUsed += 1;
    proc.quantumUsed += 1;
    const boundary = t + 1;

    if (proc.remainingTime === 0) {
      this.terminate(proc, boundary);
      this.releaseFinishedIo(boundary);
      return;
    }

    const io = proc.ioBursts.find((burst) => !burst.used && burst.afterCpu === proc.cpuUsed);
    if (io) {
      io.used = true;
      proc.quantumUsed = 0;
      proc.state = 'waiting';
      proc.ioRemaining = io.duration;
      this.pushHistory(proc, boundary, 'waiting');
      this.running = null;
      this.continueDispatch = false;
      this.logs.push(`t=${boundary} P${proc.pid} 进入等待，I/O ${io.duration}`);
      this.releaseFinishedIo(boundary);
      return;
    }

    if (this.quantumExpired(proc)) {
      this.yieldQuantum(proc, boundary);
    }
    this.releaseFinishedIo(boundary);
  }

  private accountNonRunning(): void {
    for (const proc of this.procs) {
      if (proc.state === 'ready') proc.readyWait += 1;
      else if (proc.state === 'waiting') {
        proc.ioTime += 1;
        proc.ioRemaining -= 1;
      }
    }
  }

  private releaseFinishedIo(time: number): void {
    const done = this.procs
      .filter((proc) => proc.state === 'waiting' && proc.ioRemaining <= 0)
      .sort((a, b) => a.pid - b.pid);
    for (const proc of done) {
      if (this.options.algorithm === 'mlfq' || this.options.algorithm === 'rr') {
        proc.quantumUsed = 0;
      }
      this.enterReady(proc, time, 'tail');
      this.logs.push(`t=${time} P${proc.pid} I/O 结束，回到${this.placeName(proc, 'tail')}`);
    }
  }

  private quantumExpired(proc: Proc): boolean {
    if (this.options.algorithm === 'rr') return proc.quantumUsed >= this.options.quantum;
    if (this.options.algorithm === 'mlfq') {
      return proc.quantumUsed >= this.options.mlfqQuantums[proc.level];
    }
    return false;
  }

  private yieldQuantum(proc: Proc, time: number): void {
    if (this.options.algorithm === 'mlfq') {
      const last = this.options.mlfqQuantums.length - 1;
      if (proc.level < last) proc.level += 1;
      proc.quantumUsed = 0;
      this.running = null;
      this.continueDispatch = false;
      this.enterReady(proc, time, 'tail');
      this.logs.push(`t=${time} P${proc.pid} 时间片用尽，进入 Q${proc.level} 队尾`);
      return;
    }
    proc.quantumUsed = 0;
    this.running = null;
    this.continueDispatch = false;
    this.enterReady(proc, time, 'tail');
    this.logs.push(`t=${time} P${proc.pid} 时间片用尽，回到队尾`);
  }

  private terminate(proc: Proc, time: number): void {
    proc.state = 'terminated';
    proc.completionTime = time;
    proc.remainingTime = 0;
    this.pushHistory(proc, time, 'terminated');
    this.running = null;
    this.continueDispatch = false;
    this.logs.push(`t=${time} P${proc.pid} 完成`);
  }

  private enterReady(proc: Proc, time: number, where: 'front' | 'tail'): void {
    proc.state = 'ready';
    this.pushHistory(proc, time, 'ready');
    if (this.options.algorithm === 'mlfq') {
      const queue = this.levels[proc.level];
      if (!queue) throw new Error(`MLFQ 队列 Q${proc.level} 不存在`);
      if (where === 'front') queue.unshift(proc);
      else queue.push(proc);
      return;
    }
    if (where === 'front') this.ready.unshift(proc);
    else this.ready.push(proc);
  }

  private appendSlice(pid: number | null, t: number): void {
    const last = this.slices[this.slices.length - 1];
    if (pid === null && last && last.pid === null && last.end === t) {
      last.end = t + 1;
      return;
    }
    if (
      pid !== null &&
      last &&
      last.pid === pid &&
      last.end === t &&
      this.continueDispatch &&
      !this.justDispatched
    ) {
      last.end = t + 1;
      return;
    }
    this.slices.push({ pid, start: t, end: t + 1 });
  }

  private pushHistory(proc: Proc, time: number, state: ProcessState): void {
    const last = proc.history[proc.history.length - 1];
    if (last && last.time === time && last.state === state) return;
    proc.history.push({ time, state });
  }

  private bestOf(list: readonly Proc[], cmp: (a: Proc, b: Proc) => number): Proc | null {
    if (list.length === 0) return null;
    let best = list[0];
    for (let i = 1; i < list.length; i += 1) {
      if (cmp(list[i], best) < 0) best = list[i];
    }
    return best;
  }

  private takeBest(list: Proc[], cmp: (a: Proc, b: Proc) => number): Proc | null {
    if (list.length === 0) return null;
    let bestIndex = 0;
    for (let i = 1; i < list.length; i += 1) {
      if (cmp(list[i], list[bestIndex]) < 0) bestIndex = i;
    }
    return list.splice(bestIndex, 1)[0] ?? null;
  }

  private readyEntries(): ReadyEntry[] {
    const algorithm = this.options.algorithm;
    if (algorithm === 'mlfq') {
      const entries: ReadyEntry[] = [];
      this.levels.forEach((queue, level) => {
        for (const proc of queue) entries.push({ pid: proc.pid, level });
      });
      return entries;
    }
    if (algorithm === 'fcfs' || algorithm === 'rr') {
      return this.ready.map((proc) => ({ pid: proc.pid, level: null }));
    }
    const cmp = algorithm === 'priority-np' || algorithm === 'priority-p' ? cmpPriority : cmpRemaining;
    return this.ready
      .slice()
      .sort(cmp)
      .map((proc) => ({ pid: proc.pid, level: null }));
  }

  private mlfqView(): MlfqQueueView[] | null {
    if (this.options.algorithm !== 'mlfq') return null;
    return this.levels.map((queue, level) => ({
      level,
      quantum: this.options.mlfqQuantums[level] ?? 0,
      pids: queue.map((proc) => proc.pid),
    }));
  }

  private placeName(proc: Proc, where: 'front' | 'tail'): string {
    if (this.options.algorithm === 'mlfq') {
      return ` Q${proc.level} ${where === 'front' ? '队首' : '队尾'}`;
    }
    return where === 'front' ? '队首' : '队尾';
  }

  private averages(): SimulationAverages {
    const done = this.procs.filter((proc) => proc.state === 'terminated');
    if (done.length === 0) return { waiting: null, turnaround: null, response: null };
    const count = done.length;
    const waiting = done.reduce((sum, proc) => sum + proc.readyWait, 0) / count;
    const turnaround =
      done.reduce((sum, proc) => sum + ((proc.completionTime ?? 0) - proc.arrivalTime), 0) / count;
    const response =
      done.reduce((sum, proc) => sum + ((proc.firstStart ?? 0) - proc.arrivalTime), 0) / count;
    return { waiting, turnaround, response };
  }

  private toView(proc: Proc): ProcessResult {
    const done = proc.completionTime !== null;
    return {
      pid: proc.pid,
      arrivalTime: proc.arrivalTime,
      burstTime: proc.burstTime,
      priority: proc.priority,
      remainingTime: proc.remainingTime,
      state: proc.state,
      completionTime: proc.completionTime,
      turnaroundTime: done ? proc.completionTime! - proc.arrivalTime : null,
      waitingTime: proc.readyWait,
      responseTime: proc.firstStart === null ? null : proc.firstStart - proc.arrivalTime,
      ioTime: proc.ioTime,
      firstStartTime: proc.firstStart,
      level: this.options.algorithm === 'mlfq' && proc.state !== 'new' ? proc.level : null,
      history: proc.history.map((entry) => ({ ...entry })),
    };
  }

  private assertQueues(): void {
    const queued = this.options.algorithm === 'mlfq' ? this.levels.flat() : this.ready;
    const ids = queued.map((proc) => proc.pid);
    if (new Set(ids).size !== ids.length) throw new Error('就绪队列中出现重复进程');
    const queuedIds = new Set(ids);
    const runningCount = this.procs.filter((proc) => proc.state === 'running').length;
    if (runningCount > 1) throw new Error('同时有多个进程处于运行态');
    if ((this.running === null) !== (runningCount === 0)) {
      throw new Error('运行指针与进程状态不一致');
    }
    for (const proc of this.procs) {
      if (proc.state === 'ready' && !queuedIds.has(proc.pid)) {
        throw new Error(`P${proc.pid} 处于就绪态但不在队列中`);
      }
      if (proc.state !== 'ready' && queuedIds.has(proc.pid)) {
        throw new Error(`P${proc.pid} 在队列中但状态是 ${proc.state}`);
      }
      if (proc.remainingTime < 0) throw new Error(`P${proc.pid} 剩余时间为负`);
    }
  }

  private assertComplete(): void {
    if (this.slices.length === 0) throw new Error('仿真结束但甘特图为空');
    if (this.slices[0].start !== 0) throw new Error('甘特图必须从 0 开始');
    for (let i = 1; i < this.slices.length; i += 1) {
      if (this.slices[i].start !== this.slices[i - 1].end) {
        throw new Error('甘特图区间不连续或重叠');
      }
    }
    if (this.slices[this.slices.length - 1].end !== this.currentTime) {
      throw new Error('甘特图结束时刻与时钟不一致');
    }
    for (const proc of this.procs) {
      const owned = this.slices.filter((slice) => slice.pid === proc.pid);
      const ran = owned.reduce((sum, slice) => sum + (slice.end - slice.start), 0);
      if (ran !== proc.burstTime) {
        throw new Error(`P${proc.pid} 运行了 ${ran}，服务时间是 ${proc.burstTime}`);
      }
      if (proc.completionTime === null || proc.firstStart === null) {
        throw new Error(`P${proc.pid} 结束后缺少完成时间或首次运行时间`);
      }
      const formula = proc.completionTime - proc.arrivalTime - proc.burstTime - proc.ioTime;
      if (formula !== proc.readyWait) {
        throw new Error(`P${proc.pid} 就绪等待 ${proc.readyWait} 与公式 ${formula} 不一致`);
      }
      if (owned[0]?.start !== proc.firstStart) {
        throw new Error(`P${proc.pid} 首次运行时间与甘特图不一致`);
      }
      const lastEnd = owned.reduce((max, slice) => Math.max(max, slice.end), 0);
      if (lastEnd !== proc.completionTime) {
        throw new Error(`P${proc.pid} 完成时间 ${proc.completionTime} 与最后一段 ${lastEnd} 不一致`);
      }
      const ioExpected = proc.ioBursts.filter((burst) => burst.used).reduce((sum, burst) => sum + burst.duration, 0);
      if (ioExpected !== proc.ioTime) {
        throw new Error(`P${proc.pid} I/O 时间 ${proc.ioTime} 与触发记录 ${ioExpected} 不一致`);
      }
    }
  }
}

export function runToCompletion(
  specs: readonly ProcessSpec[],
  options: SchedulerOptions,
): SimulationResult {
  const engine = new SchedulerEngine(specs, options);
  if (specs.length === 0) return engine.toResult();
  let guard = 0;
  while (!engine.isFinished()) {
    engine.step();
    guard += 1;
    if (guard > 100_000) throw new Error('仿真超过 100000 步，可能没有进展');
  }
  return engine.toResult();
}

export function compareAlgorithms(
  specs: readonly ProcessSpec[],
  runs: readonly SchedulerOptions[],
): SimulationResult[] {
  return runs.map((options) => runToCompletion(specs, options));
}

export function isPreemptive(algorithm: AlgorithmId): boolean {
  return algorithm === 'srtf' || algorithm === 'priority-p' || algorithm === 'mlfq';
}

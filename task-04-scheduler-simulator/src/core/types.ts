/** Discrete-time process states. 等待 is I/O blocking, not the ready queue. */
export type ProcessState = 'new' | 'ready' | 'running' | 'waiting' | 'terminated';

export type AlgorithmId =
  | 'fcfs'
  | 'sjf'
  | 'srtf'
  | 'rr'
  | 'priority-np'
  | 'priority-p'
  | 'hrrn'
  | 'mlfq';

export interface IoBurst {
  /** Block after this many CPU time units have been consumed (cumulative). */
  afterCpu: number;
  duration: number;
}

export interface ProcessSpec {
  pid: number;
  arrivalTime: number;
  burstTime: number;
  /** Smaller number = higher priority. */
  priority: number;
  ioBursts?: IoBurst[];
}

export interface SchedulerOptions {
  algorithm: AlgorithmId;
  /** Round-robin quantum. Integer >= 1. Ignored by other algorithms. Default 2. */
  quantum?: number;
  /**
   * Per-level quanta for MLFQ. Index 0 is the highest queue.
   * Length >= 3, each integer >= 1. Default [2, 4, 8].
   */
  mlfqQuantums?: number[];
  /**
   * Context-switch cost in time units, paid before every new dispatch.
   * 0 disables it and leaves gantt slices unchanged. Default 0.
   */
  contextSwitch?: number;
  /**
   * Priority aging. Every this many ready-queue time units, the priority
   * number decreases by 1. 0 disables aging. Default 0.
   */
  agingInterval?: number;
  /**
   * MLFQ boost period. At every positive multiple of this value, all
   * arrived processes return to Q0. 0 disables boost. Default 0.
   */
  mlfqBoost?: number;
}

export interface NormalizedOptions {
  algorithm: AlgorithmId;
  quantum: number;
  mlfqQuantums: number[];
  contextSwitch: number;
  agingInterval: number;
  mlfqBoost: number;
}

export interface GanttSlice {
  /** null means the CPU was idle or paying a context switch. */
  pid: number | null;
  start: number;
  end: number;
  /** Present only for a context-switch interval. Idle slices omit it. */
  switch?: true;
}

export interface StateTransition {
  time: number;
  state: ProcessState;
}

export interface ProcessResult {
  pid: number;
  arrivalTime: number;
  burstTime: number;
  priority: number;
  remainingTime: number;
  state: ProcessState;
  completionTime: number | null;
  turnaroundTime: number | null;
  /** Time spent in the ready state. Does not include I/O blocking. */
  waitingTime: number;
  responseTime: number | null;
  ioTime: number;
  firstStartTime: number | null;
  /** MLFQ queue index while known; 0 is highest. Null before the process arrives. */
  level: number | null;
  /** Time spent inside context-switch intervals that loaded this process. */
  switchTime: number;
  /** Priority after aging. Null when aging is off. */
  effectivePriority: number | null;
  /** (ready wait + original burst) / original burst. Null unless the algorithm is HRRN. */
  responseRatio: number | null;
  history: StateTransition[];
}

export interface ReadyEntry {
  pid: number;
  /** Queue index for MLFQ; null for single-queue algorithms. */
  level: number | null;
}

export interface MlfqQueueView {
  level: number;
  quantum: number;
  pids: number[];
}

export interface SimulationAverages {
  waiting: number | null;
  turnaround: number | null;
  response: number | null;
}

export interface EngineSnapshot {
  currentTime: number;
  finished: boolean;
  /** Process still holding the CPU after the last tick. Null if the CPU was released. */
  holdingPid: number | null;
  /** True when the last tick was context-switch overhead rather than a CPU burst. */
  contextSwitching: boolean;
  /** Process that occupied the CPU during the last tick. Null if that tick was idle or none ran. */
  lastExecutedPid: number | null;
  lastInterval: { start: number; end: number } | null;
  readyQueue: ReadyEntry[];
  mlfqQueues: MlfqQueueView[] | null;
  waitingQueue: number[];
  slices: GanttSlice[];
  processes: ProcessResult[];
  averages: SimulationAverages;
  /** Busy time / currentTime. Null before the clock advances. */
  cpuUtilization: number | null;
  busyTime: number;
  logs: string[];
  options: NormalizedOptions;
}

export interface SimulationResult {
  options: NormalizedOptions;
  slices: GanttSlice[];
  processes: ProcessResult[];
  averages: SimulationAverages;
  cpuUtilization: number;
  busyTime: number;
  makespan: number;
  logs: string[];
}

export interface AlgorithmInfo {
  id: AlgorithmId;
  label: string;
  short: string;
  hint: string;
}

export const ALGORITHM_CATALOG: readonly AlgorithmInfo[] = [
  {
    id: 'fcfs',
    label: '先来先服务 FCFS',
    short: 'FCFS',
    hint: '按到达先后排队，同一时刻按 PID 升序。运行中不被抢占。',
  },
  {
    id: 'sjf',
    label: '短作业优先 SJF（非抢占）',
    short: 'SJF',
    hint: 'CPU 空闲时选剩余服务时间最短者。平局先比到达时间，再比 PID。不抢占。',
  },
  {
    id: 'srtf',
    label: '最短剩余时间优先 SRTF',
    short: 'SRTF',
    hint: '剩余时间严格更短才抢占。相等时当前进程继续。空闲时的平局规则同 SJF。',
  },
  {
    id: 'rr',
    label: '时间片轮转 RR',
    short: 'RR',
    hint: '就绪队列先进先出。时间片用尽后进队尾，然后才处理同一时刻的新到达。',
  },
  {
    id: 'priority-np',
    label: '优先级（非抢占）',
    short: '优先级·非抢占',
    hint: '数值越小优先级越高。CPU 空闲时选最高优先级；平局先到达时间再 PID。不抢占。',
  },
  {
    id: 'priority-p',
    label: '优先级（抢占）',
    short: '优先级·抢占',
    hint: '仅当新进程的优先级数值严格更小才抢占。相等不抢占。平局规则同非抢占。老化开启时用有效优先级比较。',
  },
  {
    id: 'hrrn',
    label: '最高响应比优先 HRRN',
    short: 'HRRN',
    hint: '非抢占。CPU 空闲时选响应比 (就绪等待 + 服务时间) / 服务时间 最大者。平局先到达时间再 PID。',
  },
  {
    id: 'mlfq',
    label: '多级反馈队列 MLFQ',
    short: 'MLFQ',
    hint: '新进程进入最高级。时间片用尽降一级，最低级循环。被更高队列抢占时回到本队队首并保留剩余时间片。提升周期大于 0 时，每隔该时间全部回到 Q0。',
  },
] as const;

export const STATE_LABEL: Record<ProcessState, string> = {
  new: '新建',
  ready: '就绪',
  running: '运行',
  waiting: '等待',
  terminated: '完成',
};

export const ALGORITHM_IDS: readonly AlgorithmId[] = ALGORITHM_CATALOG.map((item) => item.id);

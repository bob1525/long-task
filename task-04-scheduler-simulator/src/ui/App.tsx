import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ALGORITHM_CATALOG,
  METRIC_DEFINITIONS,
  RULES_SUMMARY,
  STATE_LABEL,
  SchedulerEngine,
  colorForPid,
  formatHistory,
  formatNumber,
  formatPercent,
  historySpans,
  generateProcesses,
  importProcesses,
  resultToCsv,
  resultToJson,
  runToCompletion,
  type AlgorithmId,
  type EngineSnapshot,
  type ImportIssue,
  type ProcessSpec,
  type SchedulerOptions,
} from '../core';
import { PRESETS, type Preset } from '../fixtures/presets';
import { CompareView } from './CompareView';
import { downloadText } from './download';
import { GanttChart } from './GanttChart';

type Speed = 'slow' | 'normal' | 'fast';
type Tab = 'sim' | 'compare';

const SPEED_MS: Record<Speed, number> = { slow: 2000, normal: 800, fast: 120 };

interface DraftRow {
  uid: string;
  pid: string;
  arrival: string;
  burst: string;
  priority: string;
  ioAfter: string;
  ioDuration: string;
}

function newUid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function rowFromSpec(spec: ProcessSpec): DraftRow {
  return {
    uid: newUid(),
    pid: String(spec.pid),
    arrival: String(spec.arrivalTime),
    burst: String(spec.burstTime),
    priority: String(spec.priority),
    ioAfter: spec.ioBursts?.[0] ? String(spec.ioBursts[0].afterCpu) : '',
    ioDuration: spec.ioBursts?.[0] ? String(spec.ioBursts[0].duration) : '',
  };
}

function specFromRow(row: DraftRow): ProcessSpec {
  const spec: ProcessSpec = {
    pid: Number(row.pid),
    arrivalTime: Number(row.arrival),
    burstTime: Number(row.burst),
    priority: Number(row.priority),
  };
  if (row.ioAfter.trim() !== '' || row.ioDuration.trim() !== '') {
    spec.ioBursts = [{ afterCpu: Number(row.ioAfter), duration: Number(row.ioDuration) }];
  }
  return spec;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败';
}

export function App() {
  const initial = PRESETS[0];
  const [rows, setRows] = useState<DraftRow[]>(() => initial.processes.map(rowFromSpec));
  const [algorithm, setAlgorithm] = useState<AlgorithmId>('fcfs');
  const [quantum, setQuantum] = useState(2);
  const [mlfqQuantums, setMlqQuantums] = useState<number[]>([2, 4, 8]);
  const [snap, setSnap] = useState<EngineSnapshot | null>(null);
  const [speed, setSpeed] = useState<Speed>('normal');
  const [playing, setPlaying] = useState(false);
  const [tab, setTab] = useState<Tab>('sim');
  const [error, setError] = useState('');
  const [addPid, setAddPid] = useState('5');
  const [addArrival, setAddArrival] = useState('');
  const [addBurst, setAddBurst] = useState('3');
  const [addPriority, setAddPriority] = useState('1');
  const [addIoAfter, setAddIoAfter] = useState('');
  const [addIoDuration, setAddIoDuration] = useState('');
  const [contextSwitch, setContextSwitch] = useState(0);
  const [agingInterval, setAgingInterval] = useState(0);
  const [mlfqBoost, setMlqBoost] = useState(0);
  const [seed, setSeed] = useState(42);
  const [randomCount, setRandomCount] = useState(4);
  const [importErrors, setImportErrors] = useState<ImportIssue[]>([]);
  const [importKind, setImportKind] = useState<'json' | 'csv'>('csv');
  const [frames, setFrames] = useState<EngineSnapshot[]>([]);
  const [cursor, setCursor] = useState(0);

  const engineRef = useRef<SchedulerEngine | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const playingRef = useRef(false);
  const mountedRef = useRef(true);
  const draftRef = useRef<ProcessSpec[]>([]);
  const framesRef = useRef<EngineSnapshot[]>([]);
  const followLiveRef = useRef(true);
  const optionsRef = useRef<SchedulerOptions>({
    algorithm: 'fcfs',
    quantum: 2,
    mlfqQuantums: [2, 4, 8],
    contextSwitch: 0,
    agingInterval: 0,
    mlfqBoost: 0,
  });

  draftRef.current = rows.map(specFromRow);
  optionsRef.current = {
    algorithm,
    quantum,
    mlfqQuantums: [...mlfqQuantums],
    contextSwitch,
    agingInterval,
    mlfqBoost,
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const info = ALGORITHM_CATALOG.find((item) => item.id === algorithm);
  const started = snap !== null;

  function pause() {
    playingRef.current = false;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (mountedRef.current) setPlaying(false);
  }

  function publish(engine: SchedulerEngine) {
    if (!mountedRef.current) return;
    const next = engine.getSnapshot();
    const kept = framesRef.current.filter((frame) => frame.currentTime < next.currentTime);
    const merged = [...kept, next];
    framesRef.current = merged;
    setFrames(merged);
    setSnap(next);
    if (followLiveRef.current) setCursor(merged.length - 1);
  }

  function ensureEngine(): SchedulerEngine {
    if (!engineRef.current) {
      const engine = new SchedulerEngine(
        draftRef.current.map((spec) => ({
          ...spec,
          ioBursts: spec.ioBursts?.map((burst) => ({ ...burst })),
        })),
        optionsRef.current,
      );
      engineRef.current = engine;
      const initial = engine.getSnapshot();
      framesRef.current = [initial];
      setFrames([initial]);
      setCursor(0);
    }
    return engineRef.current;
  }

  function resetClock() {
    pause();
    engineRef.current = null;
    framesRef.current = [];
    followLiveRef.current = true;
    setFrames([]);
    setCursor(0);
    setSnap(null);
    setError('');
  }

  function stepEngine(engine: SchedulerEngine) {
    if (!engine.isFinished()) engine.step();
    publish(engine);
  }

  function onStep() {
    pause();
    if (engineRef.current && cursor < framesRef.current.length - 1) {
      const nextCursor = cursor + 1;
      followLiveRef.current = nextCursor >= framesRef.current.length - 1;
      setCursor(nextCursor);
      setError('');
      return;
    }
    followLiveRef.current = true;
    if (draftRef.current.length === 0 && !engineRef.current) {
      setError('请先添加进程');
      return;
    }
    try {
      stepEngine(ensureEngine());
      setError('');
    } catch (caught) {
      engineRef.current = null;
      setError(messageOf(caught));
    }
  }

  function play(nextSpeed: Speed) {
    pause();
    followLiveRef.current = true;
    setSpeed(nextSpeed);
    if (draftRef.current.length === 0 && !engineRef.current) {
      setError('请先添加进程');
      return;
    }
    try {
      const engine = ensureEngine();
      stepEngine(engine);
      setError('');
      if (engine.isFinished()) return;
      playingRef.current = true;
      setPlaying(true);
      timerRef.current = setInterval(() => {
        const current = engineRef.current;
        if (!current || !playingRef.current || !mountedRef.current) return;
        if (current.isFinished()) {
          pause();
          publish(current);
          return;
        }
        current.step();
        publish(current);
        if (current.isFinished()) pause();
      }, SPEED_MS[nextSpeed]);
    } catch (caught) {
      engineRef.current = null;
      pause();
      setError(messageOf(caught));
    }
  }

  function runToEnd() {
    pause();
    followLiveRef.current = true;
    if (draftRef.current.length === 0 && !engineRef.current) {
      setError('请先添加进程');
      return;
    }
    try {
      const engine = ensureEngine();
      let guard = 0;
      while (!engine.isFinished()) {
        engine.step();
        publish(engine);
        guard += 1;
        if (guard > 100_000) throw new Error('仿真步数过多');
      }
      setError('');
    } catch (caught) {
      engineRef.current = null;
      setError(messageOf(caught));
    }
  }

  function selectAlgorithm(id: AlgorithmId) {
    resetClock();
    setAlgorithm(id);
  }

  function changeQuantum(value: number) {
    if (!Number.isInteger(value) || value < 1) return;
    resetClock();
    setQuantum(value);
  }

  function changeNonNegative(value: number, apply: (next: number) => void) {
    if (!Number.isInteger(value) || value < 0) return;
    resetClock();
    apply(value);
  }

  function changeMlfq(index: number, value: number) {
    if (!Number.isInteger(value) || value < 1) return;
    resetClock();
    setMlqQuantums((current) => current.map((item, itemIndex) => (itemIndex === index ? value : item)));
  }

  function addMlfqLevel() {
    resetClock();
    setMlqQuantums((current) => [...current, Math.max(1, (current[current.length - 1] ?? 1) * 2)]);
  }

  function removeMlfqLevel() {
    resetClock();
    setMlqQuantums((current) => (current.length > 3 ? current.slice(0, -1) : current));
  }

  function loadPreset(preset: Preset) {
    resetClock();
    setRows(preset.processes.map(rowFromSpec));
    if (preset.algorithm) setAlgorithm(preset.algorithm);
    if (preset.quantum) setQuantum(preset.quantum);
    if (preset.mlfqQuantums) setMlqQuantums([...preset.mlfqQuantums]);
    setContextSwitch(preset.contextSwitch ?? 0);
    setAgingInterval(preset.agingInterval ?? 0);
    setMlqBoost(preset.mlfqBoost ?? 0);
    setImportErrors([]);
    const maxPid = preset.processes.reduce((max, proc) => Math.max(max, proc.pid), 0);
    setAddPid(String(maxPid + 1));
    setAddArrival('');
  }

  function updateRow(uid: string, patch: Partial<DraftRow>) {
    if (started) return;
    setRows((current) => current.map((row) => (row.uid === uid ? { ...row, ...patch } : row)));
  }

  function deleteRow(uid: string) {
    if (started) return;
    setRows((current) => current.filter((row) => row.uid !== uid));
  }

  function onAdd(event: FormEvent) {
    event.preventDefault();
    const arrival = addArrival.trim() === '' ? (snap?.currentTime ?? 0) : Number(addArrival);
    const spec: ProcessSpec = {
      pid: Number(addPid),
      arrivalTime: arrival,
      burstTime: Number(addBurst),
      priority: Number(addPriority),
    };
    if (addIoAfter.trim() !== '' || addIoDuration.trim() !== '') {
      spec.ioBursts = [{ afterCpu: Number(addIoAfter), duration: Number(addIoDuration) }];
    }
    if (rows.some((row) => Number(row.pid) === spec.pid)) {
      setError(`PID ${spec.pid} 已存在`);
      return;
    }
    try {
      if (engineRef.current) {
        engineRef.current.addProcess(spec);
        const stored = engineRef.current.getSnapshot().processes.find((proc) => proc.pid === spec.pid);
        const effective: ProcessSpec = { ...spec, arrivalTime: stored?.arrivalTime ?? spec.arrivalTime };
        setRows((current) => [...current, rowFromSpec(effective)]);
        publish(engineRef.current);
      } else {
        setRows((current) => [...current, rowFromSpec(spec)]);
      }
      setAddPid(String(spec.pid + 1));
      setAddArrival('');
      setAddIoAfter('');
      setAddIoDuration('');
      setError('');
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  function onScrub(time: number) {
    pause();
    const index = framesRef.current.findIndex((frame) => frame.currentTime === time);
    if (index < 0) return;
    followLiveRef.current = index === framesRef.current.length - 1;
    setCursor(index);
  }

  function applyImported(processes: ProcessSpec[]) {
    resetClock();
    setRows(processes.map(rowFromSpec));
    setImportErrors([]);
    const maxPid = processes.reduce((max, proc) => Math.max(max, proc.pid), 0);
    setAddPid(String(maxPid + 1));
    setAddArrival('');
  }

  function onImportFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      const trimmed = text.trim();
      const kind: 'json' | 'csv' =
        file.name.toLowerCase().endsWith('.json') || trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : 'csv';
      setImportKind(kind);
      const imported = importProcesses(text, kind);
      if (imported.errors.length > 0 || imported.processes.length === 0) {
        setImportErrors(imported.errors.length > 0 ? imported.errors : [{ line: 1, message: '没有读到进程' }]);
        return;
      }
      applyImported(imported.processes);
      setError('');
    };
    reader.onerror = () => setError('无法读取文件');
    reader.readAsText(file);
  }

  function onRandom() {
    try {
      const processes = generateProcesses({ seed, count: randomCount });
      resetClock();
      setRows(processes.map(rowFromSpec));
      setImportErrors([]);
      const maxPid = processes.reduce((max, proc) => Math.max(max, proc.pid), 0);
      setAddPid(String(maxPid + 1));
      setAddArrival('');
      setError('');
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  function exportResult(kind: 'json' | 'csv') {
    if (draftRef.current.length === 0) {
      setError('请先添加进程');
      return;
    }
    try {
      const result = runToCompletion(draftRef.current, optionsRef.current);
      if (kind === 'json') {
        downloadText(`schedule-${algorithm}.json`, resultToJson(result), 'application/json');
      } else {
        downloadText(`schedule-${algorithm}.csv`, resultToCsv(result), 'text/csv');
      }
      setError('');
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  const viewingPast = snap !== null && frames[cursor] !== undefined && cursor < frames.length - 1;
  const view = viewingPast ? frames[cursor] : snap;
  const liveTime = snap?.currentTime ?? 0;
  const optionNote = [
    contextSwitch > 0 ? `切换 ${contextSwitch}` : '',
    (algorithm === 'priority-np' || algorithm === 'priority-p') && agingInterval > 0 ? `老化 ${agingInterval}` : '',
    algorithm === 'mlfq' && mlfqBoost > 0 ? `提升 ${mlfqBoost}` : '',
  ].filter((part) => part !== '');
  const caption = [
    algorithm === 'rr'
      ? `${info?.label ?? 'RR'} · q=${quantum}`
      : algorithm === 'mlfq'
        ? `${info?.label ?? 'MLFQ'} · q=${mlfqQuantums.join('/')}`
        : (info?.label ?? algorithm),
    ...optionNote,
  ].join(' · ');
  const holding = view?.holdingPid ?? null;
  const holdingProc = holding === null ? null : (view?.processes.find((proc) => proc.pid === holding) ?? null);
  const runningLabel = !view ? '尚未开始' : holding !== null ? `P${holding}` : '空闲';
  const nextReady = view?.readyQueue[0] ?? null;
  const arrivingNow =
    view?.processes.filter((proc) => proc.state === 'new' && proc.arrivalTime === view.currentTime) ?? [];
  const cpuDetail = !view
    ? '尚未执行'
    : view.contextSwitching && holdingProc
      ? `正在切换到 P${holdingProc.pid}，这一拍不消耗服务时间 · 剩余 ${holdingProc.remainingTime}`
      : holdingProc
        ? `剩余 ${holdingProc.remainingTime} · 优先级 ${holdingProc.effectivePriority ?? holdingProc.priority}`
        : nextReady
          ? `本拍已结束，CPU 已空出。下一步分派时队首是 P${nextReady.pid}。`
          : arrivingNow.length > 0
            ? `时刻 ${view.currentTime} 到达 ${arrivingNow.map((proc) => `P${proc.pid}`).join('、')}，下一步才会入队并分派。`
            : view.waitingQueue.length > 0
              ? 'CPU 空闲，就绪队列没有进程，有进程正在等待 I/O。'
              : view.finished
                ? '没有待运行的进程。'
                : 'CPU 空闲。';
  const specs = rows.map(specFromRow);

  return (
    <div className="app" data-testid="app" data-algorithm={algorithm} data-playing={playing ? 'true' : 'false'}>
      <header className="top">
        <div>
          <p className="eyebrow">操作系统 · 进程调度</p>
          <h1>调度实验台</h1>
        </div>
        <p className="rules" data-testid="rules-strip">
          优先级数值越小越高 · 平局先到达时间再 PID · 主关键字相等不抢占 · 甘特图一段 = 一次分派
        </p>
      </header>

      <div className="tabs">
        <button type="button" data-testid="tab-sim" className={tab === 'sim' ? 'is-active' : ''} onClick={() => setTab('sim')}>
          模拟
        </button>
        <button
          type="button"
          data-testid="tab-compare"
          className={tab === 'compare' ? 'is-active' : ''}
          onClick={() => {
            pause();
            setTab('compare');
          }}
        >
          对比报告
        </button>
      </div>

      {tab === 'compare' ? (
        <CompareView
          processes={specs}
          quantum={quantum}
          mlfqQuantums={mlfqQuantums}
          contextSwitch={contextSwitch}
          agingInterval={agingInterval}
          mlfqBoost={mlfqBoost}
        />
      ) : (
        <>
          <section className="panel algo-panel">
            <div className="algo-grid" role="radiogroup" aria-label="调度算法">
              {ALGORITHM_CATALOG.map((item) => (
                <label key={item.id} className={item.id === algorithm ? 'algo is-active' : 'algo'}>
                  <input
                    type="radio"
                    name="algorithm"
                    data-testid={`algo-${item.id}`}
                    checked={item.id === algorithm}
                    onChange={() => selectAlgorithm(item.id)}
                  />
                  <span>{item.short}</span>
                </label>
              ))}
            </div>
            <p className="hint" data-testid="algo-hint">
              {info?.hint}
            </p>
            {algorithm === 'rr' ? (
              <label className="inline-field">
                时间片
                <input
                  data-testid="input-quantum"
                  type="number"
                  min={1}
                  step={1}
                  value={quantum}
                  onChange={(event) => changeQuantum(event.target.valueAsNumber)}
                />
              </label>
            ) : null}
            {algorithm === 'mlfq' ? (
              <div className="mlfq-fields">
                {mlfqQuantums.map((value, index) => (
                  <label key={index} className="inline-field">
                    Q{index}
                    <input
                      data-testid={`input-mlfq-${index}`}
                      type="number"
                      min={1}
                      step={1}
                      value={value}
                      onChange={(event) => changeMlfq(index, event.target.valueAsNumber)}
                    />
                  </label>
                ))}
                <button type="button" data-testid="btn-mlfq-add" onClick={addMlfqLevel}>
                  增加队列
                </button>
                <button type="button" data-testid="btn-mlfq-remove" onClick={removeMlfqLevel} disabled={mlfqQuantums.length <= 3}>
                  减少队列
                </button>
              </div>
            ) : null}
            {(algorithm === 'priority-np' || algorithm === 'priority-p') ? (
              <label className="inline-field">
                老化间隔
                <input
                  data-testid="input-aging"
                  type="number"
                  min={0}
                  step={1}
                  value={agingInterval}
                  onChange={(event) => changeNonNegative(event.target.valueAsNumber, setAgingInterval)}
                />
              </label>
            ) : null}
            {algorithm === 'mlfq' ? (
              <label className="inline-field">
                提升周期
                <input
                  data-testid="input-mlfq-boost"
                  type="number"
                  min={0}
                  step={1}
                  value={mlfqBoost}
                  onChange={(event) => changeNonNegative(event.target.valueAsNumber, setMlqBoost)}
                />
              </label>
            ) : null}
            <label className="inline-field">
              切换开销
              <input
                data-testid="input-context-switch"
                type="number"
                min={0}
                step={1}
                value={contextSwitch}
                onChange={(event) => changeNonNegative(event.target.valueAsNumber, setContextSwitch)}
              />
            </label>
            <p className="subtle">老化、提升和切换开销填 0 表示关闭。关闭时用例 A/B/C 的结果与原来相同。</p>
          </section>

          <section className="preset-row">
            {PRESETS.map((preset) => (
              <button key={preset.id} type="button" data-testid={`preset-${preset.id}`} onClick={() => loadPreset(preset)}>
                {preset.label}
              </button>
            ))}
            <div className="import-row">
              <label className="inline-field">
                导入 JSON / CSV
                <input
                  data-testid="input-import"
                  type="file"
                  accept=".json,.csv,application/json,text/csv"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    onImportFile(file);
                    event.target.value = '';
                  }}
                />
              </label>
            </div>
            <div className="random-row">
              <label className="inline-field">
                随机种子
                <input
                  data-testid="input-seed"
                  type="number"
                  step={1}
                  value={seed}
                  onChange={(event) => setSeed(event.target.valueAsNumber)}
                />
              </label>
              <label className="inline-field">
                数量
                <input
                  data-testid="input-random-count"
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  value={randomCount}
                  onChange={(event) => setRandomCount(event.target.valueAsNumber)}
                />
              </label>
              <button type="button" data-testid="btn-random" onClick={onRandom}>
                按种子生成
              </button>
            </div>
            {importErrors.length > 0 ? (
              <ul className="import-errors" data-testid="import-errors">
                {importErrors.map((item, index) => (
                  <li key={`${item.line}-${index}`} data-testid="import-error">
                    {importKind === 'json' ? `第 ${item.line} 条` : `第 ${item.line} 行`}：{item.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="controls">
            <div className="speeds" role="group" aria-label="模拟速度">
              <button type="button" data-testid="btn-pause" aria-pressed={!playing} onClick={pause}>
                暂停
              </button>
              <button type="button" data-testid="btn-slow" aria-pressed={playing && speed === 'slow'} onClick={() => play('slow')}>
                慢放
              </button>
              <button
                type="button"
                data-testid="btn-normal"
                aria-pressed={playing && speed === 'normal'}
                onClick={() => play('normal')}
              >
                正常
              </button>
              <button type="button" data-testid="btn-fast" aria-pressed={playing && speed === 'fast'} onClick={() => play('fast')}>
                快进
              </button>
            </div>
            <button type="button" data-testid="btn-step" onClick={onStep}>
              单步
            </button>
            <button type="button" data-testid="btn-run-to-end" onClick={runToEnd}>
              运行至结束
            </button>
            <button type="button" data-testid="btn-reset" onClick={resetClock}>
              重置
            </button>
            <p className="clock">
              仿真时间 <strong data-testid="sim-time">{view?.currentTime ?? 0}</strong>
            </p>
            {frames.length > 1 && snap ? (
              <label className="scrubber">
                时间轴
                <input
                  data-testid="timeline-scrubber"
                  type="range"
                  min={frames[0]?.currentTime ?? 0}
                  max={frames[frames.length - 1]?.currentTime ?? 0}
                  step={1}
                  value={view?.currentTime ?? 0}
                  onChange={(event) => onScrub(event.target.valueAsNumber)}
                />
                <span data-testid="scrubber-time">{viewingPast ? `回看 ${view?.currentTime ?? 0}` : '实时'}</span>
              </label>
            ) : null}
            <button type="button" data-testid="btn-export-json" onClick={() => exportResult('json')}>
              导出 JSON
            </button>
            <button type="button" data-testid="btn-export-csv" onClick={() => exportResult('csv')}>
              导出 CSV
            </button>
          </section>

          {error ? (
            <p className="error" data-testid="form-error">
              {error}
            </p>
          ) : null}
          {snap?.finished && !viewingPast ? (
            <p className="done-banner">全部进程已完成。可以导出、切换算法，或在下方继续添加进程。</p>
          ) : null}
          {viewingPast ? (
            <p className="done-banner" data-testid="scrubber-note">
              正在回看时刻 {view?.currentTime ?? 0}。添加进程仍按当前仿真时间 {liveTime}。单步查看下一记录，播放从已经走到的时刻继续。
            </p>
          ) : null}

          <div data-testid="stage">
          <GanttChart slices={view?.slices ?? []} caption={caption} />

          <section className="status-grid">
            <article className="card run-card" style={holding !== null ? { borderColor: colorForPid(holding) } : undefined}>
              <p className="kicker">当前运行进程</p>
              <p className="run-pid" data-testid="running-process" data-holding={holding ?? 'idle'}>
                {runningLabel}
              </p>
              <p data-testid="cpu-holding">{cpuDetail}</p>
              {view?.lastInterval ? (
                <p className="subtle">
                  上一段 [{view.lastInterval.start}, {view.lastInterval.end}){' '}
                  {view.contextSwitching ? '切换' : view.lastExecutedPid ? `P${view.lastExecutedPid}` : '空闲'}
                </p>
              ) : null}
            </article>
            <article className="card">
              <p className="kicker">就绪队列</p>
              {algorithm === 'mlfq' && view?.mlfqQueues ? (
                <div data-testid="ready-queue" className="mlfq-board">
                  {view.mlfqQueues.map((queue) => (
                    <div key={queue.level} className="mlfq-line" data-testid={`mlfq-level-${queue.level}`}>
                      <span className="q-label">
                        Q{queue.level}
                        <small>q={queue.quantum}</small>
                      </span>
                      {queue.pids.length === 0 ? (
                        <em>空</em>
                      ) : (
                        queue.pids.map((pid, index) => (
                          <span key={`${queue.level}-${index}-${pid}`} className="chip" data-testid="ready-pid" data-pid={pid}>
                            {index === 0 ? <i>队首</i> : null}P{pid}
                          </span>
                        ))
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div data-testid="ready-queue" className="chip-row">
                  {(view?.readyQueue.length ?? 0) === 0 ? (
                    <p data-testid="ready-empty">队列为空</p>
                  ) : (
                    view?.readyQueue.map((entry, index) => (
                      <span key={`${entry.pid}-${index}`} className="chip" data-testid="ready-pid" data-pid={entry.pid}>
                        {index === 0 ? <i>队首</i> : null}
                        P{entry.pid}
                      </span>
                    ))
                  )}
                </div>
              )}
              <div className="wait-row" data-testid="waiting-queue">
                <span className="kicker">等待（I/O）</span>
                {(view?.waitingQueue.length ?? 0) === 0 ? (
                  <em data-testid="waiting-empty">无</em>
                ) : (
                  view?.waitingQueue.map((pid) => (
                    <span key={pid} className="chip is-waiting" data-testid="waiting-pid" data-pid={pid}>
                      P{pid}
                    </span>
                  ))
                )}
              </div>
              <p className="subtle">队首是下一次 CPU 空闲时会先考虑的进程。SJF / 优先级按比较器排序显示。等待是 I/O 阻塞，不在就绪队列里。</p>
            </article>
            <article className="card">
              <p className="kicker">实时指标</p>
              <dl className="metrics">
                <div>
                  <dt>平均等待</dt>
                  <dd data-testid="metric-waiting">{formatNumber(view?.averages.waiting)}</dd>
                </div>
                <div>
                  <dt>平均周转</dt>
                  <dd data-testid="metric-turnaround">{formatNumber(view?.averages.turnaround)}</dd>
                </div>
                <div>
                  <dt>平均响应</dt>
                  <dd data-testid="metric-response">{formatNumber(view?.averages.response)}</dd>
                </div>
                <div>
                  <dt>CPU 利用率</dt>
                  <dd data-testid="metric-cpu">{formatPercent(view?.cpuUtilization)}</dd>
                </div>
              </dl>
              <ul className="formula">
                {METRIC_DEFINITIONS.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </article>
          </section>
          </div>

          <section className="split">
            <div>
              <h2>进程</h2>
              <div className="table-scroll">
                <table className="sheet" data-testid="process-table">
                  <thead>
                    <tr>
                      <th>PID</th>
                      <th>到达</th>
                      <th>服务</th>
                      <th>优先级</th>
                      <th>I/O 触发</th>
                      <th>I/O 时长</th>
                      <th>剩余</th>
                      <th>状态</th>
                      <th>完成</th>
                      <th>周转</th>
                      <th>等待</th>
                      <th>响应</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const live = view?.processes.find((proc) => proc.pid === Number(row.pid));
                      const pid = Number(row.pid);
                      return (
                        <tr key={row.uid} data-testid={`process-row-${row.pid}`}>
                          <td>
                            <input
                              aria-label={`P${row.pid} PID`}
                              value={row.pid}
                              disabled={started}
                              onChange={(event) => updateRow(row.uid, { pid: event.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              aria-label={`P${row.pid} 到达`}
                              value={row.arrival}
                              disabled={started}
                              onChange={(event) => updateRow(row.uid, { arrival: event.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              aria-label={`P${row.pid} 服务`}
                              value={row.burst}
                              disabled={started}
                              onChange={(event) => updateRow(row.uid, { burst: event.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              aria-label={`P${row.pid} 优先级`}
                              value={row.priority}
                              disabled={started}
                              onChange={(event) => updateRow(row.uid, { priority: event.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              aria-label={`P${row.pid} I/O 触发`}
                              value={row.ioAfter}
                              disabled={started}
                              onChange={(event) => updateRow(row.uid, { ioAfter: event.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              aria-label={`P${row.pid} I/O 时长`}
                              value={row.ioDuration}
                              disabled={started}
                              onChange={(event) => updateRow(row.uid, { ioDuration: event.target.value })}
                            />
                          </td>
                          <td>{live ? live.remainingTime : row.burst}</td>
                          <td>
                            <span className="state-pill" data-state={live?.state ?? 'new'}>
                              {STATE_LABEL[live?.state ?? 'new']}
                            </span>
                          </td>
                          <td data-testid={Number.isInteger(pid) ? `stat-${pid}-completion` : undefined}>
                            {live?.completionTime ?? '—'}
                          </td>
                          <td data-testid={Number.isInteger(pid) ? `stat-${pid}-turnaround` : undefined}>
                            {live?.turnaroundTime ?? '—'}
                          </td>
                          <td data-testid={Number.isInteger(pid) ? `stat-${pid}-waiting` : undefined}>
                            {live ? live.waitingTime : '—'}
                          </td>
                          <td data-testid={Number.isInteger(pid) ? `stat-${pid}-response` : undefined}>
                            {live?.responseTime ?? '—'}
                          </td>
                          <td>
                            <button type="button" disabled={started} onClick={() => deleteRow(row.uid)}>
                              删除
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <form className="add-form" data-testid="add-form" onSubmit={onAdd}>
                <h3>动态添加</h3>
                <label>
                  PID
                  <input data-testid="add-pid" value={addPid} onChange={(event) => setAddPid(event.target.value)} />
                </label>
                <label>
                  到达
                  <input
                    data-testid="add-arrival"
                    placeholder={String(liveTime)}
                    value={addArrival}
                    onChange={(event) => setAddArrival(event.target.value)}
                  />
                </label>
                <label>
                  服务
                  <input data-testid="add-burst" value={addBurst} onChange={(event) => setAddBurst(event.target.value)} />
                </label>
                <label>
                  优先级
                  <input
                    data-testid="add-priority"
                    value={addPriority}
                    onChange={(event) => setAddPriority(event.target.value)}
                  />
                </label>
                <label>
                  I/O 触发
                  <input data-testid="add-io-after" value={addIoAfter} onChange={(event) => setAddIoAfter(event.target.value)} />
                </label>
                <label>
                  I/O 时长
                  <input
                    data-testid="add-io-duration"
                    value={addIoDuration}
                    onChange={(event) => setAddIoDuration(event.target.value)}
                  />
                </label>
                <button type="submit" data-testid="btn-add-process">
                  添加进程
                </button>
                <p className="subtle">到达留空则使用当前仿真时间。早于当前时间的到达会被调整到现在，并在下一步参与调度。</p>
              </form>
            </div>
            <div>
              <h2>状态变化</h2>
              <div className="state-legend">
                {(Object.keys(STATE_LABEL) as (keyof typeof STATE_LABEL)[]).map((state) => (
                  <span key={state} data-state={state}>
                    {STATE_LABEL[state]}
                  </span>
                ))}
              </div>
              <div data-testid="state-history">
                {view ? (
                  view.processes.map((proc) => (
                    <article key={proc.pid} className="history-row" data-testid={`history-${proc.pid}`}>
                      <header>
                        <strong>P{proc.pid}</strong>
                        <span>{formatHistory(proc.history)}</span>
                      </header>
                      <div
                        className="lane"
                        style={{ gridTemplateColumns: `repeat(${Math.max(view.currentTime, 1)}, minmax(8px, 1fr))` }}
                      >
                        {historySpans(proc.history, view.currentTime).map((span, index) => (
                          <i
                            key={`${span.state}-${span.start}-${index}`}
                            data-state={span.state}
                            style={{ gridColumn: `${span.start + 1} / ${span.end + 1}` }}
                            title={`${STATE_LABEL[span.state]} [${span.start}, ${span.end})`}
                          />
                        ))}
                      </div>
                    </article>
                  ))
                ) : (
                  <p className="gantt-empty">开始后，这里按时间画出新建、就绪、运行、等待和完成。</p>
                )}
              </div>
              <h2>事件</h2>
              <ol className="event-log" data-testid="event-log">
                {(view?.logs ?? []).slice(-8).map((line, index) => (
                  <li key={`${index}-${line}`}>{line}</li>
                ))}
              </ol>
            </div>
          </section>
          <details className="full-rules">
            <summary>完整调度约定</summary>
            <p data-testid="rules-summary">{RULES_SUMMARY}</p>
          </details>
        </>
      )}
    </div>
  );
}

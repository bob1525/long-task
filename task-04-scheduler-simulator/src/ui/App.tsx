import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ALGORITHM_CATALOG,
  METRIC_DEFINITIONS,
  RULES_SUMMARY,
  STATE_LABEL,
  SchedulerEngine,
  formatHistory,
  formatNumber,
  formatPercent,
  historySpans,
  resultToCsv,
  resultToJson,
  runToCompletion,
  type AlgorithmId,
  type EngineSnapshot,
  type ProcessSpec,
  type SchedulerOptions,
} from '../core';
import { PRESETS, type Preset } from '../fixtures/presets';
import { CompareView } from './CompareView';
import { downloadText } from './download';
import { GanttChart } from './GanttChart';

type Speed = 'slow' | 'normal' | 'fast';
type Tab = 'sim' | 'compare';

const SPEED_MS: Record<Speed, number> = { slow: 1200, normal: 450, fast: 90 };

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

  const engineRef = useRef<SchedulerEngine | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const playingRef = useRef(false);
  const mountedRef = useRef(true);
  const draftRef = useRef<ProcessSpec[]>([]);
  const optionsRef = useRef<SchedulerOptions>({ algorithm: 'fcfs', quantum: 2, mlfqQuantums: [2, 4, 8] });

  draftRef.current = rows.map(specFromRow);
  optionsRef.current = { algorithm, quantum, mlfqQuantums: [...mlfqQuantums] };

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
    setSnap(engine.getSnapshot());
  }

  function ensureEngine(): SchedulerEngine {
    if (!engineRef.current) {
      engineRef.current = new SchedulerEngine(
        draftRef.current.map((spec) => ({
          ...spec,
          ioBursts: spec.ioBursts?.map((burst) => ({ ...burst })),
        })),
        optionsRef.current,
      );
    }
    return engineRef.current;
  }

  function resetClock() {
    pause();
    engineRef.current = null;
    setSnap(null);
    setError('');
  }

  function stepEngine(engine: SchedulerEngine) {
    if (!engine.isFinished()) engine.step();
    publish(engine);
  }

  function onStep() {
    pause();
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
    if (draftRef.current.length === 0 && !engineRef.current) {
      setError('请先添加进程');
      return;
    }
    try {
      const engine = ensureEngine();
      let guard = 0;
      while (!engine.isFinished()) {
        engine.step();
        guard += 1;
        if (guard > 100_000) throw new Error('仿真步数过多');
      }
      publish(engine);
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

  const caption =
    algorithm === 'rr'
      ? `${info?.label ?? 'RR'} · q=${quantum}`
      : algorithm === 'mlfq'
        ? `${info?.label ?? 'MLFQ'} · q=${mlfqQuantums.join('/')}`
        : (info?.label ?? algorithm);
  const holding = snap?.holdingPid ?? null;
  const holdingProc = holding === null ? null : (snap?.processes.find((proc) => proc.pid === holding) ?? null);
  const runningLabel = !snap ? '尚未开始' : holding !== null ? `P${holding}` : '空闲';
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
        <CompareView processes={specs} quantum={quantum} mlfqQuantums={mlfqQuantums} />
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
          </section>

          <section className="preset-row">
            {PRESETS.map((preset) => (
              <button key={preset.id} type="button" data-testid={`preset-${preset.id}`} onClick={() => loadPreset(preset)}>
                {preset.label}
              </button>
            ))}
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
              仿真时间 <strong data-testid="sim-time">{snap?.currentTime ?? 0}</strong>
            </p>
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
          {snap?.finished ? <p className="done-banner">全部进程已完成。可以导出、切换算法，或在下方继续添加进程。</p> : null}

          <GanttChart slices={snap?.slices ?? []} caption={caption} />

          <section className="status-grid">
            <article className="card">
              <p className="kicker">当前运行进程</p>
              <p className="run-pid" data-testid="running-process" data-holding={holding ?? 'idle'}>
                {runningLabel}
              </p>
              <p data-testid="cpu-holding">
                {holdingProc
                  ? `剩余 ${holdingProc.remainingTime} · 优先级 ${holdingProc.priority}`
                  : snap
                    ? 'CPU 空闲。时间片边界或完成后，进程会先离开 CPU，再在下一步分派。'
                    : '尚未执行'}
              </p>
              {snap?.lastInterval ? (
                <p className="subtle">
                  上一段 [{snap.lastInterval.start}, {snap.lastInterval.end}){' '}
                  {snap.lastExecutedPid ? `P${snap.lastExecutedPid}` : '空闲'}
                </p>
              ) : null}
            </article>
            <article className="card">
              <p className="kicker">就绪队列</p>
              {algorithm === 'mlfq' && snap?.mlfqQueues ? (
                <div data-testid="ready-queue" className="mlfq-board">
                  {snap.mlfqQueues.map((queue) => (
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
                  {(snap?.readyQueue.length ?? 0) === 0 ? (
                    <p data-testid="ready-empty">队列为空</p>
                  ) : (
                    snap?.readyQueue.map((entry, index) => (
                      <span key={`${entry.pid}-${index}`} className="chip" data-testid="ready-pid" data-pid={entry.pid}>
                        {index === 0 ? <i>队首</i> : null}
                        P{entry.pid}
                      </span>
                    ))
                  )}
                </div>
              )}
              <p className="subtle">队首是下一次 CPU 空闲时会先考虑的进程。SJF / 优先级按比较器排序显示。</p>
            </article>
            <article className="card">
              <p className="kicker">实时指标</p>
              <dl className="metrics">
                <div>
                  <dt>平均等待</dt>
                  <dd data-testid="metric-waiting">{formatNumber(snap?.averages.waiting)}</dd>
                </div>
                <div>
                  <dt>平均周转</dt>
                  <dd data-testid="metric-turnaround">{formatNumber(snap?.averages.turnaround)}</dd>
                </div>
                <div>
                  <dt>平均响应</dt>
                  <dd data-testid="metric-response">{formatNumber(snap?.averages.response)}</dd>
                </div>
                <div>
                  <dt>CPU 利用率</dt>
                  <dd data-testid="metric-cpu">{formatPercent(snap?.cpuUtilization)}</dd>
                </div>
              </dl>
              <ul className="formula">
                {METRIC_DEFINITIONS.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </article>
          </section>

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
                      const live = snap?.processes.find((proc) => proc.pid === Number(row.pid));
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
                    placeholder={String(snap?.currentTime ?? 0)}
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
                {snap ? (
                  snap.processes.map((proc) => (
                    <article key={proc.pid} className="history-row" data-testid={`history-${proc.pid}`}>
                      <header>
                        <strong>P{proc.pid}</strong>
                        <span>{formatHistory(proc.history)}</span>
                      </header>
                      <div
                        className="lane"
                        style={{ gridTemplateColumns: `repeat(${Math.max(snap.currentTime, 1)}, minmax(8px, 1fr))` }}
                      >
                        {historySpans(proc.history, snap.currentTime).map((span, index) => (
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
                {(snap?.logs ?? []).slice(-8).map((line, index) => (
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

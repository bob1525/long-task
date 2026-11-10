import { useMemo, useRef, useState } from 'react';
import { LispEditor } from './Editor';
import { examples } from './examples';
import { Session } from './lisp/session';
import type { EnvFrameSnapshot, Snapshot, StepStatus } from './lisp/types';

const STATUS_LABEL: Record<StepStatus, string> = {
  ready: '就绪',
  running: '执行中',
  done: '完成',
  error: '出错',
};

function chainFrom(id: number | null, frames: EnvFrameSnapshot[]): EnvFrameSnapshot[] {
  const byId = new Map(frames.map((frame) => [frame.id, frame]));
  const chain: EnvFrameSnapshot[] = [];
  const seen = new Set<number>();
  let current = id;
  while (current !== null && !seen.has(current)) {
    const frame = byId.get(current);
    if (!frame) break;
    seen.add(current);
    chain.push(frame);
    current = frame.parentId;
  }
  return chain;
}

function shouldRestart(session: Session): boolean {
  const atEnd = session.cursor >= session.history.length - 1;
  const status = session.snapshot.status;
  return atEnd && (status === 'done' || status === 'error');
}

export function App() {
  const initial = examples[0]!;
  const sessionRef = useRef<Session>(new Session(initial.source));
  const sourceRef = useRef(initial.source);
  const dirtyRef = useRef(false);
  const runningRef = useRef(false);
  const tokenRef = useRef(0);
  const [source, setSource] = useState(initial.source);
  const [exampleId, setExampleId] = useState(initial.id);
  const [snap, setSnap] = useState<Snapshot>(sessionRef.current.snapshot);
  const [meta, setMeta] = useState({ index: 0, length: 1 });
  const [dirty, setDirty] = useState(false);
  const [running, setRunning] = useState(false);
  const [pinnedId, setPinnedId] = useState<number | null>(null);
  const [uiError, setUiError] = useState<string | null>(null);

  function publish(): void {
    const session = sessionRef.current;
    setSnap(session.snapshot);
    setMeta({ index: session.cursor, length: session.history.length });
  }

  function onEdit(text: string): void {
    if (text === sourceRef.current) return;
    tokenRef.current += 1;
    runningRef.current = false;
    setRunning(false);
    sourceRef.current = text;
    setSource(text);
    dirtyRef.current = true;
    setDirty(true);
  }

  function loadExample(id: string): void {
    const example = examples.find((item) => item.id === id);
    if (!example) return;
    tokenRef.current += 1;
    runningRef.current = false;
    setRunning(false);
    sourceRef.current = example.source;
    dirtyRef.current = false;
    setDirty(false);
    setSource(example.source);
    setExampleId(id);
    setPinnedId(null);
    setUiError(null);
    sessionRef.current = new Session(example.source);
    publish();
  }

  function onReset(): void {
    tokenRef.current += 1;
    runningRef.current = false;
    setRunning(false);
    dirtyRef.current = false;
    setDirty(false);
    setPinnedId(null);
    setUiError(null);
    sessionRef.current = new Session(sourceRef.current);
    publish();
  }

  function onBack(): void {
    if (runningRef.current) return;
    sessionRef.current.stepBack();
    publish();
  }

  function onStep(): void {
    if (runningRef.current) return;
    if (dirtyRef.current) {
      sessionRef.current = new Session(sourceRef.current);
      dirtyRef.current = false;
      setDirty(false);
      setPinnedId(null);
    }
    sessionRef.current.stepForward();
    publish();
  }

  function onStop(): void {
    tokenRef.current += 1;
    runningRef.current = false;
    setRunning(false);
  }

  async function onRun(): Promise<void> {
    if (runningRef.current) return;
    const token = tokenRef.current + 1;
    tokenRef.current = token;
    runningRef.current = true;
    setRunning(true);
    setUiError(null);
    try {
      if (dirtyRef.current || shouldRestart(sessionRef.current)) {
        sessionRef.current = new Session(sourceRef.current);
        dirtyRef.current = false;
        setDirty(false);
        setPinnedId(null);
        publish();
      }
      while (tokenRef.current === token) {
        let finished = false;
        for (let count = 0; count < 60; count += 1) {
          const session = sessionRef.current;
          const atEnd = session.cursor >= session.history.length - 1;
          const status = session.snapshot.status;
          if (atEnd && (status === 'done' || status === 'error')) {
            finished = true;
            break;
          }
          session.stepForward();
        }
        if (tokenRef.current !== token) return;
        publish();
        if (finished) break;
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
    } catch (error) {
      setUiError(error instanceof Error ? error.message : String(error));
    } finally {
      if (tokenRef.current === token) {
        runningRef.current = false;
        setRunning(false);
      }
    }
  }

  const highlight = useMemo(() => {
    if (dirty || !snap.currentSpan) return null;
    return {
      from: snap.currentSpan.start.offset,
      to: snap.currentSpan.end.offset,
      error: snap.status === 'error',
    };
  }, [dirty, snap]);

  const selectedId =
    pinnedId !== null && snap.frames.some((frame) => frame.id === pinnedId) ? pinnedId : snap.activeEnvId;
  const chain = chainFrom(selectedId, snap.frames);
  const historyStart = Math.max(0, meta.index - 4);
  const historyWindow = sessionRef.current.history.slice(historyStart, historyStart + 9);
  const example = examples.find((item) => item.id === exampleId) ?? initial;
  const atEnd = meta.index >= meta.length - 1;
  const terminal = snap.status === 'done' || snap.status === 'error';
  const stepDisabled = running || (!dirty && atEnd && terminal);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <svg className="mark" viewBox="0 0 36 36" aria-hidden="true">
            <path d="M7 29 L16 7 H22 L13 29" fill="none" stroke="currentColor" strokeWidth="2.4" />
            <path d="M18 18 L29 29" fill="none" stroke="currentColor" strokeWidth="2.4" />
          </svg>
          <div>
            <h1>Lisp Machine</h1>
            <p>Scheme 子集 · 词法作用域 · 显式栈上的尾调用优化</p>
          </div>
        </div>
        <div className="controls">
          <label>
            示例
            <select data-testid="example-select" value={exampleId} onChange={(event) => loadExample(event.target.value)}>
              {examples.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <button type="button" data-testid="btn-reset" onClick={onReset}>
            重置
          </button>
          <button type="button" data-testid="btn-back" onClick={onBack} disabled={running || meta.index === 0}>
            上一步
          </button>
          <button type="button" data-testid="btn-step" onClick={onStep} disabled={stepDisabled}>
            单步
          </button>
          <button type="button" className="primary" data-testid="btn-run" onClick={running ? onStop : () => void onRun()}>
            {running ? '停止' : '连续执行'}
          </button>
        </div>
      </header>

      <p className="blurb">{example.blurb}</p>
      {dirty && (
        <p className="dirty" data-testid="dirty">
          代码已修改，下一次单步或连续执行会从头开始。
        </p>
      )}
      {uiError && (
        <p className="error" role="alert">
          界面捕获到异常：{uiError}
        </p>
      )}

      <main className="workspace">
        <section className="pane">
          <header>
            <span>源程序</span>
            <span className={`status status-${snap.status}`} data-testid="status" data-status={snap.status}>
              {STATUS_LABEL[snap.status]} · 第 <span data-testid="step-index">{meta.index}</span> / {Math.max(0, meta.length - 1)} 步
              {meta.index < meta.length - 1 && <em className="badge">回溯</em>}
            </span>
          </header>
          <LispEditor source={source} highlight={highlight} onChange={onEdit} />
        </section>

        <section className="side">
          <article className="panel expr">
            <header>
              <span>当前表达式</span>
              {snap.action.startsWith('尾调用') && <em className="badge tail">尾调用</em>}
            </header>
            <p className={snap.action.startsWith('尾调用') ? 'action tail' : 'action'} data-testid="action">
              {snap.action}
            </p>
            <pre data-testid="current-expr">{snap.currentExpr ?? snap.valuePreview ?? '—'}</pre>
            {snap.error && (
              <p className="error" data-testid="error" role="alert">
                {snap.error.text}
              </p>
            )}
          </article>

          <article className="panel stack">
            <header>
              <span>调用栈</span>
              <span>{snap.callStack.length === 0 ? '空' : `深度 ${snap.callStack.length}`}</span>
            </header>
            <ol data-testid="call-stack">
              {snap.callStack.length === 0 && <li className="empty">（空）</li>}
              {[...snap.callStack].reverse().map((frame, index) => (
                <li key={`${frame.envId}-${index}`}>
                  <button type="button" data-testid={`stack-frame-${index}`} onClick={() => setPinnedId(frame.envId)}>
                    {frame.args ? `${frame.name}(${frame.args})` : frame.name}
                  </button>
                </li>
              ))}
            </ol>
          </article>

          <article className="panel env">
            <header>
              <span>环境链 · 由内到外</span>
              {selectedId !== snap.activeEnvId && (
                <button type="button" className="texty" onClick={() => setPinnedId(null)}>
                  跟随当前
                </button>
              )}
            </header>
            <div data-testid="env-chain">
              {chain.length === 0 && <p className="placeholder">（语法错误，尚未建立环境）</p>}
              {chain.map((frame) => {
                const open = frame.id === selectedId;
                return (
                  <div key={frame.id} className="env-frame">
                    <button
                      type="button"
                      className={open ? 'frame open' : 'frame'}
                      data-testid={`env-frame-${frame.id}`}
                      data-env-label={frame.label}
                      onClick={() => setPinnedId(frame.id)}
                    >
                      {frame.label}
                      <span>{frame.bindings.length} 个绑定</span>
                    </button>
                    {open && (
                      <ul className="bindings" data-testid="env-detail">
                        {frame.bindings.length === 0 && <li className="empty">（无绑定）</li>}
                        {frame.bindings.map((binding) => (
                          <li key={binding.name}>
                            <code>{binding.name}</code>
                            <span>= {binding.value}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </article>

          <article className="panel memory-panel">
            <header>
              <span>内存</span>
              <span>累计分配，不回收</span>
            </header>
            <div className="memory" data-testid="memory">
              <span>
                点对 <strong>{snap.memory.pairs}</strong>
              </span>
              <span>
                环境 <strong>{snap.memory.environments}</strong>
              </span>
              <span>
                栈深 <strong>{snap.memory.stackDepth}</strong>
              </span>
              <span>
                最大栈深 <strong>{snap.memory.maxStackDepth}</strong>
              </span>
              <span>
                链深 <strong>{snap.memory.chainDepth}</strong>
              </span>
              <span>
                步数 <strong>{snap.memory.steps}</strong>
              </span>
            </div>
          </article>

          <article className="panel output">
            <header>
              <span>输出</span>
              <span>
                结果 <strong data-testid="result">{snap.results.at(-1) ?? ''}</strong>
              </span>
            </header>
            <pre data-testid="output">{snap.transcript}</pre>
            {snap.transcript === '' && <p className="placeholder">（尚无输出）</p>}
          </article>
        </section>
      </main>

      <footer className="history">
        <span>执行历史</span>
        <input
          data-testid="history-slider"
          type="range"
          min={0}
          max={Math.max(0, meta.length - 1)}
          value={meta.index}
          onChange={(event) => {
            sessionRef.current.goTo(Number(event.target.value));
            publish();
          }}
        />
        <div className="history-list">
          {historyWindow.map((item, offset) => {
            const index = historyStart + offset;
            return (
              <button
                key={`${index}-${item.step}`}
                type="button"
                className={index === meta.index ? 'current' : ''}
                onClick={() => {
                  sessionRef.current.goTo(index);
                  publish();
                }}
              >
                {item.step}. {item.action}
              </button>
            );
          })}
        </div>
      </footer>
    </div>
  );
}

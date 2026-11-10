import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Session } from '../src/lisp/index';

const factorial = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../examples/factorial.scm'), 'utf8');

describe('可视化历史上限', () => {
  it('超过上限后只保留最近 N 步，程序结果仍在', () => {
    const session = new Session(factorial, { maxHistory: 8 });
    const done = session.run();
    expect(done.status).toBe('done');
    expect(done.results.at(-1)).toBe('3628800');
    expect(session.history).toHaveLength(8);
    expect(session.droppedSteps).toBeGreaterThan(0);
    expect(session.history[0]?.step).toBeGreaterThan(0);
    session.goTo(0);
    expect(session.snapshot.step).toBe(session.history[0]?.step);
    session.goTo(session.history.length - 1);
    expect(session.snapshot.results.at(-1)).toBe('3628800');
  });

  it('尾递归死循环在步数上限停止，并丢弃更早的快照', () => {
    const started = Date.now();
    const session = new Session('(define (f) (f)) (f)', { maxHistory: 6, maxTraceSteps: 40 });
    const snap = session.run();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(snap.status).toBe('error');
    expect(snap.error?.kind).toBe('runtime');
    expect(snap.error?.detail).toContain('最大求值步数 40');
    expect(snap.error?.line).toBe(1);
    expect(snap.error?.column).not.toBeNull();
    expect(snap.memory.maxStackDepth).toBe(1);
    expect(session.history).toHaveLength(6);
    expect(session.droppedSteps).toBeGreaterThan(0);
    expect(session.history.every((item) => item.memory.maxStackDepth <= 1)).toBe(true);
  });

  it('非尾失控递归在可视化里也会停住', () => {
    const started = Date.now();
    const session = new Session('(define (g) (+ 1 (g))) (g)', { maxHistory: 5, maxTraceSteps: 80 });
    const snap = session.run();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(snap.status).toBe('error');
    expect(snap.error?.text ?? '').toMatch(/第 \d+ 行, 第 \d+ 列/);
    expect(snap.memory.maxStackDepth).toBeLessThanOrEqual(80);
    expect(session.history.length).toBeLessThanOrEqual(5);
  });
});

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { execute, Session } from '../src/lisp/index';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function runExample(name: string) {
  const source = readFileSync(join(root, 'examples', name), 'utf8');
  const result = execute(source);
  expect(result.ok, result.error?.text ?? name).toBe(true);
  return result;
}

describe('示例程序', () => {
  it('阶乘', () => {
    expect(runExample('factorial.scm').last).toBe('3628800');
    const session = new Session(readFileSync(join(root, 'examples', 'factorial.scm'), 'utf8'));
    const done = session.run(20_000);
    expect(done.status).toBe('done');
    expect(done.memory.maxStackDepth).toBe(11);
  });

  it('斐波那契', () => {
    expect(runExample('fibonacci.scm').last).toBe('55');
  });

  it('列表反转', () => {
    expect(runExample('reverse.scm').last).toBe('(5 4 3 2 1)');
    const session = new Session(readFileSync(join(root, 'examples', 'reverse.scm'), 'utf8'));
    const done = session.run(20_000);
    expect(done.memory.maxStackDepth).toBe(1);
  });

  it('手写 map 与 filter', () => {
    const result = runExample('map-filter.scm');
    expect(result.output).toBe('(1 4 9 16)\n');
    expect(result.last).toBe('(2 4 6)');
  });

  it('闭包', () => {
    const result = runExample('closure.scm');
    expect(result.output).toBe('8\n13\n1\n2\n1\n');
    expect(result.last).toBe('17');
  });

  it('闭包求值结束后仍能看到捕获环境', () => {
    const session = new Session(readFileSync(join(root, 'examples', 'closure.scm'), 'utf8'));
    const done = session.run();
    expect(done.status).toBe('done');
    const has = (label: string, name: string, value: string) =>
      done.frames.some(
        (frame) => frame.label === label && frame.bindings.some((binding) => binding.name === name && binding.value === value),
      );
    expect(has('make-adder', 'n', '5')).toBe(true);
    expect(has('make-adder', 'n', '10')).toBe(true);
    expect(has('let', 'n', '2')).toBe(true);
    expect(has('let', 'n', '1')).toBe(true);
    const global = done.frames.find((frame) => frame.label === '全局');
    const add5 = global?.bindings.find((binding) => binding.name === 'add5');
    const captured = done.frames.find((frame) => frame.id === add5?.capturedEnvId);
    expect(captured?.bindings).toEqual([{ name: 'n', value: '5', capturedEnvId: null }]);
  });
});

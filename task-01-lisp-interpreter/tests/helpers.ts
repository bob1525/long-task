import { expect } from 'vitest';
import { execute, type ExecuteResult } from '../src/lisp/index';

export function expectValue(source: string, expected: string): ExecuteResult {
  const result = execute(source);
  if (!result.ok) {
    throw new Error(result.error?.text ?? '执行失败');
  }
  expect(result.last).toBe(expected);
  return result;
}

export function expectKind(source: string, kind: string): ExecuteResult {
  const result = execute(source);
  expect(result.ok, result.transcript).toBe(false);
  expect(result.error?.kind).toBe(kind);
  expect(result.error?.text ?? '').toMatch(/第 \d+ 行/);
  return result;
}

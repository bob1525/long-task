import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { execute } from '../src/lisp/index';
import { expectKind } from './helpers';

describe('错误种类与位置', () => {
  it('未定义变量指向符号所在列', () => {
    const result = expectKind('(+ y)', 'undefined');
    expect(result.error).toMatchObject({ line: 1, column: 4 });
    expect(result.error?.detail).toContain('y');
  });

  it('后续行的未定义变量保留前面注释造成的行号', () => {
    const result = expectKind('; comment\n; still comment\n(define x 1)\ny', 'undefined');
    expect(result.error?.line).toBe(4);
    expect(result.error?.column).toBe(1);
  });

  it('类型错误带有调用位置', () => {
    const result = expectKind('(car "s")', 'type');
    expect(result.error).toMatchObject({ line: 1, column: 1 });
    expect(result.error?.detail).toContain('字符串');
  });

  it('参数个数错误是运行时错误', () => {
    const result = expectKind('(define (f x) x) (f)', 'runtime');
    expect(result.error?.detail).toContain('期望 1 个参数');
    expect(result.error).toMatchObject({ line: 1, column: 18 });
  });

  it('调用非过程是类型错误', () => {
    const result = expectKind('(1 2)', 'type');
    expect(result.error).toMatchObject({ line: 1, column: 1 });
  });

  it('除以零带有调用位置', () => {
    const result = expectKind('(/ 1 0)', 'runtime');
    expect(result.error?.detail).toContain('除以零');
    expect(result.error).toMatchObject({ line: 1, column: 1 });
  });

  it('未闭合列表的语法错误指向左括号', () => {
    const result = expectKind('(', 'syntax');
    expect(result.error?.detail).toContain('缺少右括号');
    expect(result.error).toMatchObject({ line: 1, column: 1 });
  });

  it('函数体内的除法错误指向定义处，而不是调用处', () => {
    const source = '(define (f x)\n  (/ x 0))\n\n\n(f 1)';
    const result = expectKind(source, 'runtime');
    expect(result.error?.detail).toContain('除以零');
    // 第 5 行的 (f 1) 是一次正常调用。出错的表达式是第 2 行函数体里的 (/ x 0)。
    expect(result.error).toMatchObject({ line: 2, column: 3 });
    expect(result.error?.line).not.toBe(5);
  });

  it('参数个数错误指向调用表达式', () => {
    const result = expectKind('(define (f x)\n  x)\n(f)', 'runtime');
    expect(result.error?.detail).toContain('期望 1 个参数');
    expect(result.error).toMatchObject({ line: 3, column: 1 });
  });

  it('空列表不能当表达式求值', () => {
    const result = expectKind('()', 'syntax');
    expect(result.error?.detail).toContain('空列表');
  });

  it('任何异常输入都返回错误而不是抛出', () => {
    const samples = ['', '   ', '; only comment', '@', '(', ')', "'", '"abc', '(define)', '(lambda)', '(set! 1 2)', '(1)', '(/ 1 0)', '(car)', '(cons 1)', '(define x 1)\nx\ny'];
    for (const source of samples) {
      expect(() => execute(source)).not.toThrow();
    }
    expect(execute('').ok).toBe(true);
    expect(execute('; only comment').ok).toBe(true);
    const symbol = execute('@');
    expect(symbol.ok).toBe(false);
    expect(symbol.error?.kind).toBe('undefined');
    expect(symbol.error?.text ?? '').toContain('第 1 行');
    const backtick = execute('`x');
    expect(backtick.ok).toBe(false);
    expect(backtick.error?.kind).toBe('syntax');
  });
});

describe('错误恢复', () => {
  it('运行时错误后继续执行后续顶层表达式', () => {
    const recovered = execute('(define x 1)\n(car x)\n(+ x 4)', { recover: true });
    expect(recovered.ok).toBe(false);
    expect(recovered.error?.kind).toBe('type');
    expect(recovered.values).toContain('5');
    const stopped = execute('(define x 1)\n(car x)\n(+ x 4)');
    expect(stopped.ok).toBe(false);
    expect(stopped.values).not.toContain('5');
  });

  it('多余右括号不会挡住后面的表达式', () => {
    const result = execute('(define x 1)\n)\n)\n(+ x 2)', { recover: true });
    expect(result.ok).toBe(false);
    expect(result.values).toContain('3');
    expect(result.forms?.filter((form) => !form.ok).length).toBe(2);
  });

  it('出错之后新的执行仍然可用', () => {
    expect(execute('(car 1)').ok).toBe(false);
    expect(execute('(+ 1 1)').last).toBe('2');
  });

  it('测试文件本身没有 skip、only 或 todo', () => {
    const files = [
      ...readdirSync('tests').filter((name) => name.endsWith('.ts')).map((name) => `tests/${name}`),
      ...readdirSync('e2e').filter((name) => name.endsWith('.ts')).map((name) => `e2e/${name}`),
    ];
    expect(files.length).toBeGreaterThan(0);
    const flags = ['skip', 'only', 'todo'];
    const names = ['it', 'describe', 'test'];
    const forbidden = [
      ...names.flatMap((name) => flags.map((flag) => `${name}.${flag}`)),
      `${'x'}it(`,
      `${'x'}describe(`,
    ];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const phrase of forbidden) {
        expect(text.includes(phrase), `${file} contains ${phrase}`).toBe(false);
      }
    }
  });
});

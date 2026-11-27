import { describe, expect, it } from 'vitest';
import { MAX_CALL_STACK, execute } from '../src/lisp/index';
import { expectValue } from './helpers';

describe('边界', () => {
  it('空字符串、列表内部注释和跨行字符串', () => {
    expectValue('""', '""');
    expectValue('(+\n  ; ignore me\n  1\n  2)', '3');
    const multiline = execute('\"a\nb\"');
    expect(multiline.ok, multiline.error?.text).toBe(true);
    expect(multiline.last).toBe('"a\\nb"');
  });

  it('let 可以遮蔽内置过程', () => {
    expectValue('(let ((+ (lambda (x) (* x x)))) (+ 4))', '16');
  });

  it('可以 set! 形参', () => {
    expectValue('(define (f x) (set! x 1) x) (f 0)', '1');
  });

  it('空程序和只有注释的程序成功结束', () => {
    expect(execute('').last).toBeNull();
    expect(execute('   \n; hi\n').ok).toBe(true);
  });

  it('引用空列表，求值空列表则失败', () => {
    expectValue("'()", '()');
    expectValue('(null? (list))', '#t');
    expectValue('(list? \'())', '#t');
    expect(execute('()').ok).toBe(false);
    expect(execute('(null? ())').ok).toBe(false);
  });

  it('深层嵌套加法不会撑爆宿主调用栈', () => {
    let source = '0';
    for (let count = 0; count < 2000; count += 1) source = `(+ 1 ${source})`;
    const result = execute(source);
    expect(result.ok, result.error?.text).toBe(true);
    expect(result.last).toBe('2000');
  });

  it('循环列表可以被识别，比较和打印都会结束', () => {
    const listed = execute('(define p (cons 1 \'())) (set-cdr! p p) (list? p)');
    expect(listed.ok).toBe(true);
    expect(listed.last).toBe('#f');
    const same = execute('(define p (cons 1 2)) (set-cdr! p p) (equal? p p)');
    expect(same.ok).toBe(true);
    expect(same.last).toBe('#t');
    const printed = execute('(define p (cons 1 2)) (set-cdr! p p) (display p) 0');
    expect(printed.ok).toBe(true);
    expect(printed.output).toContain('#<cycle>');
    const length = execute('(define p (cons 1 \'())) (set-cdr! p p) (length p)');
    expect(length.ok).toBe(false);
    expect(length.error?.kind).toBe('runtime');
  });

  it('非尾递归会让调用栈随深度增长', () => {
    const source = '(define (d n) (if (= n 0) 0 (+ 1 (d (- n 1)))))';
    const shallow = execute(`${source} (d 1)`);
    const deep = execute(`${source} (d 400)`);
    expect(shallow.ok).toBe(true);
    expect(deep.ok).toBe(true);
    expect(deep.last).toBe('400');
    expect(deep.maxCallStack).toBeGreaterThanOrEqual(400);
    expect(deep.maxCallStack).toBeGreaterThan(shallow.maxCallStack);
  });

  it('简单尾递归 100000 次不会栈溢出', { timeout: 120_000 }, () => {
    const result = execute(
      `(define (sum n acc)
         (if (= n 0)
             acc
             (sum (- n 1) (+ acc n))))
       (sum 100000 0)`,
    );
    expect(result.ok, result.error?.text).toBe(true);
    expect(result.last).toBe('5000050000');
    expect(result.maxCallStack).toBe(1);
  });

  it('begin、let 和 cond 里的尾调用同样复用栈帧', () => {
    const result = execute(
      `(define (f n)
         (begin
           0
           (let ((m (- n 1)))
             (cond
               ((= n 0) 0)
               (else (f m))))))
       (f 5000)`,
    );
    expect(result.ok, result.error?.text).toBe(true);
    expect(result.last).toBe('0');
    expect(result.maxCallStack).toBe(1);
  });

  it('无限尾递归会停在步数上限，并且栈深仍是 1', () => {
    const result = execute('(define (f) (f)) (f)', { maxSteps: 2_000 });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('runtime');
    expect(result.error?.detail).toContain('最大求值步数');
    expect(result.maxCallStack).toBe(1);
  });

  it('尾递归死循环的步数错误指向循环调用', () => {
    const started = Date.now();
    const result = execute('(define (f)\n  (f))\n(f)', { maxSteps: 2_000 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('runtime');
    expect(result.error?.detail).toContain('最大求值步数');
    expect(result.error).toMatchObject({ line: 2, column: 3 });
    expect(result.maxCallStack).toBe(1);
  });

  it('非尾失控递归在栈深上限处停止，并指向递归调用', () => {
    const started = Date.now();
    const result = execute('(define (g)\n  (+ 1 (g)))\n(g)');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('runtime');
    expect(result.error?.detail).toContain(`非尾调用栈深度超过上限 ${MAX_CALL_STACK}`);
    expect(result.error).toMatchObject({ line: 2, column: 8 });
    expect(result.maxCallStack).toBe(MAX_CALL_STACK);
  });
});

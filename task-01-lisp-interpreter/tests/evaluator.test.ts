import { describe, expect, it } from 'vitest';
import { execute, Session } from '../src/lisp/index';
import { expectKind, expectValue } from './helpers';

describe('特殊形式', () => {
  it('define 变量并允许重新定义', () => {
    expectValue('(define x 1) (define x (+ x 2)) x', '3');
  });

  it('define 过程糖与 lambda 等价', () => {
    expectValue('(define (f x) (* x x)) (f 6)', '36');
    expectValue('(define g (lambda (x) (* x x))) (g 6)', '36');
  });

  it('立即调用 lambda', () => {
    expectValue('((lambda (x) (+ x 1)) 4)', '5');
  });

  it('if 只把 #f 当假，缺少 else 时返回未指定值', () => {
    expectValue('(if #f 1 2)', '2');
    expectValue('(if 0 1 2)', '1');
    expectValue("(if '() 1 2)", '1');
    const missing = execute('(if #f 1)');
    expect(missing.ok).toBe(true);
    expect(missing.last).toBeNull();
  });

  it('cond 支持 else、短路和只含测试的子句', () => {
    expectValue("(cond (#f 'no) (#f 'nope) (else 'yes))", 'yes');
    expectValue('(cond ((+ 2 3)))', '5');
    expectValue('(cond (#f 1) (0 2))', '2');
    const none = execute('(cond (#f 1))');
    expect(none.ok).toBe(true);
    expect(none.last).toBeNull();
  });

  it('let 并行绑定，let* 顺序绑定', () => {
    expectValue('(define a 10) (let ((a 1) (b a)) b)', '10');
    expectValue('(define a 10) (let* ((a 1) (b a)) b)', '1');
    expectValue('(let* ((a 1) (a (+ a 4))) a)', '5');
    expectValue('(let () 7)', '7');
  });

  it('begin 返回最后一个值并保留副作用', () => {
    expectValue('(define x 1) (begin (set! x 2) (set! x (+ x 3)) x)', '5');
    expectValue('(begin 1 2 3)', '3');
  });

  it('quote 不求值其参数', () => {
    expectValue("'a", 'a');
    expectValue("'(+ 1 2)", '(+ 1 2)');
    expectValue("''a", "'a");
    expectValue("'(1 . 2)", '(1 . 2)');
  });

  it('set! 修改词法绑定，未定义变量报错', () => {
    expectValue('(define x 1) (set! x 4) x', '4');
    expectValue('(define x 1) (let ((x 2)) (set! x 3) x)', '3');
    expectValue('(define x 1) (let ((x 2)) (set! x 3)) x', '1');
    expectKind('(set! missing 1)', 'undefined');
  });

  it('函数名形式的 define 会给过程命名', () => {
    const result = execute('(define (fact n) n) fact');
    expect(result.ok).toBe(true);
    expect(result.last).toBe('#<procedure fact>');
  });
});

describe('作用域与高阶函数', () => {
  it('使用词法作用域而不是动态作用域', () => {
    expectValue('(define x 1) (define (f) x) (let ((x 99)) (f))', '1');
  });

  it('闭包捕获定义时的环境，互不干扰', () => {
    expectValue(
      `(define (make n)
         (lambda (x) (+ x n)))
       (define add5 (make 5))
       (define add10 (make 10))
       (+ (add5 1) (add10 1))`,
      '17',
    );
  });

  it('计数器闭包里的 set! 只影响自己的环境', () => {
    const result = execute(
      `(define (make)
         (let ((n 0))
           (lambda () (set! n (+ n 1)) n)))
       (define a (make))
       (define b (make))
       (a)
       (a)
       (b)`,
    );
    expect(result.ok).toBe(true);
    expect(result.values).toEqual(['1', '2', '1']);
  });

  it('可以把过程当参数传递', () => {
    expectValue('(define (apply1 f x) (f x)) (apply1 (lambda (n) (* n n)) 5)', '25');
  });

  it('过程体内按顺序 define，相互递归可用', () => {
    expectValue(
      `(define (check n)
         (define (even? k) (if (= k 0) #t (odd? (- k 1))))
         (define (odd? k) (if (= k 0) #f (even? (- k 1))))
         (even? n))
       (check 6)`,
      '#t',
    );
  });

  it('特殊形式关键字在组合子位置不被局部变量遮蔽', () => {
    expectValue('(let ((if 1)) if)', '1');
    expectValue('(let ((if 1)) (if #f 2 3))', '3');
  });

  it('支持 rest 参数', () => {
    expectValue('(define (f a . rest) (cons a rest)) (f 1 2 3)', '(1 2 3)');
    expectValue('((lambda xs xs) 4 5)', '(4 5)');
  });

  it('let 重复绑定、命名 let、错误 define 都是语法错误', () => {
    expectKind('(let ((a 1) (a 2)) a)', 'syntax');
    expectKind('(let loop ((a 1)) a)', 'syntax');
    expectKind('(define)', 'syntax');
    expectKind('(define (1) 1)', 'syntax');
    expectKind('(lambda (x))', 'syntax');
    expectKind('(if 1)', 'syntax');
    expectKind('(cond else)', 'syntax');
    expectKind('(cond (else))', 'syntax');
    expectKind('(cond (else 1) (#t 2))', 'syntax');
  });
});

describe('步进器历史', () => {
  it('尾递归步进时调用栈深度保持为 1，并且可以回溯', () => {
    const session = new Session('(define (f n) (if (= n 0) 0 (f (- n 1)))) (f 3)');
    const done = session.run(100_000);
    expect(done.status).toBe('done');
    expect(done.results.at(-1)).toBe('0');
    expect(session.history.some((snap) => snap.action.startsWith('尾调用'))).toBe(true);
    expect(Math.max(...session.history.map((snap) => snap.memory.stackDepth))).toBe(1);
    const middle = Math.floor(session.history.length / 2);
    session.goTo(middle);
    expect(session.cursor).toBe(middle);
    expect(session.snapshot.step).toBe(session.history[middle]!.step);
    session.stepBack();
    expect(session.cursor).toBe(middle - 1);
    session.goTo(0);
    expect(session.snapshot.status).toBe('ready');
  });
});

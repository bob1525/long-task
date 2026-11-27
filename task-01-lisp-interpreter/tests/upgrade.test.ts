import { describe, expect, it } from 'vitest';
import { execute, parseProgram, printSExpr, Session } from '../src/lisp/index';
import { expectKind, expectValue } from './helpers';

describe('可变参数', () => {
  it('lambda 的单个符号接收全部参数', () => {
    expectValue('((lambda args args))', '()');
    expectValue('((lambda args args) 1 2 3)', '(1 2 3)');
  });

  it('点号剩余参数保留固定参数和剩余列表', () => {
    expectValue('((lambda (a b . rest) (list a b rest)) 1 2 3 4)', '(1 2 (3 4))');
    expectValue('((lambda (a b . rest) rest) 1 2)', '()');
  });

  it('剩余参数不够时报出带位置的错误', () => {
    const result = expectKind('((lambda (a . rest) a))', 'runtime');
    expect(result.error).toMatchObject({ line: 1, column: 1 });
    expect(result.error?.detail).toContain('至少 1');
  });

  it('重复的剩余参数名是语法错误', () => {
    const result = expectKind('(lambda (a . a) a)', 'syntax');
    expect(result.error?.detail).toContain('重复');
  });
});

describe('命名 let 与 do', () => {
  it('命名 let 在外层环境求初始值', () => {
    expectValue(
      '(let ((n 3)) (let loop ((i n) (acc 0)) (if (= i 0) acc (loop (- i 1) (+ acc i)))))',
      '6',
    );
  });

  it('没有绑定的命名 let 直接进入函数体', () => {
    expectValue('(let loop () 1)', '1');
  });

  it('命名 let 十万次循环保持尾调用', () => {
    const result = execute(`(let loop ((i 100000) (acc 0))
  (if (= i 0) acc (loop (- i 1) (+ acc 1))))`);
    expect(result.ok, result.error?.text).toBe(true);
    expect(result.last).toBe('100000');
    expect(result.maxCallStack).toBe(1);
  }, 120_000);

  it('残缺的命名 let 和命名 let* 是语法错误', () => {
    expect(expectKind('(let loop 1)', 'syntax').error?.detail).toContain('命名 let');
    expect(expectKind('(let* loop ((a 1)) a)', 'syntax').error?.detail).toContain('let*');
  });

  it('do 累加并在测试成立时返回结果', () => {
    expectValue('(do ((i 0 (+ i 1)) (s 0 (+ s i))) ((= i 5) s))', '10');
  });

  it('do 的步进同时赋值', () => {
    expectValue('(do ((n 0 (+ n 1)) (a 1 2) (b 10 a)) ((= n 1) (list a b)))', '(2 1)');
  });

  it('do 没有结果表达式时返回未指定值', () => {
    const result = execute('(do ((i 0 (+ i 1))) ((= i 1)))');
    expect(result.ok, result.error?.text).toBe(true);
    expect(result.last).toBeNull();
  });

  it('do 的变量可以叫 do-loop', () => {
    expectValue('(do ((do-loop 0 (+ do-loop 1))) ((= do-loop 3) do-loop))', '3');
  });

  it('do 的递归保持尾调用', () => {
    const result = execute('(do ((i 0 (+ i 1))) ((= i 1000) i))');
    expect(result.ok, result.error?.text).toBe(true);
    expect(result.last).toBe('1000');
    expect(result.maxCallStack).toBe(1);
  });

  it('do 的绑定和测试写错时带位置', () => {
    expect(expectKind('(do ((i)) (#t i))', 'syntax').error).toMatchObject({ line: 1, column: 6 });
    expect(expectKind('(do i (#t 1))', 'syntax').error?.detail).toContain('绑定');
  });
});

describe('准引用', () => {
  it('反引号读成 quasiquote', () => {
    expect(printSExpr(parseProgram('`x')[0]!)).toBe('`x');
    expect(printSExpr(parseProgram('`x')[0]!)).toBe(printSExpr(parseProgram('(quasiquote x)')[0]!));
    expect(printSExpr(parseProgram('`(a ,b ,@c)')[0]!)).toBe('`(a ,b ,@c)');
  });

  it('不求值的准引用保持字面量', () => {
    expectValue('`x', 'x');
    expectValue('`(a b)', '(a b)');
  });

  it('unquote 插入求值结果', () => {
    expectValue('`(a ,(+ 1 2) c)', '(a 3 c)');
  });

  it('unquote-splicing 展开真列表', () => {
    expectValue('`(a ,@(list 1 2) b)', '(a 1 2 b)');
    expectValue('`(,@\'(1 2) ,@\'(3))', '(1 2 3)');
    expectValue('`(a ,@\'() b)', '(a b)');
  });

  it('嵌套准引用只展开最外层的 unquote', () => {
    expectValue('`(a `(b ,(+ 1 2) ,(foo ,(+ 1 3)) d) e)', '(a `(b ,(+ 1 2) ,(foo 4) d) e)');
  });

  it('准引用不调用被遮蔽的 cons', () => {
    expectValue('(let ((cons \'no) (append \'no)) `(a ,(+ 2 3)))', '(a 5)');
  });

  it('注释里的反引号不会打断程序', () => {
    expectValue('; `\n(+ 1 1)', '2');
  });

  it('字符串里的逗号保持为字符', () => {
    expectValue('(string-length "`,")', '2');
  });

  it('准引用用错位置时报带位置的错误', () => {
    const outside = expectKind(',x', 'syntax');
    expect(outside.error).toMatchObject({ line: 1, column: 1 });
    expect(outside.error?.detail).toContain('准引用');
    expect(expectKind(',@x', 'syntax').error?.detail).toContain('unquote-splicing');
    expect(expectKind('`,@\'(1)', 'syntax').error?.detail).toContain('不能独立出现');
    const bad = expectKind('`(,@1)', 'runtime');
    expect(bad.error).toMatchObject({ line: 1 });
    expect(bad.error?.detail).toContain('真列表');
  });
});

describe('and 与 or', () => {
  it('and 和 or 返回最后一个需要的值', () => {
    expectValue('(and)', '#t');
    expectValue('(or)', '#f');
    expectValue('(and 1 2 3)', '3');
    expectValue('(or #f #f 4)', '4');
    expectValue('(and 0 5)', '5');
  });

  it('and 和 or 短路，不求值后面的表达式', () => {
    expectValue('(and #f (/ 1 0))', '#f');
    expectValue('(or 1 (/ 1 0))', '1');
  });

  it('and 和 or 在运算符位置不被局部变量遮蔽', () => {
    expectValue('(let ((and #f)) (and #f 2))', '#f');
    expectValue('(let ((or 1)) (or #f 2))', '2');
  });

  it('and 的最后一个参数处于尾位置', () => {
    const result = execute('(define (f n) (and (> n 0) (f (- n 1)))) (f 100000)');
    expect(result.ok, result.error?.text).toBe(true);
    expect(result.last).toBe('#f');
    expect(result.maxCallStack).toBe(1);
  }, 120_000);

  it('or 的最后一个参数处于尾位置', () => {
    const result = execute('(define (g n) (or (= n 0) (g (- n 1)))) (g 100000)');
    expect(result.ok, result.error?.text).toBe(true);
    expect(result.last).toBe('#t');
    expect(result.maxCallStack).toBe(1);
  }, 120_000);
});

describe('字符串、列表和 apply', () => {
  it('拼接、截取并换算字符串', () => {
    expectValue('(string-append)', '""');
    expectValue('(string-append "a" "b" "c")', '"abc"');
    expectValue('(string-length "abc")', '3');
    expectValue('(substring "hello" 1 4)', '"ell"');
    expectValue('(string->symbol "foo")', 'foo');
    expectValue('(eq? (string->symbol "foo") \'foo)', '#t');
    expectValue('(symbol->string \'bar)', '"bar"');
    expectValue('(number->string 42)', '"42"');
    expectValue('(string->symbol (symbol->string \'bar))', 'bar');
  });

  it('按下标取列表、查找关联表和成员', () => {
    expectValue('(list-ref \'(a b c) 1)', 'b');
    expectValue('(list-ref \'(a b c) 0)', 'a');
    expectValue('(assoc \'b \'((a . 1) (b . 2)))', '(b . 2)');
    expectValue('(assoc \'z \'((a 1)))', '#f');
    expectValue('(assoc \'(1) \'(((1) . a) ((2) . b)))', '((1) . a)');
    expectValue('(member 2 \'(1 2 3))', '(2 3)');
    expectValue('(member \'(b) \'((a) (b) (c)))', '((b) (c))');
    expectValue('(member 9 \'(1 2 3))', '#f');
    expectValue('(length \'(1 2))', '2');
    expectValue('(append \'(1) \'(2 3))', '(1 2 3)');
  });

  it('apply 展开参数列表', () => {
    expectValue('(apply + \'(1 2 3))', '6');
    expectValue('(apply list \'x \'y \'(z))', '(x y z)');
    expectValue('(apply cons \'(1 2))', '(1 . 2)');
  });

  it('尾位置的 apply 不增长调用栈', () => {
    const result = execute(`(define (sum n acc)
  (if (= n 0) acc (apply sum (list (- n 1) (+ acc n)))))
(sum 3000 0)`);
    expect(result.ok, result.error?.text).toBe(true);
    expect(result.last).toBe('4501500');
    expect(result.maxCallStack).toBe(1);
  });

  it('字符串函数的错误参数带位置', () => {
    expect(expectKind('(string-length 1)', 'type').error).toMatchObject({ line: 1, column: 1 });
    expect(expectKind('(string-append "a" 1)', 'type').error?.detail).toContain('字符串');
    expect(expectKind('(substring "ab" 1 0)', 'runtime').error?.detail).toContain('范围');
    expect(expectKind('(substring "ab" 1.5 2)', 'type').error?.detail).toContain('整数');
    expect(expectKind('(symbol->string "a")', 'type').error).toMatchObject({ line: 1, column: 1 });
    expect(expectKind('(number->string \'a)', 'type').error?.detail).toContain('数字');
  });

  it('列表函数和 apply 的错误参数带位置', () => {
    expect(expectKind('(list-ref \'(a) 3)', 'runtime').error).toMatchObject({ line: 1, column: 1 });
    expect(expectKind('(list-ref \'(a) -1)', 'runtime').error?.detail).toContain('负数');
    expect(expectKind('(assoc 1 2)', 'type').error?.detail).toContain('真列表');
    expect(expectKind('(member 1 2)', 'type').error).toMatchObject({ line: 1, column: 1 });
    expect(expectKind('(length 1)', 'type').error).toMatchObject({ line: 1, column: 1 });
    expect(expectKind('(append 1 \'())', 'type').error?.detail).toContain('真列表');
    expect(expectKind('(apply + 1)', 'runtime').error?.detail).toContain('真列表');
    expect(expectKind('(apply 1 \'())', 'type').error?.detail).toContain('过程');
    expect(expectKind('(apply +)', 'runtime').error?.detail).toContain('至少 2');
  });
});

describe('回溯', () => {
  it('后退 200 步恢复调用栈、环境和当前表达式', () => {
    const session = new Session('(define (f n) (if (= n 0) 0 (+ 1 (f (- n 1))))) (f 40)');
    let guard = 0;
    while (guard < 80 && !session.snapshot.callStack.some((frame) => frame.name === 'f')) {
      session.stepForward();
      guard += 1;
    }
    expect(session.snapshot.callStack.some((frame) => frame.name === 'f')).toBe(true);
    const index = session.cursor;
    const expr = session.snapshot.currentExpr;
    const stack = session.snapshot.callStack.map((frame) => `${frame.name}:${frame.args}`);
    const envId = session.snapshot.activeEnvId;
    const bindings = JSON.stringify(session.snapshot.frames.find((frame) => frame.id === envId)?.bindings ?? null);
    for (let step = 0; step < 200; step += 1) session.stepForward();
    expect(session.cursor).toBe(index + 200);
    expect(session.snapshot.status).not.toBe('error');
    for (let step = 0; step < 200; step += 1) session.stepBack();
    expect(session.cursor).toBe(index);
    expect(session.snapshot.currentExpr).toBe(expr);
    expect(session.snapshot.callStack.map((frame) => `${frame.name}:${frame.args}`)).toEqual(stack);
    const restored = JSON.stringify(
      session.snapshot.frames.find((frame) => frame.id === session.snapshot.activeEnvId)?.bindings ?? null,
    );
    expect(restored).toBe(bindings);
    expect(session.history.length).toBeGreaterThan(index + 200);
  });
});

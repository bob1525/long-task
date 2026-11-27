import { describe, expect, it } from 'vitest';
import { execute } from '../src/lisp/index';
import { expectKind, expectValue } from './helpers';

describe('算术与比较', () => {
  it('加减乘除与一元负号', () => {
    expectValue('(+)', '0');
    expectValue('(+ 1 2 3)', '6');
    expectValue('(*)', '1');
    expectValue('(* 2 3 4)', '24');
    expectValue('(- 5)', '-5');
    expectValue('(- 5 2 1)', '2');
    expectValue('(/ 8 2)', '4');
    expectValue('(/ 1 2)', '0.5');
    expectValue('(/ 2)', '0.5');
  });

  it('abs、modulo 与 remainder 遵循 Scheme 的取整方向', () => {
    expectValue('(abs -4)', '4');
    expectValue('(modulo 7 3)', '1');
    expectValue('(modulo -7 3)', '2');
    expectValue('(remainder -7 3)', '-1');
    expectValue('(remainder 7 3)', '1');
  });

  it('链式比较', () => {
    expectValue('(= 1 1 1)', '#t');
    expectValue('(= 1 2 1)', '#f');
    expectValue('(< 1 2 3)', '#t');
    expectValue('(< 1 3 2)', '#f');
    expectValue('(<= 1 1 2)', '#t');
    expectValue('(> 3 2 1)', '#t');
    expectValue('(>= 3 3)', '#t');
  });

  it('除以零和类型不匹配会失败', () => {
    expectKind('(/ 1 0)', 'runtime');
    expectKind('(modulo 1 0)', 'runtime');
    expectKind("(+ 1 'a)", 'type');
    expectKind('(= 1)', 'runtime');
  });
});

describe('列表、类型与相等', () => {
  it('cons、car、cdr、list', () => {
    expectValue("(cons 1 '())", '(1)');
    expectValue('(cons 1 2)', '(1 . 2)');
    expectValue("(car '(1 2))", '1');
    expectValue("(cdr '(1 2))", '(2)');
    expectValue('(list)', '()');
    expectValue('(list 1 2 3)', '(1 2 3)');
  });

  it('null?、pair?、list?、length、append', () => {
    expectValue("(null? '())", '#t');
    expectValue("(null? '(1))", '#f');
    expectValue("(pair? '())", '#f');
    expectValue("(pair? '(1))", '#t');
    expectValue("(list? '())", '#t');
    expectValue("(list? '(1 2))", '#t');
    expectValue("(list? '(1 . 2))", '#f');
    expectValue("(length '())", '0');
    expectValue("(length '(a b c))", '3');
    expectValue("(append)", '()');
    expectValue("(append '(1 2) '(3) '(4))", '(1 2 3 4)');
    expectValue("(append '(1 2) 3)", '(1 2 . 3)');
  });

  it('类型谓词', () => {
    expectValue('(number? 1)', '#t');
    expectValue("(number? 'a)", '#f');
    expectValue('(boolean? #f)', '#t');
    expectValue('(boolean? 0)', '#f');
    expectValue('(string? "a")', '#t');
    expectValue("(symbol? 'a)", '#t');
    expectValue('(procedure? car)', '#t');
    expectValue('(procedure? (lambda () 1))', '#t');
    expectValue('(procedure? 1)', '#f');
  });

  it('eq? 与 equal?', () => {
    expectValue("(eq? 'a 'a)", '#t');
    expectValue('(eq? 1 1)', '#t');
    expectValue('(define p (cons 1 2)) (eq? p p)', '#t');
    expectValue('(eq? (cons 1 2) (cons 1 2))', '#f');
    expectValue("(equal? '(1 2) (list 1 2))", '#t');
    expectValue('(equal? "ab" "ab")', '#t');
    expectValue("(equal? '(1 . 2) (cons 1 2))", '#t');
    expectValue('(equal? 1 2)', '#f');
  });

  it('not 只把 #f 变成 #t', () => {
    expectValue('(not #f)', '#t');
    expectValue('(not #t)', '#f');
    expectValue('(not 0)', '#f');
    expectValue("(not '())", '#f');
  });

  it('set-car! 与 set-cdr! 就地修改', () => {
    expectValue('(define p (cons 1 2)) (set-car! p 9) (car p)', '9');
    expectValue('(define p (cons 1 2)) (set-cdr! p \'(3)) p', '(1 3)');
  });

  it('car/cdr 拒绝非点对，length 拒绝非真列表', () => {
    expectKind('(car 1)', 'type');
    expectKind("(cdr '())", 'type');
    expectKind("(length '(1 . 2))", 'type');
    expectKind('(car)', 'runtime');
    expectKind('(cons 1)', 'runtime');
  });
});

describe('输出', () => {
  it('display、write 与 newline 写入输出而不是返回值', () => {
    const result = execute('(display "a b") (display 1) (newline) (write "a b") 9');
    expect(result.ok).toBe(true);
    expect(result.output).toBe('a b1\n"a b"');
    expect(result.last).toBe('9');
    expect(result.transcript).toContain('=> 9');
  });

  it('字符串里的换行只在 display 时原样输出', () => {
    const result = execute(String.raw`(display "a\nb") "a\nb"`);
    expect(result.output).toBe('a\nb');
    expect(result.last).toBe('"a\\nb"');
  });
});

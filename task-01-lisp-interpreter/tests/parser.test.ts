import { describe, expect, it } from 'vitest';
import { lex, parseProgram } from '../src/lisp/index';
import { LispError } from '../src/lisp/error';
import { printSExpr } from '../src/lisp/print';

describe('词法分析', () => {
  it('识别整数、负数、小数和符号运算符', () => {
    const { tokens } = lex('(+ -12 3.5)');
    expect(tokens.map((token) => token.kind)).toEqual(['lparen', 'symbol', 'number', 'number', 'rparen']);
    expect(tokens[1]).toMatchObject({ value: '+', span: { start: { line: 1, column: 2 } } });
    expect(tokens[2]).toMatchObject({ value: -12, span: { start: { line: 1, column: 4 } } });
    expect(tokens[3]).toMatchObject({ value: 3.5 });
  });

  it('把单独的 + 和 - 当作符号，而不是数字', () => {
    const { tokens } = lex('(+ -)');
    expect(tokens.map((token) => (token.kind === 'symbol' ? token.value : token.kind))).toEqual([
      'lparen',
      '+',
      '-',
      'rparen',
    ]);
  });

  it('识别布尔字面量的大小写变体', () => {
    const { tokens } = lex('#t #f #TRUE #False');
    expect(tokens.map((token) => (token.kind === 'boolean' ? token.value : null))).toEqual([true, false, true, false]);
  });

  it('解析字符串转义', () => {
    const { tokens } = lex(String.raw`"a\n\"\\"`);
    expect(tokens[0]).toMatchObject({ kind: 'string', value: 'a\n"\\' });
  });

  it('记录跨行 token 的行列', () => {
    const { tokens } = lex('(define x\n  1)');
    const one = tokens.find((token) => token.kind === 'number');
    expect(one?.span.start).toMatchObject({ line: 2, column: 3 });
  });

  it('拒绝非法数字并带上列号', () => {
    expect(() => lex('1.2.3')).toThrow(LispError);
    try {
      lex('1.2.3');
    } catch (error) {
      expect(error).toBeInstanceOf(LispError);
      expect((error as LispError).kind).toBe('syntax');
      expect((error as LispError).message).toContain('第 1 行');
      expect((error as LispError).message).toContain('第 1 列');
    }
  });
});

describe('解析器', () => {
  it('解析空列表', () => {
    expect(printSExpr(parseProgram('()')[0]!)).toBe('()');
  });

  it('解析嵌套真列表', () => {
    expect(printSExpr(parseProgram('(a (b c) d)')[0]!)).toBe('(a (b c) d)');
  });

  it('解析点对', () => {
    expect(printSExpr(parseProgram('(1 . 2)')[0]!)).toBe('(1 . 2)');
    expect(printSExpr(parseProgram('(1 2 . 3)')[0]!)).toBe('(1 2 . 3)');
  });

  it("把 'expr 读成 (quote expr)", () => {
    expect(printSExpr(parseProgram("'a")[0]!)).toBe(printSExpr(parseProgram('(quote a)')[0]!));
    expect(printSExpr(parseProgram("'(a b)")[0]!)).toBe("'(a b)");
    expect(printSExpr(parseProgram("''x")[0]!)).toBe("''x");
  });

  it('忽略行注释，包括括号和分号', () => {
    const forms = parseProgram('; comment with (parens)\n(+ 1 2) ; trailing\n');
    expect(forms).toHaveLength(1);
    expect(printSExpr(forms[0]!)).toBe('(+ 1 2)');
  });

  it('不把字符串里的分号当成注释', () => {
    expect(printSExpr(parseProgram('"; not comment"')[0]!)).toBe('"; not comment"');
  });

  it('一次读出多个顶层表达式', () => {
    const forms = parseProgram('(define x 1)\n\nx');
    expect(forms.map((form) => printSExpr(form))).toEqual(['(define x 1)', 'x']);
  });

  it('多余右括号给出第 2 行第 4 列', () => {
    expect(() => parseProgram('\n   )')).toThrow(LispError);
    try {
      parseProgram('\n   )');
    } catch (error) {
      expect((error as LispError).message).toContain('多余的右括号');
      expect((error as LispError).span?.start).toMatchObject({ line: 2, column: 4 });
    }
  });

  it('未闭合列表指向左括号', () => {
    try {
      parseProgram('(define x 1');
      expect.unreachable();
    } catch (error) {
      expect((error as LispError).message).toContain('列表未闭合');
      expect((error as LispError).span?.start).toMatchObject({ line: 1, column: 1 });
    }
  });

  it('未闭合字符串给出位置', () => {
    try {
      parseProgram('\n"abc');
      expect.unreachable();
    } catch (error) {
      expect((error as LispError).message).toContain('结束引号');
      expect((error as LispError).span?.start.line).toBe(2);
    }
  });

  it('拒绝悬空引号、错误点对和准引用', () => {
    expect(() => parseProgram("'")).toThrow(/引号后缺少表达式/);
    expect(() => parseProgram('(. 1)')).toThrow(/点号前缺少表达式/);
    expect(() => parseProgram('(1 . )')).toThrow(/点号后缺少表达式/);
    expect(() => parseProgram('(1 . 2 3)')).toThrow(/点号后只能有一个表达式/);
    expect(() => parseProgram('`x')).toThrow(/准引用/);
  });

  it('解析 4000 层嵌套列表', () => {
    let source = '1';
    for (let depth = 0; depth < 4000; depth += 1) source = `(${source})`;
    const [form] = parseProgram(source);
    expect(form).toBeTruthy();
    let node = form!;
    let depth = 0;
    while (node.t === 'pair') {
      depth += 1;
      node = node.car;
    }
    expect(depth).toBe(4000);
    expect(node).toMatchObject({ t: 'num', v: 1 });
  });
});

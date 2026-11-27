import type { Value } from './types';

export const TRUE: Value = { kind: 'boolean', value: true };
export const FALSE: Value = { kind: 'boolean', value: false };
export const NIL: Value = { kind: 'nil' };
export const VOID: Value = { kind: 'void' };

export function isTruthy(value: Value): boolean {
  return !(value.kind === 'boolean' && value.value === false);
}

export function typeName(value: Value): string {
  switch (value.kind) {
    case 'number':
      return '数字';
    case 'boolean':
      return '布尔值';
    case 'string':
      return '字符串';
    case 'symbol':
      return '符号';
    case 'nil':
      return '空列表';
    case 'pair':
      return '点对';
    case 'procedure':
      return '过程';
    case 'builtin':
      return '内置过程';
    case 'void':
      return '未指定值';
    default: {
      const neverValue: never = value;
      return String(neverValue);
    }
  }
}

export function isProperList(value: Value): boolean {
  const seen = new Set<number>();
  let current = value;
  while (current.kind === 'pair') {
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    current = current.cdr;
  }
  return current.kind === 'nil';
}

function sameNumber(left: number, right: number): boolean {
  return left === right;
}

export function valuesEq(left: Value, right: Value): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'number':
      return sameNumber(left.value, (right as typeof left).value);
    case 'boolean':
      return left.value === (right as typeof left).value;
    case 'string':
      return left.value === (right as typeof left).value;
    case 'symbol':
      return left.name === (right as typeof left).name;
    case 'nil':
    case 'void':
      return true;
    case 'pair':
      return left.id === (right as typeof left).id;
    case 'procedure':
      return left.id === (right as typeof left).id;
    case 'builtin':
      return left.name === (right as typeof left).name;
    default: {
      const neverValue: never = left;
      return neverValue;
    }
  }
}

export function valuesEqual(left: Value, right: Value): boolean {
  const stack: Array<[Value, Value]> = [[left, right]];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const pair = stack.pop();
    if (!pair) break;
    const [x, y] = pair;
    if (x.kind !== y.kind) return false;
    switch (x.kind) {
      case 'number':
        if (!sameNumber(x.value, (y as typeof x).value)) return false;
        break;
      case 'boolean':
        if (x.value !== (y as typeof x).value) return false;
        break;
      case 'string':
        if (x.value !== (y as typeof x).value) return false;
        break;
      case 'symbol':
        if (x.name !== (y as typeof x).name) return false;
        break;
      case 'builtin':
        if (x.name !== (y as typeof x).name) return false;
        break;
      case 'procedure':
        if (x.id !== (y as typeof x).id) return false;
        break;
      case 'nil':
      case 'void':
        break;
      case 'pair': {
        const other = y as typeof x;
        const key = `${x.id},${other.id}`;
        if (seen.has(key)) break;
        seen.add(key);
        stack.push([x.car, other.car], [x.cdr, other.cdr]);
        break;
      }
      default: {
        const neverValue: never = x;
        return neverValue;
      }
    }
  }
  return true;
}

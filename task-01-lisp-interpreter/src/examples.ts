import closure from '../examples/closure.scm?raw';
import factorial from '../examples/factorial.scm?raw';
import fibonacci from '../examples/fibonacci.scm?raw';
import mapFilter from '../examples/map-filter.scm?raw';
import reverse from '../examples/reverse.scm?raw';

export interface Example {
  id: string;
  title: string;
  blurb: string;
  source: string;
}

export const examples: Example[] = [
  {
    id: 'factorial',
    title: '阶乘',
    blurb: '线性递归。factorial(10) = 3628800',
    source: factorial,
  },
  {
    id: 'fibonacci',
    title: '斐波那契',
    blurb: '双递归。fib(10) = 55',
    source: fibonacci,
  },
  {
    id: 'reverse',
    title: '列表反转',
    blurb: '尾递归累加器。结果 (5 4 3 2 1)',
    source: reverse,
  },
  {
    id: 'map-filter',
    title: 'map 与 filter',
    blurb: '手写高阶函数。输出平方，结果为偶数',
    source: mapFilter,
  },
  {
    id: 'closure',
    title: '闭包',
    blurb: '加法器与两个独立计数器。结果 17',
    source: closure,
  },
];

# 交互式 Scheme 风格 Lisp 解释器

一个手写的 Scheme 子集解释器，加上可以单步、回溯的 Web 执行环境。求值器用堆上的显式栈，尾调用不增长调用栈，非尾递归也不会打爆宿主的 JavaScript 栈。

规范原文在同目录的 `task-01-lisp-interpreter.md`。两轮审查记录在 `REVIEW.md`。

## 架构

```
源码
  → lexer.ts        逐字符词法，保留行列
  → parser.ts       手写读取器（递归下降，显式栈）
  → machine.ts      显式栈求值器，尾位置复用当前帧
  → session.ts      每一步的快照，供前端回溯
  → App.tsx         编辑器、环境链、调用栈、内存、输出
```

| 模块 | 职责 |
| --- | --- |
| `src/lisp/types.ts` | 源码位置、S 表达式、值、快照的类型 |
| `src/lisp/lexer.ts` | 数字、布尔、字符串、符号、括号、点、引号、`;` 注释 |
| `src/lisp/parser.ts` | 列表、点对、`'expr` → `(quote expr)`，错误带行列 |
| `src/lisp/machine.ts` | `define` / `lambda` / `if` / `cond` / `let` / `let*` / `begin` / `quote` / `set!` |
| `src/lisp/env.ts` | 词法环境链。子环境指向父环境 |
| `src/lisp/builtins.ts` | 算术、比较、列表、类型谓词、`display` / `write` |
| `src/lisp/execute.ts` | 整段程序求值。`recover` 时跳过出错的顶层形式继续执行 |
| `src/lisp/session.ts` | 单步、回退、跳到某一历史步。只保留最近 6000 步 |
| `src/Editor.tsx` | CodeMirror 6。高亮规则是手写的 `StreamLanguage`，不是 Lisp 解析库 |
| `src/App.tsx` | 单步、连续执行、重置、环境帧、调用栈、内存计数、历史滑块 |

尾调用的判定：`if`、`cond`、`begin`、`let`、`let*` 和过程体的最后一个表达式处于尾位置。尾位置上的过程调用在调用栈非空时替换栈顶帧，并留下原来的返回续延。内置函数不压 Lisp 帧。第一条进入过程的调用会压入一帧。

特殊形式的名字在运算符位置不被遮蔽。`(let ((if 1)) (if #f 2 3))` 仍是 `if`。内层 `define` 按顺序执行，不是完整的 `letrec`；两个内部过程都定义完之后再调用，可以相互递归。

只有 `#f` 是假。数字是 IEEE-754。`()` 不能求值，`'()`、`(quote ())` 和 `(list)` 是空表。

## 如何运行

```bash
cd task-01-lisp-interpreter
npm install
npx playwright install chromium
npm run dev
```

浏览器打开 `http://127.0.0.1:5173`。左上角选择示例，然后「单步」或「连续执行」。点环境链里的任意一帧查看绑定；拖底部滑块回溯。改完代码后，下一次单步或连续执行从头开始。

## 测试

```bash
npm test            # 单元测试（Vitest）
npm run test:e2e    # 前端端到端（Playwright）
npm run typecheck   # tsc --noEmit，strict
npm run build       # 类型检查并构建
npm run test:all    # 单元测试、类型检查、端到端
```

单元测试在 `tests/`，覆盖解析器、求值器、特殊形式、内置函数、错误位置、边界（空表、深层嵌套、尾递归 100000 次、错误恢复）以及失控递归和历史上限。端到端测试在 `e2e/programs.spec.ts`，通过页面单步查看五个示例的表达式、调用栈和环境，并检查死循环、栈深上限和错误高亮。

拉取请求在改动 `task-01-lisp-interpreter/**` 时会跑 `.github/workflows/lisp-interpreter.yml`：`npm ci`、`npm test`、`npm run typecheck`、`npm run build`，安装 Chromium 后再跑 `npm run test:e2e`。Playwright 报告和截图作为 artifact 上传。

## 示例程序

| 文件 | 预期 |
| --- | --- |
| `examples/factorial.scm` | `(factorial 10)` → `3628800` |
| `examples/fibonacci.scm` | `(fib 10)` → `55` |
| `examples/reverse.scm` | `'(1 2 3 4 5)` → `(5 4 3 2 1)`，尾递归，最大栈深 1 |
| `examples/map-filter.scm` | 输出 `(1 4 9 16)`，结果 `(2 4 6)` |
| `examples/closure.scm` | 输出 `8` `13` `1` `2` `1`，结果 `17` |

## 已知限制

- 数字是 IEEE-754。`2^53 - 1` 以内的整数运算可视为精确。`(sum 100000 0)` 的结果 `5000050000` 在这个范围内；更大的阶乘会丢精度。
- 没有宏、准引用、块注释、向量、字符、端口、`call/cc`、多值、命名 `let`、`and` / `or`、`do`、`delay`。反引号和逗号是语法错误。
- `eq?` 对数字、布尔、符号和字符串按值比较，对点对和过程按身份比较。`equal?` 对结构做深度比较，并能处理循环。
- 非尾调用栈深度上限是 **512**（`src/lisp/limits.ts` 的 `MAX_CALL_STACK`）。再深一层会得到带位置的运行时错误，不会把宿主撑爆。尾调用替换当前帧，不占这个深度。`(d 400)` 这种 401 层的非尾递归仍在上限以内。
- `execute` 的求值步数上限是 500 万。无限尾递归会停在这个上限，并带上当前表达式的位置。
- 可视化另有 2 万步的上限（`MAX_TRACE_STEPS`）。界面上的无限尾递归停在这里；非尾失控递归通常先碰到 512 层栈深。
- 回溯只保留最近 **6000** 步（`MAX_HISTORY`）。更早的步骤被丢掉，页面会写明「只保留最近 6000 步」以及丢弃了多少步。阶乘、斐波那契、反转、map/filter 和闭包都不到 6000 步，可以完整回溯。
- 内存面板统计的是累计分配的点对和环境数量，没有垃圾回收。
- 词法错误（未闭合字符串、非法数字、反引号）会让整段程序停止解析。多余的右括号和运行时错误可以按顶层形式恢复（`execute` 的 `recover` 选项）。
- 极深结构的打印可能显示为 `#<deep-value>` 或 `#<deep-expr>`，求值本身仍然是迭代的。
- 编辑器高亮是独立的词法规则，不参与求值。

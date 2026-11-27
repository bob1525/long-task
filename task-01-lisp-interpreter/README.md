# 交互式 Scheme 风格 Lisp 解释器

一个手写的 Scheme 子集解释器，加上可以单步、回溯的 Web 执行环境。求值器用堆上的显式栈，尾调用不增长调用栈，非尾递归也不会打爆宿主的 JavaScript 栈。

规范原文在同目录的 `task-01-lisp-interpreter.md`。审查记录在 `REVIEW.md`。

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
| `src/lisp/lexer.ts` | 数字、布尔、字符串、符号、括号、点、引号、准引用、`;` 注释 |
| `src/lisp/parser.ts` | 列表、点对、`'expr`、`` ` `` / `,` / `,@`，错误带行列 |
| `src/lisp/machine.ts` | 特殊形式、命名 `let`、`do`、`and` / `or`、准引用、尾位置 `apply` |
| `src/lisp/env.ts` | 词法环境链。子环境指向父环境 |
| `src/lisp/builtins.ts` | 算术、比较、列表、字符串、类型谓词、`display` / `write` |
| `src/lisp/execute.ts` | 整段程序求值。`recover` 时跳过出错的顶层形式继续执行 |
| `src/lisp/session.ts` | 单步、回退、跳到某一历史步。只保留最近 6000 步 |
| `src/Editor.tsx` | CodeMirror 6。高亮规则是手写的 `StreamLanguage`，行号可设断点 |
| `src/App.tsx` | 单步、后退、连续执行、断点、地址栏分享、环境帧、调用栈 |

尾调用的判定：`if`、`cond`、`begin`、`let`、`let*`、`and`、`or` 和过程体的最后一个表达式处于尾位置。命名 `let` 和 `do` 的递归调用走同一条路径。尾位置上的过程调用在调用栈非空时替换栈顶帧，并留下原来的返回续延。`apply` 在尾位置展开参数后同样替换栈顶。内置函数不压 Lisp 帧。第一条进入过程的调用会压入一帧。

特殊形式的名字在运算符位置不被遮蔽。`(let ((if 1)) (if #f 2 3))` 仍是 `if`，`(let ((and #f)) (and #f 2))` 仍是 `and`。内层 `define` 按顺序执行，不是完整的 `letrec`；两个内部过程都定义完之后再调用，可以相互递归。

只有 `#f` 是假。数字是 IEEE-754。`()` 不能求值，`'()`、`(quote ())` 和 `(list)` 是空表。

## 这一轮新增的语法

- 可变参数：`(lambda args body ...)` 把全部实收录进 `args`。`(lambda (a b . rest) body ...)` 和 `(define (f a . rest) body ...)` 中，`rest` 是剩下的真列表。固定参数不够是带位置的运行时错误。
- 命名 `let`：`(let loop ((i 0)) body ...)`。初始值在外层环境求值，循环过程在函数体里可见。循环调用处于尾位置时不增长栈。`(let loop ((i 100000) (acc 0)) ...)` 的最大栈深是 1。
- `do`：`(do ((var init step) ...) (test result ...) command ...)`。没有 `step` 时变量保持原值，多个步进同时赋值。`do` 展开成命名 `let`，所以循环本身也是尾调用。内部循环名从 `do-loop` 起，如果和绑定重名就改成 `do-loop*`。没有 `result` 时返回未指定值。
- 准引用：`` `expr ``、`,expr`、`,@expr`，分别读成 `quasiquote`、`unquote`、`unquote-splicing`。嵌套时只展开当前层。`unquote-splicing` 只能出现在列表元素位置，结果必须是真列表。展开直接构造点对，不调用用户的 `cons` 或 `append`。
- `and` / `or`：从左到右短路。`(and)` 是 `#t`，`(or)` 是 `#f`。只有 `#f` 为假，所以 `(and 0 1)` 是 `1`。最后一个参数处于尾位置。

## 新增的内置过程

`string-length`、`string-append`、`substring`、`string->symbol`、`symbol->string`、`number->string`、`append`、`length`、`list-ref`、`assoc`、`member`、`apply`。

`substring` 和 `list-ref` 的下标从 0 开始，`substring` 的结束位置不包含在内。`assoc` 和 `member` 用 `equal?` 比较，分别返回匹配的点对或从匹配处开始的子列表，找不到返回 `#f`。`apply` 的最后一个参数必须是真列表。参数个数、类型、范围和下标错误都带源码位置。

## 界面

浏览器打开 `http://127.0.0.1:5173`。左上角选择示例，然后「单步」「上一步」或「连续执行」。点环境链里的任意一帧查看绑定；拖底部滑块回溯。历史窗口里可以连续后退，至少覆盖最近 200 步的环境链、调用栈和当前表达式。改完代码后，下一次单步或连续执行从头开始。

点行号设置或取消断点。连续执行在求值进入该行时停下，再次按「连续执行」从这里继续，离开这一行之后才会再次停下。出错时，错误面板给出行和列，编辑器用 `.cm-eval-error` 标出对应区间。

当前程序写在地址栏 `#src=` 后面，用 `encodeURIComponent` 编码。打开这个链接会恢复编辑器里的同一段代码，而不是默认示例。

## 如何运行

```bash
cd task-01-lisp-interpreter
npm install
npx playwright install chromium
npm run dev
```

开发服务器起来之后，按上一节的方式操作页面。

## 测试

```bash
npm test            # 单元测试（Vitest）
npm run test:e2e    # 前端端到端（Playwright）
npm run typecheck   # tsc --noEmit，strict
npm run build       # 类型检查并构建
npm run test:all    # 单元测试、类型检查、端到端
```

单元测试在 `tests/`，覆盖解析器、求值器、特殊形式、内置函数、错误位置、边界（空表、深层嵌套、尾递归 100000 次、错误恢复）、失控递归和历史上限。`tests/upgrade.test.ts` 覆盖可变参数、命名 `let` 的 100000 次尾调用、`do`、准引用、`and` / `or` 的尾调用、新内置函数的错误位置，以及后退 200 步。端到端测试在 `e2e/programs.spec.ts`，通过页面单步查看五个示例的表达式、调用栈和环境，并检查死循环、栈深上限、断点、后退 200 步、错误高亮和地址栏恢复。

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
- 没有宏、块注释、向量、字符、端口、`call/cc`、多值、`delay`。`quasiquote` 按 Scheme 的嵌套层数展开，不是 `syntax-rules`。
- `eq?` 对数字、布尔、符号和字符串按值比较，对点对和过程按身份比较。`equal?` 对结构做深度比较，并能处理循环。
- 非尾调用栈深度上限是 **512**（`src/lisp/limits.ts` 的 `MAX_CALL_STACK`）。再深一层会得到带位置的运行时错误，不会把宿主撑爆。尾调用替换当前帧，不占这个深度。`(d 400)` 这种 401 层的非尾递归仍在上限以内。
- `execute` 的求值步数上限是 500 万。无限尾递归会停在这个上限，并带上当前表达式的位置。
- 可视化另有 2 万步的上限（`MAX_TRACE_STEPS`）。界面上的无限尾递归停在这里；非尾失控递归通常先碰到 512 层栈深。
- 回溯只保留最近 **6000** 步（`MAX_HISTORY`）。更早的步骤被丢掉，页面会写明「只保留最近 6000 步」以及丢弃了多少步。阶乘、斐波那契、反转、map/filter 和闭包都不到 6000 步，可以完整回溯。
- 内存面板统计的是累计分配的点对和环境数量，没有垃圾回收。
- 词法错误（未闭合字符串、非法数字）会让整段程序停止解析。多余的右括号和运行时错误可以按顶层形式恢复（`execute` 的 `recover` 选项）。悬空的反引号或逗号是语法错误，位置指向这个记号。
- 极深结构的打印可能显示为 `#<deep-value>` 或 `#<deep-expr>`，求值本身仍然是迭代的。
- 编辑器高亮是独立的词法规则，不参与求值。

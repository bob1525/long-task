# 小型 ETL 工具

从 CSV、JSON 或 SQLite 读取记录，按 YAML/JSON 规则转换，再写入 CSV、JSON 和 SQLite。单条坏记录会被记入错误报告，不会中断其余记录。任务可以按检查点续跑，并且不会把已经成功的行再写一遍。

## 安装

需要 Python 3.11 或更高版本。

```bash
cd task-03-etl-tool
python -m pip install -e ".[dev]"
```

## 运行演示

演示数据在 `demo/customers.csv`，配置在 `demo/config.yaml`。13 行里有过滤行、非法年龄、除零和重复主键。

```bash
cd task-03-etl-tool
python -m etl_tool demo
```

也可以从任意目录执行 `./run_demo.sh`。

一次成功的演示会打印：

```text
status: completed
success: 8
failed: 4
loaded: 8
extracted: 13
filtered_out: 1
```

并生成：

| 文件 | 内容 |
| --- | --- |
| `demo-output/customers.csv` | 成功行 |
| `demo-output/customers.json` | 成功行（数组） |
| `demo-output/customers.db` | 表 `customers`，主键 `id` |
| `demo-output/errors.json` | 错误报告 |
| `demo-output/errors.md` | 同一份错误报告的 Markdown |
| `demo-output/report.json` | 执行报告：成功数、失败数、耗时、每条规则的统计 |
| `demo-output/checkpoint.json` | 最近一次检查点 |
| `demo-output/etl.log` | 运行日志 |

`status=ignore` 的一行被提取阶段过滤，不算失败。两条年龄无法转成整数，一条 `qty` 为 0 导致 `price / qty` 失败，一条重复 `id` 在 SQLite 主键冲突后被单独丢弃。成功的 8 行仍然写入三个目标。

## 运行自己的任务

```bash
python -m etl_tool run --config path/to/job.yaml
python -m etl_tool run --config path/to/job.yaml --resume
python -m etl_tool run --config path/to/job.yaml --web --web-port 8765 --web-keep 30
```

`--web` 在任务运行期间提供本地页面和 `GET /api/status`。页面显示状态、进度、成功/失败计数、规则统计和最近的错误。`--web-keep` 让页面在任务结束后再停留若干秒。

退出码：`0` 完成，`3` 因失败阈值中止，`2` 配置或检查点不可用，`1` 其他未能隔离的错误。

相对路径相对于配置文件所在目录。

## 配置示例

```yaml
name: orders
extract:
  type: csv          # csv | json | sqlite
  path: orders.csv   # 或用 data: 传入文本，json 也可用 records:
  filter:
    field: status
    op: eq
    value: open
transform:
  rules:
    - name: clean_city
      type: string
      field: city
      ops: [trim, title]
    - name: cast_qty
      type: cast
      field: qty
      to: int
    - name: line_total
      type: expression
      target: line_total
      expr: price * qty
load:
  batch_size: 200
  targets:
    - type: json
      path: out/orders.json
      mode: overwrite   # overwrite | append
    - type: sqlite
      path: out/orders.db
      table: orders
      mode: overwrite
      primary_key: [id]
error_handling:
  max_failures: 50          # 失败数大于该值则停止；等于该值仍继续
  max_failure_ratio: 0.2    # 失败数 / 已处理行数，大于该比例则停止
  checkpoint_path: out/checkpoint.json
  error_report_path: out/errors.json
  log_path: out/etl.log
monitor:
  progress: true
  report_path: out/report.json
```

内存输入示例：

```yaml
extract:
  type: json
  records:
    - {id: 1, qty: "2"}
```

```yaml
extract:
  type: sqlite
  records:
    - {id: 1, city: " Paris "}
  table: records
```

SQLite 文件也可以写 `path` 加 `table` 或 `query`。CSV 和 JSON 可以用 `data` 传字符串，不必落盘。

## 规则语法

规则按 `transform.rules` 的顺序执行，后一条看到前一条改过的记录。每条规则统计 `rows_seen`、`rows_modified`、`fields_modified`、`rows_failed`，写进执行报告。某条规则失败时，该记录不再执行后面的规则，其他记录继续。

`on_missing` 默认是 `skip`。设为 `fail` 时，缺字段会让这一行失败。

### rename

```yaml
- type: rename
  mapping: {email: email_address, notes: comment}
```

### cast

目标类型：`int`、`float`、`str`、`bool`、`date`、`datetime`。

```yaml
- type: cast
  fields: {id: int, price: float, active: bool}
  # 可选 default: 0
```

布尔文本接受 `true/false`、`yes/no`、`y/n`、`1/0`。非有限数字（`inf`、`nan`）不能转换。

### string

`ops` 按顺序应用：`trim`、`lower`、`upper`、`title`，以及替换。

```yaml
- type: string
  field: notes
  ops:
    - trim
    - lower
    - replace: {old: pioneer, new: legend, count: 1}  # count 可省略
```

### expression

写入 `target`。语法由 `etl_tool/transform/expression.py` 自行解析和求值，不调用 Python 的 `eval` 或 `exec`。没有函数调用、下标、属性访问或乘方。

支持：

- 算术：`+ - * / %`，一元 `+`/`-`，括号
- 比较：`== != < > <= >=`，可以连写 `1 < x < 5`
- 逻辑：`and` `or` `not`，以及 `&&` `||` `!`。`and`/`or` 会短路
- 字面量：整数、小数、科学计数、单引号或双引号字符串、`true` `false` `null`
- 字段名：当前记录里的列。两个字符串相加是拼接

整数运算保持 `int`，除法得到 `float`。结果如果不是有限数，这一行失败。除零和取模零也失败。

```yaml
- type: expression
  target: line_total
  expr: price * qty
```

### conditional

按顺序匹配 `when`，命中第一条为真的条件。`then` 和 `else` 可以是常量，或者 `{expr: "..."}`。

```yaml
- type: conditional
  target: tier
  when:
    - if: line_total >= 1000
      then: gold
    - if: line_total >= 100
      then: {expr: "'silver'"}
  else: bronze
```

### merge / split

```yaml
- type: merge
  fields: [street, city, zip]
  target: address
  separator: ", "
  skip_empty: true
- type: split
  field: full_name
  separator: " "
  targets: [first_name, last_name]
```

分段少于目标数时，缺少的字段写成空字符串，多余的文本留在最后一段。

## 提取过滤

`extract.filter` 在转换之前丢弃行。被丢弃的行计入 `filtered_out`，不计入失败。多个条件可以用列表或 `all`（并且）、`any`（或者）、`not`。

叶子条件：`field` + `op` + `value`。`op` 可以是 `eq`、`ne`、`gt`、`gte`、`lt`、`lte`、`contains`、`startswith`、`endswith`、`in`、`not_in`、`regex`、`is_null`、`not_null`、`is_blank`、`exists`。

## 加载、回滚和断点

- `mode: overwrite` 会在新任务开始时清掉该目标。`append` 保留已有内容。
- 每个批次先写 SQLite（显式 `BEGIN`/`COMMIT`），再追加 JSON Lines 和 CSV。批次失败时 SQLite 事务回滚，文件截断回本批开始前的长度，然后逐行重试。错误报告里的 `failed_batches` 记录被回滚的批次。
- 每提交一批就追加一行检查点。中断后用 `--resume` 从最后一条完整检查点继续，并截掉检查点之后的输出，所以不会重复写入已成功的行。输入文件或规则变了，检查点指纹对不上，工具会拒绝续跑。
- JSON 数组由旁路的 `.jsonl` 在任务结束时（以及续跑恢复时）一次性生成。运行中途以 `.jsonl` 和检查点为准。

失败阈值：`failed > max_failures`，或 `failed / 已处理行数 > max_failure_ratio` 时停止。等于阈值不会停止。已经成功提交的行会保留。

## 错误报告示例

下面是 `python -m etl_tool demo` 写出的 `demo-output/errors.md` 的开头。完整文件还包含原始记录、失败规则和原因；JSON 版是 `demo-output/errors.json`。

```markdown
# ETL error report: customer-demo

- Status: completed
- Failures: 4
- Failed batches: 1

## 1. index 3 — transform `cast_types`

- Rule type: cast
- Error: cast_types: cannot cast field 'age' value 'not_a_number' to int

## 2. index 4 — transform `unit_price`

- Rule type: expression
- Error: unit_price: division by zero in 'price / qty'

## 4. index 12 — load `sqlite:.../customers.db:customers`

- Error: UNIQUE constraint failed: customers.id
```

执行报告 `demo-output/report.json` 含 `success`、`failed`、`duration_seconds` 和 `rules` 数组。

## 测试

```bash
cd task-03-etl-tool
pytest --cov=etl_tool/transform --cov-report=term-missing --cov-fail-under=80
```

覆盖率统计的是核心转换包 `etl_tool/transform`（规则、表达式、执行引擎）。门槛是 80%。测试里没有 `skip`、`xfail` 或只跑单条的标记。

GitHub Actions 工作流 `.github/workflows/etl-tool.yml` 只在 `task-03-etl-tool/**` 或该工作流文件变更的 pull request 上运行：安装依赖、跑全部测试、覆盖率不足 80% 则失败、执行 `python -m etl_tool demo`，并上传 `reports/` 和 `demo-output/`。

## 已知限制

- 表达式不能调用函数，不能使用 `**`、下标或属性。这是故意的，避免把配置变成任意代码。
- CSV 追加时，新行不能带出已写表头之外的列；整行记为加载失败。
- 检查点日志每一批都保存完整状态。失败记录很多时，日志会变大。
- `:memory:` SQLite 只活在当前进程里，不能靠 `--resume` 跨进程恢复。文件数据库可以。
- Web 页面只在本次进程里提供，绑定地址默认是 `127.0.0.1`。
- 过滤掉的行不会出现在成功输出或错误报告里。

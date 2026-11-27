# 审查记录

## 第一轮：基本流程

这一轮把提取、规则转换、加载和命令行跑通，并用 `demo/customers.csv` 走完一条带坏数据的流程。规则按配置顺序执行，三种来源和三种目标都能读写，失败行单独记报告。

跑测试时发现并修了三个具体问题：

1. **整数字面量被收成 float。** `etl_tool/transform/expression.py` 的语法树把数字节点写成 `("num", float(token.value))`。`9007199254740993 + 1` 得到 `9007199254740992.0`，`1 + 1` 得到 `2.0`，和记录里的整数 `2` 比会被当成“字段变了”。词法分析本来已经区分了 `int` 和 `float`，语法树却又转了一遍。改为保留 token 原来的 `int` 或 `float`。`tests/test_expression.py::test_large_integers_are_not_rounded` 和 `tests/test_rules.py::test_expression_rule_writes_target_and_records_failure` 覆盖这件事。

2. **失败异常的文本里没有规则名。** `CastRule` 抛出的消息是 `cannot cast field 'age' ...`，规则名只放在 `TransformError.rule` 上。错误报告和日志如果只看 `str(exc)`，就看不出是哪条规则。`TransformError.__str__` 现在会加上 `规则名:` 前缀。断言仍要求消息里能找到规则名，没有改松。

3. **隔离测试的夹具和 SQLite 主键不一致。** `test_bad_record_does_not_stop_the_job` 使用主键 `id`，但输入行没有 `id`。转换成功的两行在加载阶段全部失败，`success` 变成 0。这不是“坏年龄应该拖垮任务”，而是主键列缺失。给这三行补上 `id` 后，断言不变：`success == 2`、`failed == 1`，坏行不在输出里。

第一轮结束时，演示命令能写出成功数据、错误报告和执行报告。

## 第二轮：错误处理、边界和性能

对着“任何异常输入都不能让工具崩溃”、回滚和续跑再查了一遍。

1. **写错误报告时，一条坏值会让整个任务退出。** `snapshot()` 在 `sanitize()` 失败后用 `json.dumps` 再 `json.loads`。`NaN` 会变成非法 JSON，`set` 不能被默认编码器处理，`JSONDecodeError` 或 `TypeError` 冒泡到流水线最外层，任务状态变成 `failed` 并向上抛出。一条记录里的集合或非有限数就会停掉后面的行。`snapshot()` 改为始终返回可 JSON 序列化的结构（非有限数写成字符串，集合写成列表，循环引用写成 `"<cycle>"`），不再抛异常。`tests/test_pipeline.py::test_unusual_values_fail_one_record_and_do_not_abort` 用 `{1, 2}` 这样的字段确认：该行记为加载失败，另外两行照常写入。

2. **表达式溢出只在加载时才被发现。** `1e308 * 1e308` 得到 `inf`，规则统计把它算作成功，然后 `sanitize()` 才拒绝。现在浮点运算结果如果不是有限数，表达式求值直接失败，规则的 `rows_failed` 加一，记录不会进入加载。`tests/test_expression.py::test_runtime_errors` 和上面的流水线测试覆盖 `1e308 * 1e308`。

3. **每个批次都重写整个 JSON 数组。** `JsonTarget.materialize()` 会读完 `.jsonl` 再原子写出数组。原先每提交一批就做一次，输出越大越慢，写入量按批次数平方增长。持久日志本来就是追加的 `.jsonl`，检查点里记了它的字节长度，续跑时也会按这个长度截断再物化。因此数组文件只在任务结束时，以及 `--resume` 恢复时，生成一次。成功输出的内容不变，`tests/test_pipeline.py` 里对 `out.json` 的断言仍然成立。

另外核对了这些边界，行为与测试一致，没有再改断言：

- 失败数或失败比例**大于**配置值才中止，等于阈值时跑完（`test_failure_thresholds_are_strictly_greater_than`）。
- SQLite 一批里出现主键冲突时，整批事务回滚，再逐行提交，只有冲突行进入 `failed_batches`（`test_load_failure_rolls_back_batch_and_keeps_good_rows`）。
- 中断后 `--resume` 不重写已成功的行；检查点之后多出来的 CSV 尾巴和 SQLite 行会被截掉；输入变了则拒绝续跑（`test_resume_does_not_rewrite_successful_rows`、`test_resume_discards_unjournaled_output_and_rejects_changed_input`）。
- 转换包源码里没有 `eval(` 或 `exec(`（`tests/test_no_eval.py`）。

## 第三轮：校验、去重、查找、upsert 和实时进度

在已经通过验收的实现上加了这些能力，原来的 44 个测试一个都没删，断言也没有放宽。新测试在 `tests/test_round3.py`。

1. **校验规则。** `ValidateRule` 支持 `required`、`regex`（整段 `fullmatch`）、闭区间 `min`/`max` 和 `enum`。失败抛出 `TransformError`，错误报告里的 `rule` 就是配置里的规则名。非法正则和空枚举在构建规则时就是 `ConfigError`，不会拖到跑数据的时候。

2. **去重规则。** `keep: first` 在流里直接丢掉后面的重复键。`keep: last` 给每条记录盖一个序号，等提取结束后只留下每个键的最后一条；更早的行记成该规则的失败，不会写入。这一轮发现并修了一个统计缺口：`keep: last` 的落选行是在加载前才判定的，规则的 `rows_failed` 一开始没有加上。现在在落选时补计，执行报告能看到失败行数。

3. **查找规则。** 内存字典、内存行，以及 CSV/JSON 文件都能做一对一查找。数字和数字字符串归一成同一个键。找不到时可以失败，也可以写默认值。查找表里的重复键保留第一行。

4. **SQLite upsert 和加载重试。** `mode: upsert` 使用 `ON CONFLICT(primary_key) DO UPDATE`。没有主键，或者把 upsert 用在 CSV/JSON 上，配置阶段就拒绝。批次提交失败会按 `load.retry` 做有限次尝试，等待时间从 `backoff_seconds` 翻倍到 `max_backoff_seconds`。次数用尽才写入 `failed_batches`，然后再逐行试。测试用钩子注入失败，不靠真的睡觉，所以能断言等待序列是 `0.05, 0.1`。

5. **`--dry-run` 和 HTML 报告。** dry-run 不调用 `prepare`，因此不会删除已有目标文件，也不会写检查点。`would_load` 和最多 5 条样例进标准输出和执行报告。每份执行报告旁边额外写一份 HTML，包含成功数、失败数、规则表和错误样例。

6. **监控轮询。** 页面每 500 毫秒请求 `/api/status`，更新进度、规则表和最近错误。`test_web_status_grows_while_the_job_is_running` 在任务跑的过程中多次读这个接口，确认 `processed` 在增长，而不是只在结束时跳一次。

7. **升级演示的路径写错了一层。** `demo/upgrade/config.yaml` 最初用 `../demo-output-upgrade`。配置目录已经是 `demo/upgrade`，这个相对路径落到了 `demo/demo-output-upgrade`，和命令预先种下的 `task-03-etl-tool/demo-output-upgrade/customers.db` 不是同一个文件，所以 upsert 没有打到占位行，JSON 也不在验收命令期望的目录。改成 `../../demo-output-upgrade` 之后，`id=1` 从 `Placeholder` 更新为 `Ada Lovelace`，`python -m etl_tool demo-upgrade` 的结果是成功 7、失败 6、加载 7、提取 14、过滤 1。旧的 `python -m etl_tool demo` 仍然是成功 8、失败 4。

覆盖率门槛从 80% 提高到 85%，统计范围仍是 `etl_tool/transform`。转换包里仍然没有 `eval` 或 `exec`。

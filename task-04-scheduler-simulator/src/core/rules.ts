/**
 * These sentences are the scheduling contract. The engine, README, and
 * standard-case hand calculations all follow this text.
 */
export const RULES_SUMMARY =
  '时间是离散整数。时刻 t 的处理顺序：① 到达时间等于 t 的进程按 PID 升序进入就绪队列队尾；② 抢占式算法若就绪进程在主关键字上严格更优，则抢占当前进程；③ CPU 空闲则分派下一进程；④ 执行时间区间 [t, t+1)；⑤ 剩余时间减到 0 则完成，否则若到达 I/O 触发点则进入等待，否则若时间片用尽则让出 CPU。时间片用尽先于同一时刻的新到达入队（用尽发生在上一拍结束）。优先级数值越小越高。服务时间、剩余时间或优先级相同的平局：先到达时间更早，再 PID 更小。剩余时间或优先级仅仅相等时不抢占。甘特图的一段是一次分派区间；同一进程在时间片边界被再次分派时两段不合并。连续空闲合并为一段。等待时间只统计就绪态，不含 I/O 阻塞，也不含尚未到达的新建态。';

export const METRIC_DEFINITIONS = [
  '周转时间 = 完成时间 − 到达时间',
  '等待时间 = 周转时间 − 服务时间 − I/O 时间（等于停留在就绪态的时间）',
  '响应时间 = 首次获得 CPU 的时间 − 到达时间',
  'CPU 利用率 = 总 CPU 忙碌时间 / 仿真时钟（从 0 到最后完成时刻，含开头和中间的空闲）',
  '平均值只统计已完成进程',
] as const;

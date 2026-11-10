import { describe, it } from 'vitest';
import { expectSchedule, runsFor } from '../helpers/oracle';

describe('优先级调度', () => {
  for (const run of [...runsFor('priority-np'), ...runsFor('priority-p')]) {
    it(`${run.caseId} ${run.run.algorithm} ${run.title} 与手算一致`, () => {
      expectSchedule(run);
    });
  }
});

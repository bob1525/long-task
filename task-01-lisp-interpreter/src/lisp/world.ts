import { installBuiltins } from './builtins';
import { Environment } from './env';
import type { Value, World } from './types';

export interface Runtime {
  world: World;
  globalEnv: Environment;
}

export function createRuntime(): Runtime {
  const world: World = {
    output: [],
    results: [],
    pairs: 0,
    envCount: 0,
    nextPairId: 1,
    nextEnvId: 1,
    nextProcId: 1,
    maxCallStack: 0,
  };
  const builtinEnv = new Environment(world, null, '内置');
  installBuiltins(builtinEnv);
  const globalEnv = new Environment(world, builtinEnv, '全局');
  return { world, globalEnv };
}

export function consPair(world: World, car: Value, cdr: Value): Value {
  world.pairs += 1;
  const id = world.nextPairId;
  world.nextPairId += 1;
  return { kind: 'pair', id, car, cdr };
}

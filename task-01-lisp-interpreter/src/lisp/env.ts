import type { Env, Value, World } from './types';

export class Environment implements Env {
  readonly id: number;
  readonly label: string;
  readonly parent: Environment | null;
  private readonly world: World;
  private readonly bindings = new Map<string, Value>();

  constructor(world: World, parent: Environment | null, label: string) {
    this.world = world;
    this.id = world.nextEnvId;
    world.nextEnvId += 1;
    world.envCount += 1;
    this.parent = parent;
    this.label = label;
  }

  lookup(name: string): Value | null {
    const found = this.bindings.get(name);
    if (found !== undefined) return found;
    return this.parent ? this.parent.lookup(name) : null;
  }

  define(name: string, value: Value): void {
    this.bindings.set(name, value);
  }

  assign(name: string, value: Value): boolean {
    if (this.bindings.has(name)) {
      this.bindings.set(name, value);
      return true;
    }
    return this.parent ? this.parent.assign(name, value) : false;
  }

  entries(): Array<[string, Value]> {
    return [...this.bindings.entries()];
  }

  extend(label: string): Environment {
    return new Environment(this.world, this, label);
  }
}

export function envChain(env: Env): Env[] {
  const chain: Env[] = [];
  const seen = new Set<number>();
  let current: Env | null = env;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.parent;
  }
  return chain;
}

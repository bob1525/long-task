import { builtinLevels } from '../src/levels'
import { recordClear, scriptSource } from '../src/recorder'

const names: Record<string, string> = {
  'builtin-meadow': 'MEADOW_SCRIPT',
  'builtin-bridge': 'BRIDGE_SCRIPT',
  'builtin-patrol': 'PATROL_SCRIPT',
}

for (const level of builtinLevels) {
  const result = recordClear(level)
  console.log(`\n# ${level.id} ${level.name} won=${result.won} status=${result.status} reason=${result.lossReason ?? '-'} frames=${result.frames} x=${result.x.toFixed(1)} y=${result.y.toFixed(1)}`)
  console.log(scriptSource(names[level.id] ?? level.id, result.script))
}

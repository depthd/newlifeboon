// Diagnostic injection: hold movement, advance lifecycle by one simulated minute.
// This tests blocked-action handling; it does not reproduce a natural traffic jam.
import { дорогиПосёлка, построитьПосёлок } from '../src/city/plan.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildNetwork } from '../src/city/traffic.ts';
import { расселить } from '../src/city/житель.ts';
import { вывестиНаУлицу, жить } from '../src/city/жизнь.ts';
const p = построитьПосёлок(20260913, 300, 'город');
const r = расселить(p), w = buildWorld(дорогиПосёлка(p), 'plain');
const n = buildNetwork(w), s = вывестиНаУлицу(w, n, r, 0);
for (let minute = 1; minute <= 1440; minute++) {
  жить(w, n, r, s, minute / 60);
  const counts = new Map<number, number>();
  for (const a of s.пешие) counts.set(a.житель, (counts.get(a.житель) ?? 0) + 1);
  const duplicate = [...counts].find(([id, count]) => id >= 0 && count > 1);
  if (duplicate) {
    console.log(JSON.stringify({ residents: r.всего, hour: minute / 60, duplicate,
      walkers: s.пешие.filter(a => a.житель === duplicate[0]).map(a => ({
        id: a.житель, state: a.state, shape: a.shape, s: a.s,
      })),
    }));
    process.exit(1);
  }
}
console.log('No duplicate walkers in blocked-movement experiment');

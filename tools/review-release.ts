/** Hold the actual walker, then release it through moveWalkers; do not fake arrival. */
import { дорогиПосёлка, построитьПосёлок } from '../src/city/plan.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildNetwork } from '../src/city/traffic.ts';
import { расселить } from '../src/city/житель.ts';
import { вывестиНаУлицу, жить } from '../src/city/жизнь.ts';
import { moveWalkers } from '../src/city/walkers.ts';

const town = построитьПосёлок(20260913, 300, 'город');
const population = расселить(town), world = buildWorld(дорогиПосёлка(town), 'plain');
const reports: object[] = [];
let failures = 0;
for (const releaseAt of [7.5, 24 + 1 / 60]) {
  const net = buildNetwork(world), street = вывестиНаУлицу(world, net, population, 0);
  // Isolate this existing family's schedule, without changing its routes or times.
  street.выходы.splice(0, street.выходы.length, ...street.выходы.filter(e => e.номер === 4253));
  street.пешие.length = 0; street.машины.length = 0; street.стоят.length = 0;
  for (let minute = 1; minute <= Math.round(releaseAt * 60); minute++) {
    жить(world, net, population, street, minute / 60);
  }
  const originals = street.пешие.filter(w => w.житель === 4253);
  const first = originals.find(w => w.дорога === 0);
  const pending = street.ждут.find(e => e.номер === 4253 && e.i === 1);
  const savedDay = pending === undefined ? null : ('сутки' in pending ? pending.сутки : null);
  let finishedAt: number | null = null, resumedAt: number | null = null, earlyStart = false;
  let maxRepresentations = originals.length;
  for (let tick = 1; tick <= 18000; tick++) {
    const seconds = tick / 10, hour = releaseAt + seconds / 3600;
    moveWalkers(world, net, street.пешие, 0.1, hour * 3600);
    if (first?.state === 'пришёл' && finishedAt === null) finishedAt = seconds;
    жить(world, net, population, street, hour);
    const active = street.пешие.filter(w => w.житель === 4253);
    maxRepresentations = Math.max(maxRepresentations, active.length);
    if (active.some(w => w.дорога === 1)) {
      if (finishedAt === null) earlyStart = true;
      resumedAt = seconds;
      break;
    }
  }
  const ok = originals.length === 1 && first !== undefined && savedDay === 0
    && finishedAt !== null && resumedAt !== null && resumedAt >= finishedAt
    && !earlyStart && maxRepresentations === 1;
  if (!ok) failures++;
  reports.push({ releaseAt, resident: 4253, initialRepresentations: originals.length,
    originalChildren: first?.ведёт, savedDay, finishedAtSeconds: finishedAt,
    resumedAtSeconds: resumedAt, maxRepresentations, earlyStart, ok });
}
console.log(JSON.stringify({ experiment: 'real moveWalkers after injected stall, same-day and midnight', reports }, null, 2));
process.exitCode = failures ? 1 : 0;

/** Independent injected-stall regression. Holds movement while advancing lifecycle.
 * It does not claim to simulate a natural queue, complete trip, or rendered scene.
 * Run: node --experimental-strip-types tools/review-lifecycle.ts
 */
import { дорогиПосёлка, построитьПосёлок } from '../src/city/plan.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildNetwork } from '../src/city/traffic.ts';
import { расселить } from '../src/city/житель.ts';
import { вывестиНаУлицу, жить } from '../src/city/жизнь.ts';

const town = построитьПосёлок(20260913, 300, 'город');
const population = расселить(town), world = buildWorld(дорогиПосёлка(town), 'plain');
const net = buildNetwork(world), start = 7.8;
const street = вывестиНаУлицу(world, net, population, start);
// Clear arrivals already complete in the snapshot before injecting the stall.
жить(world, net, population, street, start);
const heldWalkers = [...street.пешие];
const heldCars = street.машины.filter(c => c.park?.phase !== 'стоит').map(car => ({
  car, route: JSON.stringify(car.маршрут), until: car.доЧаса,
}));
const violations = new Map<string, unknown>();
const fail = (name: string, detail: unknown): void => {
  if (!violations.has(name)) violations.set(name, detail);
};
let maxRepresentations = 0, afterMidnight = false;
for (let minute = 1; minute <= 25 * 60; minute++) {
  const hour = start + minute / 60;
  жить(world, net, population, street, hour);
  if (street.сутки >= 1) afterMidnight = true;
  const owners = new Map<number, string[]>();
  const add = (id: number, mode: string): void => {
    if (id < 0) return;
    const present = owners.get(id) ?? [];
    present.push(mode); owners.set(id, present);
    maxRepresentations = Math.max(maxRepresentations, present.length);
    if (present.length > 1) fail('unique-active-resident', { hour, id, modes: present });
  };
  for (const walker of street.пешие) {
    if (walker.state === 'пришёл') continue;
    add(walker.житель, 'walker');
    for (const child of walker.ведёт) add(child, 'accompanied-child');
  }
  for (const car of street.машины) if (car.park?.phase !== 'стоит') {
    add(car.хозяин, 'driver');
    for (const child of street.пассажиры?.get(car) ?? []) add(child, 'passenger');
  }
  for (const held of heldCars) {
    if (!street.машины.includes(held.car)) fail('held-car-retained', { hour, id: held.car.хозяин });
    if (JSON.stringify(held.car.маршрут) !== held.route || held.car.доЧаса !== held.until) {
      fail('active-trip-not-replaced', { hour, id: held.car.хозяин,
        originalUntil: held.until, newUntil: held.car.доЧаса });
    }
  }
  for (const walker of heldWalkers) {
    if (!street.пешие.includes(walker)) fail('held-walker-retained', { hour, id: walker.житель });
  }
}
if (!heldWalkers.length || !heldCars.length || !afterMidnight) fail('nonempty-experiment', {
  walkers: heldWalkers.length, cars: heldCars.length, afterMidnight,
});
console.log(JSON.stringify({ experiment: '25 simulated hours, lifecycle each minute, all movement held',
  residents: population.всего, heldWalkers: heldWalkers.length, heldCars: heldCars.length,
  accompaniedChildren: heldWalkers.reduce((n, w) => n + w.ведёт.length, 0),
  maxRepresentations, afterMidnight, violations: Object.fromEntries(violations),
}, null, 2));
process.exitCode = violations.size ? 1 : 0;

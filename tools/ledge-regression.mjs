// npm run car:ledges [-- --root /path/to/checkout --json report.json]
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { root: { type: 'string' }, json: { type: 'string' } } });
const root = resolve(values.root ?? fileURLToPath(new URL('..', import.meta.url)));
const load = file => import(pathToFileURL(resolve(root, 'src/car', file)).href);
const { createCar, step, центрКолеса } = await load('car.ts');
const { LOGAN, VIPER } = await load('passport.ts');
const { GroundIndex } = await load('ground.ts');

const cars = [LOGAN, VIPER];
const rates = [300, 600, 1200];
const road = { height: 0, nx: 0, ny: 1, nz: 0, material: 'asphalt' };
const empty = { ...road, height: -10000, present: false };
const idle = { throttle: 0, brake: 0, steer: 0, assist: false, handbrake: false };
const flat = () => road;
const depth = 6;
const riseLimit = 0.05;
const duration = 2;
const observations = [];

// A finite lower level tests landing on a real road mesh after leaving the upper deck.
function platform(polygon) {
  const positions = [];
  const indices = [];
  function addTriangle(points, height) {
    for (const [x, z] of points) {
      indices.push(positions.length / 3);
      positions.push(x, height, z);
    }
  }
  const floor = [[-30, -30], [-30, 30], [30, 30], [30, -30]];
  addTriangle([floor[0], floor[1], floor[2]], -depth);
  addTriangle([floor[0], floor[2], floor[3]], -depth);

  const center = [0, 0];
  for (const [x, z] of polygon) {
    center[0] += x / polygon.length;
    center[1] += z / polygon.length;
  }
  for (let i = 0; i < polygon.length; i++) {
    addTriangle([center, polygon[i], polygon[(i + 1) % polygon.length]], 0);
  }
  const ground = new GroundIndex({
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    groups: [{ start: 0, count: indices.length, material: 'asphalt' }],
  });
  return ground.sample.bind(ground);
}

function validState(car) {
  return [car.x, car.y, car.z, car.vx, car.vy, car.vz, ...Object.values(car.q), ...Object.values(car.вращение)]
    .every(Number.isFinite) && car.wheels.every(w => Number.isFinite(w.load) && w.load >= 0);
}

function observe(name, p, hz, yaw, offset, sample, settleSeconds = 3) {
  const dt = 1 / hz;
  const car = createCar(p, 0, offset, yaw);
  for (let i = 0; i < settleSeconds * hz; i++) step(car, p, p.шина, flat, idle, dt);
  const startHeight = car.y;
  const expectedContacts = car.wheels.map(w => {
    const point = центрКолеса(car, w, 0);
    const hit = sample(point.x, point.z);
    return hit.present !== false && Math.abs(hit.height) < 0.001;
  });
  const checks = { settled: car.wheels.every(w => w.load > 0), finite: true, firstContacts: true, rise: true };
  let maxRise = 0;
  let minY = startHeight;
  let maxLoaded = 0;
  let firstContacts = [];
  for (let i = 0; i < duration * hz; i++) {
    step(car, p, p.шина, sample, idle, dt);
    checks.finite = validState(car);
    if (!checks.finite) break;
    if (i === 0) {
      firstContacts = car.wheels.map(w => w.load > 0);
      checks.firstContacts = firstContacts.every((loaded, wheel) => loaded === expectedContacts[wheel]);
    }
    maxRise = Math.max(maxRise, car.y - startHeight);
    minY = Math.min(minY, car.y);
    maxLoaded = Math.max(maxLoaded, car.wheels.filter(w => w.load > 0).length);
  }
  checks.rise = maxRise <= riseLimit;
  const row = { name, car: p.ярлык, hz, yaw, offset, startHeight, expectedContacts, firstContacts, maxRise, minY,
    finalY: car.y, finalVy: car.vy, maxLoaded, checks };
  observations.push(row);
  return row;
}

const analytic = {
  convexCorner: (x, z) => x < 0 && z < 0,
  concaveCorner: (x, z) => x < 0 || z < 0,
  disk6m: (x, z) => Math.hypot(x, z + 6) < 6,
  disk40m: (x, z) => Math.hypot(x, z + 40) < 40,
  shoulder: (_x, z) => -.5 < z && z < 0,
};
const disk = Array.from({ length: 48 }, (_, i) => {
  const angle = 2 * Math.PI * i / 48;
  return [6 * Math.cos(angle), -6 + 6 * Math.sin(angle)];
});
const meshes = {
  meshTriangle: platform([[-15, -10], [8, -8], [0, 0]]),
  meshDisk: platform(disk),
  meshStrip: platform([[-12, -1.2], [12, -1.2], [12, 0], [-12, 0]]),
};
for (const [name, contains] of Object.entries(analytic)) {
  const sample = (x, z) => contains(x, z) ? road : empty;
  for (const p of cars) for (const hz of rates) {
    for (const yaw of [0, .5, 1]) for (const offset of [-.2, .2]) observe(name, p, hz, yaw, offset, sample);
  }
}
for (const [name, sample] of Object.entries(meshes)) {
  for (const p of cars) for (const hz of [300, 600]) for (const yaw of [0, Math.PI / 8, Math.PI / 3]) {
    const row = observe(name, p, hz, yaw, -.12, sample);
    row.checks.lowerFloor = row.minY >= -depth - .05;
  }
}
for (const p of cars) for (const hz of rates) {
  // Both variants leave all four wheels suspended. Only the first has a physical support under the belly.
  const beam = observe('beam', p, hz, 0, 0, (_x, z) => Math.abs(z) < .25 ? road : empty, 2);
  beam.checks.unloadedWheels = beam.maxLoaded === 0;
  beam.checks.bodySupported = Math.abs(beam.finalY - (p.cgHeight - .18)) < .06 && Math.abs(beam.finalVy) < .1;
  const drop = observe('empty', p, hz, 0, 0, () => empty, 2);
  drop.checks.unloadedWheels = drop.maxLoaded === 0;
  drop.checks.freeFall = Math.abs(drop.finalY - (drop.startHeight - 0.5 * 9.80665 * duration ** 2)) < .06;
}

const failed = observations.filter(row => Object.values(row.checks).includes(false));
const report = { duration_s: duration, maxRise_m: riseLimit, passed: observations.length - failed.length, total: observations.length, observations };
if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 2) + '\n');
for (const name of [...Object.keys(analytic), ...Object.keys(meshes), 'beam', 'empty']) {
  const group = observations.filter(row => row.name === name);
  const count = failed.filter(row => row.name === name).length;
  console.log(`${name}: ${group.length - count}/${group.length}, максимальный подъём ${Math.max(...group.map(r => r.maxRise)).toFixed(4)} м`);
}
for (const r of failed.slice(0, 6)) {
  console.error(r.name, r.car, r.hz, 'Гц, угол', r.yaw, 'смещение', r.offset, Object.keys(r.checks).filter(key => !r.checks[key]).join(', '));
}
console.log(`Пройдено ${report.passed}/${report.total}`);
if (failed.length) process.exitCode = 1;

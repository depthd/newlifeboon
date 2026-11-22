// Usage: node road-matches.mjs <project-root> <output-directory>
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2] || !process.argv[3]) throw new Error('Expected <project-root> <output-directory>');
const root = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
mkdirSync(output, { recursive: true });
const load = relative => import(pathToFileURL(path.join(root, relative)).href);
const { createCar, step, forwardSpeed, PHYSICS_STEP } = await load('src/car/car.ts');
const { VIPER, LOGAN } = await load('src/car/passport.ts');
const dt = PHYSICS_STEP ?? 1 / 600;
const mph = 0.44704;
const flat = () => ({ height: 0, nx: 0, ny: 1, nz: 0, material: 'asphalt' });
const input = (throttle, brake) => ({ throttle, brake, steer: 0, assist: false, handbrake: false });
const rows = ['scenario,time_s,travel_m,speed_kmh,gear,engine_rpm'];
function setup(passport, initialSpeed, gear = 0) {
  const car = createCar(passport, 0, 0, 0);
  const tick = controls => step(car, passport, passport.шина, flat, controls, dt);
  for (let index = 0; index < Math.round(3 / dt); index++) tick(input(0, 0));
  car.vx = initialSpeed;
  car.gear = gear;
  for (const wheel of car.wheels) wheel.spin = initialSpeed / wheel.radius;
  return { car, tick };
}
function record(id, time, travel, car) {
  rows.push([id, time.toFixed(5), travel.toFixed(5), (forwardSpeed(car) * 3.6).toFixed(4), car.gear + 1, car.rpm.toFixed(1)].join(','));
}
function accelerate(id, passport, initialSpeed, targetSpeeds) {
  const { car, tick } = setup(passport, initialSpeed);
  const origin = car.x;
  const crossings = [];
  const wot = input(1, 0);
  const stride = Math.max(1, Math.round(0.05 / dt));
  record(id, 0, 0, car);
  for (let index = 1; index <= Math.ceil(40 / dt); index++) {
    const previous = forwardSpeed(car);
    tick(wot);
    const speed = forwardSpeed(car);
    if (index % stride === 0) record(id, index * dt, car.x - origin, car);
    while (crossings.length < targetSpeeds.length && speed >= targetSpeeds[crossings.length]) {
      const target = targetSpeeds[crossings.length];
      crossings.push((index - 1 + (target - previous) / (speed - previous)) * dt);
    }
    if (crossings.length === targetSpeeds.length) return crossings;
  }
  throw new Error('Could not reach requested speed: ' + id);
}
function viperStop() {
  const { car, tick } = setup(VIPER, 70 * mph, 2);
  const origin = car.x;
  const pedal = input(0, 1);
  const stride = Math.max(1, Math.round(0.05 / dt));
  record('viper_70_0', 0, 0, car);
  for (let index = 1; index <= Math.ceil(10 / dt); index++) {
    tick(pedal);
    if (index % stride === 0) record('viper_70_0', index * dt, car.x - origin, car);
    if (forwardSpeed(car) <= 0.05) return car.x - origin;
  }
  throw new Error('Could not stop');
}
const [t80, t100] = accelerate('logan_0_100', LOGAN, 0, [80 / 3.6, 100 / 3.6]);
const [rollingTime] = accelerate('viper_5_60', VIPER, 5 * mph, [60 * mph]);
const stop = viperStop();
function comparison(name, value, reference, margin, unit) {
  return { name, value, reference, margin, unit, error: value - reference,
    withinProjectWindow: Math.abs(value - reference) <= margin };
}
let revision = null;
try { revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8', stdio:['ignore','pipe','ignore']}).trim(); } catch {}
const files = readdirSync(path.join(root, 'src/car')).filter(name => name.endsWith('.ts')).sort().map(name => 'src/car/' + name);
const hashes = Object.fromEntries(files.map(relative =>
  [relative, createHash('sha256').update(readFileSync(path.join(root, relative))).digest('hex')]));
const results = {
  revision, hashes, stepSeconds: dt,
  surface: 'flat dry asphalt, no wind, deterministic powertrain, base passports, no steering assistance',
  protocol: '3 s settling at standstill. When a nonzero starting speed is required, set body and wheel speeds consistently. From rest Logan accelerates with full throttle, Viper rolls on at 5 mph in first gear. Viper braking begins immediately at exactly 70 mph in third gear; endpoint 0.05 m/s. No simulated heat cycles.',
  controls: 'Pedals are applied directly to the same simulation step used in game, no test-only traction regulator.',
  passport: [VIPER, LOGAN].map(p => ({name:p.name,mass_kg:p.mass,abs:p.abs,tyre:p.шина,suspension:p.suspension})),
  sources: {
    logan:'https://auto.mail.ru/article/54096-vosmiklapannoe-serdtse-dlitelnyij-test-renault-log/',
    viper:'https://www.caranddriver.com/reviews/comparison-test/a15117228/2013-srt-viper-gts-vs-2013-chevrolet-corvette-zr1-comparison-test/',
  },
  comparisons: [
    comparison('Logan 0–80 km/h', t80, 9, 1, 's'),
    comparison('Logan 80–100 km/h, continuation of 0–80', t100-t80, 4, 1, 's'),
    comparison('Viper 70–0 mph', stop, 146 * 0.3048, 146 * 0.3048 * 0.07, 'm'),
    comparison('Viper rolling 5–60 mph', rollingTime, 4.4, 0.55, 's'),
  ],
};
writeFileSync(path.join(output, 'road-matches.csv'), rows.join('\n') + '\n');
writeFileSync(path.join(output, 'road-matches.json'), JSON.stringify(results, null, 2) + '\n');
console.table(results.comparisons);

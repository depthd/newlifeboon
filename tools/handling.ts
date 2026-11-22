/**
 * Driving measurements on the game's solver. Run with Node 24:
 * node tools/handling.ts <output-directory>
 * Output includes time histories at 20 Hz, inputs, protocols and pass/fail.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type Car,
  type Controls,
  createCar,
  forwardSpeed,
  PHYSICS_STEP as dt,
  step,
} from '../src/car/car.ts';
import { type Passport, LOGAN, VIPER } from '../src/car/passport.ts';
import type { Spot } from '../src/car/ground.ts';
import {
  halfWidth,
  laneOffset,
  pointAt,
  progressAt,
  radius,
  straight,
  trackLength,
  trackSurface,
} from '../src/trial/course.ts';
import { type Balance, trialPassport } from '../src/trial/profiles.ts';

const output = process.argv[2];
if (!output) throw Error('Usage: node tools/handling.ts <output-directory>');
mkdirSync(output, { recursive: true });
const flat: Spot = { height: 0, material: 'asphalt', nx: 0, ny: 1, nz: 0 };
const asphalt = () => flat;
const rad = Math.PI / 180;
const gravity = 9.80665;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(x, hi));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const pedals = (gas = 0, brake = 0, steer = 0, assist = false): Controls => ({
  steer: clamp(steer, -1, 1),
  throttle: clamp(gas, 0, 1),
  brake: clamp(brake, 0, 1),
  assist,
  handbrake: false,
});

function rolling(p: Passport, speed: number) {
  const car = createCar(p, 0, 0, 0);
  for (let tick = 0; tick < Math.round(2 / dt); tick++) step(car, p, p.шина, asphalt, pedals(), dt);
  car.vx = speed;
  for (const wheel of car.wheels) wheel.spin = speed / wheel.radius;
  // A rolling start in a suitable gear, using the model's own ratios and shift points.
  const wheelRpm = ((speed / car.wheels.find((w) => w.driven)!.radius) * 60) / (2 * Math.PI);
  while (car.gear < p.gears.length - 1 && wheelRpm * p.gears[car.gear] * p.finalDrive > p.переключение.вверх)
    car.gear++;
  return car;
}

const speedOf = (c: Car) => Math.hypot(c.vx, c.vz);
const sideslip = (c: Car) => wrap(Math.atan2(c.vz, c.vx) - c.yaw) / rad;
const columnNames =
  't_s,x_m,z_m,speed_kmh,yaw_deg,yaw_rate_degs,roll_deg,sideslip_deg,steer_road_deg,gas,brake,front_slip_ratio,rear_slip_ratio,front_slip_angle_deg,rear_slip_angle_deg,front_left_N,front_right_N,rear_left_N,rear_right_N,steer_requested_normalized,steering_assist_on';
function reading(t: number, c: Car, u: Controls): number[] {
  const w = c.wheels;
  return [
    t,
    c.x,
    c.z,
    speedOf(c) * 3.6,
    c.yaw / rad,
    c.yawRate / rad,
    c.roll / rad,
    sideslip(c),
    c.steer / rad,
    u.throttle,
    u.brake,
    (w[0].slip + w[1].slip) / 2,
    (w[2].slip + w[3].slip) / 2,
    (w[0].angle + w[1].angle) / 2 / rad,
    (w[2].angle + w[3].angle) / 2 / rad,
    ...w.map((wheel) => wheel.load),
    u.steer,
    Number(u.assist),
  ];
}
function csv(name: string, lines: number[][], extra = '') {
  if (lines.some((row) => row.some((value) => !Number.isFinite(value))))
    throw Error('Non-finite telemetry in ' + name);
  writeFileSync(
    join(output, name + '.csv'),
    columnNames +
      extra +
      '\n' +
      lines.map((line) => line.map((n) => n.toFixed(5)).join(',')).join('\n') +
      '\n',
  );
}
const sampleEvery = Math.round(0.05 / dt);

function speedController() {
  let integral = 0;
  return (v: number, target: number, steer: number) => {
    const error = target - v;
    integral = clamp(integral + 0.12 * error * dt, -0.15, 0.65);
    const command = 0.15 + 0.34 * error + integral;
    return pedals(command, -command * 0.38, steer);
  };
}

// Radial and heading feedback. No access to tyre parameters or measured track-test g.
function circleTrial(p: Passport, target: number, direction: number, progressive: boolean) {
  const R = 45.72; // 300-foot diameter, centreline
  const c = rolling(p, progressive ? 12 : target);
  const warmupAngle = (progressive ? 4 : 2) * Math.PI;
  const finishAngle = warmupAngle + 2 * Math.PI;
  const speedControl = speedController();
  let oldAngle = 0,
    distanceAngle = 0,
    steerTrim = 0,
    startTime = 0;
  let drift = 0,
    worstSpeedError = 0,
    endTime = 0,
    maxSlipFront = 0,
    maxSlipRear = 0;
  const rows: number[][] = [];
  for (let i = 0; i < Math.ceil(85 / dt); i++) {
    const angle = Math.atan2(c.x, R - direction * c.z);
    const radialError = Math.hypot(c.x, R - direction * c.z) - R;
    const v = speedOf(c);
    const headingError = wrap(direction * angle - Math.atan2(c.vz, c.vx));
    steerTrim = clamp(steerTrim + radialError * dt * 0.02, -0.12, 0.29);
    const desiredSteer =
      direction * (Math.atan(p.wheelbase / R) + 0.029 * radialError + steerTrim) +
      0.7 * headingError +
      0.14 * ((direction * v) / R - c.yawRate);
    const requestedSpeed = progressive ? Math.min(target, 12 + i * dt * 0.45) : target;
    const u = speedControl(v, requestedSpeed, desiredSteer / p.steerLock);
    const oldProgress = distanceAngle;
    step(c, p, p.шина, asphalt, u, dt);
    const newAngle = Math.atan2(c.x, R - direction * c.z);
    distanceAngle += wrap(newAngle - oldAngle);
    oldAngle = newAngle;
    const t = (i + 1) * dt;
    const crossing = (a: number) => (i + (a - oldProgress) / (distanceAngle - oldProgress)) * dt;
    if (oldProgress < warmupAngle && distanceAngle >= warmupAngle) startTime = crossing(warmupAngle);
    if (startTime > 0) {
      const r = Math.hypot(c.x, R - direction * c.z);
      drift = Math.max(drift, Math.abs(r - R));
      worstSpeedError = Math.max(worstSpeedError, Math.abs(speedOf(c) - target));
      maxSlipFront = Math.max(maxSlipFront, ...c.wheels.slice(0, 2).map((w) => Math.abs(w.angle) / rad));
      maxSlipRear = Math.max(maxSlipRear, ...c.wheels.slice(2).map((w) => Math.abs(w.angle) / rad));
      if (i % sampleEvery === 0) rows.push([...reading(t, c, u), r - R]);
    }
    if (oldProgress < finishAngle && distanceAngle >= finishAngle) {
      endTime = crossing(finishAngle);
      break;
    }
    if (!Number.isFinite(c.x) || Math.abs(radialError) > 8) break;
  }
  const lapS = endTime > startTime && startTime > 0 ? endTime - startTime : null;
  const g = lapS === null ? null : (((2 * Math.PI) / lapS) ** 2 * R) / gravity;
  return {
    direction,
    targetKmh: target * 3.6,
    lapS,
    g,
    maxRadiusErrorM: startTime > 0 ? drift : null,
    maxSpeedErrorMps: startTime > 0 ? worstSpeedError : null,
    peakFrontSlipAngleDeg: maxSlipFront,
    peakRearSlipAngleDeg: maxSlipRear,
    valid: lapS !== null && drift <= 0.75 && worstSpeedError <= 0.5,
    rows,
  };
}

function skidpad(p: Passport, key: string, progressive: boolean) {
  const directions = [1, -1].map((direction) => {
    const trials: Omit<ReturnType<typeof circleTrial>, 'rows'>[] = [];
    let fastest: ReturnType<typeof circleTrial> | undefined;
    for (let target = 15; target <= 24; target += 0.25) {
      const trial = circleTrial(p, target, direction, progressive);
      const { rows: _rows, ...metrics } = trial;
      trials.push(metrics);
      if (trial.valid && (trial.g ?? 0) > (fastest?.g ?? 0)) fastest = trial;
      if (trials.length >= 3 && trials.slice(-3).every((t) => !t.valid)) break;
    }
    if (fastest)
      csv(key + '-circle-' + (direction === 1 ? 'right' : 'left'), fastest.rows, ',radial_error_m');
    return { direction, bestG: fastest?.g ?? null, bestKmh: fastest?.targetKmh ?? null, trials };
  });
  const g = directions.every((d) => d.bestG !== null)
    ? directions.reduce((s, d) => s + d.bestG!, 0) / 2
    : null;
  return { g, directions };
}

// Open-loop replay: identical road-wheel angle and pedal timeline for both cars.
function corner(p: Passport, key: string, gasMode: 'early' | 'late' | 'lift', assist = false) {
  const c = rolling(p, 66 / 3.6);
  const rows: number[][] = [];
  let maxSideslip = 0,
    maxYaw = 0,
    at4s = 0,
    firstPeak: string | null = null,
    firstPeakS: number | null = null;
  for (let i = 0; i < Math.round(5 / dt); i++) {
    const t = i * dt;
    const turnIn = clamp((t - 0.6) / 0.45, 0, 1);
    const unwind = clamp((4.2 - t) / 0.85, 0, 1);
    let gas = 0;
    if (
      (gasMode === 'early' && t >= 1.3) ||
      (gasMode === 'late' && t >= 2.6) ||
      (gasMode === 'lift' && t >= 1.3 && t < 2.15)
    )
      gas = 0.72;
    const u = pedals(
      gas,
      t >= 0.18 && t < 0.6 ? 0.38 : 0,
      (3.6 * rad * turnIn * unwind) / p.steerLock,
      assist,
    );
    step(c, p, p.шина, asphalt, u, dt);
    if (t > 0.6) {
      maxSideslip = Math.max(maxSideslip, Math.abs(sideslip(c)));
      maxYaw = Math.max(maxYaw, Math.abs(c.yawRate / rad));
      if (firstPeak === null && c.wheels.some((w) => w.use >= 1)) {
        const frontAtPeak = c.wheels[0].use >= 1 || c.wheels[1].use >= 1;
        const rearAtPeak = c.wheels[2].use >= 1 || c.wheels[3].use >= 1;
        firstPeak = frontAtPeak && rearAtPeak ? 'both' : frontAtPeak ? 'front' : 'rear';
        firstPeakS = (i + 1) * dt;
      }
    }
    if (i === Math.round(4 / dt) - 1) at4s = speedOf(c) * 3.6;
    if (i % sampleEvery === sampleEvery - 1) rows.push(reading((i + 1) * dt, c, u));
  }
  csv(key + '-corner-' + gasMode, rows);
  return {
    gasMode,
    assist,
    finalX: c.x,
    finalZ: c.z,
    finalSpeedKmh: speedOf(c) * 3.6,
    speedAt4sKmh: at4s,
    maxSideslipDeg: maxSideslip,
    maxYawDegS: maxYaw,
    firstTyreAtPeakAxle: firstPeak,
    firstPeakS,
  };
}

function steering(c: Car, p: Passport, x: number, z: number) {
  const dx = x - c.x,
    dz = z - c.z;
  const lateral = -dx * Math.sin(c.yaw) + dz * Math.cos(c.yaw);
  return Math.atan((2 * p.wheelbase * lateral) / Math.max(1, dx * dx + dz * dz)) / p.steerLock;
}
function laneCentre(x: number) {
  const smooth = (t: number) => {
    const a = clamp(t, 0, 1);
    return a ** 3 * (10 - 15 * a + 6 * a * a);
  };
  return 3.5 * (smooth((x - 18) / 36) - smooth((x - 77) / 36));
}

function laneChange(p: Passport, key: string) {
  const c = rolling(p, 60 / 3.6),
    speedControl = speedController(),
    rows: number[][] = [];
  let maxError = 0,
    peakYaw = 0,
    peakRoll = 0,
    endInLane = false,
    reachedOther = false;
  for (let i = 0; i < Math.round(14 / dt); i++) {
    const targetX = c.x + 9;
    const u = speedControl(speedOf(c), 60 / 3.6, steering(c, p, targetX, laneCentre(targetX)));
    step(c, p, p.шина, asphalt, u, dt);
    const pathZ = laneCentre(c.x);
    maxError = Math.max(maxError, Math.abs(c.z - pathZ));
    peakYaw = Math.max(peakYaw, Math.abs(c.yawRate / rad));
    peakRoll = Math.max(peakRoll, Math.abs(c.roll / rad));
    if (c.x >= 54 && c.x <= 77 && Math.abs(c.z - 3.5) < 0.5) reachedOther = true;
    if (i % sampleEvery === sampleEvery - 1) rows.push([...reading((i + 1) * dt, c, u), pathZ]);
    if (c.x > 155) {
      endInLane = Math.abs(c.z) < 0.4 && Math.abs(c.yawRate / rad) < 2;
      break;
    }
  }
  csv(key + '-lane', rows, ',target_z_m');
  return {
    maxPathErrorM: maxError,
    peakYawDegS: peakYaw,
    peakRollDeg: peakRoll,
    terminalYawDegS: c.yawRate / rad,
    passed: reachedOther && endInLane && maxError < 1.25,
  };
}

function circuit(p: Passport, key: string) {
  const c = rolling(p, 15),
    speedControl = speedController(),
    rows: number[][] = [];
  const halfLap = straight + Math.PI * radius;
  const boundaries = [straight, halfLap, halfLap + straight, trackLength];
  const splits: number[] = [];
  let previous = 0,
    maxOffset = 0,
    allWheelsOnAsphalt = true,
    worstCornerSpeed = Infinity;
  for (let i = 0; i < Math.round(65 / dt); i++) {
    const s = progressAt(c.x, c.z);
    const phase = s % halfLap;
    const target = phase < straight ? Math.min(31, Math.sqrt(15 ** 2 + 2 * 4.2 * (straight - phase))) : 15;
    const aim = pointAt(s + clamp(speedOf(c) * 0.57, 8, 15));
    const u = speedControl(speedOf(c), target, steering(c, p, aim.x, aim.z));
    step(c, p, p.шина, trackSurface, u, dt);
    let next = progressAt(c.x, c.z);
    if (previous > trackLength / 2 && next < trackLength / 4) next += trackLength;
    if (next >= boundaries[splits.length] && next > previous)
      splits.push((i + (boundaries[splits.length] - previous) / (next - previous)) * dt);
    previous = next;
    maxOffset = Math.max(maxOffset, Math.abs(laneOffset(c.x, c.z)));
    if (c.wheels.some((w) => w.material !== 'asphalt')) allWheelsOnAsphalt = false;
    if (phase > straight) worstCornerSpeed = Math.min(worstCornerSpeed, speedOf(c));
    if (i % sampleEvery === sampleEvery - 1) rows.push([...reading((i + 1) * dt, c, u), next, target * 3.6]);
    if (splits.length === 4) break;
  }
  csv(key + '-lap', rows, ',progress_m,target_kmh');
  return {
    lapS: splits.length === 4 ? splits[3] : null,
    splitCount: splits.length,
    sectorsS: splits.map((t, i) => t - (splits[i - 1] ?? 0)),
    maxOffsetM: maxOffset,
    allWheelsOnAsphalt,
    minCornerSpeedKmh: worstCornerSpeed * 3.6,
    passed: splits.length === 4 && maxOffset < halfWidth && allWheelsOnAsphalt,
  };
}

function braking70(p: Passport) {
  const v0 = 70 * 0.44704;
  const c = rolling(p, v0);
  const u = pedals(0, 1);
  const origin = c.x;
  const initialGear = c.gear + 1;
  for (let i = 0; i < Math.round(15 / dt); i++) {
    step(c, p, p.шина, asphalt, u, dt);
    if (forwardSpeed(c) < 0.1)
      return { distanceM: c.x - origin, initialGear, timeS: (i + 1) * dt, terminalMps: forwardSpeed(c) };
  }
  throw Error('70 mph brake run did not stop');
}

const root = resolve(import.meta.dirname, '..');
const sources = [
  'tools/handling.ts',
  ...readdirSync(join(root, 'src/car'))
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => 'src/car/' + name),
  'src/trial/course.ts',
  'src/trial/profiles.ts',
];
const sourceHashes = Object.fromEntries(
  sources.map((f) => [
    f,
    createHash('sha256')
      .update(readFileSync(join(root, f)))
      .digest('hex'),
  ]),
);
const cars = [
  ['logan', LOGAN],
  ['viper', VIPER],
] as const;
const results = cars.map(([key, p]) => {
  const circle = skidpad(p, key, true);
  const flyingStartCircle = skidpad(p, key + '-flying', false);
  const corners = (['early', 'late', 'lift'] as const).map((mode) => corner(p, key, mode));
  const balance = (['a', 'b'] as Balance[]).map((profile) => ({
    profile,
    ...corner(trialPassport(p, profile), key + '-' + profile, 'early'),
  }));
  return {
    key,
    circle,
    flyingStartCircle,
    corners,
    assistedCorner: corner(p, key + '-assist', 'early', true),
    balance,
    lane: laneChange(p, key),
    lap: circuit(p, key),
    braking70: braking70(p),
  };
});
const viper = results.find((r) => r.key === 'viper')!;
const checks = {
  finite: results.every((r) =>
    [...r.corners, ...r.balance, r.assistedCorner].every((a) =>
      [a.finalX, a.finalZ, a.maxYawDegS].every(Number.isFinite),
    ),
  ),
  bothDirections: results.every((r) => r.circle.directions.every((d) => d.bestG !== null)),
  profileEffect: results.every((r) => r.balance[1].maxSideslipDeg - r.balance[0].maxSideslipDeg > 5),
  assistEffect: results.every(
    (r) =>
      Math.hypot(
        r.assistedCorner.finalX - r.corners[0].finalX,
        r.assistedCorner.finalZ - r.corners[0].finalZ,
      ) > 0.1,
  ),
  laneAndLap: results.every((r) => r.lane.passed && r.lap.passed),
  viper300ft: viper.circle.g !== null && Math.abs(viper.circle.g - 1.02) <= 0.06,
  viperBraking70: Math.abs(viper.braking70.distanceM - 44.5008) <= 44.5008 * 0.07,
};
if (
  sources.some(
    (f) =>
      sourceHashes[f] !==
      createHash('sha256')
        .update(readFileSync(join(root, f)))
        .digest('hex'),
  )
) {
  throw Error('Physics or benchmark code changed during the run. Repeat on an immutable revision.');
}
// A downloaded source archive has no .git directory; file hashes still identify it.
let gitCommit: string | null = null;
try {
  gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  // Commit metadata is optional in an exported build.
}
const report = {
  gitCommit,
  sourceHashes,
  physicsHz: 1 / dt,
  samplingHz: 1 / (sampleEvery * dt),
  assisted: 'off except for the named assistedCorner replay',
  surface: 'analytic dry flat asphalt; stadium has grass beyond ±6 m',
  protocol: {
    circle:
      '300 ft diameter; clockwise/counterclockwise; targets every 0.25 m/s. Progressive entry starts at 12 m/s, rises by 0.45 m/s² to target with 2 warm-up laps; then 1 timed lap. Secondary flying-start robot enters at target with 1 warm-up lap. Same gains, tyres and measurement gates. Valid lap requires radial error ≤0.75 m and speed error ≤0.5 m/s throughout. g=(2π/t)²·R/9.80665. Best valid lap per direction, then mean. Three consecutive misses end sweep. Result includes driver limitations.',
    corner:
      'Rolling start 66 km/h. Brake 38% at 0.18–0.60 s. Ramp to 3.6° road steer at 0.60–1.05 s; unwind over 3.35–4.20 s. Early gas 72% from 1.30 s, late from 2.60 s, lift has early gas until 2.15 s. First peak is combined-slip measure on any single tyre after brake release.',
    lane: '60 km/h target. Two quintic lane changes of 3.5 m over 36 m each, 23 m in other lane. Pass reaches adjacent lane within 0.5 m, centreline error <1.25 m and at x=155 m error <0.4 m, yaw rate <2°/s. Bespoke engineering check.',
    lap: 'Rolling start 54 km/h. Same pure-pursuit steering driver and target profile on stadium, straights 120 m, turns R38 m, no assists. Four sectors at geometric transitions. Require one full lap with every wheel on asphalt. Times characterize this driver and circuit.',
    source:
      'Car and Driver, 2013 SRT Viper GTS vs. Chevrolet Corvette ZR1, test sheet for Viper. 1.02 g and 146 ft. Steering pad goal ±0.06 g, 70→0 mph distance ±7%. Project engineering tolerances chosen before these runs.',
    steeringReference:
      'R. Craig Coulter, Implementation of the Pure Pursuit Path Tracking Algorithm (1992), https://www.ri.cmu.edu/publications/implementation-of-the-pure-pursuit-path-tracking-algorithm/ . Adapted geometric curvature 2·crossTrack/previewDistance² for lap and lane change.',
    sourceURL:
      'https://www.caranddriver.com/reviews/comparison-test/a15117228/2013-srt-viper-gts-vs-2013-chevrolet-corvette-zr1-comparison-test/',
    stop: '70 mph rolling equilibrium on dry asphalt, pedal immediately to 100%, threshold 0.10 m/s. No reaction distance. Programme uses passport braking system.',
  },
  checks,
  results,
};
writeFileSync(join(output, 'handling.json'), JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      checks,
      results: results.map((r) => ({
        car: r.key,
        circleG: r.circle.g,
        lane: r.lane,
        lap: r.lap,
        brake: r.braking70,
        corner: r.corners,
        balance: r.balance,
      })),
    },
    null,
    2,
  ),
);
if (Object.values(checks).includes(false)) process.exitCode = 1;

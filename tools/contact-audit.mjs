// node tools/contact-audit.mjs [project-root] [report.json | --summary]
// Loads each checkout through its own physics entry point for identical before/after inputs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] || fileURLToPath(new URL('..', import.meta.url)));
const moduleUrl = name => pathToFileURL(resolve(root, 'src/car', name)).href;
const { createCar, step, изУглов, точкаКузова, углыКузова, центрКолеса } = await import(moduleUrl('car.ts'));
const { VIPER, LOGAN } = await import(moduleUrl('passport.ts'));
const g = 9.80665;
const idle = { steer: 0, throttle: 0, brake: 0, handbrake: false, assist: false };
const handbrake = { ...idle, handbrake: true };
const brake = { ...idle, brake: 1 };
const asphalt = { height: 0, nx: 0, ny: 1, nz: 0, material: 'asphalt' };
const noRoad = { ...asphalt, present: false, height: -10000 };
const grass = { ...asphalt, material: 'grass' };
const flat = () => asphalt;
const grade = 0.1;
const ramp = x => ({ ...asphalt, height: grade*x, nx: -grade / Math.hypot(1, grade), ny: 1 / Math.hypot(1, grade) });

function valid(car) {
  return [car.x, car.y, car.z, car.vx, car.vy, car.vz, ...Object.values(car.q), ...Object.values(car.вращение)].every(Number.isFinite)
    && car.wheels.every(w => [w.spin, w.travel, w.slip, w.angle, w.load].every(Number.isFinite) && w.load >= 0 && w.travel >= 0);
}

function simulate(p, hz, scenario, duration, car, surface, controls, observe = () => {}, stop = () => false) {
  const trace = [];
  let finite = true;
  let elapsed = 0;
  const fixed = 1 / hz;
  const record = () => {
    const points = [elapsed, car.x, car.y, car.z, car.vy, car.roll, ...car.wheels.map(w => w.load)];
    if (scenario === 'edge-right') {
      const body = углыКузова(p).map(c => точкаКузова(car, ...c));
      const wheels = car.wheels.map(w => центрКолеса(car, w, w.travel));
      points.push([...body, ...wheels].map(v => [v.z, v.y]));
    }
    trace.push(points);
  };
  if (hz === 600) record();
  for (let n = 1; n <= hz * duration; n++) {
    step(car, p, p.шина, surface, controls, fixed);
    elapsed = n / hz;
    if (!valid(car)) { finite = false; break; }
    observe(car, n);
    if (hz === 600 && n % (hz/30) === 0) record();
    if (stop(car)) break;
  }
  return { car: p.ярлык, hz, scenario, duration_s: elapsed, checks: { finite }, metrics: {}, trace };
}

function atRest(p, hz) {
  const car = createCar(p, 0, 0, 0);
  for (let n = 0; n < 3 * hz; n++) step(car, p, p.шина, flat, idle, 1 / hz);
  return car;
}

function penetrating(p, car, surface) {
  let depth = 0;
  for (const local of углыКузова(p)) {
    const corner = точкаКузова(car, ...local);
    const road = surface(corner.x, corner.z);
    if (road.present !== false) depth = Math.max(depth, road.height - corner.y);
  }
  return depth;
}

function rest(p, hz) {
  const car = atRest(p, hz);
  const origin = [car.x, car.y, car.z];
  let drift = 0, weightError = 0, allContact = true;
  const r = simulate(p, hz, 'rest', 5, car, flat, idle, () => {
    drift = Math.max(drift, Math.hypot(car.x-origin[0], car.y-origin[1], car.z-origin[2]));
    const total = car.wheels.reduce((s,w) => s+w.load, 0);
    weightError = Math.max(weightError, Math.abs(total/(g*p.mass) - 1));
    allContact &&= car.wheels.every(w => w.load > 0);
  });
  Object.assign(r.metrics, { max_drift_m: drift, load_error_fraction: weightError });
  Object.assign(r.checks, { drift: drift <= 0.01, weight: weightError <= 0.01, fourWheels: allContact });
  return r;
}

function edge(p, hz, side, angle = 0) {
  const car = atRest(p, hz), start = car.y;
  const radians = angle * Math.PI / 180;
  const support = (x, z) => side * (z * Math.cos(radians) + x * Math.sin(radians)) > 0 ? noRoad : asphalt;
  let rise = 0, projectedDepth = 0, solidDepth = 0, initialLoads;
  const name = 'edge-' + (side > 0 ? 'right' : 'left') + (angle ? '-oblique' : '');
  const r = simulate(p, hz, name, 2, car, support, idle, (_, n) => {
    if (n === 1) initialLoads = car.wheels.map(w => w.load);
    rise = Math.max(rise, car.y-start);
    const corners = углыКузова(p).map(local => {
      const v = точкаКузова(car,...local);
      return { top: -v.y, wall: -side * (v.z*Math.cos(radians) + v.x*Math.sin(radians)) };
    });
    for (const [i,a] of corners.entries()) {
      if (a.wall >= 0) projectedDepth = Math.max(projectedDepth, a.top);
      solidDepth = Math.max(solidDepth, Math.min(a.top,a.wall));
      // Inside the solid, distance to its boundary is min(top depth, side depth).
      // On a box edge the maximum is at an endpoint or where these two depths cross.
      for (const bit of [1,2,4]) {
        if (i & bit) continue;
        const b = corners[i|bit], start = a.top-a.wall, end = b.top-b.wall;
        if (start * end < 0) {
          const t = start / (start-end);
          solidDepth = Math.max(solidDepth, a.top + t*(b.top-a.top));
        }
      }
    }
  });
  Object.assign(r.metrics, { rise_m: rise, deepest_corner_below_top_m: projectedDepth, solid_hull_intrusion_m: solidDepth, initial_loads_N: initialLoads, end_dy_m: car.y-start });
  Object.assign(r.checks, { twoWheels: initialLoads?.every((load, i) => ((i%2 ? 1 : -1)*side > 0 ? load === 0 : load > 0)) ?? false, noLaunch: rise <= .05 });
  return r;
}

function flight(passport, hz) {
  const p = { ...passport, liftArea: 0, dragArea: 0, rollingResistance: 0 };
  const car = atRest(p, hz);
  Object.assign(car, { y: 100, vx: .1, vy: 0, vz: 0, q: изУглов(0), вращение: { x: 0, y: 1, z: 0 } });
  const energy = () => p.mass*g*car.y + .5*p.mass*(car.vx**2+car.vy**2+car.vz**2) + .5*p.yawInertia*car.вращение.y**2;
  const e0 = energy(), tolerance = .5*g*2/hz + .001;
  let eError = 0, maxLoad = 0;
  const r = simulate(p,hz,'flight',2,car,() => noRoad,idle,() => {
    eError = Math.max(eError, Math.abs(energy()-e0));
    maxLoad = Math.max(maxLoad, ...car.wheels.map(w=>w.load));
  });
  Object.assign(r.metrics, { final_vx_mps: car.vx, final_spin_radps: car.вращение.y, max_translational_and_yaw_energy_drift_J: eError });
  Object.assign(r.checks, { empty: maxLoad === 0, vx: Math.abs(car.vx-.1) < 1e-6, yaw: Math.abs(car.вращение.y-1) < 1e-6,
    vy: Math.abs(car.vy+2*g) < 1e-6, height: Math.abs(car.y-(100-2*g)) <= tolerance, energy: eError <= p.mass*g*tolerance });
  return r;
}

function drop(p,hz,height) {
  const car = atRest(p,hz), restY = car.y;
  car.y += height;
  let airborne = false, landed = false, rise = 0, penetration = 0, rebound = 0, bottom = Infinity;
  let tyreBelowSurface = 0, bumpTravel = 0;
  const r = simulate(p,hz,'drop-'+height+'m',5,car,flat,idle,() => {
    const load = car.wheels.some(w=>w.load>0);
    airborne ||= !load;
    landed ||= airborne && load;
    if (landed) {
      bottom = Math.min(bottom, car.y);
      rebound = Math.max(rebound, car.y-bottom);
    }
    rise = Math.max(rise, car.y-restY-height);
    penetration = Math.max(penetration, penetrating(p,car,flat));
    for (const w of car.wheels) {
      const hub = центрКолеса(car, w, w.travel);
      tyreBelowSurface = Math.max(tyreBelowSurface, w.radius - hub.y);
      bumpTravel = Math.max(bumpTravel, w.travel - p.suspension.travel);
    }
  });
  const finalSpeed = Math.hypot(car.vx,car.vy,car.vz);
  Object.assign(r.metrics, { hull_intrusion_m: penetration, rebound_from_compression_m: rebound, rise_above_release_m: rise,
    wheel_bottom_below_surface_m: tyreBelowSurface, stroke_beyond_nominal_m: bumpTravel,
    final_y_minus_rest_m: car.y-restY, final_speed_mps: finalSpeed });
  Object.assign(r.checks, { airborne, landed, release: rise <= .01, penetration: penetration <= .02, fourWheels: car.wheels.every(w=>w.load>0),
    finalHeight: Math.abs(car.y-restY)<=.02, finalSpeed: finalSpeed<=.05 });
  return r;
}

function slope(p,hz,held) {
  const car = createCar(p,0,0,0);
  car.q = изУглов(0,Math.atan(grade));
  let maxShift = 0;
  const r = simulate(p,hz,held?'slope-held':'slope-free',held?10:5,car,ramp,held?handbrake:idle,() => {
    maxShift = Math.max(maxShift, Math.hypot(car.x,car.z));
  });
  Object.assign(r.metrics, { max_shift_m: maxShift, final_x_m: car.x, final_vx_mps: car.vx });
  if (held) r.checks.holds = maxShift <= .05;
  else r.checks.rollsDownhill = car.x < -.5;
  return r;
}

function mixedGrip(p,hz) {
  const surfaces = { asphalt: flat, mixed: (_x,z) => z>0?grass:asphalt, grass: () => grass };
  const rows = [];
  for (const [name,ground] of Object.entries(surfaces)) {
    const car = atRest(p,hz);
    car.vx = 60/3.6;
    for (const w of car.wheels) w.spin = car.vx / w.radius;
    let x = car.x, z = car.z, path = 0;
    const r = simulate(p,hz,'braking-'+name,15,car,ground,brake,() => {
      path += Math.hypot(car.x-x,car.z-z); x=car.x; z=car.z;
    }, () => Math.hypot(car.vx,car.vz) <= 1);
    Object.assign(r.metrics, { stop_path_m: path, end_yaw_deg: car.yaw * 180/Math.PI, end_z_m: car.z });
    r.checks.stopped = Math.hypot(car.vx,car.vz) <= 1;
    rows.push(r);
  }
  const [dry,split,soft] = rows.map(r=>r.metrics.stop_path_m);
  rows[1].checks.splitBetweenSurfaces = dry<split && split<soft;
  return rows;
}

function curb(p,hz) {
  const c = atRest(p,hz), speed = 8;
  c.vx = speed;
  for (const w of c.wheels) w.spin = speed/w.radius;
  const surface = (x,z) => {
    if (z<0 || x<5 || x>7) return asphalt;
    const phase = Math.PI*(x-5)/2, slope = .04*Math.PI*Math.sin(2*phase);
    return { ...asphalt, material:'curb', height:.08*Math.sin(phase)**2, nx:-slope/Math.hypot(1,slope), ny:1/Math.hypot(1,slope) };
  };
  const wheelsTouched = new Set();
  let roll = 0;
  const r = simulate(p,hz,'one-sided-curb',4,c,surface,idle,() => {
    c.wheels.forEach((w,i)=>{if (w.material==='curb' && w.load>0) wheelsTouched.add(i);});
    roll = Math.max(roll, Math.abs(c.roll)*180/Math.PI);
  });
  Object.assign(r.metrics,{ max_roll_deg:roll, supported_on_curb:[...wheelsTouched] });
  Object.assign(r.checks,{ bothAxles: wheelsTouched.has(1) && wheelsTouched.has(3), roll: roll>=.1 && roll<=30 });
  return r;
}

const rows = [];
for (const p of [VIPER,LOGAN]) {
  for (const hz of [300,600,1200]) {
    rows.push(rest(p,hz), edge(p,hz,1), edge(p,hz,-1), edge(p,hz,1,20), edge(p,hz,-1,20), flight(p,hz), drop(p,hz,.5), drop(p,hz,2),
      slope(p,hz,true), slope(p,hz,false), ...mixedGrip(p,hz), curb(p,hz));
  }
}
const failed = rows.filter(r=>Object.values(r.checks).some(ok=>!ok));
const hashes = Object.fromEntries(readdirSync(resolve(root,'src/car')).filter(name=>name.endsWith('.ts')).sort().map(name=>
  [name,createHash('sha256').update(readFileSync(resolve(root,'src/car',name))).digest('hex')]));
let revision = null;
try {
  revision = execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
} catch { /* Source archives carry the same source hashes without repository metadata. */ }
const result = { revision, auditSha256:createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  physicsSourceSha256:hashes, node:process.version, traceColumns:['s','x_m','y_m','z_m','vy_mps','roll_rad','FL_N','FR_N','RL_N','RR_N','edge-right only: 8 body corners + 4 wheel centers as [z_m,y_m]'],
  checksPassed:rows.length-failed.length, checksTotal:rows.length, rows };
if (process.argv[3]) {
  if (process.argv[3] !== '--summary') writeFileSync(process.argv[3],JSON.stringify(result)+'\n');
  for (const r of failed) console.log(r.car, r.hz, r.scenario, Object.keys(r.checks).filter(k=>!r.checks[k]).join(', '));
  console.log(result.checksPassed+'/'+result.checksTotal+' scenario rows passed');
} else console.log(JSON.stringify(result));
process.exitCode = failed.length ? 1 : 0;

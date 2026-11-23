import assert from 'node:assert/strict';
import { createDriver } from '../src/car/controls.ts';
import { createCar, PHYSICS_STEP as dt, step } from '../src/car/car.ts';
import { LOGAN, VIPER } from '../src/car/passport.ts';

const events = new EventTarget();
const surface = new EventTarget();
const fakeAim = { take() {}, give() {}, held: () => false, onMove() {}, onTake() {}, detach() {} };
globalThis.addEventListener = events.addEventListener.bind(events);
globalThis.removeEventListener = events.removeEventListener.bind(events);
let pads = [];
Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => pads } });

function key(type, code) {
  const event = new Event(type);
  Object.defineProperty(event, 'code', { value: code });
  events.dispatchEvent(event);
}

const straight = { steer: 0, throttle: 0, brake: 0, handbrake: false, assist: true };
const asphalt = { height: 0, nx: 0, ny: 1, nz: 0, material: 'asphalt' };
const road = () => asphalt;
function atSpeed(passport, speed) {
  const car = createCar(passport, 0, 0, 0);
  for (let i = 0; i < 600; i++) step(car, passport, passport.шина, road, straight, dt);
  car.vx = speed / 3.6;
  for (const wheel of car.wheels) wheel.spin = car.vx / wheel.radius;
  car.gear = 2;
  return car;
}

function reversal(passport, setting) {
  const car = atSpeed(passport, 60);
  const driver = createDriver(surface, fakeAim);
  driver.keyboard = setting;
  const tick = () => step(car, passport, passport.шина, road, driver.read(dt, Math.hypot(car.vx, car.vz)), dt);
  key('keydown', 'KeyD');
  for (let i = 0; i < 600; i++) tick();
  assert.ok(car.steer > 0.02, 'D must work with a resting gamepad connected');
  key('keyup', 'KeyD');
  key('keydown', 'KeyA');
  let wheels;
  let trajectory;
  let course = Math.atan2(car.vz, car.vx);
  for (let i = 1; i <= 600; i++) {
    tick();
    const nextCourse = Math.atan2(car.vz, car.vx);
    if (wheels === undefined && car.steer < -0.002) wheels = i * dt;
    if (trajectory === undefined && nextCourse < course - 0.00001) trajectory = i * dt;
    course = nextCourse;
  }
  driver.detach();
  return { wheels: Math.round(wheels * 1000), trajectory: Math.round(trajectory * 1000) };
}

pads = [{ axes: [0], buttons: [] }];
for (const passport of [LOGAN, VIPER]) {
  const old = reversal(passport, 'legacy');
  const current = reversal(passport, 'responsive');
  assert.ok(current.wheels < 100 && old.wheels > 500, 'quick corrections must cross the centre within 100 ms');
  assert.ok(current.trajectory < 200 && old.trajectory > 500, 'the movement itself must respond to the correction');
  console.log(passport.ярлык, 'колёса и траектория, мс', old, '→', current);
}

const driver = createDriver(surface, fakeAim);
pads = [{ axes: [0.45], buttons: [{}, {}, {}, {}, {}, {}, { value: 0.2 }, { value: 0.7 }] }];
assert.deepEqual(driver.read(dt, 25), { steer: 0.45, throttle: 0.7, brake: 0.2, handbrake: false, assist: true });
pads[0].axes[0] = 0;
assert.equal(driver.read(dt, 25).steer, 0);
driver.detach();

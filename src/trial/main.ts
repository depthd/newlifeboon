import { type Car, type Controls, createCar, PHYSICS_STEP, step } from '../car/car.ts';
import { createDriver, type KeyboardSteering } from '../car/controls.ts';
import { LOGAN, VIPER } from '../car/passport.ts';
import { halfWidth, laneOffset, pointAt, progressAt, trackLength, trackSurface } from './course.ts';
import { type Balance, trialPassport } from './profiles.ts';
import { ChaseView, resizeCanvas } from './view.ts';

type Mode = 'stock' | 'balance' | 'assist';
type Letter = 'A' | 'B';
type Sample = { t: number; x: number; z: number; kmh: number; steer: number; wheelAngle: number; gas: number; brake: number };
type Run = {
  model: string;
  mode: Mode;
  letter: string;
  balance: Balance;
  assist: boolean;
  keyboard: KeyboardSteering;
  start_kmh: number;
  samples: Sample[];
  laps: number[];
  clipped: boolean;
};
function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
const scene = element<HTMLCanvasElement>('scene'),
  map = element<HTMLCanvasElement>('map');
const view = new ChaseView(scene);
const go = element<HTMLButtonElement>('start'),
  exportButton = element<HTMLButtonElement>('export');
const speedEl = element('speed'),
  gearEl = element('gear'),
  clockEl = element('simclock'),
  lapEl = element('lap'),
  steeringEl = element('steering-angle');
const speedSelect = element<HTMLSelectElement>('start-speed'),
  keyboardSelect = element<HTMLSelectElement>('keyboard-steering');
const experiments = element('experiments'),
  brief = element('brief'),
  details = element('details'),
  state = element('state');
const reveal = element<HTMLButtonElement>('reveal');
const legend = element('legend');
const choose = element<HTMLButtonElement>('choose');
const bit = () => (crypto.getRandomValues(new Uint32Array(1))[0] & 1) === 1;
function blindOrder(): { balance: boolean; assist: boolean } {
  const key = 'lifeboon-handling-order-v1';
  try {
    const saved = localStorage.getItem(key);
    if (saved && /^[01]{2}$/.test(saved)) return { balance: saved[0] === '1', assist: saved[1] === '1' };
    const fresh = { balance: bit(), assist: bit() };
    localStorage.setItem(key, Number(fresh.balance).toString() + Number(fresh.assist));
    return fresh;
  } catch {
    return { balance: bit(), assist: bit() };
  }
}
const order = blindOrder();
const choices: Record<string, Letter> = {};
const neutral: Controls = { steer: 0, throttle: 0, brake: 0, handbrake: false, assist: false };
const startX = 84;
const samplesHz = 10;
const traceColors: Record<string, string> = { Серия: '#dafe63', A: '#75d9e3', B: '#ffad72' };

let mode: Mode = 'stock',
  letter: Letter = 'A',
  model = LOGAN;
let passport = model,
  car: Car,
  driver = createDriver(scene);
let run: Run,
  history: Run[] = [];
let running = false,
  opened = false,
  elapsed = 0,
  residual = 0,
  ticks = 0;
let lapMeters = 0,
  previousProgress = 0,
  lastLine = 0,
  validLap = true;

function underlying(): 'a' | 'b' {
  if (mode === 'stock') return 'a';
  return (letter === 'A') !== order[mode] ? 'a' : 'b';
}

function selections() {
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-car]')))
    b.setAttribute('aria-pressed', String(model === (b.dataset.car === 'viper' ? VIPER : LOGAN)));
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-mode]')))
    b.setAttribute('aria-pressed', String(mode === b.dataset.mode));
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-letter]')))
    b.setAttribute('aria-pressed', String(letter === b.dataset.letter));
  experiments.hidden = mode === 'stock';
  const preferred = choices[model.ярлык + '/' + mode];
  choose.textContent = preferred === letter ? '✓ Выбран ' + letter : 'Мне ближе ' + letter;
  choose.setAttribute('aria-pressed', String(preferred === letter));
  const latest = underlying();
  const info =
    mode === 'balance'
      ? latest === 'a'
        ? 'У передних шин на 40% меньше поперечного сцепления. На пределе машина сильнее распрямляет поворот.'
        : 'У задних шин на 40% меньше поперечного сцепления. На пределе заднюю ось легче сорвать в скольжение.'
      : latest === 'a'
        ? 'Помощь выключена. Колёса следуют за заданным углом руля.'
        : 'Помощь включена. На скорости действуют ограничение угла и контрруль.';
  details.textContent = info;
  details.hidden = !opened || mode === 'stock';
  reveal.setAttribute('aria-expanded', String(!details.hidden));
  reveal.textContent = opened ? 'Скрыть настройки' : 'Раскрыть настройки';
  brief.textContent =
    mode === 'stock'
      ? 'У трёх конусов поверни вправо. Для первой попытки отпусти газ до выхода из поворота.'
      : mode === 'balance'
        ? 'Для сравнения шин выбери старт на 60 км/ч и повтори один поворот в A и B. Помощь рулю выключена в обоих заездах.'
        : 'Одна серийная машина и две настройки руля. В A и B попробуй быстро вернуть машину на дугу после коррекции.';
  const letters = mode === 'stock' ? ['Серия'] : ['A', 'B'];
  legend.replaceChildren();
  for (const name of letters) {
    const tag = document.createElement('span'),
      line = document.createElement('i');
    line.style.background = traceColors[name];
    tag.append(line, name);
    legend.append(tag);
  }
}

function newCar(): Car {
  const balance: Balance = mode === 'balance' ? underlying() : 'standard';
  passport = trialPassport(model, balance);
  driver.assist = mode === 'stock' || (mode === 'assist' && underlying() === 'b');
  driver.keyboard = keyboardSelect.value === 'legacy' ? 'legacy' : 'responsive';
  const c = createCar(passport, startX, 0, 0);
  for (let i = 0; i < Math.round(1 / PHYSICS_STEP); i++)
    step(c, passport, passport.шина, trackSurface, neutral, PHYSICS_STEP);
  const startKmh = Number(speedSelect.value);
  c.vx = startKmh / 3.6;
  for (const wheel of c.wheels) wheel.spin = c.vx / wheel.radius;
  const wheel = c.wheels.find((w) => w.driven)!;
  const rpm = (ratio: number) => (wheel.spin * ratio * passport.finalDrive * 60) / (2 * Math.PI);
  c.gear = passport.gears.findIndex((r) => rpm(r) < passport.переключение.вверх * 0.74);
  c.gear = Math.max(0, c.gear);
  c.rpm = Math.max(passport.idleRpm, rpm(passport.gears[c.gear]));
  run = {
    model: model.ярлык,
    mode,
    letter: mode === 'stock' ? 'Серия' : letter,
    balance,
    assist: driver.assist,
    keyboard: driver.keyboard,
    start_kmh: startKmh,
    samples: [],
    laps: [],
    clipped: false,
  };
  return c;
}

function timeText(t: number) {
  return Math.floor(t / 60) + ':' + (t % 60).toFixed(1).padStart(4, '0');
}
function drawMap() {
  const { w, h, ctx } = resizeCanvas(map);
  if (w === 0 || h === 0) return;
  const scale = Math.min((w - 24) / 208, (h - 14) / 90);
  const mx = (x: number) => w / 2 + (x - 60) * scale,
    mz = (z: number) => h / 2 + (z - 38) * scale;
  ctx.clearRect(0, 0, w, h);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i <= 140; i++) {
    const pos = pointAt((trackLength * i) / 140);
    const x = mx(pos.x),
      z = mz(pos.z);
    if (i === 0) ctx.moveTo(x, z);
    else ctx.lineTo(x, z);
  }
  ctx.closePath();
  ctx.lineWidth = 2 * halfWidth * scale;
  ctx.strokeStyle = '#4c5953';
  ctx.stroke();
  const recent = new Map<string, Run>();
  for (const record of [...history, run]) {
    if (record.model === model.ярлык && record.mode === mode && record.samples.length)
      recent.set(record.letter, record);
  }
  for (const trace of recent.values()) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = traceColors[trace.letter];
    ctx.beginPath();
    trace.samples.forEach((s, i) => {
      if (i === 0) ctx.moveTo(mx(s.x), mz(s.z));
      else ctx.lineTo(mx(s.x), mz(s.z));
    });
    ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(mx(car.x), mz(car.z), 3.5, 0, Math.PI * 2);
  ctx.fill();
}

function hud() {
  speedEl.textContent = Math.round(3.6 * Math.hypot(car.vx, car.vz)).toString();
  gearEl.textContent = car.reverse ? 'R' : String(car.gear + 1);
  clockEl.textContent = timeText(elapsed);
  lapEl.textContent = run.laps.length
    ? 'Последний ' + timeText(run.laps[run.laps.length - 1])
    : validLap
      ? 'Первый круг'
      : 'Вне трассы';
  drawMap();
}
function showSteering() {
  const degrees = car.steer * 180 / Math.PI;
  steeringEl.parentElement!.style.setProperty('--steer', String(car.steer / passport.steerLock));
  steeringEl.textContent = Math.abs(degrees) < 0.2 ? '0°' : `${Math.abs(degrees).toFixed(1)}° ${degrees < 0 ? '←' : '→'}`;
}
function refreshRun() {
  if (run && run.samples.length) {
    history.push(run);
    if (history.length > 60) history.shift();
  }
  driver.release();
  driver.detach();
  driver = createDriver(scene);
  driver.anchor();
  running = false;
  elapsed = 0;
  residual = 0;
  ticks = 0;
  lapMeters = 0;
  lastLine = 0;
  validLap = true;
  car = newCar();
  previousProgress = progressAt(car.x, car.z);
  selections();
  view.reset(0);
  go.hidden = false;
  go.textContent = 'Начать заезд';
  state.textContent = 'ГОТОВ К СТАРТУ';
  exportButton.disabled = history.length === 0 && !Object.keys(choices).length;
  view.draw(car, passport, 1);
  showSteering();
  hud();
}

function play() {
  running = true;
  go.hidden = true;
  state.textContent = 'НА ТРАССЕ';
  scene.focus({ preventScroll: true });
}
function pause() {
  if (!running) return;
  running = false;
  residual = 0;
  driver.release();
  driver.detach();
  driver = createDriver(scene);
  driver.assist = run.assist;
  driver.keyboard = run.keyboard;
  driver.anchor();
  state.textContent = 'ПАУЗА';
  go.hidden = false;
  go.textContent = 'Продолжить';
}
function simulate() {
  const input = driver.read(PHYSICS_STEP, Math.hypot(car.vx, car.vz));
  step(car, passport, passport.шина, trackSurface, input, PHYSICS_STEP);
  ticks++;
  elapsed = ticks * PHYSICS_STEP;
  if (Math.abs(laneOffset(car.x, car.z)) > halfWidth) validLap = false;
  const progress = progressAt(car.x, car.z);
  let d = progress - previousProgress;
  if (d > trackLength / 2) d -= trackLength;
  if (d < -trackLength / 2) d += trackLength;
  previousProgress = progress;
  lapMeters += d;
  if (lapMeters >= trackLength) {
    if (validLap) run.laps.push(elapsed - lastLine);
    lapMeters -= trackLength;
    lastLine = elapsed;
    validLap = true;
  }
  if (ticks % Math.round(1 / PHYSICS_STEP / samplesHz) === 1) {
    if (run.samples.length < 6000) {
      run.samples.push({
        t: elapsed,
        x: car.x,
        z: car.z,
        kmh: 3.6 * Math.hypot(car.vx, car.vz),
        steer: input.steer,
        wheelAngle: car.steer,
        gas: input.throttle,
        brake: input.brake,
      });
    } else run.clipped = true;
    exportButton.disabled = false;
  }
}

go.onclick = play;
element('restart').onclick = refreshRun;
speedSelect.onchange = refreshRun;
keyboardSelect.onchange = refreshRun;
reveal.onclick = () => {
  opened = !opened;
  selections();
};
choose.onclick = () => {
  const key = model.ярлык + '/' + mode;
  if (choices[key] === letter) delete choices[key];
  else choices[key] = letter;
  exportButton.disabled = false;
  selections();
};
element('cars').onclick = (event) => {
  const name = (event.target as HTMLElement).closest('button')?.dataset.car;
  if (!name) return;
  model = name === 'viper' ? VIPER : LOGAN;
  refreshRun();
};
element('modes').onclick = (event) => {
  const selected = (event.target as HTMLElement).closest('button')?.dataset.mode as Mode | undefined;
  if (!selected) return;
  mode = selected;
  letter = 'A';
  opened = false;
  refreshRun();
};
experiments.onclick = (event) => {
  const selected = (event.target as HTMLElement).closest('button')?.dataset.letter as Letter | undefined;
  if (!selected) return;
  letter = selected;
  refreshRun();
};
exportButton.onclick = () => {
  const blob = new Blob(
    [
      JSON.stringify(
        {
          course: { length_m: trackLength, radius_m: 38, halfWidth_m: halfWidth, start_m: startX },
          step_s: PHYSICS_STEP,
          samples_hz: samplesHz,
          choices,
          blindOrder: {
            balanceA: order.balance ? 'rearReduced' : 'frontReduced',
            assistA: order.assist ? 'on' : 'off',
          },
          runs: [...history, ...(run.samples.length ? [run] : [])],
        },
        null,
        2,
      ),
    ],
    { type: 'application/json' },
  );
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = 'lifeboon-trials.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.code === 'KeyP') {
    if (running) pause();
    else play();
  }
  if (e.code === 'KeyR') refreshRun();
});
window.addEventListener('blur', pause);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});
for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-key]'))) {
  const send = (type: string) => window.dispatchEvent(new KeyboardEvent(type, { code: b.dataset.key }));
  b.onpointerdown = (e) => {
    e.preventDefault();
    b.setPointerCapture(e.pointerId);
    if (!running) play();
    send('keydown');
  };
  b.onpointerup = () => {
    send('keyup');
  };
  b.onpointercancel = () => {
    send('keyup');
  };
  b.onlostpointercapture = () => {
    send('keyup');
  };
}
refreshRun();
let previous = performance.now(),
  nextHud = 0;
function frame(now: number) {
  const dt = Math.max(0, Math.min(0.15, (now - previous) / 1000));
  previous = now;
  if (running) {
    residual += dt;
    const count = Math.floor((residual + 1e-12) / PHYSICS_STEP);
    for (let i = 0; i < count; i++) simulate();
    residual = Math.max(0, residual - count * PHYSICS_STEP);
  }
  view.draw(car, passport, dt, run.samples);
  if (now >= nextHud) {
    hud();
    nextHud = now + 75;
  }
  showSteering();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

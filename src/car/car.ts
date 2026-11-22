/**
 * Машина. Про экран не знает: ей дают опору под колёсами и положение органов
 * управления, она возвращает новое состояние. Считается без браузера —
 * значит её можно проверить из терминала и однажды считать на сервере.
 *
 * Ни одного правила про «занос», «снос» или «пробуксовку». Всё это —
 * следствия четырёх честно посчитанных пятен контакта. Устройство и вывод
 * формул: docs/how-cars-work.md.
 */

import { type Passport, cornerSpring, доНоса, engineTorque, frontArm, rearArm, sprungMass } from './passport.ts';
import { type Tyre, SURFACE_GRIP, tyreForce, peakForce } from './tyre.ts';
import type { Spot } from './ground.ts';
import { type Вектор, type Кватернион, повернуть, вОсиКузова, cross } from './contact-math.ts';
export { type Вектор, type Кватернион, повернуть } from './contact-math.ts';
import { hullContacts } from './contacts.ts';
import { solveContacts, type RigidContact } from './contact-impulse.ts';
import { brakePressure } from './brakes.ts';

/** Общий шаг приложения и проверок: жёсткие контакты рассчитаны на 600 Гц. */
export const PHYSICS_STEP = 1 / 600;

const G = 9.80665;
const AIR = 1.225;
/** Ниже этой скорости проскальзывание считать нельзя: деление на ноль. */
const CRAWL = 1.4;

export interface Controls {
  /** Положение руля: −1 влево, +1 вправо. */
  readonly steer: number;
  readonly throttle: number;
  readonly brake: number;
  readonly handbrake: boolean;
  /** Помощь рулю: предел по сцеплению и контрруль. См. `steerHelp`. */
  readonly assist: boolean;
}

export interface Wheel {
  /**
   * Где колесо стоит в машине: вперёд от центра масс и ВПРАВО, м.
   *
   * Право, а не влево: в осях мира право по ходу — это cross(вперёд, вверх)
   * = (−sin ψ, cos ψ). Раньше эта ось называлась «влево», и от одного
   * неверного названия наизнанку оказались руль и сторона движения трафика.
   */
  readonly ahead: number;
  readonly right: number;
  readonly radius: number;
  readonly inertia: number;
  readonly driven: boolean;
  /** Вращение, рад/с. */
  spin: number;
  /** Давление рабочего тормоза после регулятора ABS, от 0 до 1. */
  brakePressure: number;
  /** Сжатие подвески от свободного положения, м. Ноль — колесо висит. */
  travel: number;
  /** Свободная длина подвески, м. */
  rest: number;
  /** Высота земли под колесом на прошлом шаге — демпферу нужна скорость дороги. */
  groundPrev: number;
  /** Касается ли колесо земли. */
  down: boolean;
  /** Что под ним прямо сейчас. */
  load: number;
  slip: number;
  angle: number;
  /** Насколько выбрано сцепление: 1 — ровно на пределе. */
  use: number;
  steer: number;
  /**
   * Высота крепления подвески над центром масс в осях кузова, м. Место
   * колеса в мире не хранится — его считает `центрКолеса` из позы кузова.
   */
  крепление: number;
  material: string;
}

const ВПЕРЁД: Вектор = { x: 1, y: 0, z: 0 };
const ВВЕРХ: Вектор = { x: 0, y: 1, z: 0 };
const ВПРАВО: Вектор = { x: 0, y: 0, z: 1 };

/** Курс, тангаж (нос вверх +) и крен (правый борт вниз +) — из поворота. */
export function углы(q: Кватернион): { yaw: number; pitch: number; roll: number } {
  const f = повернуть(q, ВПЕРЁД), u = повернуть(q, ВВЕРХ), r = повернуть(q, ВПРАВО);
  return {
    yaw: Math.atan2(f.z, f.x),
    pitch: Math.asin(Math.max(-1, Math.min(1, f.y))),
    roll: Math.atan2(-r.y, u.y),
  };
}

/** Поворот из курса, тангажа и крена — тот же порядок, что у кузова на экране. */
export function изУглов(yaw: number, pitch = 0, roll = 0): Кватернион {
  const mul = (a: Кватернион, b: Кватернион): Кватернион => ({
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  });
  // курс — поворот вокруг вертикали на −курс: так нос (1, 0, 0) смотрит в (cos, 0, sin)
  const qy = { w: Math.cos(-yaw / 2), x: 0, y: Math.sin(-yaw / 2), z: 0 };
  const qx = { w: Math.cos(roll / 2), x: Math.sin(roll / 2), y: 0, z: 0 };
  const qz = { w: Math.cos(pitch / 2), x: 0, y: 0, z: Math.sin(pitch / 2) };
  return mul(qy, mul(qx, qz));
}

/**
 * Поза кузова — всё, из чего складывается положение любой его точки:
 * где центр масс и как кузов повёрнут.
 */
export interface ПозаКузова {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly q: Кватернион;
}

/**
 * ТОЧКА КУЗОВА в мире: (вперёд, вверх, вправо) от центра масс в осях
 * кузова, повёрнутая вместе с ним.
 *
 * Колесо — такая точка: крепление подвески плюс её длина вдоль оси кузова
 * «вниз». Поэтому место колеса НЕ ХРАНИТСЯ, а вычисляется отсюда — и
 * физикой, и показом. До 28.09 оно хранилось, ставилось линейно («плечо ×
 * угол») в начале шага, кузов двигался в конце, а показ вертел кузов
 * вокруг низа: в кувырке колесо уходило от кузова на 7.1 м (Алекс: «выпал
 * с карты — колёса отдаляются»). Колесо, отставшее от кузова, теперь
 * записать нечем.
 */
export function точкаКузова(поза: ПозаКузова, вперёд: number, вверх: number, вправо: number): Вектор {
  const r = повернуть(поза.q, { x: вперёд, y: вверх, z: вправо });
  return { x: поза.x + r.x, y: поза.y + r.y, z: поза.z + r.z };
}

/** Центр колеса в мире при таком ходе подвески. */
export const центрКолеса = (поза: ПозаКузова, w: Wheel, travel: number): Вектор =>
  точкаКузова(поза, w.ahead, w.крепление - w.rest + travel, w.right);

/**
 * МАШИНА — твёрдое тело в 3D: центр масс, скорость, поворот (кватернион)
 * и угловая скорость в мире. До 28.09 поворот хранился тремя углами на
 * малых наклонах, и в кувырке модель ломалась: при тангаже 90° крен
 * вертит машину вокруг вертикали, и упор в землю раскручивал его до
 * −14705° (снято на живой странице). Курс, тангаж и крен теперь
 * вычисляются из поворота, а «вращение по курсу» — окно в угловую
 * скорость: им пользуются стены и удары о чужие машины.
 */
export interface Car extends ПозаКузова {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  q: Кватернион;
  /** Угловая скорость в осях мира, рад/с. */
  вращение: Вектор;
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  /** Вращение по курсу, рад/с: + — курс растёт. Это вертикальная доля угловой скорости. */
  yawRate: number;
  steer: number;
  wheels: Wheel[];
  gear: number;
  reverse: boolean;
  rpm: number;
  /** Фактически приложенный положительный момент двигателя до коробки, Н·м. */
  engineTorqueNm: number;
  /** Доля доступного момента (0 при переключении/отсечке), не нагрузка шины. */
  engineLoad: number;
  /** Эффективный газ, включая задний ход. */
  engineThrottle: number;
  shiftLeft: number;
  stopHold: number;
  /** Поставлена ли машина на землю. */
  placed: boolean;
  /** Угол колёс, при котором они смотрят туда, куда машина едет на самом деле. */
  neutral: number;
  /** Насколько помощь изменила запрошенный угол, рад. Для приборки. */
  helped: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export function createCar(p: Passport, x: number, z: number, yaw: number): Car {
  const a = frontArm(p), b = rearArm(p);
  const wheel = (ahead: number, right: number, front: boolean): Wheel => ({
    ahead, right,
    radius: front ? p.wheelFront.radius : p.wheelRear.radius,
    inertia: front ? p.wheelFront.inertia : p.wheelRear.inertia,
    driven: p.привод === 'перед' ? front : !front,
    spin: 0, brakePressure: 0, travel: 0, rest: 0, крепление: 0, groundPrev: 0, down: true,
    load: 0, slip: 0, angle: 0, use: 0, steer: 0,
    material: 'asphalt',
  });
  return {
    x, y: 0, z, vx: 0, vy: 0, vz: 0, q: изУглов(yaw), вращение: { x: 0, y: 0, z: 0 },
    get yaw() { return углы(this.q).yaw; },
    get pitch() { return углы(this.q).pitch; },
    get roll() { return углы(this.q).roll; },
    // курс растёт против вращения вокруг вертикали мира (см. `изУглов`)
    get yawRate() { return -this.вращение.y; },
    set yawRate(v: number) { this.вращение.y = -v; },
    steer: 0,
    // порядок: переднее левое, переднее правое, заднее левое, заднее правое
    wheels: [
      wheel(a, -p.trackFront / 2, true),
      wheel(a, p.trackFront / 2, true),
      wheel(-b, -p.trackRear / 2, false),
      wheel(-b, p.trackRear / 2, false),
    ],
    gear: 0, reverse: false, rpm: p.idleRpm, shiftLeft: 0, stopHold: 0,
    placed: false, neutral: 0, helped: 0, engineTorqueNm: 0, engineLoad: 0, engineThrottle: 0,
  };
}

/**
 * Подвесить колёса: свободная длина и высота крепления — из паспорта и
 * нынешней настройки подвески. Зовётся при постановке машины и при смене
 * настройки.
 */
export function подвесить(car: Car, p: Passport): void {
  car.wheels.forEach((w, i) => {
    w.rest = restLength(p, i < 2);
    w.крепление = p.suspension.ride - p.cgHeight;
  });
}

/** Подкрутить кузов: добавить вращение носом (+ вверх) и боком (+ правым бортом вниз), рад/с. */
export function подкрутить(car: Car, тангаж: number, крен: number): void {
  const r = повернуть(car.q, ВПРАВО), f = повернуть(car.q, ВПЕРЁД);
  car.вращение = {
    x: car.вращение.x + r.x * тангаж + f.x * крен,
    y: car.вращение.y + r.y * тангаж + f.y * крен,
    z: car.вращение.z + r.z * тангаж + f.z * крен,
  };
}

/**
 * УГЛЫ КУЗОВА — коробка, которой кузов касается земли: низ (18 см над
 * землёй) и крыша, по длине и ширине машины; (вперёд, вверх, вправо) от
 * центра масс. До 28.09 земли касались только колёса: перевёрнутая
 * машина проваливалась сквозь землю.
 */
export function углыКузова(p: Passport): [number, number, number][] {
  const нос = доНоса(p), r = p.width / 2 - 0.12;
  const углы: [number, number, number][] = [];
  for (const вверх of [0.18 - p.cgHeight, p.height - p.cgHeight])
    for (const вперёд of [нос, нос - p.length]) for (const вправо of [r, -r]) углы.push([вперёд, вверх, вправо]);
  return углы;
}

/**
 * Жёсткий упор полностью сжатого колеса в землю:
 * 1.5 МН/м (весь вес машины на одном углу — 1 см) и сильное гашение В ОБЕ
 * СТОРОНЫ: кузов при ударе мнётся, а не отпружинивает (с гашением только
 * на сжатие удар на 28 м/с подбрасывал машину на 30 м). Упор только
 * толкает. Шаг физики 1/600 с держит такую жёсткость с запасом.
 */
const УПОР = 1.5e6;
const УПОР_ГАШЕНИЕ = 60000;
const упор = (глубина: number, вверх: number): number => Math.max(0, УПОР * глубина - УПОР_ГАШЕНИЕ * вверх);
/** Трение кузова о землю: скребёт, а не катится. */
const ТРЕНИЕ_КУЗОВА = 0.5;
/** Отбойник сжимается ещё на столько после конца хода; дальше колесо — часть кузова. */
const ОТБОЙНИК = 0.04;

/**
 * Свободная длина подвески подбирается так, чтобы под своим весом машина
 * села ровно на заданную высоту — и передом, и задом одинаково. Иначе кузов
 * стоял бы наклонённым просто потому, что пружины разные.
 */
export function restLength(p: Passport, front: boolean): number {
  const { k, mass } = cornerSpring(p, front);
  const radius = front ? p.wheelFront.radius : p.wheelRear.radius;
  return p.suspension.ride - radius + (mass * G) / k;
}

/** Скорость машины вдоль её носа, м/с. Отрицательная — едет задом. */
export const forwardSpeed = (car: Car): number => {
  const yaw = car.yaw;
  return car.vx * Math.cos(yaw) + car.vz * Math.sin(yaw);
};

export type Sampler = (x: number, z: number) => Spot;

/**
 * Помощь рулю — ровно то, что делают BeamNG и Assetto Corsa, и по той же
 * причине: у человека с мышью нет обратной связи, и он не чувствует, что
 * передние колёса уже сорвались или что машину развернуло.
 *
 * 1. **Предел по сцеплению.** Угол ограничен полосой шириной в пик увода
 *    вокруг «нейтрали» — того угла, при котором колёса смотрят туда, куда
 *    машина реально едет. Просить у шины больше её пика бессмысленно: за
 *    пиком она держит хуже. На малой скорости предел выключен, иначе не
 *    припарковаться.
 * 2. **Контрруль (кастор).** Настоящий руль тянет не к нулю, а к направлению
 *    движения. На прямой это возврат в ноль, в заносе — доворот в занос.
 *    Тянет слабо: держать поворот это не мешает, а поймать занос помогает.
 */
function steerHelp(
  car: Car, p: Passport, tyre: Tyre, wanted: number, u: number,
): { angle: number; helped: number } {
  const speed = Math.abs(u);
  const asked = wanted;

  // 1. предел: полностью с 60 км/ч, выключен ниже 25
  const bite = Math.min(1, Math.max(0, (speed - 7) / 10));
  if (bite > 0) {
    const band = tyre.peakAngle * 1.15;
    const capped = clamp(wanted, car.neutral - band, car.neutral + band);
    wanted = wanted * (1 - bite) + capped * bite;
  }

  // 2. кастор: чем быстрее, тем сильнее тянет к направлению движения
  const caster = Math.min(1, speed / 12) * 0.3;
  wanted += (car.neutral - wanted) * caster;

  return { angle: wanted, helped: wanted - asked };
}

export function step(
  car: Car,
  p: Passport,
  tyre: Tyre,
  sample: Sampler,
  controls: Controls,
  dt: number,
): void {
  const yaw = car.yaw;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  // оси курса на земле: вперёд и вправо
  const fh: Вектор = { x: cos, y: 0, z: sin }, rh: Вектор = { x: -sin, y: 0, z: cos };
  const u = car.vx * cos + car.vz * sin;          // вперёд
  const v = -car.vx * sin + car.vz * cos;         // вправо
  const ω = car.вращение;

  // ── руль
  let wanted = clamp(controls.steer, -1, 1) * p.steerLock;
  car.neutral = Math.atan2(v + car.yawRate * frontArm(p), Math.max(Math.abs(u), 1)) * Math.sign(u || 1);
  if (controls.assist) {
    const help = steerHelp(car, p, tyre, wanted, u);
    wanted = help.angle;
    car.helped = help.helped;
  } else {
    car.helped = 0;
  }
  // колёса доходят до заданного угла не мгновенно, а со скоростью рук
  const swing = p.steerRate * dt;
  car.steer += clamp(wanted - car.steer, -swing, swing);

  /**
   * Задний ход. Подержал тормоз на стоянке — включился, и тогда тормоз стал
   * задней тягой, а газ — тормозом. Выводит из него ГАЗ, а не скорость:
   * раньше выходом была скорость, и назад нельзя было разогнаться быстрее
   * пяти километров в час — реверс мигал туда-сюда.
   */
  if (!car.reverse && Math.abs(u) < 0.5 && controls.brake > 0.15) car.stopHold += dt;
  else car.stopHold = 0;
  if (car.stopHold > 0.35) { car.reverse = true; car.stopHold = 0; }
  if (car.reverse && (controls.throttle > 0.1 || u > 0.5)) car.reverse = false;
  const throttle = car.reverse ? controls.brake : controls.throttle;
  const braking = car.reverse ? controls.throttle : controls.brake;

  // ── прижимная сила: давит на кузов сверху, дальше её разложит подвеска
  const downforce = 0.5 * AIR * p.liftArea * u * u;
  const weight = p.mass * G + downforce;

  // ── ПОДВЕСКА. Нагрузку на колёса больше не считает формула переноса веса:
  // она получается сама, потому что кузов честно качается на четырёх пружинах.
  const springs = [cornerSpring(p, true), cornerSpring(p, true), cornerSpring(p, false), cornerSpring(p, false)];
  const sprung = sprungMass(p);
  if (!car.placed) {
    подвесить(car, p);
    const initial = sample(car.x, car.z);
    const under = initial.present === false ? car.y - p.cgHeight : initial.height;
    car.y = under + p.cgHeight;
    for (const w of car.wheels) w.groundPrev = under;
    car.placed = true;
  }

  // ── трансмиссия: обороты берутся от ведущих колёс — какая ось, говорит паспорт
  const [левое, правое] = p.привод === 'перед' ? [0, 1] : [2, 3];
  const ratio = (car.reverse ? 2.9 : p.gears[car.gear]) * p.finalDrive;
  const spinAvg = (car.wheels[левое].spin + car.wheels[правое].spin) / 2;
  const fromWheels = (Math.abs(spinAvg) * ratio * 60) / (2 * Math.PI);
  // сцепление буксует на старте — иначе мотор глохнет на нулевой скорости
  car.rpm = clamp(Math.max(fromWheels, throttle > 0.05 ? 3400 : p.idleRpm), p.idleRpm, p.cutoffRpm);

  if (car.shiftLeft > 0) car.shiftLeft -= dt;
  else if (!car.reverse) {
    if (fromWheels > p.переключение.вверх && car.gear + 1 < p.gears.length) { car.gear++; car.shiftLeft = 0.25; }
    else if (fromWheels < p.переключение.вниз && car.gear > 0) { car.gear--; car.shiftLeft = 0.2; }
  }

  // на заднем ходу мотор придушен: иначе передача 2.9 разгоняет назад до 80 км/ч
  const ceiling = car.reverse ? 3500 : p.cutoffRpm - 1;
  const cut = car.shiftLeft > 0 || car.rpm >= ceiling;
  const engine = cut ? 0 : engineTorque(p, car.rpm) * throttle;
  car.engineThrottle = throttle;
  car.engineTorqueNm = engine;
  car.engineLoad = cut ? 0 : throttle;
  const push = engine * ratio * p.driveline * (car.reverse ? -1 : 1);
  /**
   * Торможение двигателем ГАСИТ вращение, а не крутит колёса.
   * Раньше оно было просто отрицательным моментом — и на стоянке медленно
   * увозило машину назад само по себе. Теперь оно всегда против вращения
   * и исчезает вместе с ним.
   */
  const rolling = Math.sign(spinAvg) * Math.min(1, Math.abs(spinAvg) / 3);
  const engineBrake = cut || throttle > 0.05
    ? 0 : engineTorque(p, car.rpm) * 0.12 * ratio * p.driveline * rolling;
  const axleTorque = push - engineBrake;

  // вязкостная блокировка: колёса тянут друг друга, разница скоростей давит
  const lock = clamp((car.wheels[левое].spin - car.wheels[правое].spin) * p.diffLock, -2500, 2500);

  // ── ПРОХОД ПЕРВЫЙ: где колёса, что под ними и с какой силой давит подвеска
  const along = [0, 0, 0, 0];       // сила пружины вдоль оси подвески
  const ground = [0, 0, 0, 0];      // земля толкает колесо вверх
  const сквозь = [0, 0, 0, 0], скоростьУпора = [0, 0, 0, 0];
  let nx = 0, ny = 0, nz = 0, опора = 0;
  // насколько ось кузова «вверх» смотрит вверх в мире: 1 — стоит ровно
  const s = повернуть(car.q, ВВЕРХ).y;
  const предел = p.suspension.travel + ОТБОЙНИК;

  for (let i = 0; i < 4; i++) {
    const w = car.wheels[i];
    const front = i < 2;
    w.steer = front ? car.steer : 0;
    // где стояло бы колесо на полностью вытянутой подвеске — туда и смотрим землю
    const free = центрКолеса(car, w, 0);
    const spot = sample(free.x, free.z);
    w.material = spot.material;
    if (spot.present === false) {
      w.travel = 0; w.down = false;
      continue;
    }
    nx += spot.nx / 4; ny += spot.ny / 4; nz += spot.nz / 4;

    // сжатие — вдоль оси подвески: насколько колесо надо поднять по ней,
    // чтобы оно встало на землю. Колесо, смотрящее вбок или вверх (машина
    // на боку, на крыше), земли не касается — там упирается кузов
    const поднять = spot.height + w.radius - free.y;
    // Свежий контакт достижим в пределах хода. Поверхность, оказавшаяся
    // сбоку выше полностью сжатого колеса, встречает кузов своей кромкой.
    const reachable = w.down || поднять <= предел * s;
    w.travel = s > 0.2 && reachable ? clamp(поднять / s, 0, предел) : 0;
    w.down = w.travel > 1e-4;

    // скорость крепления вверх: движется центр масс и вращается кузов
    const a = повернуть(car.q, { x: w.ahead, y: w.крепление, z: w.right });
    const attachRate = car.vy + ω.z * a.x - ω.x * a.z;
    const roadRate = clamp((spot.height - w.groundPrev) / dt, -12, 12);
    w.groundPrev = spot.height;
    const squeezeRate = w.down && w.travel < предел ? (roadRate - attachRate) / s : 0;

    const spring = springs[i];
    let force = w.down ? spring.k * w.travel + spring.c * squeezeRate : 0;
    // отбойник: за пределом хода подвеска резко твердеет
    const over = w.travel - p.suspension.travel;
    if (over > 0) force += over * spring.k * 8;
    along[i] = Math.max(0, force);
    // колесо на отбойнике, а земля ещё выше: дальше давит сам кузов через колесо
    сквозь[i] = w.down ? Math.max(0, поднять - предел * s) : 0;
    скоростьУпора[i] = attachRate - roadRate;
  }

  /**
   * Стабилизатор связывает колёса одной оси: он не мешает обоим сжиматься
   * вместе и мешает сжиматься по-разному. Поэтому он влияет ТОЛЬКО на крен —
   * и именно им настраивается характер машины (docs/how-cars-work.md §5.5).
   */
  for (const [a, b, bar] of [[0, 1, p.suspension.barFront], [2, 3, p.suspension.barRear]] as const) {
    const twist = (car.wheels[a].travel - car.wheels[b].travel) / 2;
    if (car.wheels[a].down) along[a] = Math.max(0, along[a] + bar * twist);
    if (car.wheels[b].down) along[b] = Math.max(0, along[b] - bar * twist);
  }

  /**
   * Земля толкает колесо ВВЕРХ: пружина давит вдоль своей оси, а земле
   * достаётся её вертикальная доля (остальное держат рычаги подвески).
   * Пока машина стоит ровно, это вся сила пружины. До 28.09 наверх шла
   * вся сила, и когда сжатие мерили вдоль наклонённой оси, приземлившуюся
   * боком машину выстреливало в небо (снято).
   */
  for (let i = 0; i < 4; i++) {
    const w = car.wheels[i];
    ground[i] = along[i] * s + (сквозь[i] > 0 ? упор(сквозь[i], скоростьУпора[i]) : 0);
    // прижимная сила давит на кузов и через подвеску доходит до колёс
    w.load = ground[i] > 0 ? ground[i] + p.unsprung * G : 0;
    if (ground[i] > 0) опора += 0.25;
  }

  // ── СИЛЫ НА КУЗОВ: сумма и момент около центра масс (плечо × сила)
  const сила: Вектор = { x: 0, y: -sprung * G - downforce, z: 0 };
  const момент: Вектор = { x: 0, y: 0, z: 0 };
  const приложить = (где: Вектор, F: Вектор): void => {
    сила.x += F.x; сила.y += F.y; сила.z += F.z;
    const m = cross({ x: где.x - car.x, y: где.y - car.y, z: где.z - car.z }, F);
    момент.x += m.x; момент.y += m.y; момент.z += m.z;
  };

  const contacts: RigidContact[] = [];
  // ── ПРОХОД ВТОРОЙ: силы в четырёх пятнах
  for (let i = 0; i < 4; i++) {
    const w = car.wheels[i];
    const front = i < 2;
    // пятно — под центром колеса, на земле
    const c = центрКолеса(car, w, w.travel);
    const пятно: Вектор = { x: c.x, y: c.y - w.radius, z: c.z };

    // скорость СТУПИЦЫ (центра колеса) на твёрдом теле: вращение добавляет
    // своё. Не пятна: шину по дороге тащит ступица, а пятно ниже неё
    const rp = cross(ω, { x: c.x - car.x, y: c.y - car.y, z: c.z - car.z });
    const pvx = car.vx + rp.x, pvz = car.vz + rp.z;
    const pointLong = pvx * cos + pvz * sin;
    const pointLat = -pvx * sin + pvz * cos;
    const cs = Math.cos(w.steer), sn = Math.sin(w.steer);
    const alongWheel = pointLong * cs + pointLat * sn;
    const acrossWheel = -pointLong * sn + pointLat * cs;
    const reference = Math.max(Math.abs(alongWheel), CRAWL);

    /**
     * РЕЛАКСАЦИЯ: шина набирает силу не мгновенно, а за `relaxation`
     * метров пути — резина в пятне должна успеть деформироваться. До 28.09
     * длина релаксации была записана в шине, но в счёте не участвовала, и
     * свободное колесо ниже ~10 км/ч колебалось через шаг: шина толкала
     * лёгкое колесо так сильно, что вращение каждый шаг перескакивало
     * через верное (проскальзывание ±30% попеременно), и эта дрожь шла
     * в кузов. Нашлось на Логане: его задние колёса на старте «буксовали».
     */
    const slipNow = (w.spin * w.radius - alongWheel) / reference;
    const angleNow = Math.atan2(acrossWheel, reference);
    const догнать = Math.min(1, (reference * dt) / tyre.relaxation);
    w.slip += (slipNow - w.slip) * догнать;
    w.angle += (angleNow - w.angle) * догнать;

    const grip = SURFACE_GRIP[w.material] ?? 1;
    const parked = !front && controls.handbrake && w.down && w.spin === 0 && Math.hypot(alongWheel, acrossWheel) < CRAWL;
    const force = parked ? { x: 0, y: 0, use: 0 } : tyreForce(tyre, { slip: w.slip, angle: w.angle, load: w.load, grip }, front ? 0 : 1);
    w.use = force.use;

    // назад в оси курса, потом в мир; вместе с толчком земли вверх
    const fLong = force.x * cs - force.y * sn;
    const fLat = force.x * sn + force.y * cs;
    приложить(пятно, {
      x: fLong * fh.x + fLat * rh.x,
      y: ground[i],
      z: fLong * fh.z + fLat * rh.z,
    });

    // раскрутка колеса
    const share = w.driven ? axleTorque / 2 + (i === левое ? -lock : lock) : 0;
    const handbrake = !front && controls.handbrake;
    const speedOnRoad = Math.abs(alongWheel);
    const absActive = p.abs && w.down && !handbrake && speedOnRoad > 1.5 && braking > 0;
    const slipOnBrake = (speedOnRoad - w.spin * w.radius * Math.sign(alongWheel)) / Math.max(speedOnRoad, CRAWL);
    w.brakePressure = absActive
      ? brakePressure(w.brakePressure, braking, slipOnBrake, tyre.peakSlip, dt)
      : braking;
    const brakeMax = (front ? p.brakeFront : p.brakeRear) * w.brakePressure
      + (handbrake ? p.brakeRear * 1.4 : 0);
    const inertia = w.inertia + (w.driven ? (p.engineInertia * ratio * ratio) / 2 : 0);
    let spin = w.spin + ((share - force.x * w.radius) / inertia) * dt;
    // тормоз не может раскрутить колесо назад — он только гасит вращение
    const stop = (brakeMax / inertia) * dt;
    spin = Math.abs(spin) <= stop ? 0 : spin - Math.sign(spin) * stop;
    w.spin = spin;
    if (parked && spin === 0 && w.load > 0) {
      const peak = peakForce(tyre, grip, w.load);
      const brakeReserve = Math.max(0, brakeMax - Math.abs(share)) / w.radius;
      const holding = Math.min(peak.x, peak.y * (tyre.lateralGripByAxle?.[1] ?? 1), brakeReserve);
      contacts.push({ point: пятно, normal: ВВЕРХ, depth: 0, friction: 0, parkingGrip: holding * dt });
    }
  }

  /**
   * На ровной земле кузов касается её углами, у обрыва — ещё и рёбрами.
   * После интегрирования сил импульсы разрешают все касания совместно.
   */
  const corners = углыКузова(p).map(([x, y, z]) => точкаКузова(car, x, y, z));
  hullContacts(corners, sample, (point, normal, depth) => {
    contacts.push({ point, normal, depth, friction: ТРЕНИЕ_КУЗОВА });
  }, опора);

  // ── сопротивление: воздух — в центре масс, качение — у земли, пока колёса на ней
  const air = 0.5 * AIR * p.dragArea * u * Math.abs(u);
  const roll = p.rollingResistance * weight * опора * Math.sign(u) * Math.min(1, Math.abs(u) / 0.5);
  приложить({ x: car.x, y: car.y, z: car.z }, { x: -air * fh.x, y: 0, z: -air * fh.z });
  приложить({ x: car.x, y: car.y - p.cgHeight, z: car.z }, { x: -roll * fh.x, y: 0, z: -roll * fh.z });

  /**
   * ── ДВИЖЕНИЕ. Вдоль земли толкают шины (масса всей машины), вверх —
   * земля через подвеску (масса кузова: колёса стоят на земле сами).
   * Перенос веса рождается сам: сила шины приложена у земли, масса —
   * в центре масс, между ними плечо, оно кренит кузов, кузов давит на
   * пружины. Никакой формулы переноса веса нет.
   */
  // уклон: сила тяжести вдоль поверхности, из нормали под машиной — пока она на ней стоит
  const slopeX = G * ny * nx * опора;
  const slopeZ = G * ny * nz * опора;
  car.vx += (сила.x / p.mass + slopeX) * dt;
  car.vz += (сила.z / p.mass + slopeZ) * dt;
  car.vy += (сила.y / sprung) * dt;

  // вращение: в осях кузова момент инерции — три числа по трём осям
  const I: Вектор = { x: p.mass * (0.28 * p.width) ** 2, y: p.yawInertia, z: p.mass * (0.3 * p.length) ** 2 };
  const wb = вОсиКузова(car.q, ω);
  const tb = вОсиКузова(car.q, момент);
  const гироскоп = cross(wb, { x: I.x * wb.x, y: I.y * wb.y, z: I.z * wb.z });
  const wbNext: Вектор = {
    x: wb.x + ((tb.x - гироскоп.x) / I.x) * dt,
    y: wb.y + ((tb.y - гироскоп.y) / I.y) * dt,
    z: wb.z + ((tb.z - гироскоп.z) / I.z) * dt,
  };
  car.вращение = повернуть(car.q, wbNext);
  // Помощь гасит рысканье только при опоре колёс; в полёте нет такого момента.
  if (опора > 0) car.вращение.y -= car.вращение.y * Math.min(1, dt * 0.8);

  const correctiveSpin = contacts.length ? solveContacts(car, contacts, p.mass, sprung, I, dt) : null;
  car.x += car.vx * dt;
  car.y += car.vy * dt;
  car.z += car.vz * dt;
  // поворот: q += ½·(0, ω)·q·dt, и снова единичной длины
  const spin = car.вращение, q = car.q;
  const o = correctiveSpin ? { x: spin.x + correctiveSpin.x, y: spin.y + correctiveSpin.y, z: spin.z + correctiveSpin.z } : spin;
  const nq = {
    w: q.w + 0.5 * dt * (-o.x * q.x - o.y * q.y - o.z * q.z),
    x: q.x + 0.5 * dt * (o.x * q.w + o.y * q.z - o.z * q.y),
    y: q.y + 0.5 * dt * (o.y * q.w + o.z * q.x - o.x * q.z),
    z: q.z + 0.5 * dt * (o.z * q.w + o.x * q.y - o.y * q.x),
  };
  const n = Math.hypot(nq.w, nq.x, nq.y, nq.z);
  car.q = { w: nq.w / n, x: nq.x / n, y: nq.y / n, z: nq.z / n };
}

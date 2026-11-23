/**
 * Органы управления: мышь — руль, клавиши — педали.
 *
 * Сделано как в Assetto Corsa: **указатель захватывается**, и руль — это
 * накопленное движение мыши от нуля, поставленного в тот миг, когда сел
 * за руль. Захват нужен именно для нуля: пока указатель живёт своей жизнью,
 * «прямо» оказывается там, где он случайно был, — и середина экрана
 * становится упором. Ровно на этом первая версия и сломалась.
 *
 * Накопитель упирается в единицу и дальше не растёт — как настоящий руль
 * упирается в замок: крути сколько хочешь, ничего не изменится, а обратно
 * пойдёт сразу.
 *
 * Педали — на клавишах (так у всех троих: Assetto Corsa, Euro Truck, BeamNG),
 * и клавиша не включает газ, а начинает нажимать педаль: до пола 0.22 с.
 *
 * Помощь рулю (её считает сама машина, здесь только выключатель) — два
 * помощника, как в BeamNG: предел по сцеплению передних колёс и контрруль,
 * изображающий кастор.
 */

import type { Controls } from './car.ts';
import { type Aim, createAim } from '../aim.ts';

/** Сколько пикселей мыши от нуля до упора руля. */
const TRAVEL_DEFAULT = 700;
/** Время хода педали до пола и обратно, с. */
const PRESS = 0.22;
const RELEASE = 0.14;
/** На скорости клавиша задаёт меньший угол, потому что частичного нажатия у неё нет. */
const KEY_STEER_SPEED = 11; // м/с, половина парковочного угла
const KEY_STEER_RESPONSE = 20; // 1/с, около 0,12 с от нуля до 90% команды

export type KeyboardSteering = 'responsive' | 'legacy';

export interface Driver {
  read(dt: number, speed: number): Controls;
  keyboard: KeyboardSteering;
  /** Помощь рулю: предел по сцеплению и контрруль. */
  assist: boolean;
  /** Пикселей мыши на полный выворот. Больше — спокойнее. */
  travel: number;
  /** Положение руля, заданное игроком, −1..1 — приборке. */
  command: number;
  /** Захвачен ли указатель. Без захвата рулить нечем. */
  held(): boolean;
  /** Поставить руль в ноль. */
  anchor(): void;
  /** Отпустить указатель: вышел из машины — мышь снова твоя. */
  release(): void;
  pad(): boolean;
  detach(): void;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Педаль догоняет клавишу со скоростью ноги, а не мгновенно. */
function pedal(now: number, want: number, dt: number): number {
  const rate = want > now ? dt / PRESS : dt / RELEASE;
  return clamp(now + clamp(want - now, -rate, rate), 0, 1);
}

export function createDriver(surface: HTMLElement, shared?: Aim): Driver {
  const keys = new Set<string>();
  let wheel = 0;   // −1..1, накопленное положение руля
  /**
   * Мышь берётся через общий захват (`src/aim.ts`): там же живёт выброс
   * первого отсчёта после захвата — браузер переносит курсор в середину окна
   * и присылает это как одно огромное движение, от которого руль оказался бы
   * в упоре, хотя игрок мыши не касался. Пешеход спрашивает мышь оттуда же.
   */
  const aim = shared ?? createAim(surface);
  let throttle = 0, brake = 0, keySteer = 0;
  let steeringOwner: 'keyboard' | 'mouse' | 'gamepad' = 'keyboard';

  const down = (e: KeyboardEvent): void => {
    if ((e.target as HTMLElement | null)?.closest?.('select, input, textarea, [contenteditable]')) return;
    keys.add(e.code);
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    // острота руля: сколько миллиметров коврика уходит на полный выворот
    if (e.code === 'BracketLeft') driver.travel = clamp(driver.travel + 100, 200, 1600);
    if (e.code === 'BracketRight') driver.travel = clamp(driver.travel - 100, 200, 1600);
    if (e.code === 'KeyR') wheel = 0;
  };
  const up = (e: KeyboardEvent): void => { keys.delete(e.code); };
  const clear = (): void => { keys.clear(); };
  const grab = (): void => { aim.take(); };

  // вправо мышью — вправо колёсами: положительный руль это поворот направо.
  // Считается на КАЖДОМ событии, а не раз в кадр: сумма за кадр под захватом
  // указателя уничтожается встречными скачками браузера.
  aim.onMove((dx) => {
    if (steeringOwner !== 'mouse') wheel = driver.command;
    wheel = clamp(wheel + dx / driver.travel, -1, 1);
    if (dx !== 0) steeringOwner = 'mouse';
  });
  // взял руль — руль прямой: иначе «прямо» зависело бы от того, где был курсор
  aim.onTake(() => { wheel = 0; steeringOwner = 'mouse'; });

  addEventListener('keydown', down);
  addEventListener('keyup', up);
  addEventListener('blur', clear);
  // Слушателя «щелчок берёт руль» тут нет нарочно: он живёт только пока сидим
  // в машине (anchor ставит, release снимает). Иначе любой щелчок по миру —
  // повернуть камеру, вести дорогу — забирал бы мышь у игрока, а заодно ломал
  // вращение камеры: три.js в тот же миг просит захват указателя и получает
  // отказ, потому что указатель уже заперт. «Мышь у руля, а за рулём никого»
  // теперь невыразимо.

  const driver: Driver = {
    assist: true,
    keyboard: 'responsive',
    travel: TRAVEL_DEFAULT,
    command: 0,
    held(): boolean { return aim.held(); },
    anchor(): void {
      wheel = 0;
      keySteer = 0;
      steeringOwner = 'keyboard';
      surface.addEventListener('mousedown', grab);
    },
    release(): void {
      surface.removeEventListener('mousedown', grab);
      aim.give();
    },
    pad(): boolean {
      return typeof navigator.getGamepads === 'function' && [...navigator.getGamepads()].some((g) => g !== null);
    },
    detach(): void {
      removeEventListener('keydown', down);
      removeEventListener('keyup', up);
      removeEventListener('blur', clear);
      surface.removeEventListener('mousedown', grab);
      // общий захват не наш, чтобы его закрывать: его закроет тот, кто завёл
      if (shared === undefined) aim.detach();
      else aim.give();
    },
    read(dt: number, speed: number): Controls {
      const gamepad = typeof navigator.getGamepads === 'function'
        ? [...navigator.getGamepads()].find((g) => g !== null) ?? null : null;

      const left = keys.has('KeyA') || keys.has('ArrowLeft');
      const right = keys.has('KeyD') || keys.has('ArrowRight');
      const direction = Number(right) - Number(left);
      const axis = gamepad?.axes[0] ?? 0;
      if (Math.abs(axis) >= 0.12 && steeringOwner !== 'mouse') steeringOwner = 'gamepad';
      if (left || right) steeringOwner = 'keyboard';
      if (steeringOwner === 'mouse' && !aim.held()) steeringOwner = 'keyboard';

      if (driver.keyboard === 'legacy') {
        if (direction) keySteer = clamp(keySteer + direction * dt * 1.6, -1, 1);
        else keySteer -= clamp(keySteer, -dt * 2.2, dt * 2.2);
      } else {
        const target = direction / (1 + (speed / KEY_STEER_SPEED) ** 2);
        keySteer += (target - keySteer) * -Math.expm1(-KEY_STEER_RESPONSE * dt);
        if (!direction && Math.abs(keySteer) < 0.001) keySteer = 0;
      }

      if (steeringOwner === 'mouse') driver.command = wheel;
      else if (steeringOwner === 'gamepad') driver.command = Math.abs(axis) < 0.12 ? 0 : clamp(axis, -1, 1);
      else driver.command = keySteer;

      const gas = keys.has('KeyW') || keys.has('ArrowUp') ? (keys.has('ShiftLeft') ? 1 : 0.85) : 0;
      const stop = keys.has('KeyS') || keys.has('ArrowDown') || keys.has('Space') ? 1 : 0;
      throttle = pedal(throttle, gas, dt);
      brake = pedal(brake, stop, dt);
      return {
        steer: driver.command,
        throttle: Math.max(throttle, gamepad?.buttons[7]?.value ?? 0),
        brake: Math.max(brake, gamepad?.buttons[6]?.value ?? 0),
        handbrake: keys.has('KeyX') || (gamepad?.buttons[0]?.pressed ?? false),
        assist: driver.assist,
      };
    },
  };
  return driver;
}

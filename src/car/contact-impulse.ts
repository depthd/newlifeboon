import type { Car } from './car.ts';
import { type Вектор, dot, scale, cross, повернуть } from './contact-math.ts';

export interface RigidContact {
  point: Вектор;
  normal: Вектор;
  depth: number;
  friction: number;
  /** Заданный предел импульса трения у заторможенной шины, Н·с. */
  parkingGrip?: number;
}

const zero = (): Вектор => ({ x: 0, y: 0, z: 0 });
function addScaled(v: Вектор, a: Вектор, s: number): void {
  v.x += a.x * s;
  v.y += a.y * s;
  v.z += a.z * s;
}

interface Row {
  linear: Вектор;
  angular: Вектор;
  direction: Вектор;
  lever: Вектор;
  mass: number;
  impulse: number;
}
function project(row: Row, v: Вектор, w: Вектор, target: number, lo: number, hi: number): void {
  const speed = dot(row.direction, v) + dot(row.lever, w);
  const next = Math.max(lo, Math.min(hi, row.impulse + (target - speed) * row.mass));
  addScaled(v, row.linear, next - row.impulse);
  addScaled(w, row.angular, next - row.impulse);
  row.impulse = next;
}

/** Контактные импульсы решаются последовательно (Catto, Sequential Impulses).
 * Поправка пересечения меняет позу отдельно от физической скорости: глубина
 * не является запасом упругой энергии у несжимаемого асфальта. */
export function solveContacts(
  car: Car,
  hits: RigidContact[],
  mass: number,
  sprung: number,
  inertia: Вектор,
  dt: number,
): Вектор {
  const q = car.q,
    inverse = { w: q.w, x: -q.x, y: -q.y, z: -q.z };
  const makeRow = (arm: Вектор, direction: Вектор): Row => {
    const lever = cross(arm, direction);
    const t = повернуть(inverse, lever);
    const angular = повернуть(q, { x: t.x / inertia.x, y: t.y / inertia.y, z: t.z / inertia.z });
    const linear = { x: direction.x / mass, y: direction.y / sprung, z: direction.z / mass };
    return {
      linear,
      angular,
      direction,
      lever,
      mass: 1 / (dot(direction, linear) + dot(lever, angular)),
      impulse: 0,
    };
  };
  const constraints = hits.map((hit) => {
    const arm = { x: hit.point.x - car.x, y: hit.point.y - car.y, z: hit.point.z - car.z };
    const n = hit.normal;
    const side = Math.abs(n.x) < 0.8 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
    const tangent = cross(n, side);
    const t1 = scale(tangent, 1 / Math.hypot(tangent.x, tangent.y, tangent.z));
    const normal = makeRow(arm, n);
    return {
      hit,
      normal,
      t1: makeRow(arm, t1),
      t2: makeRow(arm, cross(n, t1)),
      position: { ...normal },
    };
  });
  const v = { x: car.vx, y: car.vy, z: car.vz },
    w = car.вращение;
  const correctV = zero(),
    correctW = zero();
  for (let i = 0; i < 8; i++)
    for (const c of constraints) {
      if (c.hit.parkingGrip === undefined) {
        project(c.normal, v, w, 0, 0, Infinity);
        project(
          c.position,
          correctV,
          correctW,
          (0.2 * Math.max(0, c.hit.depth - 0.001)) / dt,
          0,
          Infinity,
        );
      }
      const limit = c.hit.parkingGrip ?? c.normal.impulse * c.hit.friction;
      if (limit === 0 && c.t1.impulse === 0 && c.t2.impulse === 0) continue;
      // Оба касательных импульса делят один круг трения.
      project(c.t1, v, w, 0, -limit, limit);
      project(c.t2, v, w, 0, -limit, limit);
      const used = Math.hypot(c.t1.impulse, c.t2.impulse);
      if (used > limit) {
        const scale = limit / used;
        for (const row of [c.t1, c.t2]) {
          const reduction = row.impulse * (scale - 1);
          addScaled(v, row.linear, reduction);
          addScaled(w, row.angular, reduction);
          row.impulse *= scale;
        }
      }
    }
  car.vx = v.x;
  car.vy = v.y;
  car.vz = v.z;
  car.x += correctV.x * dt;
  car.y += correctV.y * dt;
  car.z += correctV.z * dt;
  return correctW;
}

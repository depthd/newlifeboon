import type { Sampler } from './car.ts';
import { type Вектор, dot, cross, scale } from './contact-math.ts';
import type { Spot } from './ground.ts';

type Point = Вектор;
type Contact = (point: Point, normal: Point, depth: number) => void;
const axisBits = [1, 2, 4] as const; // углыКузова: ширина, длина, высота
const difference = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const length = (p: Point): number => Math.hypot(p.x, p.y, p.z);
const between = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});
const normal = (s: Spot): Point => ({ x: s.nx, y: s.ny, z: s.nz });

interface Ledge {
  origin: Point;
  top: Point;
  side: Point;
  rim: Point;
}

// Когда в грунте осталась одна вершина, её пересечения с кромкой почти
// совпали. Две пробы границы на окружности дают направление и в этом случае.
function localChord(origin: Point, top: Point, halfDrop: number, sample: Sampler): Point[] {
  const pointAt = (angle: number): Point => ({
    x: origin.x + 0.025 * Math.cos(angle),
    y: origin.y,
    z: origin.z + 0.025 * Math.sin(angle),
  });
  const supported = (angle: number): boolean => {
    const p = pointAt(angle),
      s = sample(p.x, p.z);
    p.y = s.height;
    return s.present !== false && dot(top, difference(p, origin)) >= -halfDrop;
  };
  const intersections: Point[] = [];
  let prev = supported(0);
  for (let i = 1; i <= 4; i++) {
    let lo = ((i - 1) * Math.PI) / 2,
      hi = (i * Math.PI) / 2;
    const next = supported(hi);
    if (prev !== next) {
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) / 2;
        if (supported(mid) === prev) lo = mid;
        else hi = mid;
      }
      intersections.push(pointAt((lo + hi) / 2));
    }
    prev = next;
  }
  return intersections;
}

// Локально у ступеньки две грани: верх над дорогой и бок, обращённый к обрыву.
// Пересечения рёбер кузова с перепадом задают направление кромки в мире.
function findLedge(points: Point[], samples: Spot[], sample: Sampler): Ledge | null {
  const cuts: Point[] = [];
  let highNormal: Point | undefined;
  let halfDrop = Infinity;
  const towardsLower: Point[] = [];
  for (let i = 0; i < 8; i++)
    for (const bit of axisBits) {
      if (i & bit) continue;
      let hi = i,
        lo = i | bit;
      if (
        samples[hi].present === false ||
        (samples[lo].present !== false && samples[lo].height > samples[hi].height)
      )
        [hi, lo] = [lo, hi];
      const high = samples[hi],
        low = samples[lo];
      if (high.present === false) continue;
      const a = points[hi],
        b = points[lo],
        delta = difference(b, a);
      const gradient = -(high.nx * delta.x + high.nz * delta.z) / Math.max(high.ny, 1e-6);
      const drop = high.height + gradient - low.height;
      // На ровной и наклонной плоскости высота совпадает с касательной.
      if (low.present !== false && drop < 0.01) continue;
      let start = 0,
        end = 1,
        upper = high,
        lower = low;
      for (let iter = 0; iter < 13; iter++) {
        const t = (start + end) / 2;
        const probe = sample(a.x + delta.x * t, a.z + delta.z * t);
        if (
          probe.present !== false &&
          (low.present === false || probe.height >= high.height + gradient * t - drop / 2)
        ) {
          start = t;
          upper = probe;
        } else {
          end = t;
          lower = probe;
        }
      }
      // У непрерывной поверхности (включая перегиб дороги) нет вертикального бока.
      if (lower.present !== false && upper.height - lower.height < 0.005) continue;
      const cut = between(a, b, start);
      cut.y = upper.height;
      cuts.push(cut);
      if (!highNormal)
        halfDrop = lower.present === false ? Infinity : ((upper.height - lower.height) * upper.ny) / 2;
      highNormal ??= normal(upper);
      towardsLower.push(delta);
    }
  if (!cuts.length || !highNormal) return null;
  let endpoint = cuts[0],
    largest = 0;
  for (const c of cuts) {
    const distance = Math.hypot(c.x - cuts[0].x, c.z - cuts[0].z);
    if (distance > largest) {
      largest = distance;
      endpoint = c;
    }
  }
  let rim = difference(endpoint, cuts[0]);
  if (largest < 0.04) {
    const chord = localChord(cuts[0], highNormal, halfDrop, sample);
    if (chord.length !== 2) return null;
    rim = difference(chord[1], chord[0]);
    largest = Math.hypot(rim.x, rim.z);
    if (largest < 1e-6) return null;
  }
  let side = { x: -rim.z / largest, y: 0, z: rim.x / largest };
  // У почти параллельного кромке ребра направление по нормали плохо
  // обусловлено. Ориентируем грань по наиболее поперечному пересечению.
  let strongest = 0;
  for (const direction of towardsLower) {
    const component = dot(side, direction);
    if (Math.abs(component) > Math.abs(strongest)) strongest = component;
  }
  if (strongest < 0) side = scale(side, -1);
  // Несколько несогласованных кромок под одной машиной не образуют одну ступень.
  if (cuts.some((c) => Math.abs(dot(difference(c, cuts[0]), side)) > 0.012)) return null;
  const rimAxis = cross(highNormal, side);
  return { origin: cuts[0], top: highNormal, side, rim: scale(rimAxis, 1 / length(rimAxis)) };
}

// SAT для коробки и земли по одну сторону кромки. Нормаль, по которой
// коробке ближе всего разойтись с землёй, может принадлежать верху, боку
// или паре рёбер. Поэтому у скользящей вдоль обрыва машины толчок боковой.
function boxLedge(points: Point[], ledge: Ledge, contact: Contact): void {
  const { origin, top, side, rim } = ledge;
  const relative = points.map((p) => difference(p, origin));
  const axes = [top, side];
  const bits = [0, 0];
  for (const bit of axisBits) {
    let axis = cross(rim, difference(points[bit], points[0]));
    const mag = length(axis);
    if (mag < 1e-6) continue;
    axis = scale(axis, (axis.y < 0 ? -1 : 1) / mag);
    const componentOnTop = axis.y / top.y;
    const componentOnSide = dot(axis, side) - componentOnTop * dot(top, side);
    if (componentOnSide <= 1e-6 || componentOnTop <= 1e-6) continue;
    axes.push(axis);
    bits.push(bit);
  }
  let winner = 0,
    gap = -Infinity;
  for (let i = 0; i < axes.length; i++) {
    const distance = Math.min(...relative.map((r) => dot(axes[i], r)));
    if (distance >= 0) return;
    if (distance > gap) {
      winner = i;
      gap = distance;
    }
  }
  const n = axes[winner];
  if (winner < 2) {
    const clip = winner === 0 ? side : top;
    const distances = relative.map((r) => dot(clip, r));
    for (let i = 0; i < 8; i++) {
      const d = dot(n, relative[i]);
      if (distances[i] <= 0 && d < 0) contact(points[i], n, -d);
      for (const bit of axisBits) {
        if (i & bit) continue;
        const j = i | bit;
        if (distances[i] < 0 === distances[j] < 0) continue;
        const t = distances[i] / (distances[i] - distances[j]);
        const point = between(points[i], points[j], t);
        const depth = -dot(n, difference(point, origin));
        if (depth > 0) contact(point, n, depth);
      }
    }
    return;
  }
  const bit = bits[winner];
  const transverse = cross(rim, n);
  for (let i = 0; i < 8; i++) {
    if (i & bit || Math.abs(dot(relative[i], n) - gap) > 1e-6) continue;
    const j = i | bit;
    const tx = dot(relative[i], transverse),
      ty = dot(relative[j], transverse);
    const t = Math.max(0, Math.min(1, tx / (tx - ty)));
    contact(between(points[i], points[j], t), n, -gap);
  }
}

export function hullContacts(points: Point[], sample: Sampler, contact: Contact): void {
  const samples = points.map((p) => sample(p.x, p.z));
  let maxGround = -Infinity,
    bottom = Infinity;
  for (let i = 0; i < points.length; i++) {
    if (samples[i].present !== false) maxGround = Math.max(maxGround, samples[i].height);
    bottom = Math.min(bottom, points[i].y);
  }
  if (bottom > maxGround) return;
  const ledge = findLedge(points, samples, sample);
  if (ledge) boxLedge(points, ledge, contact);
  for (let i = 0; i < points.length; i++) {
    const p = points[i],
      s = samples[i];
    if (s.present === false || p.y >= s.height) continue;
    // Верх и вертикальный бок уже разрешены одним SAT; внизу может быть вторая дорога.
    if (ledge && dot(ledge.top, difference({ x: p.x, y: s.height, z: p.z }, ledge.origin)) > -0.005)
      continue;
    contact(p, normal(s), (s.height - p.y) * s.ny);
  }
}

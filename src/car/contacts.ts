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
const boxEdges: [number, number][] = [];
for (let i = 0; i < 8; i++) for (const bit of axisBits) if (!(i & bit)) boxEdges.push([i, i | bit]);

function ledgeContacts(
  points: Point[],
  samples: Spot[],
  sample: Sampler,
  contact: Contact,
  edges = boxEdges,
): Pick<Ledge, 'origin' | 'top'> | null {
  const cuts: Point[] = [];
  let highNormal: Point | undefined;
  let halfDrop = Infinity;
  const towardsLower: Point[] = [];
  const cutEdges: number[][] = [];
  for (const [first, second] of edges) {
    let hi = first,
      lo = second;
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
    cutEdges.push([hi, lo]);
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
  const top = highNormal;
  const occupied = (p: Point): boolean => {
    const spot = sample(p.x, p.z);
    const height = { x: p.x, y: spot.height, z: p.z };
    return spot.present !== false && dot(top, difference(height, cuts[0])) >= -halfDrop;
  };
  const middle = between(cuts[0], endpoint, 0.5);
  const onSide = (d: number): boolean =>
    occupied({ x: middle.x + d * side.x, y: middle.y, z: middle.z + d * side.z });
  const curved = cuts.some((c) => Math.abs(dot(difference(c, cuts[0]), side)) > 0.012);
  if (edges !== boxEdges || curved || onSide(0.025) || !onSide(-0.025)) {
    compoundContacts(points, samples, sample, cuts, cutEdges, top, halfDrop, occupied, contact);
  } else {
    const rimAxis = cross(top, side);
    boxLedge(points, { origin: cuts[0], top, side, rim: scale(rimAxis, 1 / length(rimAxis)) }, contact);
  }
  return { origin: cuts[0], top };
}

// У выпуклого угла, узкой полосы или дуги разные рёбра кузова встречают
// разные участки борта. Каждый участок восстанавливаем локально.
function compoundContacts(
  points: Point[],
  samples: Spot[],
  sample: Sampler,
  cuts: Point[],
  edges: number[][],
  top: Point,
  halfDrop: number,
  occupied: (p: Point) => boolean,
  contact: Contact,
): void {
  const planes: Ledge[] = [];
  for (let k = 0; k < cuts.length; k++) {
    const cut = cuts[k],
      chord = localChord(cut, top, halfDrop, sample);
    if (chord.length !== 2) continue;
    const tangent = difference(chord[1], chord[0]);
    const size = Math.hypot(tangent.x, tangent.z);
    if (size < 0.001) continue;
    let side = { x: -tangent.z / size, y: 0, z: tangent.x / size };
    if (occupied({ x: cut.x + 0.015 * side.x, y: cut.y, z: cut.z + 0.015 * side.z }))
      side = scale(side, -1);
    const rim = cross(top, side);
    const plane = { origin: cut, top, side, rim: scale(rim, 1 / length(rim)) };
    planes.push(plane);
    // Проверим, что нормаль пары «ребро кузова — кромка дороги» даёт
    // ближайшее разъединение. На почти вертикальном борту бывает ближе бок.
    const [hi, lo] = edges[k],
      a = points[hi],
      b = points[lo];
    const d = difference(b, a);
    let n = cross(rim, d),
      mag = length(n);
    if (mag < 1e-9) continue;
    n = scale(n, (n.y < 0 ? -1 : 1) / mag);
    if (dot(n, side) < 0 || n.y < 1e-6) continue;
    const gap = dot(n, difference(a, cut)),
      sideGap = Math.min(dot(side, difference(a, cut)), dot(side, difference(b, cut))),
      topGap = Math.min(dot(top, difference(a, cut)), dot(top, difference(b, cut)));
    if (gap >= 0 || gap < Math.max(sideGap, topGap) - 1e-6) continue;
    const along = Math.abs(d.x) > Math.abs(d.z) ? (cut.x - a.x) / d.x : (cut.z - a.z) / d.z;
    if (Number.isFinite(along)) contact(between(a, b, along), n, -gap);
  }
  // Для вершины внутри объёма ищем ближайший действительный выход на верх
  // или бок дороги. Касательную к дуге проверяем по обеим сторонам в мире.
  for (let i = 0; i < points.length; i++) {
    const p = points[i],
      s = samples[i];
    if (s.present === false || !occupied(p)) continue;
    let depth = (s.height - p.y) * s.ny,
      n = normal(s);
    if (depth <= 0) continue;
    for (const plane of planes) {
      const rel = difference(p, plane.origin),
        sideDepth = -dot(plane.side, rel);
      if (sideDepth < 0 || sideDepth >= depth) continue;
      const foot = { x: p.x + sideDepth * plane.side.x, y: p.y, z: p.z + sideDepth * plane.side.z };
      const tol = 0.015;
      if (
        !occupied({ x: foot.x + tol * plane.side.x, y: 0, z: foot.z + tol * plane.side.z }) &&
        occupied({ x: foot.x - tol * plane.side.x, y: 0, z: foot.z - tol * plane.side.z })
      ) {
        n = plane.side;
        depth = sideDepth;
      } else {
        const toward = { x: plane.origin.x - p.x, y: 0, z: plane.origin.z - p.z };
        const dist = length(toward);
        if (dist > 1e-6 && dist < depth) {
          n = scale(toward, 1 / dist);
          depth = dist;
        }
      }
    }
    if (depth > 0) contact(p, n, depth);
  }
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

// На вывешенных колёсах узкая полоса может целиком оказаться между углами
// кузова. Проверяем обращённую к земле грань с шагом сетки не более 25 см.
function bellyContacts(corners: Point[], sample: Sampler, contact: Contact): void {
  const axis = axisBits
    .map((bit) => {
      const d = difference(corners[bit], corners[0]);
      return { bit, vertical: d.y / length(d) };
    })
    .sort((a, b) => Math.abs(b.vertical) - Math.abs(a.vertical));
  const first = axis[0].vertical < 0 ? axis[0].bit : 0;
  const base = corners[first];
  const u = difference(corners[first | axis[1].bit], base);
  const v = difference(corners[first | axis[2].bit], base);
  const nu = Math.ceil(length(u) / 0.25),
    nv = Math.ceil(length(v) / 0.25);
  const points: Point[] = [],
    samples: Spot[] = [];
  let deepest = 0;
  const patch: number[] = [];
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++) {
      const a = i / nu,
        b = j / nv;
      const p = {
        x: base.x + u.x * a + v.x * b,
        y: base.y + u.y * a + v.y * b,
        z: base.z + u.z * a + v.z * b,
      };
      points.push(p);
      const s = sample(p.x, p.z);
      samples.push(s);
      if (s.present !== false && s.height > p.y) {
        deepest = Math.max(deepest, (s.height - p.y) * s.ny);
        patch.push(points.length - 1);
      }
    }
  if (!patch.length) return;

  // Тонкий плоский контакт днища с полкой: проверим крайние точки
  // опорного пятна. Если каждой ближе верх, решатель получает до четырёх
  // точек вместо поиска всей кромки на каждом шаге припаркованной машины.
  if (deepest < 0.01 && Math.abs(axis[0].vertical) > 0.98) {
    const extremes = new Set<number>();
    for (const su of [-1, 1])
      for (const sv of [-1, 1]) {
        let best = patch[0],
          max = -Infinity;
        for (const k of patch) {
          const score = su * ((k % (nu + 1)) / nu) + sv * (Math.floor(k / (nu + 1)) / nv);
          if (score > max) {
            max = score;
            best = k;
          }
        }
        extremes.add(best);
      }
    const topFace = [...extremes].every((k) => {
      const p = points[k],
        s = samples[k],
        radius = 2 * (s.height - p.y);
      return [
        [radius, 0],
        [-radius, 0],
        [0, radius],
        [0, -radius],
      ].every(([dx, dz]) => {
        const neighbor = sample(p.x + dx, p.z + dz);
        return neighbor.present !== false && neighbor.height >= p.y;
      });
    });
    if (topFace) {
      for (const k of extremes)
        contact(points[k], normal(samples[k]), (samples[k].height - points[k].y) * samples[k].ny);
      return;
    }
  }
  const edges: [number, number][] = [];
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++) {
      const k = j * (nu + 1) + i;
      if (i < nu) edges.push([k, k + 1]);
      if (j < nv) edges.push([k, k + nu + 1]);
    }
  if (ledgeContacts(points, samples, sample, contact, edges)) return;
  for (let i = 0; i < points.length; i++) {
    const s = samples[i],
      p = points[i];
    if (s.present !== false && p.y < s.height) contact(p, normal(s), (s.height - p.y) * s.ny);
  }
}

export function hullContacts(
  points: Point[],
  sample: Sampler,
  contact: Contact,
  wheelSupport: number,
): void {
  const samples = points.map((p) => sample(p.x, p.z));
  let maxGround = -Infinity,
    bottom = Infinity;
  for (let i = 0; i < points.length; i++) {
    if (samples[i].present !== false) maxGround = Math.max(maxGround, samples[i].height);
    bottom = Math.min(bottom, points[i].y);
  }
  if (bottom > maxGround) {
    if (wheelSupport === 0) bellyContacts(points, sample, contact);
    return;
  }
  const ledge = ledgeContacts(points, samples, sample, contact);
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

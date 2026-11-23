import { type Car, повернуть, центрКолеса } from '../car/car.ts';
import { type Passport, доНоса } from '../car/passport.ts';
import { pointAt, trackLength, halfWidth, laneOffset } from './course.ts';

type Point = { x: number; y: number; z: number };
type Face = { points: Point[]; color: string };
type Projected = { x: number; y: number; d: number };
const angleDelta = (to: number, from: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
const world = (x: number, y: number, z: number): Point => ({ x, y, z });
const roadPoint = (s: number, offset: number, y = 0): Point => {
  const p = pointAt(s);
  return world(p.x + Math.sin(p.yaw) * offset, y, p.z - Math.cos(p.yaw) * offset);
};
const trees: Point[] = [];
let seed = 1701;
function random(): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
for (let i = 0; i < 650; i++) {
  const x = (random() - 0.5) * 470 + 60,
    z = (random() - 0.5) * 365 + 38;
  if (laneOffset(x, z) < 53) continue;
  trees.push(world(x, 6 + 12 * random(), z));
}

const terrain: Face[] = [];
function strip(start: number, end: number, inner: number, outer: number, h: number, color: string) {
  terrain.push({
    points: [
      roadPoint(start, inner, h),
      roadPoint(end, inner, h),
      roadPoint(end, outer, h),
      roadPoint(start, outer, h),
    ],
    color,
  });
}
const pieces = 160;
for (let i = 0; i < pieces; i++) {
  const s = (trackLength * i) / pieces,
    e = (trackLength * (i + 1)) / pieces;
  strip(s, e, -halfWidth, halfWidth, 0, '#505654');
  for (const rut of [-0.82, 0.82]) strip(s, e, rut - 0.16, rut + 0.16, 0.002, '#4b514f');
  for (const side of [-1, 1]) {
    strip(s, e, side * (halfWidth - 0.18), side * (halfWidth - 0.07), 0.01, '#e8e7d9');
    if (((s > 108 && s < 238) || s > 345) && side < 0) {
      strip(s, e, -halfWidth - 0.8, -halfWidth, 0.012, i % 2 ? '#fcde93' : '#bc643f');
    }
  }
  if (i % 4 === 0) strip(s, s + 1.6, -0.055, 0.055, 0.01, '#a1a299');
}
for (let i = 0; i < 24; i++) {
  const width = 12 / 24;
  for (let j = 0; j < 2; j++)
    strip(
      84 + j * 0.48,
      84 + (j + 1) * 0.48,
      -6 + i * width,
      -6 + (i + 1) * width,
      0.015,
      (i + j) % 2 ? '#eeeadd' : '#242c2b',
    );
}
function cone(s: number, offset: number) {
  const center = roadPoint(s, offset);
  const pt = (dx: number, dy: number, dz: number) => world(center.x + dx, dy, center.z + dz);
  const sides = 8;
  for (let i = 0; i < sides; i++) {
    const a = (i * 2 * Math.PI) / sides,
      b = ((i + 1) * 2 * Math.PI) / sides;
    for (const [low, high, color] of [
      [0, 0.23, '#e77736'],
      [0.23, 0.34, '#f3edd7'],
      [0.34, 0.58, '#da6733'],
    ] as const) {
      const vertex = (angle: number, h: number) =>
        pt(Math.cos(angle) * (0.22 - 0.32 * h), h, Math.sin(angle) * (0.22 - 0.32 * h));
      terrain.push({ points: [vertex(a, low), vertex(b, low), vertex(b, high), vertex(a, high)], color });
    }
  }
}
// Открытый металлический отбойник — ориентир на внешнем краю виража, за зоной съезда.
for (const [start, end] of [
  [125, 218],
  [362, 455],
]) {
  for (let s = start; s < end; s += 4) {
    const a = roadPoint(s, 11, 0.46),
      b = roadPoint(s + 4, 11, 0.46);
    terrain.push({ points: [a, b, { ...b, y: 0.77 }, { ...a, y: 0.77 }], color: '#969b87' });
    terrain.push({
      points: [
        { ...a, y: 0.74 },
        { ...b, y: 0.74 },
        { ...b, y: 0.82 },
        { ...a, y: 0.82 },
      ],
      color: '#ccd0b8',
    });
    terrain.push({
      points: [a, roadPoint(s + 0.14, 11, 0.46), roadPoint(s + 0.14, 11, 0), roadPoint(s, 11, 0)],
      color: '#717c70',
    });
  }
}
for (const s of [110, 113, 116, 176, 180, 235, 238, 351, 354]) cone(s, s === 176 || s === 180 ? -6.35 : 6.35);

export function resizeCanvas(canvas: HTMLCanvasElement) {
  const w = Math.round(canvas.clientWidth),
    h = Math.round(canvas.clientHeight);
  const scale = Math.min(1.65, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(w * scale) || canvas.height !== Math.round(h * scale)) {
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  return { w, h, ctx };
}

function carFaces(c: Car, p: Passport): Face[] {
  const faces: Face[] = [];
  const bodyPoint = (x: number, y: number, z: number): Point => {
    const r = повернуть(c.q, world(x, y - p.cgHeight, z));
    return world(c.x + r.x, c.y + r.y, c.z + r.z);
  };
  const nose = доНоса(p),
    half = p.width / 2;
  const red = p.ярлык === 'viper';
  const paint = red ? ['#a63631', '#d45747', '#a44538'] : ['#819cac', '#acc0cd', '#718d9c'];
  const glass = p.стёкла;
  // Крыша и капот сужаются кверху. Геометрия продольного профиля — из паспорта.
  const sections = p.силуэт.map(([back, y]) => {
    const window = y > glass.низ && back >= glass.от - 0.08 && back <= glass.до + 0.08;
    const width = half * (window ? 0.82 : 0.96);
    return {
      back,
      y,
      left: bodyPoint(nose - back, y, -width),
      right: bodyPoint(nose - back, y, width),
      window,
    };
  });
  for (let i = 0; i < sections.length; i++) {
    const a = sections[i],
      b = sections[(i + 1) % sections.length];
    const window = (a.window || b.window) && Math.abs(a.y - b.y) > 0.18;
    const horizontal = Math.abs(b.back - a.back) > 1.2 * Math.abs(b.y - a.y);
    faces.push({
      points: [a.left, a.right, b.right, b.left],
      color: window ? '#344b55' : horizontal ? paint[1] : paint[2],
    });
  }
  for (const [side, color] of [
    [-1, paint[0]],
    [1, paint[2]],
  ] as const) {
    faces.push({ points: sections.map((s) => (side < 0 ? s.left : s.right)), color });
    const front = nose - glass.от,
      rear = nose - glass.до;
    const gl = (x: number, y: number) => bodyPoint(x, y, side * half * 0.969);
    const pillar = (front + rear) / 2;
    faces.push({
      points: [
        gl(front, glass.низ),
        gl(front - 0.26, glass.верх),
        gl(pillar + 0.035, glass.верх),
        gl(pillar + 0.035, glass.низ),
      ],
      color: '#435d67',
    });
    faces.push({
      points: [
        gl(pillar - 0.035, glass.низ),
        gl(pillar - 0.035, glass.верх),
        gl(rear + 0.22, glass.верх),
        gl(rear, glass.низ),
      ],
      color: '#354a53',
    });
  }
  const rear = nose - p.length - 0.025;
  for (const side of [-1, 1]) {
    const cz = side * half * 0.73,
      y = p.height * 0.4;
    faces.push({
      points: [
        bodyPoint(rear, y - 0.035, cz - 0.15),
        bodyPoint(rear, y + 0.055, cz - 0.15),
        bodyPoint(rear, y + 0.055, cz + 0.15),
        bodyPoint(rear, y - 0.035, cz + 0.15),
      ],
      color: '#ec5b42',
    });
  }
  faces.push({
    points: [
      bodyPoint(rear, 0.31, -half * 0.83),
      bodyPoint(rear, 0.36, -half * 0.83),
      bodyPoint(rear, 0.36, half * 0.83),
      bodyPoint(rear, 0.31, half * 0.83),
    ],
    color: '#454f52',
  });
  faces.push({
    points: [
      bodyPoint(rear, 0.39, -0.2),
      bodyPoint(rear, 0.47, -0.2),
      bodyPoint(rear, 0.47, 0.2),
      bodyPoint(rear, 0.39, 0.2),
    ],
    color: '#ece9d2',
  });
  for (const wheel of c.wheels) {
    const hub = центрКолеса(c, wheel, wheel.travel);
    const side = Math.sign(wheel.right),
      tireWidth = wheel.ahead > 0 ? p.wheelFront.width : p.wheelRear.width;
    for (const [r, col, depth] of [
      [wheel.radius, '#202628', tireWidth * 0.5],
      [wheel.radius * 0.58, '#809092', tireWidth * 0.51],
    ] as const) {
      const points: Point[] = [];
      for (let i = 0; i < 12; i++) {
        const a = (i * Math.PI) / 6,
          x = r * Math.cos(a),
          z = side * depth;
        const v = повернуть(
          c.q,
          world(
            x * Math.cos(wheel.steer) - z * Math.sin(wheel.steer),
            r * Math.sin(a),
            x * Math.sin(wheel.steer) + z * Math.cos(wheel.steer),
          ),
        );
        points.push(world(hub.x + v.x, hub.y + v.y, hub.z + v.z));
      }
      faces.push({ points, color: col });
    }
  }
  return faces;
}

export class ChaseView {
  private heading = 0;
  constructor(private readonly canvas: HTMLCanvasElement) {}
  reset(yaw: number) {
    this.heading = yaw;
  }
  draw(car: Car, p: Passport, dt: number, trail: readonly { x: number; z: number }[] = []) {
    const { ctx, w, h } = resizeCanvas(this.canvas);
    if (w <= 0 || h <= 0) return;
    const speed = Math.hypot(car.vx, car.vz);
    // Камера держится за траекторию. Когда нос уходит вбок, это видно на фоне дороги.
    const nose = car.yaw;
    const slip = angleDelta(Math.atan2(car.vz, car.vx), nose);
    const followsCourse = Math.min(0.75, Math.max(0, (speed - 2) / 8)) * Math.max(0, Math.cos(slip));
    const heading = nose + slip * followsCourse;
    this.heading += angleDelta(heading, this.heading) * (1 - Math.exp(-12 * dt));
    const yaw = this.heading + 0.075,
      co = Math.cos(yaw),
      si = Math.sin(yaw);
    const cam = world(
      car.x - 8.5 * Math.cos(this.heading) + 0.95 * Math.sin(this.heading),
      car.y + 3.25,
      car.z - 8.5 * Math.sin(this.heading) - 0.95 * Math.cos(this.heading),
    );
    const f = Math.min(w * 0.9, h * 0.9),
      horizon = h * 0.38;
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#709fb5');
    sky.addColorStop(0.7, '#bed3d2');
    sky.addColorStop(1, '#f4ddaa');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, horizon + 1);
    for (let i = 0; i < 22; i++) {
      const a = ((i + 0.36 * Math.cos(i * 5)) * 2 * Math.PI) / 22,
        relative = Math.atan2(Math.sin(a - yaw), Math.cos(a - yaw));
      if (Math.abs(relative) > 1.15) continue;
      const sx = w / 2 + Math.tan(relative) * f,
        cy = h * (0.085 + 0.105 * (1 + Math.sin(i * 11)) * 0.5);
      const size = h * (0.024 + 0.016 * (1 + Math.sin(i * 3)) * 0.5);
      for (let j = 0; j < 5; j++) {
        ctx.beginPath();
        ctx.ellipse(
          sx + (j - 2) * size * 0.9,
          cy + size * 0.22 * Math.sin(i + j),
          size * (1.5 - Math.abs(j - 2) * 0.18),
          size * (0.36 + 0.15 * Math.cos(j)),
          0,
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = 'rgba(244,239,212,.13)';
        ctx.fill();
      }
    }
    for (let layer = 0; layer < 3; layer++) {
      ctx.beginPath();
      ctx.moveTo(0, horizon);
      for (let x = -4; x <= w + 6; x += 4) {
        const a = yaw + Math.atan((x - w / 2) / f);
        const wave =
          Math.sin(3 * a + layer * 1.5) * 0.3 +
          Math.sin(7 * a + layer) * 0.19 +
          Math.sin(19 * a + 0.7 * layer) * 0.07;
        ctx.lineTo(x, horizon - h * (0.065 - layer * 0.016 + wave * 0.095));
      }
      ctx.lineTo(w, horizon);
      ctx.closePath();
      ctx.fillStyle = ['#9baea8', '#899d91', '#758c79'][layer];
      ctx.fill();
    }
    const field = ctx.createLinearGradient(0, horizon, 0, h);
    field.addColorStop(0, '#98a780');
    field.addColorStop(1, '#778753');
    ctx.fillStyle = field;
    ctx.fillRect(0, horizon, w, h - horizon);
    const cameraPoint = (v: Point): Projected => {
      const x = v.x - cam.x,
        z = v.z - cam.z;
      return { x: -si * x + co * z, y: cam.y - v.y, d: co * x + si * z };
    };
    for (let ti = 0; ti < trees.length; ti++) {
      const tree = trees[ti];
      const t = cameraPoint(world(tree.x, 0, tree.z));
      if (t.d < 0.7) continue;
      const sx = w / 2 + (f * t.x) / t.d,
        base = horizon + (f * t.y) / t.d,
        height = (tree.y * f) / t.d;
      if (sx + height * 0.4 < 0 || sx - height * 0.4 > w) continue;
      ctx.fillStyle = t.d > 140 ? '#627f70' : '#4b6d55';
      if (ti % 4 === 0) {
        const width = height * (0.34 + 0.04 * Math.sin(ti));
        ctx.fillRect(sx - height * 0.04, base - height * 0.34, height * 0.08, height * 0.34);
        for (let k = 0; k < 4; k++) {
          ctx.beginPath();
          ctx.ellipse(
            sx + Math.sin(k * 3.9) * width * 0.51,
            base - height * (0.55 + k * 0.08),
            width * 0.76,
            height * 0.25,
            0,
            0,
            Math.PI * 2,
          );
          ctx.fillStyle = k % 2 === 0 ? '#607b60' : '#6b8867';
          ctx.fill();
        }
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(sx, base - height);
      ctx.lineTo(sx + height * 0.22, base - height * 0.42);
      ctx.lineTo(sx + height * 0.14, base - height * 0.43);
      ctx.lineTo(sx + height * 0.29, base - height * 0.09);
      ctx.lineTo(sx, base);
      ctx.lineTo(sx - height * 0.3, base - height * 0.11);
      ctx.lineTo(sx - height * 0.13, base - height * 0.45);
      ctx.lineTo(sx - height * 0.21, base - height * 0.4);
      ctx.closePath();
      ctx.fill();
    }
    // Трава вдали, полигон, тень и машина рисуются в физическом масштабе.
    const drawFace = (points: Projected[], color: string) => {
      const near = 0.35;
      if (points.every((t) => t.d < near)) return;
      let clipped = points;
      if (points.some((t) => t.d < near)) {
        clipped = [];
        for (let i = 0; i < points.length; i++) {
          const a = points[i],
            b = points[(i + 1) % points.length];
          if (a.d >= near) clipped.push(a);
          if (a.d >= near !== b.d >= near) {
            const v = (near - a.d) / (b.d - a.d);
            clipped.push({ x: a.x + v * (b.x - a.x), y: a.y + v * (b.y - a.y), d: near });
          }
        }
      }
      ctx.beginPath();
      for (let i = 0; i < clipped.length; i++) {
        const a = clipped[i],
          px = w / 2 + (f * a.x) / a.d,
          py = horizon + (f * a.y) / a.d;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.65;
      ctx.stroke();
    };
    for (const face of terrain) drawFace(face.points.map(cameraPoint), face.color);
    const tail = trail.slice(-16).map(({ x, z }) => cameraPoint(world(x, 0.025, z)));
    ctx.strokeStyle = '#dafe639e';
    ctx.lineWidth = Math.max(2, h * 0.004);
    ctx.beginPath();
    let visible = false;
    for (const point of tail) {
      if (point.d <= 0.35) { visible = false; continue; }
      const sx = w / 2 + (f * point.x) / point.d, sy = horizon + (f * point.y) / point.d;
      if (visible) ctx.lineTo(sx, sy);
      else ctx.moveTo(sx, sy);
      visible = true;
    }
    ctx.stroke();
    const shadow: Projected[] = [];
    for (let i = 0; i < 18; i++) {
      const a = (i * 2 * Math.PI) / 18;
      const dx = p.length * 0.53 * Math.cos(a),
        dz = p.width * 0.6 * Math.sin(a);
      shadow.push(cameraPoint(world(car.x + dx * co - dz * si, 0.015, car.z + dx * si + dz * co)));
    }
    drawFace(shadow, '#363c39');
    const faces = carFaces(car, p)
      .map((face) => {
        const points = face.points.map(cameraPoint);
        return { points, color: face.color, depth: points.reduce((v, t) => v + t.d, 0) / points.length };
      })
      .sort((a, b) => b.depth - a.depth);
    for (const face of faces) drawFace(face.points, face.color);
  }
}

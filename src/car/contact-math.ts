/** Вектор в мире или в осях кузова: x вперёд, y вверх, z вправо. */
export interface Вектор {
  x: number;
  y: number;
  z: number;
}
/** Поворот кузова в мире — кватернион: четыре числа, которые описывают любой поворот в 3D без «замка» углов. */
export interface Кватернион {
  readonly w: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Повернуть вектор кватернионом (из осей кузова в мир). */
export function повернуть(q: Кватернион, v: Вектор): Вектор {
  const tx = 2 * (q.y * v.z - q.z * v.y),
    ty = 2 * (q.z * v.x - q.x * v.z),
    tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}
/** Обратно: из мира в оси кузова. */
export const вОсиКузова = (q: Кватернион, v: Вектор): Вектор =>
  повернуть({ w: q.w, x: -q.x, y: -q.y, z: -q.z }, v);
export const cross = (a: Вектор, b: Вектор): Вектор => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export const dot = (a: Вектор, b: Вектор): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const scale = (v: Вектор, factor: number): Вектор => ({
  x: v.x * factor,
  y: v.y * factor,
  z: v.z * factor,
});

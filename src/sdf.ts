// Signed-distance primitives and smooth blending used to generate the base clay lumps.
export type V3 = [number, number, number];

export type Prim =
  | { t: 'sphere'; c: V3; r: number }
  | { t: 'ellipsoid'; c: V3; r: V3 }
  | { t: 'capsule'; a: V3; b: V3; r: number; r2?: number };

export interface Shape {
  prims: Prim[];
  /** smooth-min blend radius; bigger = more "melted together" clay */
  blend: number;
}

export type SDF = (x: number, y: number, z: number) => number;

export interface Bounds { min: V3; max: V3 }

function smin(a: number, b: number, k: number): number {
  if (k <= 0) return a < b ? a : b;
  const diff = a - b;
  const h = Math.max(k - (diff < 0 ? -diff : diff), 0) / k;
  return (a < b ? a : b) - h * h * k * 0.25;
}

export function compilePrim(p: Prim): SDF {
  switch (p.t) {
    case 'sphere': {
      const [cx, cy, cz] = p.c;
      const r = p.r;
      return (x, y, z) => {
        const dx = x - cx, dy = y - cy, dz = z - cz;
        return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
      };
    }
    case 'ellipsoid': {
      const [cx, cy, cz] = p.c;
      const [rx, ry, rz] = p.r;
      return (x, y, z) => {
        const px = (x - cx) / rx, py = (y - cy) / ry, pz = (z - cz) / rz;
        const k0 = Math.sqrt(px * px + py * py + pz * pz);
        if (k0 < 1e-6) return -Math.min(rx, ry, rz);
        const k1 = Math.sqrt((px * px) / (rx * rx) + (py * py) / (ry * ry) + (pz * pz) / (rz * rz));
        return (k0 * (k0 - 1)) / k1;
      };
    }
    case 'capsule': {
      const [ax, ay, az] = p.a;
      const [bx, by, bz] = p.b;
      const r1 = p.r;
      const r2 = p.r2 ?? p.r;
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      const l2 = dx * dx + dy * dy + dz * dz || 1e-9;
      return (x, y, z) => {
        const px = x - ax, py = y - ay, pz = z - az;
        let t = (px * dx + py * dy + pz * dz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = px - dx * t, qy = py - dy * t, qz = pz - dz * t;
        return Math.sqrt(qx * qx + qy * qy + qz * qz) - (r1 + (r2 - r1) * t);
      };
    }
  }
}

export function compileShape(shape: Shape): SDF {
  const fns = shape.prims.map(compilePrim);
  const k = shape.blend;
  return (x, y, z) => {
    let d = fns[0](x, y, z);
    for (let i = 1; i < fns.length; i++) d = smin(d, fns[i](x, y, z), k);
    return d;
  };
}

export function shapeBounds(shape: Shape): Bounds {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  const grow = (c: V3, r: V3) => {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], c[i] - r[i]);
      max[i] = Math.max(max[i], c[i] + r[i]);
    }
  };
  for (const p of shape.prims) {
    if (p.t === 'sphere') grow(p.c, [p.r, p.r, p.r]);
    else if (p.t === 'ellipsoid') grow(p.c, p.r);
    else {
      const r = Math.max(p.r, p.r2 ?? p.r);
      grow(p.a, [r, r, r]);
      grow(p.b, [r, r, r]);
    }
  }
  const pad = shape.blend + 0.08;
  return {
    min: [min[0] - pad, min[1] - pad, min[2] - pad],
    max: [max[0] + pad, max[1] + pad, max[2] + pad],
  };
}

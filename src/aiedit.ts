// "AI와 함께 고치기": applies the AI's edit ops to the clay surface.
// The work is spread over EDIT_STEPS steps so the sculptor's dynamic topology can split stretched
// triangles in between (a horn pulled out of a head stays smooth). Every step re-reads the current
// surface and covers a share of the *remaining* way, so it converges instead of piling up, and
// vertices created by a split are moved like the rest.
import { compilePrim, type SDF } from './sdf';
import { buildAdjacency, type Adjacency } from './mesher';
import type { EditOp, EditPrim } from './cloud';

export interface EditCtx {
  pos: Float32Array;
  nrm: Float32Array;
  count: number;
  /** Set > 0 on every vertex the step moves, so dyntopo refines there. */
  weight: Float32Array;
  idx: Uint32Array;
  icount: number;
}

export const EDIT_STEPS = 8;

const falloff = (d: number, r: number) => {
  if (d >= r) return 0;
  const t = d / r;
  return 1 - t * t * (3 - 2 * t);
};

function reachOf(p: EditPrim): number {
  if (p.t === 'sphere') return p.r * 2;
  if (p.t === 'ellipsoid') return Math.max(...p.r) * 2;
  return Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]) + Math.max(p.r, p.r2 ?? p.r) * 2;
}

/** How far to go from p along d (p inside the shape, sdf < 0) until leaving it; at most maxT. */
function exitDistance(sdf: SDF, px: number, py: number, pz: number, dx: number, dy: number, dz: number, maxT: number): number {
  let lo = 0, hi = -1;
  // Inside, -sdf is the distance to the nearest surface, so stepping by it never jumps past the exit.
  for (let t = 0; t <= maxT;) {
    const d = sdf(px + dx * t, py + dy * t, pz + dz * t);
    if (d >= 0) { hi = t; break; }
    lo = t;
    t += Math.max(-d, 0.004);
  }
  if (hi < 0) return lo;
  for (let k = 0; k < 12; k++) {
    const m = (lo + hi) / 2;
    if (sdf(px + dx * m, py + dy * m, pz + dz * m) < 0) lo = m; else hi = m;
  }
  return hi;
}

/** Laplacian relax: each selected vertex moves toward its neighbours' average by sel[v] * 0.5. */
function relax(pos: Float32Array, count: number, adj: Adjacency, sel: Float32Array, iterations: number) {
  const tmp = new Float32Array(count * 3);
  for (let it = 0; it < iterations; it++) {
    tmp.set(pos.subarray(0, count * 3));
    for (let v = 0; v < count; v++) {
      const s = sel[v];
      const nb = adj[v];
      if (!s || !nb?.length) continue;
      let ax = 0, ay = 0, az = 0;
      for (const u of nb) { ax += tmp[u * 3]; ay += tmp[u * 3 + 1]; az += tmp[u * 3 + 2]; }
      const k = s * 0.5, n = nb.length, j = v * 3;
      pos[j] += (ax / n - tmp[j]) * k;
      pos[j + 1] += (ay / n - tmp[j + 1]) * k;
      pos[j + 2] += (az / n - tmp[j + 2]) * k;
    }
  }
}

/** Builds the per-step callback for Sculptor.applyProgrammatic. */
export function makeEditStep(ops: EditOp[]) {
  const shaped = ops.map((op) => ('prim' in op ? { op, sdf: compilePrim(op.prim), reach: reachOf(op.prim) } : { op, sdf: null, reach: 0 }));

  return (ctx: EditCtx, step: number) => {
    const { pos, nrm, count, weight } = ctx;
    const share = 1 / (EDIT_STEPS - step);
    for (const { op, sdf, reach } of shaped) {
      if (op.op === 'smooth') continue; // handled once at the end
      if ('prim' in op) {
        // add: push the clay inside the part out to its surface along the normal; carve: push it in.
        const sign = op.op === 'add' ? 1 : -1;
        for (let v = 0; v < count; v++) {
          const j = v * 3;
          const x = pos[j], y = pos[j + 1], z = pos[j + 2];
          if (sdf!(x, y, z) >= 0) continue;
          const nx = nrm[j] * sign, ny = nrm[j + 1] * sign, nz = nrm[j + 2] * sign;
          const t = exitDistance(sdf!, x, y, z, nx, ny, nz, reach) * share;
          pos[j] = x + nx * t; pos[j + 1] = y + ny * t; pos[j + 2] = z + nz * t;
          weight[v] = 1;
        }
        continue;
      }
      const [cx, cy, cz] = op.c;
      const k = op.op === 'scale' ? op.factor ** (1 / EDIT_STEPS) - 1 : 0;
      for (let v = 0; v < count; v++) {
        const j = v * 3;
        const dx = pos[j] - cx, dy = pos[j + 1] - cy, dz = pos[j + 2] - cz;
        const w = falloff(Math.hypot(dx, dy, dz), op.r);
        if (!w) continue;
        if (op.op === 'move') {
          pos[j] += (op.offset[0] * w) / EDIT_STEPS;
          pos[j + 1] += (op.offset[1] * w) / EDIT_STEPS;
          pos[j + 2] += (op.offset[2] * w) / EDIT_STEPS;
        } else {
          pos[j] += dx * k * w; pos[j + 1] += dy * k * w; pos[j + 2] += dz * k * w;
        }
        weight[v] = Math.max(weight[v], w);
      }
    }
    spread(ctx, shaped);
    if (step === EDIT_STEPS - 1) finish(ctx, shaped);
  };
}

/**
 * Normals converge as clay is pushed out, which folds a new part into ridges. Even the moved vertices out
 * over the part's surface: relax them a little, then snap them back onto the part (Newton steps on its SDF).
 */
function spread(ctx: EditCtx, shaped: { op: EditOp; sdf: SDF | null }[]) {
  const { pos, count, weight } = ctx;
  const sel = new Float32Array(count);
  let adj: Adjacency | null = null;
  for (const { op, sdf } of shaped) {
    if (!sdf || op.op !== 'add') continue;
    const band = Math.max(op.blend, 0.02);
    let any = false;
    sel.fill(0);
    for (let v = 0; v < count; v++) {
      if (weight[v] > 0 && Math.abs(sdf(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2])) < band) { sel[v] = 1; any = true; }
    }
    if (!any) continue;
    relax(pos, count, (adj ??= buildAdjacency(ctx.idx, count, ctx.icount)), sel, 2);
    const e = 1e-3;
    for (let v = 0; v < count; v++) {
      if (!sel[v]) continue;
      const j = v * 3;
      for (let it = 0; it < 2; it++) {
        const x = pos[j], y = pos[j + 1], z = pos[j + 2];
        const d = sdf(x, y, z);
        const gx = sdf(x + e, y, z) - sdf(x - e, y, z), gy = sdf(x, y + e, z) - sdf(x, y - e, z), gz = sdf(x, y, z + e) - sdf(x, y, z - e);
        const l = Math.hypot(gx, gy, gz);
        if (l < 1e-9) break;
        pos[j] = x - (gx / l) * d; pos[j + 1] = y - (gy / l) * d; pos[j + 2] = z - (gz / l) * d;
      }
    }
  }
}

/** Last step: melt the seams of added/carved parts and run the smooth ops. */
function finish(ctx: EditCtx, shaped: { op: EditOp; sdf: SDF | null }[]) {
  const { pos, count } = ctx;
  let adj: Adjacency | null = null;
  const neighbours = () => (adj ??= buildAdjacency(ctx.idx, count, ctx.icount));
  const sel = new Float32Array(count);
  for (const { op, sdf } of shaped) {
    sel.fill(0);
    let any = false;
    if (sdf && (op.op === 'add' || op.op === 'carve')) {
      const band = op.blend * 1.5;
      for (let v = 0; v < count; v++) {
        const d = Math.abs(sdf(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]));
        if (d < band) { sel[v] = 1 - d / band; any = true; }
      }
      if (any) relax(pos, count, neighbours(), sel, 2);
    } else if (op.op === 'smooth') {
      for (let v = 0; v < count; v++) {
        const w = falloff(Math.hypot(pos[v * 3] - op.c[0], pos[v * 3 + 1] - op.c[1], pos[v * 3 + 2] - op.c[2]), op.r);
        if (w) { sel[v] = w * op.amount; any = true; }
      }
      if (any) relax(pos, count, neighbours(), sel, 4);
    }
  }
}

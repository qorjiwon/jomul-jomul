// Marching cubes over an SDF with shared edge vertices -> clean indexed geometry.
import * as THREE from 'three';
import { edgeTable, triTable } from 'three/addons/objects/MarchingCubes.js';
import type { Bounds, SDF } from './sdf';

/** Neighbour lists per vertex. Plain arrays so the sculptor can grow/rewire them while splitting edges. */
export type Adjacency = number[][];

export interface ClayMesh {
  geometry: THREE.BufferGeometry;
  adjacency: Adjacency;
}

export function buildClayMesh(sdf: SDF, bounds: Bounds, resolution: number): ClayMesh {
  const ext = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
  const h = Math.max(ext[0], ext[1], ext[2]) / resolution;
  const nx = Math.ceil(ext[0] / h) + 1;
  const ny = Math.ceil(ext[1] / h) + 1;
  const nz = Math.ceil(ext[2] / h) + 1;
  const px = nx + 1, py = ny + 1, pz = nz + 1;
  const ox = bounds.min[0], oy = bounds.min[1], oz = bounds.min[2];

  // Sample field at grid points
  const field = new Float32Array(px * py * pz);
  for (let k = 0; k < pz; k++) {
    const z = oz + k * h;
    for (let j = 0; j < py; j++) {
      const y = oy + j * h;
      const row = (j + py * k) * px;
      for (let i = 0; i < px; i++) field[row + i] = sdf(ox + i * h, y, z);
    }
  }

  const edgeVert = new Int32Array(px * py * pz * 3).fill(-1);
  const positions: number[] = [];
  const indices: number[] = [];
  const vlist = new Int32Array(12);

  const yd = px, zd = px * py;

  // Returns the vertex index for the edge starting at grid point p along axis (0=x,1=y,2=z)
  const edgeVertex = (p: number, axis: number, i: number, j: number, k: number, s1: number, s2: number): number => {
    const key = p * 3 + axis;
    let v = edgeVert[key];
    if (v >= 0) return v;
    let t = s1 / (s1 - s2);
    if (!isFinite(t)) t = 0.5;
    const x = ox + (i + (axis === 0 ? t : 0)) * h;
    const y = oy + (j + (axis === 1 ? t : 0)) * h;
    const z = oz + (k + (axis === 2 ? t : 0)) * h;
    v = positions.length / 3;
    positions.push(x, y, z);
    edgeVert[key] = v;
    return v;
  };

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const q = i + j * yd + k * zd;
        const q1 = q + 1, qy = q + yd, qz = q + zd, q1y = q1 + yd, q1z = q1 + zd, qyz = qy + zd, q1yz = q1y + zd;
        const s0 = field[q], s1 = field[q1], s2 = field[qy], s3 = field[q1y];
        const s4 = field[qz], s5 = field[q1z], s6 = field[qyz], s7 = field[q1yz];
        let ci = 0;
        if (s0 > 0) ci |= 1;
        if (s1 > 0) ci |= 2;
        if (s2 > 0) ci |= 8;
        if (s3 > 0) ci |= 4;
        if (s4 > 0) ci |= 16;
        if (s5 > 0) ci |= 32;
        if (s6 > 0) ci |= 128;
        if (s7 > 0) ci |= 64;
        const bits = edgeTable[ci];
        if (bits === 0) continue;

        if (bits & 1) vlist[0] = edgeVertex(q, 0, i, j, k, s0, s1);
        if (bits & 2) vlist[1] = edgeVertex(q1, 1, i + 1, j, k, s1, s3);
        if (bits & 4) vlist[2] = edgeVertex(qy, 0, i, j + 1, k, s2, s3);
        if (bits & 8) vlist[3] = edgeVertex(q, 1, i, j, k, s0, s2);
        if (bits & 16) vlist[4] = edgeVertex(qz, 0, i, j, k + 1, s4, s5);
        if (bits & 32) vlist[5] = edgeVertex(q1z, 1, i + 1, j, k + 1, s5, s7);
        if (bits & 64) vlist[6] = edgeVertex(qyz, 0, i, j + 1, k + 1, s6, s7);
        if (bits & 128) vlist[7] = edgeVertex(qz, 1, i, j, k + 1, s4, s6);
        if (bits & 256) vlist[8] = edgeVertex(q, 2, i, j, k, s0, s4);
        if (bits & 512) vlist[9] = edgeVertex(q1, 2, i + 1, j, k, s1, s5);
        if (bits & 1024) vlist[10] = edgeVertex(q1y, 2, i + 1, j + 1, k, s3, s7);
        if (bits & 2048) vlist[11] = edgeVertex(qy, 2, i, j + 1, k, s2, s6);

        const base = ci << 4;
        for (let t = 0; triTable[base + t] !== -1; t += 3) {
          indices.push(vlist[triTable[base + t]], vlist[triTable[base + t + 1]], vlist[triTable[base + t + 2]]);
        }
      }
    }
  }

  const pos = new Float32Array(positions);
  const idx = new Uint32Array(indices);

  // Make sure triangles face outward (positive signed volume)
  if (signedVolume(pos, idx) < 0) {
    for (let t = 0; t < idx.length; t += 3) {
      const b = idx[t + 1];
      idx[t + 1] = idx[t + 2];
      idx[t + 2] = b;
    }
  }

  const adjacency = buildAdjacency(idx, pos.length / 3);
  // Regularise the irregular marching-cubes triangles a little (Taubin smoothing, no shrink)
  taubinSmooth(pos, adjacency, 2);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setIndex(new THREE.BufferAttribute(idx, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, adjacency };
}

export function signedVolume(pos: Float32Array, idx: Uint32Array): number {
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
    const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

export function buildAdjacency(idx: Uint32Array, nV: number, count = idx.length): Adjacency {
  const sets: Set<number>[] = new Array(nV);
  for (let i = 0; i < nV; i++) sets[i] = new Set();
  for (let t = 0; t < count; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    sets[a].add(b); sets[a].add(c);
    sets[b].add(a); sets[b].add(c);
    sets[c].add(a); sets[c].add(b);
  }
  return sets.map((s) => [...s]);
}

/** 1→4 midpoint subdivision: same shape, four times the triangles (denser surface for crisper paint). */
export function subdivideMesh(positions: Float32Array, index: Uint32Array): { positions: Float32Array; index: Uint32Array } {
  const nV = positions.length / 3;
  const P: number[] = Array.from(positions);
  const mids = new Map<number, number>();
  const mid = (a: number, b: number) => {
    const key = a < b ? a * nV + b : b * nV + a;
    let k = mids.get(key);
    if (k === undefined) {
      k = P.length / 3;
      for (let c = 0; c < 3; c++) P.push((P[a * 3 + c] + P[b * 3 + c]) / 2);
      mids.set(key, k);
    }
    return k;
  };
  const out = new Uint32Array(index.length * 4);
  for (let t = 0, o = 0; t < index.length; t += 3, o += 12) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    out.set([a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca], o);
  }
  return { positions: new Float32Array(P), index: out };
}

function laplacianStep(pos: Float32Array, adj: Adjacency, factor: number, tmp: Float32Array) {
  const nV = pos.length / 3;
  for (let v = 0; v < nV; v++) {
    const nb = adj[v];
    if (nb.length === 0) { tmp[v * 3] = pos[v * 3]; tmp[v * 3 + 1] = pos[v * 3 + 1]; tmp[v * 3 + 2] = pos[v * 3 + 2]; continue; }
    let ax = 0, ay = 0, az = 0;
    for (const nn of nb) {
      const n = nn * 3;
      ax += pos[n]; ay += pos[n + 1]; az += pos[n + 2];
    }
    const inv = 1 / nb.length;
    ax *= inv; ay *= inv; az *= inv;
    tmp[v * 3] = pos[v * 3] + (ax - pos[v * 3]) * factor;
    tmp[v * 3 + 1] = pos[v * 3 + 1] + (ay - pos[v * 3 + 1]) * factor;
    tmp[v * 3 + 2] = pos[v * 3 + 2] + (az - pos[v * 3 + 2]) * factor;
  }
  pos.set(tmp);
}

export function taubinSmooth(pos: Float32Array, adj: Adjacency, iterations: number) {
  const tmp = new Float32Array(pos.length);
  for (let i = 0; i < iterations; i++) {
    laplacianStep(pos, adj, 0.5, tmp);
    laplacianStep(pos, adj, -0.53, tmp);
  }
}

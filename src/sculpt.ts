import * as THREE from 'three';
import type { Adjacency } from './mesher';

export type SculptTool = 'pull' | 'push' | 'inflate' | 'smooth' | 'grab' | 'flatten';

export const SCULPT_TOOLS: { id: SculptTool; name: string; icon: string; key: string; hint: string }[] = [
  { id: 'pull', name: '당기기', icon: '👆', key: '1', hint: '찰흙을 덧붙여 불룩하게 만들어요' },
  { id: 'push', name: '밀기', icon: '👇', key: '2', hint: '찰흙을 눌러 오목하게 만들어요' },
  { id: 'inflate', name: '부풀리기', icon: '🎈', key: '3', hint: '풍선처럼 바깥으로 부풀려요' },
  { id: 'smooth', name: '매끄럽게', icon: '🧽', key: '4', hint: '울퉁불퉁한 곳을 문질러 고르게 해요' },
  { id: 'grab', name: '잡아끌기', icon: '✊', key: '5', hint: '한 덩이를 잡고 원하는 곳으로 끌어요' },
  { id: 'flatten', name: '평평하게', icon: '🫓', key: '6', hint: '표면을 눌러 납작하게 다져요' },
];

const MAX_HISTORY = 20;
/** Hard ceiling for dynamic topology so a runaway stroke can't eat the browser. */
export const MAX_VERTS = 350_000;
/** Edges longer than this many times the lump's original mean edge get split while sculpting. */
const SPLIT_RATIO = 1.7;

export interface Hit { point: THREE.Vector3; normal: THREE.Vector3 }

interface Snapshot { pos: Float32Array; idx: Uint32Array }

/** Neighbour vertices and incident triangles (index offsets) per vertex, built from the index buffer. */
function buildTopology(idx: Uint32Array, nV: number, icount: number): { adj: Adjacency; vtris: number[][] } {
  const vtris: number[][] = new Array(nV);
  const adj: number[][] = new Array(nV);
  for (let v = 0; v < nV; v++) { vtris[v] = []; adj[v] = []; }
  for (let t = 0; t < icount; t += 3) { vtris[idx[t]].push(t); vtris[idx[t + 1]].push(t); vtris[idx[t + 2]].push(t); }
  for (let v = 0; v < nV; v++) {
    const nb = adj[v];
    for (const t of vtris[v]) {
      for (let k = 0; k < 3; k++) {
        const o = idx[t + k];
        if (o !== v && !nb.includes(o)) nb.push(o);
      }
    }
  }
  return { adj, vtris };
}

/**
 * Brush-based clay sculpting on an indexed mesh.
 * Dynamic topology: while a stroke stretches triangles, edges inside the brush that grow too long are
 * split (both triangles sharing the edge), so pulling a long tentacle out of a sphere stays smooth instead
 * of turning into a few huge stretched faces. Arrays grow mid-stroke and are trimmed back at stroke end.
 */
export class Sculptor {
  tool: SculptTool = 'pull';
  radius = 0.24;
  strength = 0.5;
  symmetry = true;
  dyntopo = true;

  private pos!: Float32Array;
  private nrm!: Float32Array;
  private idx!: Uint32Array;
  private count = 0;   // used vertices
  private icount = 0;  // used index entries
  private adj!: Adjacency;
  private vtris: number[][] = [];
  /** Per-triangle pass stamp (index offset / 3) so a region scan visits each triangle once. */
  private stamp = new Uint32Array(0);
  private region = new Int32Array(0);
  private stampGen = 0;
  private readonly edgeTarget: number;
  private readonly original: Snapshot;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private w1!: Float32Array;
  private w2!: Float32Array;
  private tmp!: Float32Array;
  private strokeTool: SculptTool = 'pull';
  private invert = false;
  private grabStart: Float32Array | null = null;
  private grabPlane = new THREE.Plane();
  private grabOrigin = new THREE.Vector3();
  private stroking = false;
  private lastDab = new THREE.Vector3();
  private warnedCap = false;
  /** Called after every change (stroke step, undo…); `grew` is true when vertices were added. */
  onChange: ((grew: boolean) => void) | null = null;
  onCap: (() => void) | null = null;

  constructor(readonly mesh: THREE.Mesh, _adjacency?: Adjacency) {
    const g = mesh.geometry;
    const pa = g.getAttribute('position') as THREE.BufferAttribute;
    this.count = pa.count;
    this.icount = g.getIndex()!.count;
    this.bind();
    this.rebuildTopology();
    this.original = this.snapshot();
    this.edgeTarget = this.meanEdge();
  }

  get geometry() { return this.mesh.geometry; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get isStroking() { return this.stroking; }
  get vertexCount() { return this.count; }

  // ---------------------------------------------------------------- storage
  /** Re-reads the geometry's arrays (after we swapped attributes) and sizes the scratch arrays to match. */
  private bind() {
    const g = this.geometry;
    this.pos = (g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    this.nrm = (g.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array;
    this.idx = g.getIndex()!.array as Uint32Array;
    const cap = this.pos.length / 3;
    if (!this.w1 || this.w1.length < cap) {
      const grow = (old: Float32Array | undefined, n: number) => { const a = new Float32Array(n); if (old) a.set(old.subarray(0, Math.min(old.length, n))); return a; };
      this.w1 = grow(this.w1, cap); this.w2 = grow(this.w2, cap); this.tmp = grow(this.tmp, cap * 3);
    }
  }

  /** Makes room for `nV` vertices / `nI` index entries, replacing geometry attributes when needed. */
  private ensure(nV: number, nI: number) {
    const g = this.geometry;
    let changed = false;
    if (nV * 3 > this.pos.length) {
      const cap = Math.max(nV, Math.ceil(this.pos.length / 3 * 1.6));
      const p = new Float32Array(cap * 3); p.set(this.pos);
      const n = new Float32Array(cap * 3); n.set(this.nrm);
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
      changed = true;
    }
    if (nI > this.idx.length) {
      const cap = Math.max(nI, Math.ceil(this.idx.length * 1.6));
      const i = new Uint32Array(cap); i.set(this.idx);
      g.setIndex(new THREE.BufferAttribute(i, 1));
      changed = true;
    }
    if (changed) this.bind();
  }

  /** Trims the geometry back to exactly the used vertices/indices (so saving/exporting sees no slack). */
  private compact() {
    const g = this.geometry;
    if (this.pos.length !== this.count * 3) {
      g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, this.count * 3), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.slice(0, this.count * 3), 3));
    }
    if (this.idx.length !== this.icount) g.setIndex(new THREE.BufferAttribute(this.idx.slice(0, this.icount), 1));
    g.setDrawRange(0, Infinity);
    this.bind();
  }

  private snapshot(): Snapshot { return { pos: this.pos.slice(0, this.count * 3), idx: this.idx.slice(0, this.icount) }; }

  private restore(s: Snapshot) {
    const g = this.geometry;
    this.count = s.pos.length / 3;
    this.icount = s.idx.length;
    g.setAttribute('position', new THREE.BufferAttribute(s.pos.slice(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(s.pos.length), 3));
    g.setIndex(new THREE.BufferAttribute(s.idx.slice(), 1));
    g.setDrawRange(0, Infinity);
    this.bind();
    this.rebuildTopology();
    this.commit(true);
    g.computeBoundingBox();
  }

  private rebuildTopology() {
    ({ adj: this.adj, vtris: this.vtris } = buildTopology(this.idx, this.count, this.icount));
    this.stamp = new Uint32Array(Math.ceil(this.idx.length / 3));
    this.stampGen = 0;
  }

  private meanEdge(): number {
    let sum = 0, n = 0;
    const step = Math.max(3, Math.floor(this.icount / 3 / 4000) * 3);
    for (let t = 0; t < this.icount; t += step) {
      const a = this.idx[t] * 3, b = this.idx[t + 1] * 3;
      sum += Math.hypot(this.pos[a] - this.pos[b], this.pos[a + 1] - this.pos[b + 1], this.pos[a + 2] - this.pos[b + 2]);
      n++;
    }
    return n ? sum / n : 0.02;
  }

  // ---------------------------------------------------------------- strokes
  beginStroke(hit: Hit, camera: THREE.Camera, mods: { shift: boolean; alt: boolean }) {
    this.pushUndo();
    this.stroking = true;
    this.strokeTool = mods.shift ? 'smooth' : this.tool;
    this.invert = mods.alt;
    if (this.strokeTool === 'grab') {
      this.grabStart = this.pos.slice(0, this.count * 3);
      this.grabOrigin.copy(hit.point);
      const n = camera.getWorldDirection(new THREE.Vector3());
      this.grabPlane.setFromNormalAndCoplanarPoint(n, hit.point);
      this.computeWeights(hit.point);
    } else {
      this.lastDab.copy(hit.point);
      this.applyAt(hit.point);
      this.commit(this.refine());
    }
  }

  moveStroke(hit: Hit | null, ray: THREE.Ray) {
    if (!this.stroking) return;
    if (this.strokeTool === 'grab') {
      const p = ray.intersectPlane(this.grabPlane, new THREE.Vector3());
      if (!p || !this.grabStart) return;
      const d = p.sub(this.grabOrigin);
      const start = this.grabStart;
      const pos = this.pos;
      for (let v = 0; v < this.count; v++) {
        const a = this.w1[v], b = this.w2[v];
        if (a === 0 && b === 0) continue;
        const i = v * 3;
        pos[i] = start[i] + d.x * a - d.x * b;
        pos[i + 1] = start[i + 1] + d.y * (a + b);
        pos[i + 2] = start[i + 2] + d.z * (a + b);
      }
      this.commit(this.refine());
    } else if (hit) {
      const spacing = Math.max(0.004, this.radius * 0.22);
      const dist = hit.point.distanceTo(this.lastDab);
      if (dist < spacing) return;
      const n = Math.min(14, Math.floor(dist / spacing));
      const from = this.lastDab.clone();
      const p = new THREE.Vector3();
      for (let i = 1; i <= n; i++) {
        p.lerpVectors(from, hit.point, i / n);
        this.applyAt(p);
      }
      this.lastDab.copy(p);
      this.commit(this.refine());
    }
  }

  endStroke() {
    if (!this.stroking) return;
    this.stroking = false;
    this.grabStart = null;
    this.compact();
    this.geometry.computeBoundingBox();
  }

  /** Fill w1/w2 with falloff weights for the brush centre and (if symmetric) its mirror, normalised so w1+w2 <= 1. */
  private computeWeights(center: THREE.Vector3) {
    const { pos, radius, w1, w2 } = this;
    const r2 = radius * radius;
    const cx = center.x, cy = center.y, cz = center.z;
    const sym = this.symmetry;
    for (let v = 0; v < this.count; v++) {
      const i = v * 3;
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      let dx = x - cx, dy = y - cy, dz = z - cz;
      let d2 = dx * dx + dy * dy + dz * dz;
      let a = 0, b = 0;
      if (d2 < r2) { const t = Math.sqrt(d2) / radius; a = 1 - t * t * (3 - 2 * t); }
      if (sym) {
        dx = x + cx;
        d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < r2) { const t = Math.sqrt(d2) / radius; b = 1 - t * t * (3 - 2 * t); }
      }
      const s = a + b;
      if (s > 1) { a /= s; b /= s; }
      w1[v] = a; w2[v] = b;
    }
  }

  private applyAt(center: THREE.Vector3) {
    this.computeWeights(center);
    const tool = this.strokeTool;
    const sign = this.invert ? -1 : 1;
    const { w1, w2, count, radius, strength, nrm, pos } = this;

    if (tool === 'pull' || tool === 'push') {
      const amt = strength * radius * 0.11 * (tool === 'push' ? -1 : 1) * sign;
      // region-average normal for a clay-like build-up (per side)
      let nx = 0, ny = 0, nz = 0, mx = 0, my = 0, mz = 0;
      for (let v = 0; v < count; v++) {
        const a = w1[v], b = w2[v];
        if (a === 0 && b === 0) continue;
        const i = v * 3;
        nx += nrm[i] * a; ny += nrm[i + 1] * a; nz += nrm[i + 2] * a;
        mx += nrm[i] * b; my += nrm[i + 1] * b; mz += nrm[i + 2] * b;
      }
      let l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      l = Math.hypot(mx, my, mz) || 1; mx /= l; my /= l; mz /= l;
      for (let v = 0; v < count; v++) {
        const a = w1[v], b = w2[v];
        if (a === 0 && b === 0) continue;
        const i = v * 3;
        pos[i] += (nx * a + mx * b) * amt;
        pos[i + 1] += (ny * a + my * b) * amt;
        pos[i + 2] += (nz * a + mz * b) * amt;
      }
    } else if (tool === 'inflate') {
      const amt = strength * radius * 0.09 * sign;
      for (let v = 0; v < count; v++) {
        const w = w1[v] + w2[v];
        if (w === 0) continue;
        const i = v * 3;
        pos[i] += nrm[i] * amt * w;
        pos[i + 1] += nrm[i + 1] * amt * w;
        pos[i + 2] += nrm[i + 2] * amt * w;
      }
    } else if (tool === 'smooth') {
      const f = Math.min(1, strength * 0.4);
      const { adj, tmp } = this;
      for (let v = 0; v < count; v++) {
        const w = w1[v] + w2[v];
        if (w === 0) continue;
        const nb = adj[v];
        if (nb.length === 0) continue;
        let ax = 0, ay = 0, az = 0;
        for (const nn of nb) { const n = nn * 3; ax += pos[n]; ay += pos[n + 1]; az += pos[n + 2]; }
        const inv = 1 / nb.length;
        const i = v * 3;
        const k = f * w;
        tmp[i] = pos[i] + (ax * inv - pos[i]) * k;
        tmp[i + 1] = pos[i + 1] + (ay * inv - pos[i + 1]) * k;
        tmp[i + 2] = pos[i + 2] + (az * inv - pos[i + 2]) * k;
      }
      for (let v = 0; v < count; v++) {
        if (w1[v] + w2[v] === 0) continue;
        const i = v * 3;
        pos[i] = tmp[i]; pos[i + 1] = tmp[i + 1]; pos[i + 2] = tmp[i + 2];
      }
    } else if (tool === 'flatten') {
      // Plane through the weighted centroid with the weighted normal, per side
      const f = Math.min(1, strength * 0.35);
      for (const side of [0, 1]) {
        const w = side === 0 ? w1 : w2;
        let cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0, tw = 0;
        for (let v = 0; v < count; v++) {
          const a = w[v]; if (a === 0) continue;
          const i = v * 3;
          cx += pos[i] * a; cy += pos[i + 1] * a; cz += pos[i + 2] * a;
          nx += nrm[i] * a; ny += nrm[i + 1] * a; nz += nrm[i + 2] * a; tw += a;
        }
        if (tw === 0) continue;
        cx /= tw; cy /= tw; cz /= tw;
        const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
        for (let v = 0; v < count; v++) {
          const a = w[v]; if (a === 0) continue;
          const i = v * 3;
          const d = (pos[i] - cx) * nx + (pos[i + 1] - cy) * ny + (pos[i + 2] - cz) * nz;
          const k = d * f * a * sign;
          pos[i] -= nx * k; pos[i + 1] -= ny * k; pos[i + 2] -= nz * k;
        }
      }
    }
  }

  // ---------------------------------------------------------------- dynamic topology
  /**
   * Splits every edge inside the brush (both endpoints weighted) that has stretched past the target length.
   * Each split inserts a midpoint vertex and turns the two incident triangles into four, keeping the mesh
   * closed and consistently wound. Returns true when vertices were added.
   */
  private refine(): boolean {
    if (!this.dyntopo || this.strokeTool === 'smooth') return false;
    if (this.count >= MAX_VERTS) { if (!this.warnedCap) { this.warnedCap = true; this.onCap?.(); } return false; }
    const lmax2 = (this.edgeTarget * SPLIT_RATIO) ** 2;
    let grew = false;
    for (let pass = 0; pass < 3; pass++) {
      const { pos, w1, w2, vtris, count } = this;
      if (this.stamp.length < this.idx.length / 3) { const st = new Uint32Array(Math.ceil(this.idx.length / 3)); st.set(this.stamp); this.stamp = st; }
      if (this.region.length < this.icount / 3) this.region = new Int32Array(Math.ceil(this.idx.length / 3));
      const gen = ++this.stampGen, stamp = this.stamp, region = this.region;
      // Triangles touching a weighted vertex, each listed once.
      let nR = 0;
      for (let v = 0; v < count; v++) {
        if (w1[v] + w2[v] === 0) continue;
        const vt = vtris[v];
        for (let k = 0; k < vt.length; k++) { const t = vt[k], ti = t / 3; if (stamp[ti] !== gen) { stamp[ti] = gen; region[nR++] = t; } }
      }
      const touched = ++this.stampGen;
      let splits = 0;
      for (let r = 0; r < nR; r++) {
        const t = region[r];
        if (this.count >= MAX_VERTS) break;
        if (stamp[t / 3] === touched) continue;
        const idx = this.idx;
        for (let e = 0; e < 3; e++) {
          const p = idx[t + e], q = idx[t + (e === 2 ? 0 : e + 1)];
          if (w1[p] + w2[p] === 0 || w1[q] + w2[q] === 0) continue;
          const i = p * 3, j = q * 3;
          const dx = pos[i] - pos[j], dy = pos[i + 1] - pos[j + 1], dz = pos[i + 2] - pos[j + 2];
          if (dx * dx + dy * dy + dz * dz <= lmax2) continue;
          // the other triangle on this edge
          const vp = vtris[p], vq = vtris[q];
          let t2 = -1, n = 0;
          for (let k = 0; k < vp.length; k++) { const u = vp[k]; if (u !== t && vq.indexOf(u) >= 0) { t2 = u; n++; } }
          if (n !== 1 || stamp[t2 / 3] === touched) continue;
          if (this.splitEdge(p, q, t, t2)) { stamp[t / 3] = touched; stamp[t2 / 3] = touched; splits++; }
          break;
        }
      }
      if (splits === 0) break;
      grew = true;
    }
    return grew;
  }

  /** Splits edge a–b shared by triangles t1 and t2 (index offsets). Returns false if the winding is inconsistent. */
  private splitEdge(a: number, b: number, t1: number, t2: number): boolean {
    const idx = this.idx;
    // Rotate each triangle so the shared edge comes first, oriented a→b in one and b→a in the other.
    const rot = (t: number, p: number, q: number): [number, number, number] | null => {
      const v = [idx[t], idx[t + 1], idx[t + 2]];
      for (let r = 0; r < 3; r++) if (v[r] === p && v[(r + 1) % 3] === q) return [p, q, v[(r + 2) % 3]];
      return null;
    };
    let r1 = rot(t1, a, b), r2 = rot(t2, b, a);
    if (!r1 || !r2) { r1 = rot(t1, b, a); r2 = rot(t2, a, b); if (!r1 || !r2) return false; [a, b] = [b, a]; }
    const c = r1[2], d = r2[2];
    if (c === d) return false;

    const m = this.count;
    this.ensure(m + 1, this.icount + 6);
    const { pos, nrm, adj, w1, w2 } = this;
    const i = m * 3, ia = a * 3, ib = b * 3;
    for (let k = 0; k < 3; k++) { pos[i + k] = (pos[ia + k] + pos[ib + k]) / 2; nrm[i + k] = nrm[ia + k] + nrm[ib + k]; }
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
    nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l;
    w1[m] = (w1[a] + w1[b]) / 2; w2[m] = (w2[a] + w2[b]) / 2;
    if (this.grabStart) {
      if (this.grabStart.length < (m + 1) * 3) {
        const gs = new Float32Array(pos.length);
        gs.set(this.grabStart);
        this.grabStart = gs;
      }
      for (let k = 0; k < 3; k++) this.grabStart[i + k] = (this.grabStart[ia + k] + this.grabStart[ib + k]) / 2;
    }
    this.count = m + 1;

    const I = this.idx; // (ensure may have swapped the array)
    I[t1] = a; I[t1 + 1] = m; I[t1 + 2] = c;
    I[t2] = b; I[t2 + 1] = m; I[t2 + 2] = d;
    I[this.icount] = m; I[this.icount + 1] = b; I[this.icount + 2] = c;
    I[this.icount + 3] = m; I[this.icount + 4] = a; I[this.icount + 5] = d;
    this.icount += 6;
    this.geometry.setDrawRange(0, this.icount);

    const drop = (list: number[], v: number) => { const j = list.indexOf(v); if (j >= 0) list.splice(j, 1); };
    drop(adj[a], b); adj[a].push(m);
    drop(adj[b], a); adj[b].push(m);
    adj[c].push(m); adj[d].push(m);
    adj[m] = [a, b, c, d];
    const n1 = this.icount - 6, n2 = this.icount - 3;
    const vt = this.vtris;
    drop(vt[b], t1); drop(vt[a], t2);
    vt[b].push(n1); vt[c].push(n1); vt[a].push(n2); vt[d].push(n2);
    vt[m] = [t1, t2, n1, n2];
    return true;
  }

  // ---------------------------------------------------------------- commit / history
  private commit(grew = false) {
    const g = this.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    if (grew) g.getIndex()!.needsUpdate = true;
    this.computeNormals();
    (g.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true;
    g.computeBoundingSphere();
    this.onChange?.(grew);
  }

  /** Area-weighted vertex normals over the used triangles only (typed arrays; far faster than three's). */
  private computeNormals() {
    const { pos, nrm, idx, count, icount } = this;
    nrm.fill(0, 0, count * 3);
    for (let t = 0; t < icount; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const abx = pos[b] - pos[a], aby = pos[b + 1] - pos[a + 1], abz = pos[b + 2] - pos[a + 2];
      const acx = pos[c] - pos[a], acy = pos[c + 1] - pos[a + 1], acz = pos[c + 2] - pos[a + 2];
      const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
      nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz;
      nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz;
      nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz;
    }
    for (let i = 0; i < count * 3; i += 3) {
      const l = Math.sqrt(nrm[i] * nrm[i] + nrm[i + 1] * nrm[i + 1] + nrm[i + 2] * nrm[i + 2]) || 1;
      nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l;
    }
  }

  private pushUndo() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.redoStack.push(this.snapshot());
    this.restore(s);
    return true;
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.undoStack.push(this.snapshot());
    this.restore(s);
    return true;
  }

  resetToOriginal() {
    this.pushUndo();
    this.restore(this.original);
  }

  /**
   * One undoable programmatic edit (used by AI edits). `step` runs `steps` times; before each run the
   * weights are cleared, and `step` sets weight[v] > 0 on every vertex it moves, so dyntopo refines exactly
   * there. It re-reads the arrays each time, so vertices split in an earlier step are moved too.
   */
  applyProgrammatic(steps: number, step: (ctx: { pos: Float32Array; nrm: Float32Array; count: number; weight: Float32Array }, i: number) => void) {
    this.pushUndo();
    const prevTool = this.strokeTool;
    this.strokeTool = 'pull';
    let grew = false;
    for (let i = 0; i < steps; i++) {
      this.w1.fill(0, 0, this.count); this.w2.fill(0, 0, this.count);
      step({ pos: this.pos, nrm: this.nrm, count: this.count, weight: this.w1 }, i);
      this.commit(false); // fresh normals for the next step
      if (this.refine()) grew = true;
    }
    this.strokeTool = prevTool;
    this.compact();
    this.commit(grew);
    this.geometry.computeBoundingBox();
  }
}

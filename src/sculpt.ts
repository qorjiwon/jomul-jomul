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

const MAX_HISTORY = 30;

export interface Hit { point: THREE.Vector3; normal: THREE.Vector3 }

export class Sculptor {
  tool: SculptTool = 'pull';
  radius = 0.24;
  strength = 0.5;
  symmetry = true;

  private pos: Float32Array;
  private readonly count: number;
  private readonly original: Float32Array;
  private undoStack: Float32Array[] = [];
  private redoStack: Float32Array[] = [];
  private w1: Float32Array;
  private w2: Float32Array;
  private tmp: Float32Array;
  private strokeTool: SculptTool = 'pull';
  private invert = false;
  private grabStart: Float32Array | null = null;
  private grabPlane = new THREE.Plane();
  private grabOrigin = new THREE.Vector3();
  private stroking = false;
  private lastDab = new THREE.Vector3();
  onChange: (() => void) | null = null;

  constructor(readonly mesh: THREE.Mesh, private readonly adj: Adjacency) {
    const attr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    this.pos = attr.array as Float32Array;
    this.count = attr.count;
    this.original = this.pos.slice();
    this.w1 = new Float32Array(this.count);
    this.w2 = new Float32Array(this.count);
    this.tmp = new Float32Array(this.count * 3);
  }

  get geometry() { return this.mesh.geometry; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get isStroking() { return this.stroking; }

  beginStroke(hit: Hit, camera: THREE.Camera, mods: { shift: boolean; alt: boolean }) {
    this.pushUndo();
    this.stroking = true;
    this.strokeTool = mods.shift ? 'smooth' : this.tool;
    this.invert = mods.alt;
    if (this.strokeTool === 'grab') {
      this.grabStart = this.pos.slice();
      this.grabOrigin.copy(hit.point);
      const n = camera.getWorldDirection(new THREE.Vector3());
      this.grabPlane.setFromNormalAndCoplanarPoint(n, hit.point);
      this.computeWeights(hit.point);
    } else {
      this.lastDab.copy(hit.point);
      this.applyAt(hit.point);
      this.commit();
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
      this.commit();
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
      this.commit();
    }
  }

  endStroke() {
    if (!this.stroking) return;
    this.stroking = false;
    this.grabStart = null;
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
    const nrm = (this.geometry.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array;
    const pos = this.pos;
    const { w1, w2, count, radius, strength } = this;

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
        const s = adj.offsets[v], e = adj.offsets[v + 1];
        if (e === s) continue;
        let ax = 0, ay = 0, az = 0;
        for (let o = s; o < e; o++) { const n = adj.list[o] * 3; ax += pos[n]; ay += pos[n + 1]; az += pos[n + 2]; }
        const inv = 1 / (e - s);
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

  private commit() {
    const g = this.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    g.computeVertexNormals();
    g.computeBoundingSphere();
    this.onChange?.();
  }

  private pushUndo() {
    this.undoStack.push(this.pos.slice());
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.redoStack.push(this.pos.slice());
    this.pos.set(s);
    this.commit();
    this.geometry.computeBoundingBox();
    return true;
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.undoStack.push(this.pos.slice());
    this.pos.set(s);
    this.commit();
    this.geometry.computeBoundingBox();
    return true;
  }

  resetToOriginal() {
    this.pushUndo();
    this.pos.set(this.original);
    this.commit();
    this.geometry.computeBoundingBox();
  }
}

import * as THREE from 'three';

export type PaintTool = 'brush' | 'eraser' | 'fill' | 'picker';

export const PAINT_TOOLS: { id: PaintTool; name: string; icon: string; key: string; hint: string }[] = [
  { id: 'brush', name: '붓', icon: '🖌️', key: '1', hint: '드래그해서 색을 칠해요' },
  { id: 'eraser', name: '지우개', icon: '🧽', key: '2', hint: '칠한 색을 지워 원래 흙색으로 돌려요' },
  { id: 'fill', name: '전체 칠하기', icon: '🪣', key: '3', hint: '클릭하면 작품 전체를 한 색으로 칠해요' },
  { id: 'picker', name: '색 뽑기', icon: '💧', key: '4', hint: '작품에서 색을 클릭해 붓 색으로 가져와요' },
];

export const PALETTE = [
  '#ffffff', '#f6e7c1', '#f9c9a3', '#f28c8c', '#e2495b', '#9b2c3c',
  '#ffd166', '#f4a259', '#ef7b45', '#b5651d', '#7a4a2a', '#3b2a1e',
  '#c7e9a7', '#7cc47f', '#2f8f5b', '#9ad7f5', '#3a86d9', '#2b3f8f',
  '#d9b8f5', '#9b5de5', '#ff8fd8', '#b6b6b6', '#5e5e5e', '#1b1b1b',
];

const MAX_HISTORY = 30;

export class Painter {
  tool: PaintTool = 'brush';
  readonly color = new THREE.Color('#e2495b');
  radius = 0.16;
  opacity = 1;
  hardness = 0.5;
  readonly baseColor: THREE.Color;

  private col: Float32Array;
  private readonly count: number;
  private undoStack: Float32Array[] = [];
  private redoStack: Float32Array[] = [];
  private strokeBase: Float32Array | null = null;
  private mask: Float32Array;
  private stroking = false;
  private lastDab = new THREE.Vector3();
  onChange: (() => void) | null = null;

  constructor(readonly mesh: THREE.Mesh, baseColor: THREE.Color) {
    this.baseColor = baseColor.clone();
    const g = mesh.geometry;
    this.count = g.getAttribute('position').count;
    let attr = g.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!attr) {
      const arr = new Float32Array(this.count * 3);
      for (let i = 0; i < this.count; i++) { arr[i * 3] = baseColor.r; arr[i * 3 + 1] = baseColor.g; arr[i * 3 + 2] = baseColor.b; }
      attr = new THREE.BufferAttribute(arr, 3);
      g.setAttribute('color', attr);
    }
    this.col = attr.array as Float32Array;
    this.mask = new Float32Array(this.count);
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get isStroking() { return this.stroking; }

  beginStroke(point: THREE.Vector3) {
    this.pushUndo();
    this.stroking = true;
    this.strokeBase = this.col.slice();
    this.mask.fill(0);
    this.lastDab.copy(point);
    this.dab(point);
    this.commit();
  }

  moveStroke(point: THREE.Vector3) {
    if (!this.stroking) return;
    const spacing = Math.max(0.003, this.radius * 0.2);
    const dist = point.distanceTo(this.lastDab);
    if (dist < spacing) return;
    const n = Math.min(16, Math.ceil(dist / spacing));
    const from = this.lastDab.clone();
    const p = new THREE.Vector3();
    for (let i = 1; i <= n; i++) {
      p.lerpVectors(from, point, i / n);
      this.dab(p);
    }
    this.lastDab.copy(point);
    this.commit();
  }

  endStroke() {
    this.stroking = false;
    this.strokeBase = null;
  }

  private dab(center: THREE.Vector3) {
    const base = this.strokeBase!;
    const pos = (this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const { radius, mask, col, opacity, hardness } = this;
    const target = this.tool === 'eraser' ? this.baseColor : this.color;
    const r2 = radius * radius;
    const cx = center.x, cy = center.y, cz = center.z;
    for (let v = 0; v < this.count; v++) {
      const i = v * 3;
      const dx = pos[i] - cx, dy = pos[i + 1] - cy, dz = pos[i + 2] - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      const t = Math.sqrt(d2) / radius;
      let w = 1;
      if (t > hardness) {
        const u = (t - hardness) / (1 - hardness + 1e-6);
        w = 1 - u * u * (3 - 2 * u);
      }
      if (w <= mask[v]) continue;
      mask[v] = w;
      const k = w * opacity;
      col[i] = base[i] + (target.r - base[i]) * k;
      col[i + 1] = base[i + 1] + (target.g - base[i + 1]) * k;
      col[i + 2] = base[i + 2] + (target.b - base[i + 2]) * k;
    }
  }

  fill(color: THREE.Color) {
    this.pushUndo();
    for (let i = 0; i < this.count; i++) { this.col[i * 3] = color.r; this.col[i * 3 + 1] = color.g; this.col[i * 3 + 2] = color.b; }
    this.commit();
  }

  pick(faceIndex: number): THREE.Color {
    const idx = this.mesh.geometry.getIndex()!;
    const v = idx.getX(faceIndex * 3);
    return new THREE.Color(this.col[v * 3], this.col[v * 3 + 1], this.col[v * 3 + 2]);
  }

  private commit() {
    (this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.onChange?.();
  }

  private pushUndo() {
    this.undoStack.push(this.col.slice());
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.redoStack.push(this.col.slice());
    this.col.set(s);
    this.commit();
    return true;
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.undoStack.push(this.col.slice());
    this.col.set(s);
    this.commit();
    return true;
  }
}

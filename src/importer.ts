// "GLB 불러오기": turn any .glb into one welded, sculptable clay mesh.
// Meshes are flattened into world space, welded by position (so sculpting doesn't tear UV/normal seams),
// scaled to the studio's size, given vertex colors from textures/materials, and subdivided if too sparse to sculpt.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export interface ImportedMesh {
  name: string;
  positions: Float32Array;
  index: Uint32Array;
  /** Linear-space RGB per vertex, or null when the model carries no color information. */
  colors: Float32Array | null;
}

const TARGET_SIZE = 2.1;     // longest side, same as the built-in lumps
const MIN_VERTS = 12_000;    // below this, brushes can't bend the surface smoothly
const MAX_VERTS = 300_000;

type Sampler = (u: number, v: number, out: THREE.Color) => void;

function textureSampler(tex: THREE.Texture): Sampler | null {
  const img = tex.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!img || !img.width || !img.height) return null;
  const w = Math.min(img.width, 1024), h = Math.min(img.height, 1024);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  tex.updateMatrix();
  const m = tex.matrix;
  const uv = new THREE.Vector2();
  const wrap = (x: number) => x - Math.floor(x);
  return (u, v, out) => {
    uv.set(u, v).applyMatrix3(m);
    let y = wrap(uv.y);
    if (tex.flipY) y = 1 - y;
    const px = Math.min(w - 1, Math.floor(wrap(uv.x) * w));
    const py = Math.min(h - 1, Math.floor(y * h));
    const i = (py * w + px) * 4;
    out.setRGB(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255, THREE.SRGBColorSpace);
  };
}

export async function importGLB(file: File): Promise<ImportedMesh> {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader().setDecoderPath('/draco/').setDecoderConfig({ type: 'wasm' });
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(await file.arrayBuffer(), '').finally(() => draco.dispose());
  gltf.scene.updateMatrixWorld(true);

  const pos: number[] = [];
  const col: number[] = [];
  let hasColor = false;
  const white = new THREE.Color(1, 1, 1);
  const tmp = new THREE.Color(), tex = new THREE.Color();
  const v = new THREE.Vector3();

  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry.getAttribute('position')) return;
    const g = mesh.geometry;
    const p = g.getAttribute('position');
    const uvA = g.getAttribute('uv');
    const cA = g.getAttribute('color');
    const idx = g.getIndex();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = g.groups.length ? g.groups : [{ start: 0, count: idx ? idx.count : p.count, materialIndex: 0 }];

    for (const grp of groups) {
      const mat = mats[grp.materialIndex ?? 0] as THREE.MeshStandardMaterial | undefined;
      const base = mat?.color ?? white;
      const sample = mat?.map && uvA ? textureSampler(mat.map) : null;
      if (cA || sample || !base.equals(white)) hasColor = true;
      const end = Math.min(grp.start + grp.count, idx ? idx.count : p.count);
      for (let k = grp.start; k < end; k++) {
        const i = idx ? idx.getX(k) : k;
        v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
        pos.push(v.x, v.y, v.z);
        tmp.copy(base);
        if (cA) tmp.multiply(tex.setRGB(cA.getX(i), cA.getY(i), cA.getZ(i)));
        if (sample) { sample(uvA!.getX(i), uvA!.getY(i), tex); tmp.multiply(tex); }
        col.push(tmp.r, tmp.g, tmp.b);
      }
    }
  });
  if (pos.length < 9) throw new Error('이 GLB 파일에서 모형을 찾지 못했어요.');

  let mesh = weld(new Float32Array(pos), new Float32Array(col));
  if (mesh.positions.length / 3 > MAX_VERTS) throw new Error('모형이 너무 복잡해요 (정점 30만 개 이하만 불러올 수 있어요).');
  normalize(mesh.positions);
  for (let i = 0; i < 4 && mesh.positions.length / 3 < MIN_VERTS && (mesh.index.length / 3) * 4 < MAX_VERTS * 2; i++) mesh = subdivide(mesh);

  const name = file.name.replace(/\.glb$/i, '').trim().slice(0, 30);
  return { name, positions: mesh.positions, index: mesh.index, colors: hasColor ? mesh.colors : null };
}

interface Raw { positions: Float32Array; index: Uint32Array; colors: Float32Array }

/** Merges vertices that share a position (averaging their colors) and drops degenerate triangles. */
function weld(soup: Float32Array, soupColors: Float32Array): Raw {
  const box = new THREE.Box3().setFromArray(soup);
  const eps = Math.max(box.getSize(new THREE.Vector3()).length() * 1e-6, 1e-9);
  const map = new Map<string, number>();
  const outP: number[] = [], outC: number[] = [], counts: number[] = [];
  const remap = new Uint32Array(soup.length / 3);
  for (let i = 0; i < remap.length; i++) {
    const x = soup[i * 3], y = soup[i * 3 + 1], z = soup[i * 3 + 2];
    const key = `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`;
    let j = map.get(key);
    if (j === undefined) {
      j = counts.length;
      map.set(key, j);
      outP.push(x, y, z); outC.push(0, 0, 0); counts.push(0);
    }
    outC[j * 3] += soupColors[i * 3]; outC[j * 3 + 1] += soupColors[i * 3 + 1]; outC[j * 3 + 2] += soupColors[i * 3 + 2];
    counts[j]++;
    remap[i] = j;
  }
  for (let j = 0; j < counts.length; j++) for (let c = 0; c < 3; c++) outC[j * 3 + c] /= counts[j];
  const tris: number[] = [];
  for (let t = 0; t + 2 < remap.length; t += 3) {
    const a = remap[t], b = remap[t + 1], c = remap[t + 2];
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  return { positions: new Float32Array(outP), index: new Uint32Array(tris), colors: new Float32Array(outC) };
}

/** Longest side → TARGET_SIZE, centered on x/z, standing on y = 0. */
function normalize(p: Float32Array) {
  const box = new THREE.Box3().setFromArray(p);
  const size = box.getSize(new THREE.Vector3());
  const s = TARGET_SIZE / Math.max(size.x, size.y, size.z, 1e-6);
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  for (let i = 0; i < p.length; i += 3) {
    p[i] = (p[i] - cx) * s;
    p[i + 1] = (p[i + 1] - box.min.y) * s;
    p[i + 2] = (p[i + 2] - cz) * s;
  }
}

/** 1→4 midpoint subdivision: same shape, denser surface for the brushes. */
function subdivide(m: Raw): Raw {
  const nV = m.positions.length / 3;
  const P = Array.from(m.positions), C = Array.from(m.colors);
  const mids = new Map<number, number>();
  const mid = (a: number, b: number) => {
    const key = a < b ? a * nV + b : b * nV + a;
    let k = mids.get(key);
    if (k === undefined) {
      k = P.length / 3;
      for (let c = 0; c < 3; c++) {
        P.push((P[a * 3 + c] + P[b * 3 + c]) / 2);
        C.push((C[a * 3 + c] + C[b * 3 + c]) / 2);
      }
      mids.set(key, k);
    }
    return k;
  };
  const out = new Uint32Array(m.index.length * 4);
  for (let t = 0, o = 0; t < m.index.length; t += 3) {
    const a = m.index[t], b = m.index[t + 1], c = m.index[t + 2];
    const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    out.set([a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca], o);
    o += 12;
  }
  return { positions: new Float32Array(P), index: out, colors: new Float32Array(C) };
}

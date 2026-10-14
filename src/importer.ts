// "GLB 불러오기": turn any .glb into clay.
// Two results: a welded, sculptable mesh (vertex colors sampled from textures/materials, subdivided if sparse),
// and — when the model has one base-color texture — the original UV-mapped mesh + texture, so a
// "keep the colors" import shows the model at full texture quality instead of blurry vertex colors.
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
  /** Original UV-mapped geometry + base-color texture (only when the whole model uses one texture). */
  textured: TexturedMesh | null;
}

export interface TexturedMesh {
  positions: Float32Array;
  index: Uint32Array;
  uvs: Float32Array;
  texture: Blob;
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
  // Indexed copy that keeps UV seams, for the textured result. Each material becomes one atlas tile.
  const tPos: number[] = [], tUv: number[] = [], tIdx: number[] = [], tTile: number[] = [];
  const surfs = new Map<string, Surface>();
  let texturable = true;
  const uvT = new THREE.Vector2();
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
    // getVertexPosition applies skinning/morphs, so rigged models come in the pose they're shown in.
    const world = (i: number) => mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);

    for (const grp of groups) {
      const mat = mats[grp.materialIndex ?? 0] as THREE.MeshStandardMaterial | undefined;
      const base = mat?.color ?? white;
      const map = mat?.map && uvA ? mat.map : null;
      const sample = map ? textureSampler(map) : null;
      if (cA || sample || !base.equals(white)) hasColor = true;
      const end = Math.min(grp.start + grp.count, idx ? idx.count : p.count);

      if (texturable) {
        if (mat?.map && !uvA) texturable = false;
        const key = `${map ? map.source.uuid : 'flat'}|${base.getHexString()}`;
        let surf = surfs.get(key);
        if (!surf) { surf = { index: surfs.size, map, color: base.clone() }; surfs.set(key, surf); }
        map?.updateMatrix();
        const local = new Map<number, number>();
        for (let k = grp.start; k < end && texturable; k++) {
          const i = idx ? idx.getX(k) : k;
          let j = local.get(i);
          if (j === undefined) {
            j = tPos.length / 3;
            local.set(i, j);
            world(i);
            tPos.push(v.x, v.y, v.z);
            if (map) {
              uvT.set(uvA!.getX(i), uvA!.getY(i)).applyMatrix3(map.matrix);
              // Tiling UVs can't live in an atlas tile (a lone texture can still repeat on its own).
              if (uvT.x < -0.01 || uvT.x > 1.01 || uvT.y < -0.01 || uvT.y > 1.01) surf.tiles = true;
              tUv.push(uvT.x, uvT.y);
            } else tUv.push(0.5, 0.5);
            tTile.push(surf.index);
          }
          tIdx.push(j);
        }
      }

      for (let k = grp.start; k < end; k++) {
        const i = idx ? idx.getX(k) : k;
        world(i);
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

  let textured: TexturedMesh | null = null;
  const list = [...surfs.values()];
  const anyMap = list.some((s) => s.map);
  const tiling = list.some((s) => s.tiles);
  if (texturable && anyMap && !(tiling && list.length > 1) && tPos.length / 3 <= MAX_VERTS) {
    const uvs = new Float32Array(tUv);
    const texture = await buildAtlas(list, uvs, tTile);
    if (texture) {
      const positions = new Float32Array(tPos);
      normalize(positions);
      textured = { positions, index: new Uint32Array(tIdx), uvs, texture };
    }
  }

  const name = file.name.replace(/\.glb$/i, '').trim().slice(0, 30);
  return { name, positions: mesh.positions, index: mesh.index, colors: hasColor ? mesh.colors : null, textured };
}

interface Surface { index: number; map: THREE.Texture | null; color: THREE.Color; tiles?: boolean }

/**
 * Packs every material into one texture (top-down, glTF convention) and rewrites the UVs into its tiles.
 * One textured material → that texture as-is (≤2048px). Several → a grid atlas (≤4096px) with padded tiles;
 * flat-color materials become solid tiles.
 */
async function buildAtlas(surfs: Surface[], uvs: Float32Array, tile: number[]): Promise<Blob | null> {
  const imgOf = (s: Surface) => s.map?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const drawMap = (s: Surface, x: number, y: number, w: number, h: number) => {
    const img = imgOf(s)!;
    ctx.save();
    if (s.map!.flipY) { ctx.translate(0, y * 2 + h); ctx.scale(1, -1); }
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
    if (!s.color.equals(new THREE.Color(1, 1, 1))) {
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = `#${s.color.getHexString(THREE.SRGBColorSpace)}`;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }
  };

  if (surfs.length === 1) {
    const img = imgOf(surfs[0]);
    if (!img?.width) return null;
    const k = Math.min(1, 2048 / Math.max(img.width, img.height));
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    drawMap(surfs[0], 0, 0, c.width, c.height);
  } else {
    const cols = Math.ceil(Math.sqrt(surfs.length)), rows = Math.ceil(surfs.length / cols);
    const biggest = Math.max(256, ...surfs.map((s) => imgOf(s)?.width ?? 0));
    const size = Math.min(biggest, Math.floor(4096 / cols), 2048);
    const pad = 4;
    c.width = cols * size; c.height = rows * size;
    for (const s of surfs) {
      const x = (s.index % cols) * size, y = Math.floor(s.index / cols) * size;
      if (s.map && imgOf(s)?.width) {
        drawMap(s, x, y, size, size);                                 // gutter: bleeds into the padding
        drawMap(s, x + pad, y + pad, size - 2 * pad, size - 2 * pad);
      } else {
        ctx.fillStyle = `#${s.color.getHexString(THREE.SRGBColorSpace)}`;
        ctx.fillRect(x, y, size, size);
      }
    }
    for (let i = 0; i < tile.length; i++) {
      const t = tile[i], x = (t % cols) * size, y = Math.floor(t / cols) * size;
      uvs[i * 2] = (x + pad + uvs[i * 2] * (size - 2 * pad)) / c.width;
      uvs[i * 2 + 1] = (y + pad + uvs[i * 2 + 1] * (size - 2 * pad)) / c.height;
    }
  }
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
}

/** Welds a (possibly seam-split) mesh by position and densifies it so the sculpt brushes have room to work. */
export function makeSculptable(positions: Float32Array, index: Uint32Array): { positions: Float32Array; index: Uint32Array } {
  const soup = new Float32Array(index.length * 3);
  for (let k = 0; k < index.length; k++) soup.set(positions.subarray(index[k] * 3, index[k] * 3 + 3), k * 3);
  let m = weld(soup, new Float32Array(soup.length));
  for (let i = 0; i < 4 && m.positions.length / 3 < MIN_VERTS && (m.index.length / 3) * 4 < MAX_VERTS * 2; i++) m = subdivide(m);
  return { positions: m.positions, index: m.index };
}

/**
 * Vertex normals averaged across vertices that share a position, so UV seams (split vertices)
 * don't show up as hard lighting creases.
 */
export function seamlessNormals(g: THREE.BufferGeometry) {
  const pos = g.getAttribute('position').array as Float32Array;
  const idx = g.getIndex()!.array as Uint32Array;
  const n = pos.length / 3;
  const box = new THREE.Box3().setFromArray(pos);
  const eps = Math.max(box.getSize(new THREE.Vector3()).length() * 1e-6, 1e-9);
  const group = new Uint32Array(n);
  const map = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(pos[i * 3] / eps)},${Math.round(pos[i * 3 + 1] / eps)},${Math.round(pos[i * 3 + 2] / eps)}`;
    let gi = map.get(key);
    if (gi === undefined) { gi = map.size; map.set(key, gi); }
    group[i] = gi;
  }
  const acc = new Float32Array(map.size * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
    a.fromArray(pos, i0 * 3); b.fromArray(pos, i1 * 3); c.fromArray(pos, i2 * 3);
    c.sub(b); a.sub(b); c.cross(a); // area-weighted face normal
    for (const i of [i0, i1, i2]) { const gi = group[i] * 3; acc[gi] += c.x; acc[gi + 1] += c.y; acc[gi + 2] += c.z; }
  }
  const nrm = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const gi = group[i] * 3;
    const l = Math.hypot(acc[gi], acc[gi + 1], acc[gi + 2]) || 1;
    nrm[i * 3] = acc[gi] / l; nrm[i * 3 + 1] = acc[gi + 1] / l; nrm[i * 3 + 2] = acc[gi + 2] / l;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
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

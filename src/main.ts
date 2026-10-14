import * as THREE from 'three';
import { Studio } from './scene';
import { BASES, GLB_BASE, findBase } from './bases';
import { compileShape, shapeBounds, type Shape } from './sdf';
import { buildClayMesh, buildAdjacency, type Adjacency } from './mesher';
import { Sculptor, SCULPT_TOOLS, type SculptTool, type Hit } from './sculpt';
import { Painter, PAINT_TOOLS, PALETTE, type PaintTool } from './paint';
import { runBake, makeClayMaterial, applyFiredLook, applyClayLook, loadTexture, FIRED_COLOR } from './bake';
import { listWorks, saveWork, deleteWork, newId, type Work } from './storage';
import { importGLB, makeSculptable, seamlessNormals } from './importer';
import { askAiShape, fetchConfig, getAuthor, listPublic, loadPublicMesh, publish, setAuthor, thumbUrl, unpublish, type MeshData, type PublicWork } from './cloud';
import { exportGLB, exportPNG } from './exporter';
import { $, el, section, button, slider, toggle, toolGrid, toast, setStep, setHint, fmtDate } from './ui';

type Step = 'pick' | 'view' | 'sculpt' | 'bake' | 'paint' | 'done';
type ClayMeshObj = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

interface Piece {
  id: string;
  name: string;
  baseId: string;
  createdAt: number;
  mesh: ClayMeshObj;
  adjacency: Adjacency;
  sculptor: Sculptor;
  painter: Painter | null;
  baked: boolean;
  glossy: boolean;
  /** Original base-color image for pieces imported with their texture (painted over, never resampled). */
  texture: Blob | null;
}

// ---------------------------------------------------------------- state
const canvas = $('view') as HTMLCanvasElement;
const studio = new Studio(canvas);
let piece: Piece | null = null;
let step: Step = 'pick';

const sculptSettings = { tool: 'pull' as SculptTool, radius: 0.24, strength: 0.5, symmetry: true };
const paintSettings = { tool: 'brush' as PaintTool, color: '#e2495b', radius: 0.16, opacity: 1, hardness: 0.5 };

// Brush cursor rings (main + mirrored ghost)
const ringGeo = new THREE.RingGeometry(0.9, 1, 64);
const cursor = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ff7a3d', transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide }));
const ghost = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ff7a3d', transparent: true, opacity: 0.35, depthTest: false, side: THREE.DoubleSide }));
cursor.renderOrder = ghost.renderOrder = 999;
cursor.visible = ghost.visible = false;
studio.scene.add(cursor, ghost);

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let pointerDirty = false;
let pointerOnCanvas = false;
let active: 'sculpt' | 'paint' | null = null;
let capturedPointer = -1;

// ---------------------------------------------------------------- helpers
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function showBusy(text: string) { $('busy-text').textContent = text; $('busy-overlay').hidden = false; }
function hideBusy() { $('busy-overlay').hidden = true; }

function currentRadius() { return step === 'paint' ? paintSettings.radius : sculptSettings.radius; }

function toHit(i: THREE.Intersection): Hit {
  const n = (i.normal ?? i.face?.normal ?? new THREE.Vector3(0, 1, 0)).clone();
  return { point: i.point.clone(), normal: n };
}

function raycastPiece(): THREE.Intersection | null {
  if (!piece) return null;
  raycaster.setFromCamera(ndc, studio.camera);
  const hits = raycaster.intersectObject(piece.mesh, false);
  return hits[0] ?? null;
}

function updateCursor(hit: Hit | null) {
  if (!hit || (step !== 'sculpt' && step !== 'paint')) { cursor.visible = ghost.visible = false; return; }
  const r = currentRadius();
  cursor.visible = true;
  cursor.position.copy(hit.point).addScaledVector(hit.normal, 0.004);
  cursor.lookAt(hit.point.clone().add(hit.normal));
  cursor.scale.setScalar(r);
  const col = step === 'paint' ? paintSettings.color : '#ff7a3d';
  (cursor.material as THREE.MeshBasicMaterial).color.set(col);
  const sym = step === 'sculpt' && sculptSettings.symmetry;
  ghost.visible = sym;
  if (sym) {
    const p = hit.point.clone(); p.x = -p.x;
    const n = hit.normal.clone(); n.x = -n.x;
    ghost.position.copy(p).addScaledVector(n, 0.004);
    ghost.lookAt(p.clone().add(n));
    ghost.scale.setScalar(r);
  }
}

function settle(g: THREE.BufferGeometry) {
  g.computeBoundingBox();
  const b = g.boundingBox!;
  g.translate(0, -b.min.y, -(b.min.z + b.max.z) / 2);
  g.computeBoundingBox();
  g.computeBoundingSphere();
}

function disposePiece() {
  if (!piece) return;
  studio.scene.remove(piece.mesh);
  piece.mesh.geometry.dispose();
  piece.mesh.material.dispose();
  piece = null;
}

function mountPiece(p: { id: string; name: string; baseId: string; createdAt: number; geometry: THREE.BufferGeometry; adjacency: Adjacency; baked: boolean; glossy: boolean; texture?: { blob: Blob; tex: THREE.Texture } | null }) {
  disposePiece();
  const mat = makeClayMaterial();
  const mesh = new THREE.Mesh(p.geometry, mat) as ClayMeshObj;
  mesh.castShadow = mesh.receiveShadow = true;
  studio.scene.add(mesh);
  const sculptor = new Sculptor(mesh, p.adjacency);
  const textured = p.baked && p.texture ? p.texture : null;
  piece = { ...p, mesh, sculptor, painter: null, texture: textured?.blob ?? null };
  applySculptSettings();
  if (p.baked) {
    applyFiredLook(mat, p.glossy);
    if (textured) {
      mat.map = textured.tex;
      mat.needsUpdate = true;
      // Paint layer over the texture: rgb = paint, a = coverage (0 = show the texture).
      if (p.geometry.getAttribute('color')?.itemSize !== 4) {
        p.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(p.geometry.getAttribute('position').count * 4), 4));
      }
    }
    piece.painter = new Painter(mesh, textured ? new THREE.Color(1, 1, 1) : FIRED_COLOR);
    if (textured) piece.painter.underlay = textureUnderlay(textured.tex, p.geometry);
    applyPaintSettings();
  }
  studio.fitCamera(p.geometry.boundingBox!);
  refreshHistoryButtons();
  nameInput.value = p.name;
}

function applySculptSettings() {
  if (!piece) return;
  const s = piece.sculptor;
  s.tool = sculptSettings.tool; s.radius = sculptSettings.radius; s.strength = sculptSettings.strength; s.symmetry = sculptSettings.symmetry;
}

function applyPaintSettings() {
  const p = piece?.painter;
  if (!p) return;
  p.tool = paintSettings.tool; p.radius = paintSettings.radius; p.opacity = paintSettings.opacity; p.hardness = paintSettings.hardness;
  p.color.set(paintSettings.color);
}

function panelHead(titleHtml: string, ...hist: HTMLElement[]) {
  const head = el('div', 'panel-head');
  const h = el('div', 'hist');
  h.append(...hist);
  head.append(el('h2', '', titleHtml), h);
  return head;
}

// ---------------------------------------------------------------- steps
const panels: Record<string, HTMLElement> = {
  view: $('panel-view'),
  sculpt: $('panel-sculpt'),
  paint: $('panel-paint'),
  done: $('panel-done'),
};

function go(next: Step) {
  step = next;
  setStep(next === 'view' ? 'done' : next);
  for (const [k, p] of Object.entries(panels)) p.hidden = k !== next;
  $('pick-overlay').hidden = next !== 'pick';
  $('bake-overlay').hidden = next !== 'bake';
  studio.controls.autoRotate = (next === 'done' || next === 'view') && turntable.checked;
  cursor.visible = ghost.visible = false;
  if (next === 'sculpt') hintForSculpt();
  else if (next === 'paint') hintForPaint();
  else if (next === 'view') setHint('드래그해서 돌려보며 감상해요 · ✏️ 손보기를 누르면 고칠 수 있어요');
  else if (next === 'done') setHint('드래그해서 돌려보며 감상해요 · 저장하거나 내려받을 수 있어요');
  else setHint('');
  if (next === 'pick') void refreshBgWorks();
  refreshHistoryButtons();
}

function hintForSculpt() {
  const t = SCULPT_TOOLS.find((x) => x.id === sculptSettings.tool)!;
  setHint(`${t.icon} ${t.name}: ${t.hint}  ·  오른쪽 드래그로 돌려보기  ·  [ ] 붓 크기`);
}
function hintForPaint() {
  const t = PAINT_TOOLS.find((x) => x.id === paintSettings.tool)!;
  setHint(`${t.icon} ${t.name}: ${t.hint}  ·  오른쪽 드래그로 돌려보기`);
}

async function buildLump(baseId: string, shape: Shape, name: string, busyText: string) {
  showBusy(busyText);
  await nextFrame();
  const res = Number((document.getElementById('quality') as HTMLSelectElement).value);
  const t0 = performance.now();
  const { geometry, adjacency } = buildClayMesh(compileShape(shape), shapeBounds(shape), res);
  settle(geometry);
  console.info(`[jomul] ${baseId} res=${res}: ${geometry.getAttribute('position').count} verts, ${geometry.getIndex()!.count / 3} tris in ${(performance.now() - t0).toFixed(0)}ms`);
  mountPiece({ id: newId(), name, baseId, createdAt: Date.now(), geometry, adjacency, baked: false, glossy: false });
  hideBusy();
  go('sculpt');
}

async function startPiece(baseId: string) {
  const base = findBase(baseId);
  await buildLump(base.id, base.shape, '', `${base.emoji} ${base.name} 반죽을 준비하는 중…`);
  toast(`${base.emoji} ${base.name} 반죽이 준비됐어요. 마음껏 빚어 보세요!`, 2600);
}

let aiBusy = false;
async function startAiPiece(prompt: string) {
  prompt = prompt.trim();
  if (!prompt) { toast('어떤 친구를 만들고 싶은지 적어 주세요'); ($('ai-prompt') as HTMLInputElement).focus(); return; }
  if (aiBusy) return;
  aiBusy = true;
  showBusy('✨ AI가 첫 반죽을 빚는 중… (10~30초)');
  try {
    const ai = await askAiShape(prompt);
    await buildLump('ai', ai.shape, ai.name, `${ai.emoji} ${ai.name} 반죽을 다지는 중…`);
    toast(`${ai.emoji} AI가 「${ai.name}」 첫 반죽을 빚었어요. 이제 직접 다듬어 보세요!`, 3600);
  } catch (e) {
    hideBusy();
    toast(e instanceof Error ? e.message : 'AI가 반죽을 만들지 못했어요', 3600);
  } finally {
    aiBusy = false;
  }
}

async function startBake() {
  if (!piece || piece.baked) return;
  go('bake');
  const bar = $('bake-bar');
  const temp = $('bake-temp');
  const title = $('bake-title');
  await runBake(piece.mesh, (p) => {
    bar.style.width = `${(p * 100).toFixed(1)}%`;
    const c = p < 0.6 ? (p / 0.6) * 1150 : 1150 - ((p - 0.6) / 0.4) * 1100;
    temp.textContent = `${Math.round(c)} ℃`;
    title.textContent = p < 0.6 ? '가마에서 굽는 중…' : '천천히 식히는 중…';
  });
  piece.baked = true;
  piece.glossy = false;
  piece.painter = new Painter(piece.mesh, FIRED_COLOR);
  applyPaintSettings();
  glazeToggle.set(false);
  go('paint');
  toast('잘 구워졌어요! 이제 색칠해 보세요 🎨', 2600);
}

/** Picker fallback for unpainted spots: the texture's color at that vertex's UV. */
function textureUnderlay(tex: THREE.Texture, g: THREE.BufferGeometry) {
  let px: { data: Uint8ClampedArray; w: number; h: number } | null = null;
  const uv = g.getAttribute('uv');
  return (v: number) => {
    if (!px) {
      const img = tex.image as ImageBitmap;
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      px = { data: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
    }
    const wrap = (x: number) => x - Math.floor(x);
    const x = Math.min(px.w - 1, Math.floor(wrap(uv.getX(v)) * px.w));
    const y = Math.min(px.h - 1, Math.floor(wrap(uv.getY(v)) * px.h));
    const i = (y * px.w + x) * 4;
    return new THREE.Color().setRGB(px.data[i] / 255, px.data[i + 1] / 255, px.data[i + 2] / 255, THREE.SRGBColorSpace);
  };
}

function unbake() {
  if (!piece || !piece.baked) return;
  if (!confirm('다시 빚으면 칠한 색이 모두 지워져요. 계속할까요?')) return;
  if (piece.texture) {
    // Textured meshes keep UV seams split; weld them into one clay surface before sculpting.
    const g0 = piece.mesh.geometry;
    const m = makeSculptable(g0.getAttribute('position').array as Float32Array, g0.getIndex()!.array as Uint32Array);
    const { id, name, baseId, createdAt } = piece;
    mountMesh({ id, name, baseId, createdAt, baked: false, glossy: false }, { positions: m.positions, index: m.index, colors: null });
    go('sculpt');
    return;
  }
  piece.mesh.geometry.deleteAttribute('color');
  applyClayLook(piece.mesh.material);
  piece.painter = null;
  piece.baked = false;
  go('sculpt');
}

// ---------------------------------------------------------------- pick overlay
{
  const grid = $('base-grid');
  for (const b of BASES) {
    const card = el('button', 'base');
    card.append(el('span', 'emoji', b.emoji), el('b', '', b.name), el('span', '', b.desc));
    card.addEventListener('click', () => void startPiece(b.id));
    grid.append(card);
  }
  const glbInput = $('glb-input') as HTMLInputElement;
  const imp = el('button', 'base import');
  imp.append(el('span', 'emoji', '📂'), el('b', '', 'GLB 불러오기'), el('span', '', '내 3D 모형을 가져와 이어 빚기'));
  imp.addEventListener('click', () => glbInput.click());
  glbInput.addEventListener('change', () => { const f = glbInput.files?.[0]; glbInput.value = ''; if (f) void startGlb(f); });
  grid.append(imp);

  const form = $('ai-form') as HTMLFormElement;
  const input = $('ai-prompt') as HTMLInputElement;
  form.addEventListener('submit', (e) => { e.preventDefault(); void startAiPiece(input.value); });
  const chips = $('ai-chips');
  for (const idea of ['날개 달린 아기 용', '모자 쓴 펭귄', '귀가 큰 사막여우', '뿔이 하나인 유니콘', '통통한 눈사람', '우주복 입은 아이']) {
    const b = el('button', '', idea);
    b.type = 'button';
    b.addEventListener('click', () => { input.value = idea; void startAiPiece(idea); });
    chips.append(b);
  }
  void fetchConfig().then((c) => {
    form.classList.toggle('off', !c.ai);
    $('ai-off').hidden = c.ai;
  });
}

// ---------------------------------------------------------------- GLB import
async function startGlb(file: File) {
  if (!/\.glb$/i.test(file.name)) { toast('.glb 파일만 불러올 수 있어요', 2600); return; }
  if (piece && !confirm('지금 작업 중인 작품을 닫고 불러올까요? 저장하지 않은 내용은 사라져요.')) return;
  showBusy(`📦 「${file.name}」 불러오는 중…`);
  await nextFrame();
  try {
    const m = await importGLB(file);
    hideBusy();
    const keepColor = m.colors !== null && confirm('색이 칠해진 모형이에요.\n\n확인: 색을 그대로 두고 색칠 단계로 열기\n취소: 색을 빼고 찰흙 상태로 빚기부터 시작');
    const meta = { id: newId(), name: m.name, baseId: GLB_BASE.id, createdAt: Date.now(), baked: keepColor, glossy: false };
    if (keepColor && m.textured) {
      // Keep the original texture at full resolution instead of baking it into blurry vertex colors.
      await mountMesh(meta, { positions: m.textured.positions, index: m.textured.index, colors: null, uvs: m.textured.uvs, texture: m.textured.texture });
    } else {
      await mountMesh(meta, { positions: m.positions, index: m.index, colors: keepColor ? m.colors : null });
    }
    go(keepColor ? 'paint' : 'sculpt');
    toast(`📦 「${m.name || 'GLB 모형'}」을 불러왔어요. ${keepColor ? '색칠하거나 다시 빚어 보세요' : '마음껏 빚어 보세요'}!`, 3000);
  } catch (e) {
    console.error(e);
    toast(e instanceof Error && /[가-힣]/.test(e.message) ? e.message : 'GLB 파일을 읽지 못했어요', 3200);
  } finally {
    hideBusy();
  }
}

{
  const zone = $('dropzone');
  let depth = 0;
  const hasFile = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFile(e)) { depth++; zone.hidden = false; } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) zone.hidden = true; });
  window.addEventListener('dragover', (e) => { if (hasFile(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0; zone.hidden = true;
    const f = e.dataTransfer?.files?.[0];
    if (f) void startGlb(f);
  });
}

// ---------------------------------------------------------------- 모두의 작품: random floaters behind the landing card
const BG_MAX = 15;
let bgWorks: PublicWork[] = [];

async function refreshBgWorks() {
  try {
    const all = await listPublic(60);
    for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
    bgWorks = all.slice(0, BG_MAX);
  } catch (e) {
    console.warn('[jomul] public works unavailable', e);
    bgWorks = [];
  }
  layoutBgWorks();
}

/** Scatter the floaters at random, preferring the margins beside the card and avoiding each other. */
function layoutBgWorks() {
  const layer = $('bg-works');
  const overlay = $('pick-overlay');
  layer.innerHTML = '';
  if (overlay.hidden || bgWorks.length === 0) return;
  const W = overlay.clientWidth, H = Math.max(overlay.scrollHeight, overlay.clientHeight);
  layer.style.height = `${H}px`;
  const o = overlay.getBoundingClientRect(), c = document.querySelector('.pick-card')!.getBoundingClientRect();
  const card = { x: c.left - o.left - 16, y: c.top - o.top + overlay.scrollTop - 16, w: c.width + 32, h: c.height + 32 };
  const placed: { x: number; y: number; s: number }[] = [];
  const hits = (x: number, y: number, s: number, r: { x: number; y: number; w: number; h: number }) =>
    x < r.x + r.w && x + s > r.x && y < r.y + r.h && y + s > r.y;
  for (const w of bgWorks) {
    const s = Math.round((W < 760 ? 64 : 92) + Math.random() * (W < 760 ? 28 : 56));
    let best: { x: number; y: number } | null = null;
    for (let tries = 0; tries < 80 && !best; tries++) {
      const x = Math.random() * Math.max(1, W - s), y = Math.random() * Math.max(1, H - s);
      if (placed.some((p) => hits(x, y, s, { x: p.x - 10, y: p.y - 10, w: p.s + 20, h: p.s + 20 }))) continue;
      if (tries < 60 && hits(x, y, s, card)) continue; // after 60 misses, allow tucking behind the card
      best = { x, y };
    }
    if (!best) continue;
    placed.push({ ...best, s });
    layer.append(makeFloater(w, best.x, best.y, s));
  }
}

/** A saved work standing loose on the landing page: grab it to move it around, click it to open it. */
function makeFloater(w: PublicWork, x: number, y: number, s: number) {
  const f = el('div', 'bgwork');
  f.style.cssText = `left:${x}px;top:${y}px;width:${s}px;height:${s}px;--rot:${(Math.random() * 16 - 8).toFixed(1)}deg;--dur:${(7 + Math.random() * 6).toFixed(1)}s;--delay:${(-Math.random() * 8).toFixed(1)}s;--dx:${(Math.random() * 16 - 8).toFixed(0)}px;--dy:${(-8 - Math.random() * 14).toFixed(0)}px`;
  const img = el('img');
  img.alt = w.name;
  img.draggable = false;
  const label = el('span');
  label.textContent = `${findBase(w.baseId).emoji} ${w.name} · ${w.author}`;
  f.append(img, label);

  // Only the model's own pixels are grabbable, not the transparent box around it.
  let alpha: { data: Uint8ClampedArray; n: number } | null = null;
  img.addEventListener('load', () => {
    const n = 64, c = document.createElement('canvas');
    c.width = c.height = n;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, n, n);
    alpha = { data: ctx.getImageData(0, 0, n, n).data, n };
    f.classList.add('ready');
  });
  floaterSrc(w).then((src) => { img.src = src; }, () => f.remove());
  const solid = (e: PointerEvent) => {
    if (!alpha) return false;
    const r = f.getBoundingClientRect();
    const px = Math.floor(((e.clientX - r.left) / r.width) * alpha.n), py = Math.floor(((e.clientY - r.top) / r.height) * alpha.n);
    if (px < 0 || py < 0 || px >= alpha.n || py >= alpha.n) return false;
    return alpha.data[(py * alpha.n + px) * 4 + 3] > 24;
  };

  let drag: { id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null;
  f.addEventListener('pointermove', (e) => { if (!drag) f.classList.toggle('hot', solid(e)); });
  f.addEventListener('pointerleave', () => { if (!drag) f.classList.remove('hot'); });
  const move = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    f.style.left = `${drag.ox + dx}px`;
    f.style.top = `${drag.oy + dy}px`;
  };
  const drop = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const clicked = !drag.moved && e.type === 'pointerup';
    drag = null;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', drop);
    window.removeEventListener('pointercancel', drop);
    f.classList.remove('grabbed');
    if (clicked) void openPublic(w);
  };
  f.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !solid(e)) return;
    e.preventDefault();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: f.offsetLeft, oy: f.offsetTop, moved: false };
    f.classList.add('grabbed', 'hot');
    f.parentElement?.append(f); // bring to front
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', drop);
    window.addEventListener('pointercancel', drop);
  });
  return f;
}

// Cutout image per public work. Works saved before cutouts existed have a JPEG photo on the potter's
// wheel; those get re-rendered from their mesh, one at a time, and cached for the session.
const floaterSrcs = new Map<string, Promise<string>>();
let cutoutQueue: Promise<unknown> = Promise.resolve();
function floaterSrc(w: PublicWork): Promise<string> {
  const key = `${w.id}@${w.updatedAt}`;
  let p = floaterSrcs.get(key);
  if (!p) {
    p = (async () => {
      const res = await fetch(thumbUrl(w));
      if (!res.ok) throw new Error(res.statusText);
      const blob = await res.blob();
      if (blob.type !== 'image/jpeg') return URL.createObjectURL(blob);
      const job = cutoutQueue.then(async () => cutoutOf(w, await loadPublicMesh(w)));
      cutoutQueue = job.catch(() => {});
      return job;
    })();
    p.catch(() => floaterSrcs.delete(key));
    floaterSrcs.set(key, p);
  }
  return p;
}

/** Legacy works only (plain vertex colors, no texture). */
function cutoutOf(meta: { baked: boolean; glossy: boolean }, m: MeshData): string {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  if (meta.baked && m.colors) g.setAttribute('color', new THREE.BufferAttribute(m.colors, m.colors.length / (m.positions.length / 3)));
  g.computeVertexNormals();
  const mat = makeClayMaterial();
  if (meta.baked && m.colors) applyFiredLook(mat, meta.glossy);
  const url = studio.cutout(new THREE.Mesh(g, mat), 256);
  g.dispose();
  mat.dispose();
  return url;
}
{
  let t = 0;
  window.addEventListener('resize', () => { clearTimeout(t); t = window.setTimeout(layoutBgWorks, 200); });
}

async function openPublic(w: PublicWork) {
  if (piece && !confirm('지금 작업 중인 작품을 닫고 불러올까요? 저장하지 않은 내용은 사라져요.')) return;
  showBusy(`「${w.name}」 불러오는 중…`);
  try {
    const mesh = await loadPublicMesh(w);
    // A fresh id: saving makes your own copy instead of touching the original.
    await mountMesh({ id: newId(), name: w.name, baseId: w.baseId, createdAt: Date.now(), baked: w.baked, glossy: w.glossy }, mesh);
    openView(w.name, `${w.author}님의 작품`);
  } catch (e) {
    console.error(e);
    toast('작품을 불러오지 못했어요');
  } finally {
    hideBusy();
  }
}

// ---------------------------------------------------------------- view panel: a finished work opens for looking; 손보기 unfolds the edits
const viewTitle = el('h2');
const fixList = el('div', 'fix-list');
const fixBtn = button('✏️ 손보기', 'primary', () => setFixOpen(!fixList.classList.contains('open')));
function setFixOpen(open: boolean) {
  fixList.classList.toggle('open', open);
  fixBtn.textContent = open ? '✏️ 손보기 접기' : '✏️ 손보기';
}
function fixItem(icon: string, title: string, desc: string, onClick: () => void) {
  const b = el('button', 'fix');
  b.type = 'button';
  const t = el('span');
  t.append(el('b', '', title), el('small', '', desc));
  b.append(el('span', 'ico', icon), t);
  b.addEventListener('click', onClick);
  b.style.setProperty('--i', String(fixList.children.length));
  fixList.append(b);
}
function openView(name: string, by: string) {
  if (!piece) return;
  const sub = el('small');
  sub.textContent = by;
  viewTitle.replaceChildren(document.createTextNode(name), sub);
  fixList.replaceChildren();
  if (piece.baked) {
    fixItem('🎨', '색칠하기', '색을 덧칠하거나 지우고, 광택을 바꿔요', () => go('paint'));
    fixItem('🖐', '다시 빚기', '모양을 고쳐요 · 칠한 색은 지워져요', unbake);
  } else {
    fixItem('🖐', '이어서 빚기', '당기고 누르며 모양을 다듬어요', () => go('sculpt'));
    fixItem('🔥', '가마에 굽기', '구워서 색칠할 수 있게 만들어요', () => void startBake());
  }
  fixItem('🏷', '이름 바꾸고 저장', '내 작품으로 저장하거나 모두에게 공개해요', () => go('done'));
  setFixOpen(false);
  go('view');
}
{
  const p = panels.view;
  p.append(viewTitle, fixBtn, fixList);
  const row = el('div', 'row');
  row.append(
    button('⬇ GLB', '', () => { if (piece) void exportGLB(piece.mesh, pieceName(), studio.renderer).then(() => toast('GLB 파일을 내려받았어요')).catch(() => toast('내려받기에 실패했어요')); }),
    button('📷 사진', '', () => { if (piece) void exportPNG(studio.renderer, studio.scene, studio.camera, pieceName()).then(() => toast('사진을 저장했어요')); }),
  );
  p.append(row, el('div', 'spacer'));
  p.append(button('← 첫 화면으로', '', () => { disposePiece(); go('pick'); }));
}

// ---------------------------------------------------------------- sculpt panel
let sculptSliders: { rad: ReturnType<typeof slider>; str: ReturnType<typeof slider> };
let symToggle: ReturnType<typeof toggle>;
let sculptToolGrid: ReturnType<typeof toolGrid<SculptTool>>;
const sculptUndo = button('↶', 'hist-btn', () => undo());
const sculptRedo = button('↷', 'hist-btn', () => redo());
sculptUndo.title = '되돌리기 (⌘Z)'; sculptRedo.title = '다시 실행 (⇧⌘Z)';
{
  const p = panels.sculpt;
  p.append(panelHead('빚기<small>찰흙 위를 드래그하면 모양이 바뀌어요.</small>', sculptUndo, sculptRedo));

  const tools = toolGrid(SCULPT_TOOLS, (id) => { sculptSettings.tool = id; applySculptSettings(); hintForSculpt(); });
  tools.setActive(sculptSettings.tool);
  const s1 = section('도구'); s1.append(tools.root); p.append(s1);

  const s2 = section();
  const rad = slider({ label: '붓 크기', min: 0.05, max: 0.7, step: 0.01, value: sculptSettings.radius, onInput: (v) => { sculptSettings.radius = v; applySculptSettings(); } });
  const str = slider({ label: '세기', min: 0.05, max: 1, step: 0.01, value: sculptSettings.strength, onInput: (v) => { sculptSettings.strength = v; applySculptSettings(); } });
  s2.append(rad.root, str.root);
  p.append(s2);
  sculptSliders = { rad, str };

  const sym = toggle('좌우 대칭으로 빚기 (M)', true, (v) => { sculptSettings.symmetry = v; applySculptSettings(); });
  symToggle = sym;
  p.append(sym.root);

  p.append(button('처음 모양으로 되돌리기', '', () => { if (piece && confirm('빚은 내용을 모두 지우고 처음 반죽으로 돌아갈까요?')) { piece.sculptor.resetToOriginal(); refreshHistoryButtons(); } }));

  p.append(el('div', 'spacer'));
  p.append(button('🔥 가마에 굽기', 'primary', () => void startBake()));
  p.append(button('← 다른 반죽 고르기', '', () => { if (!piece || confirm('지금 빚은 반죽을 버리고 새로 고를까요? (저장하지 않으면 사라져요)')) { disposePiece(); go('pick'); } }));
  tools.root.querySelectorAll('.tool').forEach((b, i) => b.setAttribute('title', SCULPT_TOOLS[i].hint));
  sculptToolGrid = tools;
}

// ---------------------------------------------------------------- paint panel
const paintUndo = button('↶', 'hist-btn', () => undo());
const paintRedo = button('↷', 'hist-btn', () => redo());
paintUndo.title = '되돌리기 (⌘Z)'; paintRedo.title = '다시 실행 (⇧⌘Z)';
let glazeToggle: ReturnType<typeof toggle>;
let paintSliders: { rad: ReturnType<typeof slider>; op: ReturnType<typeof slider> };
let paintToolGrid: ReturnType<typeof toolGrid<PaintTool>>;
let colorInput: HTMLInputElement;
let colorCode: HTMLElement;
let swatches: HTMLElement[] = [];

function setPaintColor(hex: string) {
  paintSettings.color = hex;
  colorInput.value = hex;
  colorCode.textContent = hex;
  for (const s of swatches) s.classList.toggle('active', s.dataset.c === hex);
  applyPaintSettings();
}

{
  const p = panels.paint;
  p.append(panelHead('색칠<small>잘 구워진 작품에 색을 입혀요.</small>', paintUndo, paintRedo));

  const s1 = section('색');
  const pal = el('div', 'palette');
  for (const c of PALETTE) {
    const sw = el('div', 'swatch');
    sw.style.background = c;
    sw.dataset.c = c;
    sw.addEventListener('click', () => { setPaintColor(c); if (paintSettings.tool === 'eraser' || paintSettings.tool === 'picker') paintToolGrid.select('brush'); });
    swatches.push(sw);
    pal.append(sw);
  }
  const cp = el('div', 'colorpick');
  colorInput = el('input'); colorInput.type = 'color'; colorInput.value = paintSettings.color;
  colorCode = el('code', '', paintSettings.color);
  colorInput.addEventListener('input', () => setPaintColor(colorInput.value));
  cp.append(colorInput, el('span', '', '직접 고르기'), colorCode);
  s1.append(pal, cp);
  p.append(s1);

  const tools = toolGrid(PAINT_TOOLS, (id) => { paintSettings.tool = id; applyPaintSettings(); hintForPaint(); });
  tools.setActive(paintSettings.tool);
  tools.root.style.gridTemplateColumns = 'repeat(4, 1fr)';
  tools.root.querySelectorAll('.tool').forEach((b, i) => b.setAttribute('title', PAINT_TOOLS[i].hint));
  const s2 = section('도구'); s2.append(tools.root); p.append(s2);
  paintToolGrid = tools;

  const s3 = section();
  const rad = slider({ label: '붓 크기', min: 0.03, max: 0.6, step: 0.01, value: paintSettings.radius, onInput: (v) => { paintSettings.radius = v; applyPaintSettings(); } });
  const op = slider({ label: '진하기', min: 0.05, max: 1, step: 0.01, value: paintSettings.opacity, onInput: (v) => { paintSettings.opacity = v; applyPaintSettings(); } });
  const hard = slider({ label: '경계 또렷함', min: 0, max: 0.95, step: 0.01, value: paintSettings.hardness, onInput: (v) => { paintSettings.hardness = v; applyPaintSettings(); } });
  s3.append(rad.root, op.root, hard.root);
  p.append(s3);
  paintSliders = { rad, op };

  glazeToggle = toggle('✨ 유약 광택', false, (v) => { if (piece?.baked) { piece.glossy = v; applyFiredLook(piece.mesh.material, v); } });
  p.append(glazeToggle.root);

  p.append(el('div', 'spacer'));
  p.append(button('✨ 완성하기', 'primary', () => go('done')));
  p.append(button('← 다시 빚기 (색 지워짐)', '', unbake));
  setPaintColor(paintSettings.color);
}

// ---------------------------------------------------------------- done panel
const nameInput = el('input', 'text') as HTMLInputElement;
const authorInput = el('input', 'text') as HTMLInputElement;
let turntable: ReturnType<typeof toggle>;
let publicToggle: ReturnType<typeof toggle>;
let saveBtn: HTMLButtonElement;
{
  const p = panels.done;
  p.append(el('h2', '', '완성!<small>이름을 지어 주고 저장하거나 내려받아요.</small>'));
  const s1 = section('작품 이름');
  nameInput.placeholder = '예) 하품하는 고양이';
  nameInput.maxLength = 30;
  s1.append(nameInput);
  p.append(s1);
  const s2 = section('만든 사람');
  authorInput.placeholder = '닉네임 (비우면 익명의 조물러)';
  authorInput.maxLength = 20;
  authorInput.value = getAuthor();
  s2.append(authorInput);
  p.append(s2);
  publicToggle = toggle('🌍 모두의 작품에 공개', true, () => {});
  p.append(publicToggle.root);

  saveBtn = button('💾 저장하기', 'primary', () => void save());
  p.append(saveBtn);
  const row = el('div', 'row');
  row.append(
    button('⬇ GLB 내려받기', '', () => { if (piece) void exportGLB(piece.mesh, pieceName(), studio.renderer).then(() => toast('GLB 파일을 내려받았어요')).catch(() => toast('내려받기에 실패했어요')); }),
    button('📷 사진 저장', '', () => { if (piece) void exportPNG(studio.renderer, studio.scene, studio.camera, pieceName()).then(() => toast('사진을 저장했어요')); }),
  );
  p.append(row);
  turntable = toggle('🔄 턴테이블 돌리기', true, (v) => { studio.controls.autoRotate = (step === 'done' || step === 'view') && v; });
  p.append(turntable.root);

  p.append(el('div', 'spacer'));
  const row2 = el('div', 'row');
  row2.append(
    button('← 돌아가서 고치기', '', () => go(piece?.baked ? 'paint' : 'sculpt')),
    button('🆕 새로 만들기', '', () => { if (confirm('새 반죽을 고를까요? 저장하지 않은 작품은 사라져요.')) { disposePiece(); go('pick'); } }),
  );
  p.append(row2);
}

function pieceName() {
  if (!piece) return '조물조물';
  return nameInput.value.trim() || `${findBase(piece.baseId).name} 친구`;
}

async function save() {
  if (!piece) return;
  const g = piece.mesh.geometry;
  const colors = g.getAttribute('color') as THREE.BufferAttribute | undefined;
  const work: Work = {
    id: piece.id,
    name: pieceName(),
    baseId: piece.baseId,
    createdAt: piece.createdAt,
    updatedAt: Date.now(),
    positions: (g.getAttribute('position').array as Float32Array).slice(),
    index: (g.getIndex()!.array as Uint32Array).slice(),
    colors: piece.baked && colors ? (colors.array as Float32Array).slice() : null,
    uvs: piece.texture ? (g.getAttribute('uv').array as Float32Array).slice() : null,
    texture: piece.texture,
    baked: piece.baked,
    glossy: piece.glossy,
    thumb: studio.cutout(piece.mesh, 256),
  };
  const author = authorInput.value.trim();
  setAuthor(author);
  saveBtn.disabled = true;
  let local = false;
  try {
    await saveWork(work);
    local = true;
    piece.name = work.name;
    nameInput.value = work.name;
    if (!publicToggle.checked || !work.baked) {
      toast(`"${work.name}" 을(를) 내 작품에 저장했어요 💾`);
      return;
    }
    showBusy('🌍 모두의 작품에 올리는 중…');
    await publish({
      id: work.id, name: work.name, author, baseId: work.baseId, baked: work.baked, glossy: work.glossy, thumb: work.thumb,
      mesh: { positions: work.positions, index: work.index, colors: work.colors, uvs: work.uvs, texture: work.texture },
    });
    toast(`"${work.name}" 을(를) 저장하고 모두의 작품에 올렸어요 🌍`, 2800);
  } catch (e) {
    console.error(e);
    const why = e instanceof Error ? e.message : '';
    toast(local ? `내 작품엔 저장했지만 공개하지 못했어요. ${why}` : '저장에 실패했어요. 브라우저 저장 공간을 확인해 주세요.', 3600);
  } finally {
    hideBusy();
    saveBtn.disabled = false;
  }
}

// ---------------------------------------------------------------- gallery
async function openGallery() {
  const list = $('gallery-list');
  list.innerHTML = '';
  $('gallery').hidden = false;
  const works = await listWorks();
  if (works.length === 0) {
    list.append(el('div', 'empty', '아직 저장한 작품이 없어요.<br/>완성 단계에서 💾 저장을 눌러 보세요!'));
    return;
  }
  for (const w of works) {
    const card = el('div', 'work');
    const img = el('img');
    img.src = w.thumb;
    img.alt = w.name;
    const info = el('div');
    const base = findBase(w.baseId);
    info.append(el('b', '', `${base.emoji} ${w.name}`), el('small', '', `${fmtDate(w.updatedAt)} · ${w.baked ? '구움' : '빚는 중'}`));
    const acts = el('div', 'acts');
    const load = el('button', '', '불러오기');
    load.addEventListener('click', () => { void loadWork(w); $('gallery').hidden = true; });
    const del = el('button', '', '삭제');
    del.addEventListener('click', async () => {
      if (!confirm(`"${w.name}" 을(를) 삭제할까요? 모두의 작품에 공개했다면 거기서도 내려가요.`)) return;
      await deleteWork(w.id);
      await unpublish(w.id).catch(() => false);
      await openGallery();
      if (step === 'pick') void refreshBgWorks();
    });
    acts.append(load, del);
    info.append(acts);
    card.append(img, info);
    list.append(card);
  }
}

async function mountMesh(meta: { id: string; name: string; baseId: string; createdAt: number; baked: boolean; glossy: boolean }, m: MeshData) {
  const nV = m.positions.length / 3;
  const textured = meta.baked && m.uvs && m.texture ? { blob: m.texture, tex: await loadTexture(m.texture) } : null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions.slice(), 3));
  g.setIndex(new THREE.BufferAttribute(m.index.slice(), 1));
  if (meta.baked && m.colors) g.setAttribute('color', new THREE.BufferAttribute(m.colors.slice(), m.colors.length / nV));
  if (textured) {
    g.setAttribute('uv', new THREE.BufferAttribute(m.uvs!.slice(), 2));
    seamlessNormals(g);
  } else {
    g.computeVertexNormals();
  }
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const adjacency = buildAdjacency(m.index, nV);
  mountPiece({ ...meta, geometry: g, adjacency, texture: textured });
  glazeToggle.set(meta.glossy);
}

async function loadWork(w: Work) {
  if (piece && !confirm('지금 작업 중인 작품을 닫고 불러올까요? 저장하지 않은 내용은 사라져요.')) return;
  await mountMesh(w, w);
  openView(w.name, `내 작품 · ${fmtDate(w.updatedAt)}`);
}

$('btn-gallery').addEventListener('click', () => void openGallery());
$('gallery-close').addEventListener('click', () => { $('gallery').hidden = true; });
$('btn-help').addEventListener('click', () => { $('help').hidden = false; });
$('help-close').addEventListener('click', () => { $('help').hidden = true; });
$('help').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('help').hidden = true; });

// ---------------------------------------------------------------- history
function refreshHistoryButtons() {
  const s = piece?.sculptor;
  sculptUndo.disabled = !s?.canUndo;
  sculptRedo.disabled = !s?.canRedo;
  const p = piece?.painter;
  paintUndo.disabled = !p?.canUndo;
  paintRedo.disabled = !p?.canRedo;
}
function undo() {
  if (!piece) return;
  const ok = step === 'paint' ? piece.painter?.undo() : step === 'sculpt' ? piece.sculptor.undo() : false;
  if (ok) toast('되돌렸어요', 900);
  refreshHistoryButtons();
}
function redo() {
  if (!piece) return;
  const ok = step === 'paint' ? piece.painter?.redo() : step === 'sculpt' ? piece.sculptor.redo() : false;
  if (ok) toast('다시 실행했어요', 900);
  refreshHistoryButtons();
}

// ---------------------------------------------------------------- pointer input
function setNDC(e: PointerEvent) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
}

function release() {
  if (capturedPointer >= 0) {
    try { canvas.releasePointerCapture(capturedPointer); } catch { /* ignore */ }
    capturedPointer = -1;
  }
  active = null;
  studio.controls.enabled = true;
  canvas.classList.remove('orbit');
}

canvas.addEventListener('pointerdown', (e) => {
  if (!piece || e.button !== 0 || (step !== 'sculpt' && step !== 'paint')) return;
  setNDC(e);
  const hit = raycastPiece();
  if (!hit) { canvas.classList.add('orbit'); return; } // empty space: OrbitControls takes over
  e.stopImmediatePropagation();
  e.preventDefault();
  studio.controls.enabled = false;
  canvas.setPointerCapture(e.pointerId);
  capturedPointer = e.pointerId;
  if (step === 'sculpt') {
    piece.sculptor.beginStroke(toHit(hit), studio.camera, { shift: e.shiftKey, alt: e.altKey });
    active = 'sculpt';
  } else {
    const p = piece.painter!;
    if (p.tool === 'picker') {
      setPaintColor(`#${p.pick(hit.faceIndex ?? 0).getHexString()}`);
      toast('색을 가져왔어요', 900);
      paintToolGrid.select('brush');
      release();
      return;
    }
    if (p.tool === 'fill') {
      p.fill(p.color);
      toast('전체를 칠했어요', 900);
      release();
      refreshHistoryButtons();
      return;
    }
    p.beginStroke(hit.point);
    active = 'paint';
  }
  refreshHistoryButtons();
}, { capture: true });

window.addEventListener('pointermove', (e) => {
  if (e.target === canvas || active) { setNDC(e); pointerDirty = true; }
});
canvas.addEventListener('pointerenter', () => { pointerOnCanvas = true; });
canvas.addEventListener('pointerleave', () => { pointerOnCanvas = false; if (!active) cursor.visible = ghost.visible = false; });
const endStroke = () => {
  if (!active) { canvas.classList.remove('orbit'); return; }
  piece?.sculptor.endStroke();
  piece?.painter?.endStroke();
  release();
  refreshHistoryButtons();
};
window.addEventListener('pointerup', endStroke);
window.addEventListener('pointercancel', endStroke);
window.addEventListener('blur', endStroke);

// ---------------------------------------------------------------- keyboard
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  const meta = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (meta && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (meta && k === 'y') { e.preventDefault(); redo(); return; }
  if (e.key === 'Escape') { $('help').hidden = true; $('gallery').hidden = true; return; }
  if (step === 'sculpt') {
    if (e.key === '[') sculptSliders.rad.set(sculptSettings.radius - 0.03);
    else if (e.key === ']') sculptSliders.rad.set(sculptSettings.radius + 0.03);
    else if (e.key === '-') sculptSliders.str.set(sculptSettings.strength - 0.1);
    else if (e.key === '=' || e.key === '+') sculptSliders.str.set(sculptSettings.strength + 0.1);
    else if (k === 'm') symToggle.set(!symToggle.checked);
    else if (/^[1-6]$/.test(e.key)) sculptToolGrid.select(SCULPT_TOOLS[Number(e.key) - 1].id);
    pointerDirty = true;
  } else if (step === 'paint') {
    if (e.key === '[') paintSliders.rad.set(paintSettings.radius - 0.02);
    else if (e.key === ']') paintSliders.rad.set(paintSettings.radius + 0.02);
    else if (e.key === '-') paintSliders.op.set(paintSettings.opacity - 0.1);
    else if (e.key === '=' || e.key === '+') paintSliders.op.set(paintSettings.opacity + 0.1);
    else if (/^[1-4]$/.test(e.key)) paintToolGrid.select(PAINT_TOOLS[Number(e.key) - 1].id);
    pointerDirty = true;
  }
});

// ---------------------------------------------------------------- loop
const ro = new ResizeObserver(() => studio.resize());
ro.observe(canvas);

const debug = location.search.includes('debug');
const fpsEl = $('fps');
fpsEl.hidden = !debug;
let frameCount = 0, frameAcc = 0, lastStat = performance.now(), maxFrame = 0;

function frame() {
  requestAnimationFrame(frame);
  const t0 = performance.now();
  if (pointerDirty && piece && (step === 'sculpt' || step === 'paint')) {
    pointerDirty = false;
    const inter = raycastPiece();
    const hit = inter ? toHit(inter) : null;
    if (active === 'sculpt') piece.sculptor.moveStroke(hit, raycaster.ray);
    else if (active === 'paint' && hit) piece.painter?.moveStroke(hit.point);
    updateCursor(pointerOnCanvas || active ? hit : null);
  }
  studio.render();
  if (debug) {
    const dt = performance.now() - t0;
    frameAcc += dt; frameCount++; if (dt > maxFrame) maxFrame = dt;
    if (t0 - lastStat > 500) {
      const verts = piece ? piece.mesh.geometry.getAttribute('position').count : 0;
      fpsEl.textContent = `${(frameAcc / frameCount).toFixed(1)} ms avg · ${maxFrame.toFixed(1)} ms max · ${verts} verts`;
      frameAcc = 0; frameCount = 0; maxFrame = 0; lastStat = t0;
    }
  }
}
frame();

go('pick');

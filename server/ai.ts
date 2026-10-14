// "AI와 첫 모형 만들기": ask Claude to block out a starting clay lump as SDF primitives (from words and/or a picture).
// "AI와 함께 고치기": ask Claude for a few local edits (add/carve/move/scale/smooth) to the piece being sculpted.
// The user still sculpts by hand; the AI only supplies the first lump and helping hands.
import Anthropic from '@anthropic-ai/sdk';

type V3 = [number, number, number];
type Prim =
  | { t: 'sphere'; c: V3; r: number }
  | { t: 'ellipsoid'; c: V3; r: V3 }
  | { t: 'capsule'; a: V3; b: V3; r: number; r2?: number };

export interface AiShape {
  name: string;
  emoji: string;
  shape: { blend: number; prims: Prim[] };
}

// Replit AI Integrations injects AI_INTEGRATIONS_ANTHROPIC_*; a plain ANTHROPIC_API_KEY works too.
const apiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
const model = process.env.AI_MODEL ?? 'claude-sonnet-4-6';
const client = apiKey ? new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) }) : null;

export const aiEnabled = () => client !== null;

const SYSTEM = `You block out the FIRST rough clay lump for a children's 3D clay-sculpting app.
The user describes a character; you return it as a union of simple primitives that get smoothly melted together (smooth-min) and then the user sculpts the details by hand.

Coordinate system (meters-ish units):
- y is up, the figure stands on the floor at y = 0, typical total height 1.2–2.2.
- The figure FACES +z (nose/face toward +z). x is left/right.
- Keep it left/right symmetric: put centered parts at x = 0 and give paired parts (ears, arms, legs, wings, eyes) positive x with "mirror": true — the mirrored copy is added automatically.

Primitives:
- sphere: center, radius
- ellipsoid: center, radii [rx, ry, rz]
- capsule: a, b (segment end points), radius (at a), optional r2 (radius at b, for tapering limbs/ears/tails)

If a reference picture is attached, block out the character IN THE PICTURE (its silhouette, proportions, distinctive parts such as ears, horns, hats, tails, wings), simplified into cute chunky clay. Use the text, if any, as extra direction.

Guidelines:
- 8–30 parts. Chunky, cute, toy-like proportions (big head, stubby limbs) that read clearly as clay.
- Every part must touch or overlap its neighbour so the result is ONE connected lump. Feet/legs must reach the floor (y ≈ 0–0.12).
- No part thinner than radius 0.04 (it would vanish in the mesh). Small features like eyes may be tiny bumps (radius 0.04–0.07) sitting on the surface.
- blend: 0.04–0.12 (higher = softer, more melted).
- name: a short, warm Korean name for the piece (예: "날개 달린 아기 용"). emoji: one emoji.

Example (a cat, abbreviated):
{"name":"고양이","emoji":"🐱","blend":0.07,"parts":[
 {"label":"body","type":"capsule","a":[0,0.62,-0.3],"b":[0,0.66,0.25],"radius":0.3},
 {"label":"head","type":"sphere","center":[0,1.0,0.55],"radius":0.34},
 {"label":"ear","type":"capsule","a":[0.2,1.22,0.5],"b":[0.3,1.5,0.45],"radius":0.1,"r2":0.03,"mirror":true},
 {"label":"front leg","type":"capsule","a":[0.17,0.5,0.22],"b":[0.17,0.08,0.26],"radius":0.09,"mirror":true},
 {"label":"tail","type":"capsule","a":[0,0.6,-0.55],"b":[0,0.95,-0.85],"radius":0.07}]}`;

const vec = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 } as const;
const TOOL: Anthropic.Tool = {
  name: 'make_clay_lump',
  description: 'Return the starting clay lump as primitives.',
  input_schema: {
    type: 'object',
    required: ['name', 'emoji', 'blend', 'parts'],
    properties: {
      name: { type: 'string' },
      emoji: { type: 'string' },
      blend: { type: 'number' },
      parts: {
        type: 'array',
        items: {
          type: 'object',
          required: ['label', 'type'],
          properties: {
            label: { type: 'string' },
            type: { type: 'string', enum: ['sphere', 'ellipsoid', 'capsule'] },
            center: vec, radius: { type: 'number' }, radii: vec, a: vec, b: vec, r2: { type: 'number' },
            mirror: { type: 'boolean' },
          },
        },
      },
    },
  },
};

// ---------------------------------------------------------------- validation
const num = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  return Math.min(hi, Math.max(lo, n));
};
const v3 = (v: unknown): V3 | null =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))
    ? [num(v[0], -3, 3, 0), num(v[1], -1, 4, 0), num(v[2], -3, 3, 0)]
    : null;

export function sanitize(raw: any): AiShape {
  const prims: Prim[] = [];
  const flip = (v: V3): V3 => [-v[0], v[1], v[2]];
  for (const p of Array.isArray(raw?.parts) ? raw.parts.slice(0, 48) : []) {
    let prim: Prim | null = null;
    if (p?.type === 'sphere') {
      const c = v3(p.center);
      if (c) prim = { t: 'sphere', c, r: num(p.radius, 0.04, 1.2, 0.2) };
    } else if (p?.type === 'ellipsoid') {
      const c = v3(p.center), r = v3(p.radii);
      if (c && r) prim = { t: 'ellipsoid', c, r: [num(r[0], 0.04, 1.2, 0.2), num(r[1], 0.04, 1.2, 0.2), num(r[2], 0.04, 1.2, 0.2)] };
    } else if (p?.type === 'capsule') {
      const a = v3(p.a), b = v3(p.b);
      if (a && b) prim = { t: 'capsule', a, b, r: num(p.radius, 0.04, 1.0, 0.1), ...(p.r2 !== undefined ? { r2: num(p.r2, 0.02, 1.0, 0.1) } : {}) };
    }
    if (!prim) continue;
    prims.push(prim);
    if (p.mirror !== true) continue;
    if (prim.t === 'capsule') {
      if (Math.abs(prim.a[0]) + Math.abs(prim.b[0]) > 1e-3) prims.push({ ...prim, a: flip(prim.a), b: flip(prim.b) });
    } else if (Math.abs(prim.c[0]) > 1e-3) {
      prims.push({ ...prim, c: flip(prim.c) } as Prim);
    }
  }
  if (prims.length === 0) throw new Error('empty shape');
  normalize(prims);
  return {
    name: String(raw?.name ?? '').trim().slice(0, 30) || 'AI 반죽',
    emoji: String(raw?.emoji ?? '✨').trim().slice(0, 8) || '✨',
    shape: { blend: num(raw?.blend, 0.03, 0.14, 0.07), prims },
  };
}

/** Scale so the longest side is ~2.1 and stand the figure on y = 0, centered in z. */
function normalize(prims: Prim[]) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const grow = (c: V3, r: number | V3) => {
    for (let i = 0; i < 3; i++) {
      const ri = typeof r === 'number' ? r : r[i];
      min[i] = Math.min(min[i], c[i] - ri);
      max[i] = Math.max(max[i], c[i] + ri);
    }
  };
  for (const p of prims) {
    if (p.t === 'capsule') { const r = Math.max(p.r, p.r2 ?? p.r); grow(p.a, r); grow(p.b, r); }
    else grow(p.c, p.r);
  }
  const s = 2.1 / Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const tz = (min[2] + max[2]) / 2;
  const tf = (v: V3): V3 => [v[0] * s, (v[1] - min[1]) * s, (v[2] - tz) * s];
  for (const p of prims) {
    if (p.t === 'capsule') { p.a = tf(p.a); p.b = tf(p.b); p.r *= s; if (p.r2 !== undefined) p.r2 *= s; }
    else if (p.t === 'sphere') { p.c = tf(p.c); p.r *= s; }
    else { p.c = tf(p.c); p.r = [p.r[0] * s, p.r[1] * s, p.r[2] * s]; }
  }
}

// ---------------------------------------------------------------- images
type ImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
export interface ImageInput { mediaType: ImageType; data: string }
const MAX_IMAGE = 5 * 1024 * 1024;

/** Accepts a `data:image/...;base64,` URL from the browser; null if it isn't a usable picture. */
export function parseImage(v: unknown): ImageInput | null {
  const m = typeof v === 'string' ? /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(v) : null;
  if (!m || (m[2].length * 3) / 4 > MAX_IMAGE) return null;
  return { mediaType: m[1] as ImageType, data: m[2] };
}
const imageBlock = (img: ImageInput): Anthropic.ImageBlockParam => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });

export async function generateShape(prompt: string, image: ImageInput | null = null): Promise<AiShape> {
  if (!client) throw new Error('AI is not configured');
  const ask = image
    ? `첨부한 그림 속 캐릭터를 찰흙 첫 반죽으로 만들어 주세요.${prompt ? ` 추가 설명: ${prompt}` : ''}`
    : `만들고 싶은 친구: ${prompt}`;
  const msg = await client.messages.create({
    model,
    max_tokens: 4096,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL.name },
    messages: [{ role: 'user', content: image ? [imageBlock(image), { type: 'text', text: ask }] : ask }],
  });
  const block = msg.content.find((b) => b.type === 'tool_use');
  if (!block || block.type !== 'tool_use') throw new Error('no tool output');
  return sanitize(block.input);
}

// ---------------------------------------------------------------- AI와 함께 고치기
export type EditOp =
  | { op: 'add' | 'carve'; prim: Prim; blend: number }
  | { op: 'move'; c: V3; r: number; offset: V3 }
  | { op: 'scale'; c: V3; r: number; factor: number }
  | { op: 'smooth'; c: V3; r: number; amount: number };

export interface AiEdit { message: string; ops: EditOp[] }

export interface EditRequest {
  request: string;
  history: { request: string; reply: string }[];
  views: { front: ImageInput; side: ImageInput };
  bounds: { min: V3; max: V3 };
}

const EDIT_SYSTEM = `You are a friendly helper in a children's 3D clay-sculpting app. The child is sculpting a clay piece and asks you to change it.
You see two pictures of the CURRENT piece and return a few local edit operations that the app applies to the clay surface. Afterwards the child keeps sculpting by hand, so rough is fine; clarity matters more than detail.

Coordinate system (same units as the bounds you are given):
- y is up, the piece stands on the floor at y = 0. The piece FACES +z. x is left/right; the piece is usually centered at x = 0.
- Picture 1 (front): camera on +z looking toward -z. Image right = +x, image up = +y.
- Picture 2 (side): camera on +x looking toward -x. Image LEFT = +z (the front of the piece), image up = +y.
- Use the bounds and both pictures to place things precisely (e.g. the top of the head is near bounds.max.y).

Operations (all coordinates in that system):
- add: melt a new clay part onto the piece. type sphere(center, radius) | ellipsoid(center, radii) | capsule(a, b, radius, optional r2 = radius at b). The part MUST start inside or touching the existing clay so it attaches (e.g. a horn capsule goes from a point just under the head surface out to the tip). blend 0.02–0.1 = how softly it melts in.
- carve: scoop clay away with a primitive (eye sockets, a mouth, a dent). Same shape fields as add.
- move: pull the clay near center (within radius) by offset [dx,dy,dz] with soft falloff (make ears longer, bend a tail, lift an arm).
- scale: grow (factor > 1) or shrink (factor < 1) the clay near center within radius (bigger head, thinner legs). factor 0.5–1.8.
- smooth: soften lumps near center within radius. amount 0.1–1.
- mirror: true also applies the op mirrored across x = 0. Use it for paired features (ears, eyes, arms, horns) and give the op the +x side.

Guidelines:
- Do what was asked and nothing else; keep the rest of the piece as it is. 1–8 ops is typical.
- Sizes should suit the piece (compare with the bounds). No part thinner than radius 0.03.
- message: one or two short, warm Korean sentences saying what you changed (예: "머리 위에 작은 뿔 두 개를 붙였어요!"). If the request is unclear or impossible, return no ops and ask a short question in message.`;

const EDIT_TOOL: Anthropic.Tool = {
  name: 'edit_clay',
  description: 'Return the edits to apply to the clay piece.',
  input_schema: {
    type: 'object',
    required: ['message', 'ops'],
    properties: {
      message: { type: 'string' },
      ops: {
        type: 'array',
        items: {
          type: 'object',
          required: ['op'],
          properties: {
            op: { type: 'string', enum: ['add', 'carve', 'move', 'scale', 'smooth'] },
            label: { type: 'string' },
            type: { type: 'string', enum: ['sphere', 'ellipsoid', 'capsule'] },
            center: vec, radius: { type: 'number' }, radii: vec, a: vec, b: vec, r2: { type: 'number' },
            blend: { type: 'number' }, offset: vec, factor: { type: 'number' }, amount: { type: 'number' },
            mirror: { type: 'boolean' },
          },
        },
      },
    },
  },
};

const fv3 = (v: unknown, lo: number, hi: number): V3 | null =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))
    ? [num(v[0], lo, hi, 0), num(v[1], lo, hi, 0), num(v[2], lo, hi, 0)]
    : null;

function primOf(p: any): Prim | null {
  const P = (v: unknown) => fv3(v, -6, 6);
  if (p?.type === 'sphere') { const c = P(p.center); return c ? { t: 'sphere', c, r: num(p.radius, 0.03, 2, 0.15) } : null; }
  if (p?.type === 'ellipsoid') {
    const c = P(p.center), r = P(p.radii);
    return c && r ? { t: 'ellipsoid', c, r: [num(r[0], 0.03, 2, 0.15), num(r[1], 0.03, 2, 0.15), num(r[2], 0.03, 2, 0.15)] } : null;
  }
  if (p?.type === 'capsule') {
    const a = P(p.a), b = P(p.b);
    return a && b ? { t: 'capsule', a, b, r: num(p.radius, 0.03, 1.5, 0.08), ...(p.r2 !== undefined ? { r2: num(p.r2, 0.015, 1.5, 0.08) } : {}) } : null;
  }
  return null;
}

const mirrorPrim = (p: Prim): Prim => {
  const f = (v: V3): V3 => [-v[0], v[1], v[2]];
  return p.t === 'capsule' ? { ...p, a: f(p.a), b: f(p.b) } : { ...p, c: f(p.c) } as Prim;
};

/** The op reflected across x = 0, or null when it is already centered. */
function mirrorOp(op: EditOp): EditOp | null {
  if ('prim' in op) {
    const prim = mirrorPrim(op.prim);
    return JSON.stringify(prim) === JSON.stringify(op.prim) ? null : { ...op, prim };
  }
  if (Math.abs(op.c[0]) <= 1e-3) return null;
  const c: V3 = [-op.c[0], op.c[1], op.c[2]];
  return op.op === 'move' ? { ...op, c, offset: [-op.offset[0], op.offset[1], op.offset[2]] } : { ...op, c };
}

export function sanitizeEdit(raw: any): AiEdit {
  const ops: EditOp[] = [];
  for (const o of Array.isArray(raw?.ops) ? raw.ops.slice(0, 16) : []) {
    let op: EditOp | null = null;
    if (o?.op === 'add' || o?.op === 'carve') {
      const prim = primOf(o);
      if (prim) op = { op: o.op, prim, blend: num(o.blend, 0.01, 0.15, 0.05) };
    } else {
      const c = fv3(o?.center, -6, 6);
      const r = num(o?.radius, 0.05, 3, 0.3);
      if (c && o?.op === 'move') { const offset = fv3(o.offset, -2, 2); if (offset) op = { op: 'move', c, r, offset }; }
      else if (c && o?.op === 'scale') op = { op: 'scale', c, r, factor: num(o.factor, 0.4, 2, 1) };
      else if (c && o?.op === 'smooth') op = { op: 'smooth', c, r, amount: num(o.amount, 0.05, 1, 0.5) };
    }
    if (!op) continue;
    ops.push(op);
    if (o.mirror === true) { const m = mirrorOp(op); if (m) ops.push(m); }
  }
  return { message: String(raw?.message ?? '').trim().slice(0, 300) || (ops.length ? '고쳐 봤어요!' : '어떻게 고칠지 조금 더 알려 줄래요?'), ops };
}

export async function editShape(req: EditRequest): Promise<AiEdit> {
  if (!client) throw new Error('AI is not configured');
  const f = (v: V3) => v.map((x) => x.toFixed(3)).join(', ');
  const messages: Anthropic.MessageParam[] = [];
  for (const h of req.history.slice(-4)) {
    messages.push({ role: 'user', content: h.request }, { role: 'assistant', content: h.reply });
  }
  messages.push({
    role: 'user',
    content: [
      imageBlock(req.views.front),
      imageBlock(req.views.side),
      { type: 'text', text: `지금 작품의 범위(bounds): min [${f(req.bounds.min)}], max [${f(req.bounds.max)}]\n부탁: ${req.request}` },
    ],
  });
  const msg = await client.messages.create({
    model,
    max_tokens: 4096,
    system: EDIT_SYSTEM,
    tools: [EDIT_TOOL],
    tool_choice: { type: 'tool', name: EDIT_TOOL.name },
    messages,
  });
  const block = msg.content.find((b) => b.type === 'tool_use');
  if (!block || block.type !== 'tool_use') throw new Error('no tool output');
  return sanitizeEdit(block.input);
}

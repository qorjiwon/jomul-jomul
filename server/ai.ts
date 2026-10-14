// "AI와 첫 모형 만들기": ask Claude to block out a starting clay lump as SDF primitives.
// The user still sculpts everything by hand afterwards — the AI only supplies the first lump.
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

export async function generateShape(prompt: string): Promise<AiShape> {
  if (!client) throw new Error('AI is not configured');
  const msg = await client.messages.create({
    model,
    max_tokens: 4096,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL.name },
    messages: [{ role: 'user', content: `만들고 싶은 친구: ${prompt}` }],
  });
  const block = msg.content.find((b) => b.type === 'tool_use');
  if (!block || block.type !== 'tool_use') throw new Error('no tool output');
  return sanitize(block.input);
}

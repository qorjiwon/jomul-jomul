// Talks to the server: public gallery ("모두의 작품") and the AI starting lump.
import type { Prim, Shape } from './sdf';
import { newId } from './storage';

export interface PublicWork {
  id: string;
  name: string;
  author: string;
  baseId: string;
  baked: boolean;
  glossy: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MeshData {
  positions: Float32Array;
  index: Uint32Array;
  /** RGB, or RGBA (paint layer over `texture`) per vertex. */
  colors: Float32Array | null;
  uvs?: Float32Array | null;
  texture?: Blob | null;
}

export interface AiShape { name: string; emoji: string; shape: Shape }

const MAGIC = 0x314d4f4a; // 'JOM1'

async function errorOf(res: Response): Promise<Error> {
  try { return new Error((await res.json()).error ?? res.statusText); } catch { return new Error(res.statusText); }
}

// ---------------------------------------------------------------- mesh packing
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/**
 * [magic, nV, nI, flags] + f32 positions + u32 index + u8 colors (if any) + textured section, gzipped.
 * flags: 1 = colors, 2 = colors are RGBA, 4 = textured (f32 uv per vertex, u32 image byte length, image bytes).
 * Keep in sync with checkMesh in server/index.ts.
 */
export async function packMesh(m: MeshData): Promise<Uint8Array> {
  const nV = m.positions.length / 3, nI = m.index.length;
  const ch = m.colors ? m.colors.length / nV : 0;
  const tex = m.uvs && m.texture ? new Uint8Array(await m.texture.arrayBuffer()) : null;
  const colorBytes = nV * ch;
  const size = 16 + nV * 12 + nI * 4 + colorBytes + (tex ? nV * 8 + 4 + tex.length : 0);
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  [MAGIC, nV, nI, (ch ? 1 : 0) | (ch === 4 ? 2 : 0) | (tex ? 4 : 0)].forEach((x, i) => dv.setUint32(i * 4, x, true));
  new Float32Array(buf, 16, nV * 3).set(m.positions);
  new Uint32Array(buf, 16 + nV * 12, nI).set(m.index);
  let off = 16 + nV * 12 + nI * 4;
  if (m.colors) {
    const c = new Uint8Array(buf, off, colorBytes);
    for (let i = 0; i < c.length; i++) c[i] = Math.round(Math.min(1, Math.max(0, m.colors[i])) * 255);
    off += colorBytes;
  }
  if (tex) {
    new Uint8Array(buf, off, nV * 8).set(new Uint8Array(m.uvs!.buffer, m.uvs!.byteOffset, nV * 8));
    off += nV * 8;
    dv.setUint32(off, tex.length, true);
    new Uint8Array(buf, off + 4, tex.length).set(tex);
  }
  return gzip(new Uint8Array(buf));
}

export async function unpackMesh(gz: ArrayBuffer): Promise<MeshData> {
  const buf = await gunzip(gz);
  const dv = new DataView(buf);
  const [magic, nV, nI, flags] = [0, 1, 2, 3].map((i) => dv.getUint32(i * 4, true));
  const ch = flags & 1 ? (flags & 2 ? 4 : 3) : 0;
  if (magic !== MAGIC) throw new Error('bad mesh');
  let off = 16 + nV * 12 + nI * 4;
  const positions = new Float32Array(buf.slice(16, 16 + nV * 12));
  const index = new Uint32Array(buf.slice(16 + nV * 12, off));
  let colors: Float32Array | null = null;
  if (ch) {
    const c = new Uint8Array(buf, off, nV * ch);
    colors = new Float32Array(c.length);
    for (let i = 0; i < c.length; i++) colors[i] = c[i] / 255;
    off += nV * ch;
  }
  let uvs: Float32Array | null = null, texture: Blob | null = null;
  if (flags & 4) {
    uvs = new Float32Array(buf.slice(off, off + nV * 8));
    off += nV * 8;
    const len = dv.getUint32(off, true);
    texture = new Blob([buf.slice(off + 4, off + 4 + len)]);
    off += 4 + len;
  }
  if (off !== buf.byteLength) throw new Error('bad mesh');
  return { positions, index, colors, uvs, texture };
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------------------------------------------------------------- ownership tokens (this browser only)
const TOKENS_KEY = 'jomul.tokens.v1';
function tokens(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(TOKENS_KEY) ?? '{}'); } catch { return {}; }
}
function tokenFor(id: string, create: boolean): string | null {
  const all = tokens();
  if (!all[id] && create) {
    all[id] = newId() + newId();
    try { localStorage.setItem(TOKENS_KEY, JSON.stringify(all)); } catch { /* private mode */ }
  }
  return all[id] ?? null;
}

const AUTHOR_KEY = 'jomul.author';
export function getAuthor(): string { try { return localStorage.getItem(AUTHOR_KEY) ?? ''; } catch { return ''; } }
export function setAuthor(v: string) { try { localStorage.setItem(AUTHOR_KEY, v); } catch { /* ignore */ } }

// ---------------------------------------------------------------- API
export async function fetchConfig(): Promise<{ ai: boolean }> {
  try {
    const res = await fetch('/api/config');
    return res.ok ? await res.json() : { ai: false };
  } catch { return { ai: false }; }
}

export async function listPublic(limit = 24, before?: number): Promise<PublicWork[]> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (before) q.set('before', String(before));
  const res = await fetch(`/api/works?${q}`);
  if (!res.ok) throw await errorOf(res);
  return (await res.json()).works;
}

export const thumbUrl = (w: PublicWork) => `/api/works/${encodeURIComponent(w.id)}/thumb?v=${w.updatedAt}`;

export async function loadPublicMesh(w: PublicWork): Promise<MeshData> {
  const res = await fetch(`/api/works/${encodeURIComponent(w.id)}/mesh?v=${w.updatedAt}`);
  if (!res.ok) throw await errorOf(res);
  return unpackMesh(await res.arrayBuffer());
}

export async function publish(w: { id: string; name: string; author: string; baseId: string; baked: boolean; glossy: boolean; thumb: string; mesh: MeshData }) {
  const mesh = toBase64(await packMesh(w.mesh));
  const res = await fetch(`/api/works/${encodeURIComponent(w.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...w, mesh, token: tokenFor(w.id, true) }),
  });
  if (!res.ok) throw await errorOf(res);
}

/** Removes a work from the public gallery if this browser published it. */
export async function unpublish(id: string): Promise<boolean> {
  const token = tokenFor(id, false);
  if (!token) return false;
  const res = await fetch(`/api/works/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'x-work-token': token } });
  return res.ok;
}

export async function askAiShape(prompt: string, image: string | null = null): Promise<AiShape> {
  const res = await fetch('/api/ai/shape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, image }),
  });
  if (!res.ok) throw await errorOf(res);
  return res.json();
}

// Mirrors server/ai.ts EditOp: local edits the AI asks for, in the piece's own coordinates.
type V3 = [number, number, number];
export type EditPrim = Prim;
export type EditOp =
  | { op: 'add' | 'carve'; prim: EditPrim; blend: number }
  | { op: 'move'; c: V3; r: number; offset: V3 }
  | { op: 'scale'; c: V3; r: number; factor: number }
  | { op: 'smooth'; c: V3; r: number; amount: number };

export async function askAiEdit(body: {
  request: string;
  history: { request: string; reply: string }[];
  views: { front: string; side: string };
  bounds: { min: V3; max: V3 };
}): Promise<{ message: string; ops: EditOp[] }> {
  const res = await fetch('/api/ai/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorOf(res);
  return res.json();
}

// Talks to the server: public gallery ("모두의 작품") and the AI starting lump.
import type { Shape } from './sdf';
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
  colors: Float32Array | null;
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

/** [magic, nV, nI, flags] + f32 positions + u32 index + u8 colors (if any), gzipped. */
export async function packMesh(m: MeshData): Promise<Uint8Array> {
  const nV = m.positions.length / 3, nI = m.index.length;
  const size = 16 + nV * 12 + nI * 4 + (m.colors ? nV * 3 : 0);
  const buf = new ArrayBuffer(size);
  new Uint32Array(buf, 0, 4).set([MAGIC, nV, nI, m.colors ? 1 : 0]);
  new Float32Array(buf, 16, nV * 3).set(m.positions);
  new Uint32Array(buf, 16 + nV * 12, nI).set(m.index);
  if (m.colors) {
    const c = new Uint8Array(buf, 16 + nV * 12 + nI * 4, nV * 3);
    for (let i = 0; i < c.length; i++) c[i] = Math.round(Math.min(1, Math.max(0, m.colors[i])) * 255);
  }
  return gzip(new Uint8Array(buf));
}

export async function unpackMesh(gz: ArrayBuffer): Promise<MeshData> {
  const buf = await gunzip(gz);
  const [magic, nV, nI, flags] = new Uint32Array(buf, 0, 4);
  const hasColors = (flags & 1) === 1;
  if (magic !== MAGIC || buf.byteLength !== 16 + nV * 12 + nI * 4 + (hasColors ? nV * 3 : 0)) throw new Error('bad mesh');
  const positions = new Float32Array(buf.slice(16, 16 + nV * 12));
  const index = new Uint32Array(buf.slice(16 + nV * 12, 16 + nV * 12 + nI * 4));
  let colors: Float32Array | null = null;
  if (hasColors) {
    const c = new Uint8Array(buf, 16 + nV * 12 + nI * 4, nV * 3);
    colors = new Float32Array(c.length);
    for (let i = 0; i < c.length; i++) colors[i] = c[i] / 255;
  }
  return { positions, index, colors };
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

export async function askAiShape(prompt: string): Promise<AiShape> {
  const res = await fetch('/api/ai/shape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) throw await errorOf(res);
  return res.json();
}

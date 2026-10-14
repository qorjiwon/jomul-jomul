// 조물조물 server: public gallery API + AI starting lump + static/Vite frontend on one port.
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createStore, seedFeatured } from './store';
import { aiEnabled, editShape, generateShape, parseImage } from './ai';

const prod = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 5173);
const host = process.env.HOST ?? (prod || process.env.REPL_ID ? '0.0.0.0' : '127.0.0.1');

const store = createStore();
seedFeatured(store).catch((e) => console.error('[jomul] seeding failed:', e));
const app = express();
const server = http.createServer(app);
app.disable('x-powered-by');
app.set('trust proxy', true);

const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;
const MAX_MESH = 16 * 1024 * 1024; // gzipped bytes
const MAX_THUMB = 2 * 1024 * 1024;
/** Thumbs are JPEG (older saves) or transparent WebP/PNG cutouts; tell them apart by their magic bytes. */
const imageType = (b: Buffer) =>
  b.subarray(0, 4).toString('latin1') === '\x89PNG' ? 'image/png'
  : b.subarray(8, 12).toString('latin1') === 'WEBP' ? 'image/webp'
  : 'image/jpeg';
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '');

/** Gunzips and checks the packed mesh header (see src/cloud.ts packMesh) so a broken upload can't reach viewers. */
function checkMesh(gz: Buffer): boolean {
  let raw: Buffer;
  try { raw = zlib.gunzipSync(gz, { maxOutputLength: 64 * 1024 * 1024 }); } catch { return false; }
  if (raw.length < 16 || raw.readUInt32LE(0) !== 0x314d4f4a) return false; // 'JOM1'
  const nV = raw.readUInt32LE(4), nI = raw.readUInt32LE(8), flags = raw.readUInt32LE(12);
  if (nV < 4 || nI < 12 || nI % 3 !== 0 || nV > 2_000_000) return false;
  let off = 16 + nV * 12 + nI * 4 + (flags & 1 ? nV * (flags & 2 ? 4 : 3) : 0);
  if (flags & 4) {
    off += nV * 8;
    if (raw.length < off + 4) return false;
    const texLen = raw.readUInt32LE(off);
    if (texLen > 12 * 1024 * 1024) return false;
    off += 4 + texLen;
  }
  return raw.length === off;
}

// ---------------------------------------------------------------- tiny rate limiter
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string) => {
    const now = Date.now();
    const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 5000) hits.clear();
    return true;
  };
}
const aiPerIp = limiter(Number(process.env.AI_PER_IP_LIMIT ?? 8), 10 * 60_000);
const aiDaily = limiter(Number(process.env.AI_DAILY_LIMIT ?? 400), 24 * 60 * 60_000);
const savePerIp = limiter(30, 10 * 60_000);

// ---------------------------------------------------------------- API
const api = express.Router();
api.use(express.json({ limit: '24mb' }));

api.get('/config', (_req, res) => { res.json({ ai: aiEnabled(), storage: store.kind }); });

api.get('/works', async (req, res) => {
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 24));
  const before = req.query.before ? Number(req.query.before) : undefined;
  res.json({ works: await store.list(limit, Number.isFinite(before) ? before : undefined) });
});

api.get('/works/:id/thumb', async (req, res) => {
  const b = ID_RE.test(req.params.id) ? await store.thumb(req.params.id) : null;
  if (!b) { res.sendStatus(404); return; }
  res.type(imageType(b)).set('Cache-Control', 'public, max-age=60').send(b);
});

api.get('/works/:id/mesh', async (req, res) => {
  const b = ID_RE.test(req.params.id) ? await store.mesh(req.params.id) : null;
  if (!b) { res.sendStatus(404); return; }
  res.type('application/octet-stream').set('Cache-Control', 'public, max-age=60').send(b);
});

api.put('/works/:id', async (req, res) => {
  const { id } = req.params;
  const body = req.body ?? {};
  if (!ID_RE.test(id)) { res.status(400).json({ error: 'bad id' }); return; }
  if (!savePerIp(req.ip ?? '')) { res.status(429).json({ error: '잠시 후에 다시 저장해 주세요.' }); return; }
  const token = text(body.token, 128);
  if (token.length < 16) { res.status(400).json({ error: 'bad token' }); return; }
  const existing = await store.tokenHash(id);
  if (existing && existing !== sha256(token)) { res.status(403).json({ error: '다른 사람의 작품은 덮어쓸 수 없어요.' }); return; }

  const thumbMatch = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.thumb ?? ''));
  const thumb = thumbMatch ? Buffer.from(thumbMatch[1], 'base64') : null;
  const mesh = typeof body.mesh === 'string' ? Buffer.from(body.mesh, 'base64') : null;
  if (!thumb || thumb.length > MAX_THUMB || !mesh || mesh.length > MAX_MESH || !checkMesh(mesh)) {
    res.status(400).json({ error: '작품 데이터가 올바르지 않아요.' }); return;
  }
  const now = Date.now();
  await store.upsert({
    id,
    name: text(body.name, 30) || '이름 없는 친구',
    author: text(body.author, 20) || '익명의 조물러',
    baseId: text(body.baseId, 20) || 'blob',
    baked: body.baked === true,
    glossy: body.glossy === true,
    createdAt: now,
    updatedAt: now,
    tokenHash: sha256(token),
    thumb,
    mesh,
  });
  res.json({ ok: true });
});

api.delete('/works/:id', async (req, res) => {
  const { id } = req.params;
  const token = text(req.get('x-work-token'), 128);
  const existing = ID_RE.test(id) ? await store.tokenHash(id) : null;
  if (!existing) { res.sendStatus(404); return; }
  if (existing !== sha256(token)) { res.sendStatus(403); return; }
  await store.remove(id);
  res.json({ ok: true });
});

/** Shared gate for AI calls: configured + per-IP and daily limits. Returns false after replying. */
function aiGate(req: Request, res: Response): boolean {
  if (!aiEnabled()) { res.status(503).json({ error: 'AI 기능이 아직 연결되지 않았어요.' }); return false; }
  if (!aiPerIp(req.ip ?? '')) { res.status(429).json({ error: 'AI에게 너무 자주 부탁했어요. 몇 분 뒤에 다시 해 보세요.' }); return false; }
  if (!aiDaily('all')) { res.status(429).json({ error: '오늘 AI 도움이 모두 소진됐어요. 내일 다시 만나요!' }); return false; }
  return true;
}

api.post('/ai/shape', async (req, res) => {
  const prompt = text(req.body?.prompt, 200);
  const image = req.body?.image ? parseImage(req.body.image) : null;
  if (req.body?.image && !image) { res.status(400).json({ error: '그림은 5MB 이하의 JPG·PNG·WEBP만 넣을 수 있어요.' }); return; }
  if (!prompt && !image) { res.status(400).json({ error: '어떤 친구를 만들지 적거나 그림을 넣어 주세요.' }); return; }
  if (!aiGate(req, res)) return;
  try {
    res.json(await generateShape(prompt, image));
  } catch (e) {
    console.error('[jomul] ai/shape failed:', e);
    res.status(502).json({ error: 'AI가 반죽을 만들지 못했어요. 다르게 설명해 볼까요?' });
  }
});

api.post('/ai/edit', async (req, res) => {
  const b = req.body ?? {};
  const request = text(b.request, 300);
  const front = parseImage(b.views?.front), side = parseImage(b.views?.side);
  const vec = (v: unknown) => (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (v as [number, number, number]) : null);
  const min = vec(b.bounds?.min), max = vec(b.bounds?.max);
  if (!request) { res.status(400).json({ error: '어떻게 고칠지 적어 주세요.' }); return; }
  if (!front || !side || !min || !max) { res.status(400).json({ error: '작품 정보를 보내지 못했어요.' }); return; }
  const history = (Array.isArray(b.history) ? b.history : [])
    .slice(-4)
    .map((h: any) => ({ request: text(h?.request, 300), reply: text(h?.reply, 300) }))
    .filter((h: { request: string; reply: string }) => h.request && h.reply);
  if (!aiGate(req, res)) return;
  try {
    res.json(await editShape({ request, history, views: { front, side }, bounds: { min, max } }));
  } catch (e) {
    console.error('[jomul] ai/edit failed:', e);
    res.status(502).json({ error: 'AI가 고치지 못했어요. 다르게 말해 볼까요?' });
  }
});

api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[jomul] api error:', err);
  res.status(500).json({ error: '서버에서 문제가 생겼어요.' });
});
app.use('/api', api);

// ---------------------------------------------------------------- frontend
if (prod) {
  const dist = path.resolve('dist');
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api\/).*/, (_req, res) => { res.sendFile(path.join(dist, 'index.html')); });
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true, hmr: { server }, allowedHosts: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

server.listen(port, host, () => {
  console.log(`[jomul] http://${host}:${port}  (storage: ${store.kind}, ai: ${aiEnabled() ? 'on' : 'off'}, ${prod ? 'production' : 'dev'})`);
});

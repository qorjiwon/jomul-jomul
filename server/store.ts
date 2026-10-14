// Public gallery storage: Postgres when DATABASE_URL is set (Replit), otherwise local files (dev).
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

export interface WorkMeta {
  id: string;
  name: string;
  author: string;
  baseId: string;
  baked: boolean;
  glossy: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface WorkRecord extends WorkMeta {
  tokenHash: string;
  thumb: Buffer;
  mesh: Buffer;
}

export interface Store {
  readonly kind: string;
  list(limit: number, before?: number): Promise<WorkMeta[]>;
  tokenHash(id: string): Promise<string | null>;
  updatedAt(id: string): Promise<number | null>;
  thumb(id: string): Promise<Buffer | null>;
  mesh(id: string): Promise<Buffer | null>;
  upsert(rec: WorkRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

// ---------------------------------------------------------------- postgres
class PgStore implements Store {
  readonly kind = 'postgres';
  private ready: Promise<unknown>;
  constructor(private pool: pg.Pool) {
    this.ready = pool.query(`
      CREATE TABLE IF NOT EXISTS works (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        base_id TEXT NOT NULL,
        baked BOOLEAN NOT NULL,
        glossy BOOLEAN NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        token_hash TEXT NOT NULL,
        thumb BYTEA NOT NULL,
        mesh BYTEA NOT NULL
      );
      CREATE INDEX IF NOT EXISTS works_updated_idx ON works (updated_at DESC);
    `);
  }

  async list(limit: number, before?: number): Promise<WorkMeta[]> {
    await this.ready;
    const { rows } = await this.pool.query(
      `SELECT id, name, author, base_id, baked, glossy, created_at, updated_at FROM works
       WHERE ($2::bigint IS NULL OR updated_at < $2) ORDER BY updated_at DESC LIMIT $1`,
      [limit, before ?? null],
    );
    return rows.map((r) => ({
      id: r.id, name: r.name, author: r.author, baseId: r.base_id, baked: r.baked, glossy: r.glossy,
      createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    }));
  }

  private async col(id: string, col: 'token_hash' | 'updated_at' | 'thumb' | 'mesh') {
    await this.ready;
    const { rows } = await this.pool.query(`SELECT ${col} AS v FROM works WHERE id = $1`, [id]);
    return rows[0]?.v ?? null;
  }
  tokenHash(id: string) { return this.col(id, 'token_hash') as Promise<string | null>; }
  async updatedAt(id: string) { const v = await this.col(id, 'updated_at'); return v === null ? null : Number(v); }
  thumb(id: string) { return this.col(id, 'thumb') as Promise<Buffer | null>; }
  mesh(id: string) { return this.col(id, 'mesh') as Promise<Buffer | null>; }

  async upsert(w: WorkRecord) {
    await this.ready;
    await this.pool.query(
      `INSERT INTO works (id, name, author, base_id, baked, glossy, created_at, updated_at, token_hash, thumb, mesh)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET name=$2, author=$3, base_id=$4, baked=$5, glossy=$6, updated_at=$8, thumb=$10, mesh=$11`,
      [w.id, w.name, w.author, w.baseId, w.baked, w.glossy, w.createdAt, w.updatedAt, w.tokenHash, w.thumb, w.mesh],
    );
  }

  async remove(id: string) {
    await this.ready;
    await this.pool.query('DELETE FROM works WHERE id = $1', [id]);
  }
}

// ---------------------------------------------------------------- files (local dev)
class FileStore implements Store {
  readonly kind = 'files';
  constructor(private dir: string) {}
  private p(id: string, ext: string) { return path.join(this.dir, `${id}.${ext}`); }
  private async read(file: string) { try { return await fs.readFile(file); } catch { return null; } }
  private async metaOf(id: string): Promise<(WorkMeta & { tokenHash: string }) | null> {
    const b = await this.read(this.p(id, 'json'));
    return b ? JSON.parse(b.toString('utf8')) : null;
  }

  async list(limit: number, before?: number) {
    await fs.mkdir(this.dir, { recursive: true });
    const files = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.json'));
    const all = (await Promise.all(files.map((f) => this.metaOf(f.slice(0, -5))))).filter((m) => m !== null);
    return all
      .filter((m) => before === undefined || m.updatedAt < before)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map(({ tokenHash: _t, ...m }) => m);
  }
  async tokenHash(id: string) { return (await this.metaOf(id))?.tokenHash ?? null; }
  async updatedAt(id: string) { return (await this.metaOf(id))?.updatedAt ?? null; }
  // `.jpg` is just the blob's file name; newer thumbs inside are WebP/PNG.
  thumb(id: string) { return this.read(this.p(id, 'jpg')); }
  mesh(id: string) { return this.read(this.p(id, 'bin')); }

  async upsert({ thumb, mesh, ...meta }: WorkRecord) {
    await fs.mkdir(this.dir, { recursive: true });
    const prev = await this.metaOf(meta.id);
    if (prev) meta.createdAt = prev.createdAt;
    await fs.writeFile(this.p(meta.id, 'jpg'), thumb);
    await fs.writeFile(this.p(meta.id, 'bin'), mesh);
    await fs.writeFile(this.p(meta.id, 'json'), JSON.stringify(meta));
  }

  async remove(id: string) {
    await Promise.all(['json', 'jpg', 'bin'].map((e) => fs.rm(this.p(id, e), { force: true })));
  }
}

export function createStore(): Store {
  const url = process.env.DATABASE_URL;
  if (url) return new PgStore(new pg.Pool({ connectionString: url, max: 5 }));
  if (process.env.NODE_ENV === 'production') {
    console.warn('[jomul] DATABASE_URL is not set — public works are stored on local disk and may disappear on redeploy.');
  }
  return new FileStore(path.resolve('data/works'));
}


import { get, set } from 'idb-keyval';

export interface Work {
  id: string;
  name: string;
  baseId: string;
  createdAt: number;
  updatedAt: number;
  positions: Float32Array;
  index: Uint32Array;
  colors: Float32Array | null;
  baked: boolean;
  glossy: boolean;
  thumb: string;
}

const KEY = 'jomul.works.v1';

export async function listWorks(): Promise<Work[]> {
  try {
    return (await get<Work[]>(KEY)) ?? [];
  } catch {
    return [];
  }
}

export async function saveWork(work: Work): Promise<void> {
  const list = await listWorks();
  const i = list.findIndex((w) => w.id === work.id);
  if (i >= 0) list[i] = work;
  else list.unshift(work);
  await set(KEY, list);
}

export async function deleteWork(id: string): Promise<void> {
  const list = (await listWorks()).filter((w) => w.id !== id);
  await set(KEY, list);
}

export function newId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

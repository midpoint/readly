const DB_NAME = "readly";
const DB_VERSION = 1;
const STORE = "articles";

/** 本地镜像的滚动窗口上限:超出时淘汰 publishedAt 最旧的 */
export const MIRROR_LIMIT = 1000;

export interface MirrorRow {
  id: number;
  feedId: number;
  feedTitle: string;
  title: string;
  url: string | null;
  publishedAt: string;
  excerpt: string | null;
  content: string | null;
}

export interface MirrorPage {
  items: MirrorRow[];
  nextCursorId: number | null;
}

export interface Mirror {
  readonly kind: "idb" | "memory";
  putMany(rows: MirrorRow[]): Promise<{ added: number; total: number }>;
  getAllNewest(limit: number): Promise<MirrorRow[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
  deleteMany(ids: number[]): Promise<void>;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("published_at", "publishedAt");
        store.createIndex("feed_id", "feedId");
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // 其他标签页升级/删除数据库时让出连接,避免长期阻塞
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("打开 IndexedDB 失败"));
  });
}

class IdbMirror implements Mirror {
  readonly kind = "idb" as const;
  constructor(private db: IDBDatabase) {}

  async putMany(rows: MirrorRow[]): Promise<{ added: number; total: number }> {
    const before = await this.count();
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const row of rows) store.put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("写入失败"));
    });
    const total = await this.count();
    return { added: total - before, total };
  }

  async getAllNewest(limit: number): Promise<MirrorRow[]> {
    return new Promise((resolve, reject) => {
      const out: MirrorRow[] = [];
      const tx = this.db.transaction(STORE, "readonly");
      const idx = tx.objectStore(STORE).index("published_at");
      const req = idx.openCursor(null, "prev");
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur || out.length >= limit) {
          resolve(out);
          return;
        }
        out.push(cur.value as MirrorRow);
        cur.continue();
      };
      req.onerror = () => reject(req.error ?? new Error("读取失败"));
    });
  }

  async count(): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE, "readonly").objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("计数失败"));
    });
  }

  async clear(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("清空失败"));
    });
  }

  async deleteMany(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const id of ids) store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("删除失败"));
    });
  }
}

export class MemoryMirror implements Mirror {
  readonly kind = "memory" as const;
  private rows = new Map<number, MirrorRow>();

  async putMany(rows: MirrorRow[]): Promise<{ added: number; total: number }> {
    let added = 0;
    for (const row of rows) {
      if (!this.rows.has(row.id)) added++;
      this.rows.set(row.id, row);
    }
    return { added, total: this.rows.size };
  }

  async getAllNewest(limit: number): Promise<MirrorRow[]> {
    return [...this.rows.values()]
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, limit);
  }

  async count(): Promise<number> {
    return this.rows.size;
  }

  async clear(): Promise<void> {
    this.rows.clear();
  }

  async deleteMany(ids: number[]): Promise<void> {
    for (const id of ids) this.rows.delete(id);
  }
}

export async function createMirror(): Promise<Mirror> {
  try {
    return new IdbMirror(await openDb());
  } catch {
    return new MemoryMirror();
  }
}

export async function syncMirror(
  mirror: Mirror,
  fetchPage: (cursorId: number | null) => Promise<MirrorPage>
): Promise<{ synced: number; total: number; exhausted: boolean }> {
  let cursor: number | null = null;
  let synced = 0;
  let exhausted = false;
  for (let page = 0; page < 50; page++) {
    const res = await fetchPage(cursor);
    const { added, total } = await mirror.putMany(res.items);
    synced += added;
    if (added === 0 || res.nextCursorId === null || res.nextCursorId === 0 || res.items.length === 0) {
      exhausted = true;
      break;
    }
    cursor = res.nextCursorId;
    if (total >= MIRROR_LIMIT) break;
  }
  // 滚动窗口:超出上限时淘汰 publishedAt 最旧的,保留恰好 MIRROR_LIMIT 篇
  const total = await mirror.count();
  if (total > MIRROR_LIMIT) {
    const all = await mirror.getAllNewest(total);
    await mirror.deleteMany(all.slice(MIRROR_LIMIT).map((r) => r.id));
  }
  return { synced, total: await mirror.count(), exhausted };
}

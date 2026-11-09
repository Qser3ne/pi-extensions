import { resolve } from 'node:path';
import type { FileSnapshot } from './reader.ts';

type Entry = { namespace: string; snapshot: FileSnapshot; bytes: number };

/** Instance-local, access-ordered snapshots; byte accounting estimates serialized metadata, not JS heap. */
export class SnapshotCache {
  #entries = new Map<string, Entry>();
  #bytes = 0;
  #maxBytes: number;
  #maxEntries: number;
  constructor(options: { maxBytes?: number; maxEntries?: number } = {}) {
    this.#maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.#maxEntries = options.maxEntries ?? 4096;
    if (![this.#maxBytes, this.#maxEntries].every(n => Number.isSafeInteger(n) && n >= 0))
      throw new RangeError('快照缓存容量必须为非负安全整数');
  }
  get size(): number { return this.#entries.size; }
  get bytes(): number { return this.#bytes; }
  #key(cacheDir: string, path: string): string { return JSON.stringify([resolve(cacheDir), path]); }
  #remove(key: string): void {
    const entry = this.#entries.get(key);
    if (entry) { this.#bytes -= entry.bytes; this.#entries.delete(key); }
  }
  get(cacheDir: string, path: string): FileSnapshot | undefined {
    const key = this.#key(cacheDir, path), entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key); this.#entries.set(key, entry);
    return entry.snapshot;
  }
  set(cacheDir: string, snapshot: FileSnapshot): void {
    const key = this.#key(cacheDir, snapshot.path);
    if (this.#entries.get(key)?.snapshot === snapshot) { this.get(cacheDir, snapshot.path); return; }
    this.#remove(key);
    if (!this.#maxBytes || !this.#maxEntries) return;
    const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
    if (bytes > this.#maxBytes) return;
    this.#entries.set(key, { namespace: resolve(cacheDir), snapshot, bytes }); this.#bytes += bytes;
    while (this.#bytes > this.#maxBytes || this.#entries.size > this.#maxEntries)
      this.#remove(this.#entries.keys().next().value!);
  }
  delete(cacheDir: string, path: string): void { this.#remove(this.#key(cacheDir, path)); }
  prune(cacheDir: string, paths: Set<string>): void {
    const namespace = resolve(cacheDir);
    for (const [key, entry] of this.#entries)
      if (entry.namespace === namespace && !paths.has(entry.snapshot.path)) this.#remove(key);
  }
}

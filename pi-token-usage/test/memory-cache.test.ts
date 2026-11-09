import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as cache from '../src/cache.ts';
import type { FileSnapshot } from '../src/reader.ts';

function snapshot(path: string, warnings: string[] = []): FileSnapshot {
  return { version: 4, path, device: 1, inode: 1, size: 0, offset: 0, mtimeMs: 1, ctimeMs: 1,
    boundaryHash: '', prefixHash: '', headerValid: true, records: [], warnings };
}
function store(options?: { maxBytes?: number; maxEntries?: number }) {
  assert.equal(typeof cache.SnapshotCache, 'function', 'SnapshotCache constructor must exist');
  return new cache.SnapshotCache(options);
}

test('snapshot retention is isolated by instance and structured cache-directory path pairs', () => {
  const memory = store(), separate = store(), a = snapshot('/c'), b = snapshot('/b/c');
  memory.set('/a/b', a); memory.set('/a', b);
  assert.equal(memory.get('/a/b', '/c'), a);
  assert.equal(memory.get('/a', '/b/c'), b);
  assert.equal(memory.get('/a', '/c'), undefined);
  assert.equal(separate.get('/a/b', '/c'), undefined);
  assert.equal(memory.get('/a/b/../b', '/c'), a);
});

test('default capacity bounds retained files at 4096 without growing on repeated hits', () => {
  const memory = store();
  for (let i = 0; i < 4100; i++) memory.set('/cache', snapshot('/' + i));
  assert.equal(memory.size, 4096);
  assert.equal(memory.get('/cache', '/0'), undefined);
  const last = memory.get('/cache', '/4099')!, bytes = memory.bytes;
  assert.ok(last);
  for (let i = 0; i < 100; i++) memory.set('/cache', last);
  assert.equal(memory.size, 4096); assert.equal(memory.bytes, bytes);
  assert.ok(bytes <= 64 * 1024 * 1024);
});

test('snapshot access order evicts least recently used entries and replaces counters', () => {
  const memory = store({ maxEntries: 2 }), a = snapshot('/a'), b = snapshot('/b'), c = snapshot('/c');
  memory.set('/cache', a); memory.set('/cache', b); memory.get('/cache', '/a'); memory.set('/cache', c);
  assert.equal(memory.get('/cache', '/b'), undefined);
  assert.equal(memory.get('/cache', '/a'), a);
  assert.equal(memory.get('/cache', '/c'), c);
  const replacement = snapshot('/a', ['updated']); memory.set('/cache', replacement);
  assert.equal(memory.size, 2);
  assert.equal(memory.get('/cache', '/a'), replacement);
  assert.equal(memory.bytes, Buffer.byteLength(JSON.stringify(replacement)) + Buffer.byteLength(JSON.stringify(c)));
});

test('serialized byte budget evicts older entries and rejects oversized replacements', () => {
  const a = snapshot('/a'), b = snapshot('/b'), limit = Buffer.byteLength(JSON.stringify(a)) + Buffer.byteLength(JSON.stringify(b)) - 1;
  const memory = store({ maxBytes: limit });
  memory.set('/cache', a); memory.set('/cache', b);
  assert.equal(memory.get('/cache', '/a'), undefined);
  assert.equal(memory.get('/cache', '/b'), b);
  assert.ok(memory.bytes <= limit);
  memory.set('/cache', snapshot('/b', ['x'.repeat(limit)]));
  assert.equal(memory.size, 0); assert.equal(memory.bytes, 0);
});

test('delete and namespace-specific prune release retained accounting', () => {
  const memory = store(), a = snapshot('/a'), b = snapshot('/b');
  memory.set('/one', a); memory.set('/one', b); memory.set('/two', b);
  memory.prune('/one', new Set(['/a']));
  assert.equal(memory.get('/one', '/b'), undefined);
  assert.equal(memory.get('/two', '/b'), b);
  memory.delete('/one', '/a'); memory.delete('/one', '/missing');
  assert.equal(memory.size, 1);
  memory.prune('/two', new Set());
  assert.equal(memory.size, 0); assert.equal(memory.bytes, 0);
});

test('zero budgets disable retention and unsafe limits are rejected', () => {
  for (const options of [{ maxBytes: 0 }, { maxEntries: 0 }]) {
    const memory = store(options); memory.set('/cache', snapshot('/a'));
    assert.equal(memory.size, 0); assert.equal(memory.bytes, 0);
  }
  for (const n of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => store({ maxBytes: n }), RangeError);
    assert.throws(() => store({ maxEntries: n }), RangeError);
  }
});

// Git pack handling: parse receive-pack packfiles (full + ofs/ref deltas)
// and write packfiles for upload-pack (clone/fetch). Also tree/commit helpers.
import { deflateSync, inflateSync } from 'node:zlib';
import type { Repo } from './store.ts';

const TYPES = ['', 'commit', 'tree', 'blob', 'tag', '', '', ''];

// read a varint-encoded type+size header, return [type, size, headerLen]
export function readObjHeader(d: Buffer, off: number): [number, number, number] {
  let c = d[off];
  const type = (c >> 4) & 7;
  let size = c & 15;
  let shift = 4;
  let len = 1;
  while (c & 0x80) {
    c = d[off + len];
    size |= (c & 0x7f) << shift;
    shift += 7;
    len++;
  }
  return [type, size, len];
}

// apply a delta buffer against base data
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let o = 0;
  const rsz = ((): number => { // read varint
    let r = 0, s = 0;
    for (;;) { const b = delta[o++]; r |= (b & 0x7f) << s; s += 7; if (!(b & 0x80)) break; }
    return r;
  })();
  if (rsz !== base.length) throw new Error('delta base size mismatch');
  const tsz = ((): number => {
    let r = 0, s = 0;
    for (;;) { const b = delta[o++]; r |= (b & 0x7f) << s; s += 7; if (!(b & 0x80)) break; }
    return r;
  })();
  const out = Buffer.alloc(tsz);
  let t = 0;
  while (o < delta.length) {
    const op = delta[o++];
    if (op & 0x80) { // copy from base
      let cp = 0, cs = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) cp |= delta[o++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) cs |= delta[o++] << (8 * i);
      if (cs === 0) cs = 0x10000;
      base.copy(out, t, cp, cp + cs);
      t += cs;
    } else { // insert literal
      delta.copy(out, t, o, o + op);
      o += op; t += op;
    }
  }
  return out;
}

// find the smallest end index e >= off such that buf[off..e] is a complete
// zlib stream. inflateSync ignores trailing garbage, so we binary-search the
// boundary. Packs are small in this forge's workloads, so this is fine.
function inflateBounded(d: Buffer, off: number, expect: number): [Buffer, number] {
  let lo = off + 8, hi = d.length;
  let best = -1, bestOut: Buffer | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(d.subarray(off, mid));
      if (out.length < expect) { lo = mid + 1; continue; }
      // need consumed length: retry with tighter search for exact boundary
      best = mid; bestOut = out; hi = mid - 1;
    } catch { lo = mid + 1; }
  }
  if (bestOut === null) throw new Error('bad zlib stream');
  // narrow to the exact consumed length: find minimal e with correct output
  let a = off + 1, b = best;
  while (a < b) {
    const mid = (a + b) >> 1;
    try {
      const out = inflateSync(d.subarray(off, mid));
      if (out.length >= expect) b = mid; else a = mid + 1;
    } catch { a = mid + 1; }
  }
  const out = inflateSync(d.subarray(off, b));
  // consumed = b - off (inflateSync consumed exactly the stream inside that slice)
  return [out, b - off];
}

export interface PackedObj { id: string | null; type: string; data: Buffer }

// parse a packfile body (after the 12-byte header), applying deltas onto
// the repo's existing objects (ref-deltas may reference objects in this pack)
export function parsePack(r: Repo, body: Buffer): PackedObj[] {
  if (body.toString('latin1', 0, 4) !== 'PACK') throw new Error('bad pack signature');
  const count = body.readUInt32BE(8);
  const objs: { id: string | null; type: number; data: Buffer; baseOfs?: number; baseRef?: string }[] = [];
  let off = 12;
  for (let i = 0; i < count; i++) {
    const [t, size, hlen] = readObjHeader(body, off);
    off += hlen;
    if (t === 6) { // ofs-delta
      let c = body[off++], rel = c & 0x7f, varint = 1;
      while (c & 0x80) { c = body[off++]; rel = ((rel + 1) << 7) | (c & 0x7f); varint++; }
      const [data, used] = inflateBounded(body, off, size);
      off += used;
      objs.push({ id: null, type: 6, data, baseOfs: off - used - varint - hlen - rel });
      continue;
    }
    if (t === 7) { // ref-delta
      const base = body.toString('hex', off, off + 20);
      off += 20;
      const [data, used] = inflateBounded(body, off, size);
      off += used;
      objs.push({ id: null, type: 7, data, baseRef: base });
      continue;
    }
    const [data, used] = inflateBounded(body, off, size);
    off += used;
    objs.push({ id: null, type: t, data });
  }
  // resolve
  const done: PackedObj[] = [];
  const pending = [...objs];
  let guard = 0;
  while (pending.length && guard++ < 10000) {
    let progress = false;
    for (let i = 0; i < pending.length; i++) {
      const o = pending[i];
      let base: { type: string; data: Buffer } | undefined;
      let baseTypeHint = '';
      if (o.type <= 4) {
        const id = r.put(TYPES[o.type], o.data);
        o.id = id; done.push({ id, type: TYPES[o.type], data: o.data });
        pending.splice(i--, 1); progress = true;
      } else if (o.type === 6) {
        const idx = objs.findIndex(x => x === undefined ? false : (x as { start?: number }).start === o.baseOfs);
        // simpler: track header offsets when parsing — recompute via baseOfs into body? use done objects by position
        base = findBaseByOffset(o, objs, body);
        baseTypeHint = base?.type ?? '';
        if (!base) continue;
        const merged = applyDelta(base.data, o.data);
        const id = r.put(baseTypeHint, merged);
        o.id = id; done.push({ id, type: baseTypeHint, data: merged });
        pending.splice(i--, 1); progress = true;
      } else if (o.type === 7) {
        base = r.get(o.baseRef!);
        if (!base) continue;
        const merged = applyDelta(base.data, o.data);
        const id = r.put(base.type, merged);
        o.id = id; done.push({ id, type: base.type, data: merged });
        pending.splice(i--, 1); progress = true;
      }
    }
    if (!progress) throw new Error('unresolvable deltas');
  }
  return done;
}

// ofs-delta bases point to an earlier object in the same pack; we recorded
// the delta's own header offset — walk the pack again from its start to find
// which object starts at baseOfs. To keep this cheap we re-derive positions.
const objStarts = new WeakMap<object, number>();

export function parsePackTracked(r: Repo, body: Buffer): PackedObj[] {
  // like parsePack but records each object's header start offset
  if (body.toString('latin1', 0, 4) !== 'PACK') throw new Error('bad pack signature');
  const count = body.readUInt32BE(8);
  const objs: { id: string | null; type: number; data: Buffer; baseOfs?: number; baseRef?: string; start: number }[] = [];
  let off = 12;
  for (let i = 0; i < count; i++) {
    const start = off;
    const [t, size, hlen] = readObjHeader(body, off);
    off += hlen;
    if (t === 6) {
      let c = body[off++], rel = c & 0x7f, varint = 1;
      while (c & 0x80) { c = body[off++]; rel = ((rel + 1) << 7) | (c & 0x7f); varint++; }
      const [data, used] = inflateBounded(body, off, size);
      off += used;
      objs.push({ id: null, type: 6, data, baseOfs: off - used - varint - hlen - rel, start });
      continue;
    }
    if (t === 7) {
      const base = body.toString('hex', off, off + 20);
      off += 20;
      const [data, used] = inflateBounded(body, off, size);
      off += used;
      objs.push({ id: null, type: 7, data, baseRef: base, start });
      continue;
    }
    const [data, used] = inflateBounded(body, off, size);
    off += used;
    objs.push({ id: null, type: t, data, start });
  }
  const byStart = new Map<number, (typeof objs)[number]>();
  for (const o of objs) byStart.set(o.start, o);
  const done: PackedObj[] = [];
  const pending = [...objs];
  let guard = 0;
  while (pending.length && guard++ < 10000) {
    let progress = false;
    for (let i = 0; i < pending.length; i++) {
      const o = pending[i];
      if (o.type <= 4) {
        const id = r.put(TYPES[o.type], o.data);
        o.id = id; done.push({ id, type: TYPES[o.type], data: o.data });
        pending.splice(i--, 1); progress = true;
      } else if (o.type === 6) {
        const b = o.baseOfs !== undefined ? byStart.get(o.baseOfs) : undefined;
        if (!b || !b.id) continue;
        const bo = r.get(b.id)!;
        const merged = applyDelta(bo.data, o.data);
        const id = r.put(bo.type, merged);
        o.id = id; done.push({ id, type: bo.type, data: merged });
        pending.splice(i--, 1); progress = true;
      } else {
        const b = r.get(o.baseRef!);
        if (!b) continue;
        const merged = applyDelta(b.data, o.data);
        const id = r.put(b.type, merged);
        o.id = id; done.push({ id, type: b.type, data: merged });
        pending.splice(i--, 1); progress = true;
      }
    }
    if (!progress) throw new Error('unresolvable deltas');
  }
  return done;
}

function findBaseByOffset(_o: unknown, _objs: unknown, _body: Buffer) { return undefined; }

// ---------- pack writing ----------

function typeSizeHeader(type: number, size: number): Buffer {
  let c = (type << 4) | (size & 15);
  size >>= 4;
  const out: number[] = [];
  while (size) { out.push(c | 0x80); c = size & 0x7f; size >>= 7; }
  out.push(c);
  return Buffer.from(out);
}

// write a full (non-delta) pack of the given objects
export function writePack(entries: { type: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'latin1');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  chunks.push(head);
  for (const e of entries) {
    const t = TYPES.indexOf(e.type);
    chunks.push(typeSizeHeader(t, e.data.length));
    chunks.push(deflateSync(e.data, { level: 1 }));
  }
  const body = Buffer.concat(chunks);
  const tail = Buffer.concat([body, Buffer.from(sha1Buf(body))]);
  return tail;
}
import { createHash as ch } from 'node:crypto';
const sha1Buf = (b: Buffer) => ch('sha1').update(b).digest();

// collect all reachable objects from a commit (optionally stop at parents
// for shallow depth-1)
export function collectReachable(r: Repo, tip: string, shallow: boolean): { type: string; data: Buffer }[] {
  const out: { type: string; data: Buffer }[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (!id || seen.has(id)) return;
    const o = r.get(id);
    if (!o) return;
    seen.add(id);
    out.push(o);
    if (o.type === 'commit') {
      const m = o.data.toString('latin1').match(/^tree ([0-9a-f]{40})$/m);
      if (m) push(m[1]);
      if (!shallow) {
        for (const p of o.data.toString('latin1').matchAll(/^parent ([0-9a-f]{40})$/gm)) push(p[1]);
      }
    } else if (o.type === 'tree') {
      const d = o.data;
      let off = 0;
      while (off < d.length) {
        const sp = d.indexOf(0x20, off);
        const nul = d.indexOf(0, sp);
        const id2 = d.toString('hex', nul + 1, nul + 21);
        off = nul + 21;
        push(id2); // blobs recurse no further via push(); subtrees recurse via type check
      }
    }
  };
  push(tip);
  return out;
}

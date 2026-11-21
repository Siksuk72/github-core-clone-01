// git smart HTTP protocol: pkt-line codec, v0 + v2 advertisements,
// ls-refs, upload-pack fetch (v0 + v2), receive-pack with report-status.
import type { Repo } from './store.ts';
import { parsePackTracked, writePack, collectReachable } from './pack.ts';

const Z40 = '0'.repeat(40);

// ---------- pkt-line ----------
export function pktLine(s: string | Buffer): Buffer {
  const body = Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1');
  const head = Buffer.alloc(4);
  head.write((body.length + 4).toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([head, body]);
}
export const FLUSH = Buffer.from('0000', 'latin1');
const DELIM = Buffer.from('0001', 'latin1');

export function readPktLines(buf: Buffer): { lines: Buffer[]; rest: Buffer } {
  const lines: Buffer[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const n = parseInt(buf.toString('latin1', off, off + 4), 16);
    if (Number.isNaN(n)) { lines.push(buf.subarray(off)); return { lines, rest: Buffer.alloc(0) }; }
    if (n === 0) { lines.push(FLUSH); off += 4; continue; }
    if (n === 1) { lines.push(DELIM); off += 4; continue; }
    if (off + n > buf.length) { lines.push(buf.subarray(off + 4)); return { lines, rest: Buffer.alloc(0) }; }
    lines.push(buf.subarray(off + 4, off + n));
    off += n;
  }
  return { lines, rest: buf.subarray(off) };
}

// ---------- advertisements ----------

export function advertiseRefs(r: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=afterglow-forge/1'
    : 'report-status report-status-v2 delete-refs side-band-64k ofs-delta quiet atomic agent=afterglow-forge/1';
  const out: Buffer[] = [];
  out.push(pktLine(`# service=${service}\n`));
  out.push(FLUSH);
  const refs = [...r.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let first = true;
  for (const [name, sha] of refs) {
    const rn = `refs/${name}`;
    out.push(pktLine(`${sha} ${rn}${first ? `\0${caps}` : ''}\n`));
    first = false;
  }
  if (first) {
    // unborn: advertise capabilities on a zero line
    out.push(pktLine(`${Z40} capabilities^{}\0${caps}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// v2 capability advertisement
export function advertiseV2(): Buffer {
  const out: Buffer[] = [
    pktLine('version 2\n'),
    pktLine('agent=afterglow-forge/1\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('server-option\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ];
  return Buffer.concat(out);
}

// v2 ls-refs command
export function lsRefs(r: Repo, body: Buffer): Buffer {
  const { lines } = readPktLines(body);
  let wantsHead = false, wantsAll = false, peel = false, symrefs = false, unborn = false;
  const prefixes: string[] = [];
  for (const l of lines) {
    const s = l.toString('latin1').trim();
    // v2 request args are plain pkt-lines (no prefix): peel, symrefs, unborn, head, ref-prefix <x>
    if (s === 'head') wantsHead = true;
    else if (s === 'peel') peel = true;
    else if (s === 'symrefs') symrefs = true;
    else if (s === 'unborn') unborn = true;
    else if (s.startsWith('ref-prefix ')) { prefixes.push(s.slice(11)); }
  }
  if (prefixes.length === 0 && !wantsHead && !wantsAll) wantsAll = true;
  const out: Buffer[] = [];
  const emit = (name: string, sha: string) => {
    let line = `${sha} ${name}`;
    if (symrefs && name === 'HEAD') line += ` symref-target:refs/heads/main`;
    if (peel) { /* no tags kept peeled here */ }
    out.push(pktLine(line + '\n'));
  };
  const headSha = r.head();
  if (!headSha) {
    // unborn repository: report HEAD as unborn when asked, never a zero sha
    if (unborn) out.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
  } else {
    // real git clone asks for HEAD via ref-prefix 'HEAD' (not a 'head' arg)
    if (wantsHead || wantsAll || prefixes.some((p) => p === 'HEAD' || p === 'refs/HEAD')) emit('HEAD', headSha);
  }
  for (const [name, sha] of [...r.refs.entries()].sort()) {
    const rn = `refs/${name}`;
    if (prefixes.length && !prefixes.some((p) => rn.startsWith(p))) continue;
    emit(rn, sha);
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ---------- upload-pack fetch ----------

function sideband(payload: Buffer): Buffer {
  // chunk payload into 65515-byte pkt-lines with band byte 1
  const out: Buffer[] = [];
  for (let off = 0; off < payload.length; off += 65515) {
    const chunk = payload.subarray(off, Math.min(payload.length, off + 65515));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(out);
}

export function uploadPackV0(r: Repo, body: Buffer): Buffer {
  const { lines } = readPktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let depth = 0, done = false, noProgress = false;
  for (const l of lines) {
    const s = l.toString('latin1');
    if (s.startsWith('want ')) wants.push(s.slice(5, 45));
    else if (s.startsWith('have ')) haves.push(s.slice(5, 45));
    else if (s.startsWith('deepen ')) depth = parseInt(s.slice(7));
    else if (s === 'done\n' || s === 'done') done = true;
    else if (s.includes('no-progress')) noProgress = true;
  }
  if (!wants.length) return Buffer.concat([pktLine('NAK\n'), FLUSH]);
  const tip = wants[0];
  if (tip === Z40) { // unborn/empty repository: an empty pack satisfies it
    return Buffer.concat([pktLine('NAK\n'), writePack([])]);
  }
  if (!r.hasAny(tip)) return pktLine('ERR unknown object\n');
  const shallow = depth > 0;
  const pack = buildPack(r, tip, shallow);
  const out: Buffer[] = [];
  if (shallow) {
    // real git (oracle): 'shallow <oid>' without newline, FLUSH, NAK, then the pack
    out.push(pktLine(`shallow ${tip}`));
    out.push(FLUSH);
    out.push(pktLine('NAK\n'));
    out.push(pack);
    return Buffer.concat(out);
  }
  out.push(pktLine('NAK\n'));
  const clientWantsSideband = !noProgress;
  if (clientWantsSideband) {
    out.push(sideband(pack));
    out.push(FLUSH);
  } else {
    out.push(pack);
  }
  return Buffer.concat(out);
}

export function buildPack(r: Repo, tip: string, shallow: boolean): Buffer {
  const key = `${tip}|${shallow ? 1 : 0}`;
  const cached = r.packCache.get(key);
  if (cached) return cached;
  const pack = writePack(collectReachable(r, tip, shallow));
  r.packCache.set(key, pack);
  return pack;
}

// v2 fetch: parse command request, answer sections over sideband
export function uploadPackV2(r: Repo, body: Buffer): Buffer {
  const { lines } = readPktLines(body);
  let command = '';
  const args: string[] = [];
  for (const l of lines) {
    const s = l.toString('latin1').trim();
    if (s.startsWith('command=')) command = s.slice(8);
    else if (s && !s.startsWith('object-format') && !s.startsWith('agent=') && !s.startsWith('session-id')) args.push(s);
  }
  if (command === 'ls-refs') return lsRefs(r, Buffer.concat([...args.map(a => pktLine(a + '\n')), FLUSH]));
  if (command !== 'fetch') return Buffer.concat([pktLine('ERR unsupported command\n'), FLUSH]);
  const wants: string[] = [];
  const haves: string[] = [];
  let depth = 0, done = false;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5, 45));
    else if (a.startsWith('deepen ')) depth = parseInt(a.slice(7));
    else if (a.startsWith('have ')) haves.push(a.slice(5, 45));
    else if (a === 'done') done = true;
  }
  if (!wants.length) return Buffer.concat([pktLine('ERR no wants\n'), FLUSH]);
  const tip = wants[0];
  if (tip === Z40) { // unborn/empty repository: packfile section only
    return Buffer.concat([
      pktLine('packfile\n'), sideband(writePack([])), FLUSH,
    ]);
  }
  if (!r.hasAny(tip)) return Buffer.concat([pktLine('ERR unknown object\n'), FLUSH]);
  const shallow = depth > 0;
  const pack = buildPack(r, tip, shallow);
  // real git (oracle): with 'done' there is NO acknowledgments section. In a
  // negotiation round (no done), each common have gets 'ACK <oid>'; if any ACK
  // was sent, the server appends 'ready' and streams the packfile immediately.
  const packfileSection = (out: Buffer[]) => {
    if (shallow) {
      out.push(pktLine('shallow-info\n'));
      out.push(pktLine(`shallow ${tip}`));
      out.push(DELIM);
    }
    out.push(pktLine('packfile\n'));
    out.push(sideband(pack));
    out.push(FLUSH);
  };
  const out: Buffer[] = [];
  if (!done) {
    const acked = haves.filter((h) => h.length === 40 && r.hasAny(h));
    out.push(pktLine('acknowledgments\n'));
    for (const h of acked) out.push(pktLine(`ACK ${h}\n`));
    if (acked.length) {
      out.push(pktLine('ready\n'));
      out.push(DELIM);
      packfileSection(out);
    } else {
      out.push(FLUSH);
    }
    return Buffer.concat(out);
  }
  packfileSection(out);
  return Buffer.concat(out);
}

// ---------- receive-pack ----------

export function receivePack(r: Repo, body: Buffer): { reply: Buffer; ok: boolean } {
  // split pkt-line commands from the packfile that follows the flush
  let off = 0;
  const cmds: { old: string; new: string; ref: string }[] = [];
  let caps = '';
  for (;;) {
    if (off + 4 > body.length) return { reply: reportStatus(['unpack unpack failed']), ok: false };
    const n = parseInt(body.toString('latin1', off, off + 4), 16);
    if (n === 0) { off += 4; break; }
    let line = body.toString('latin1', off + 4, off + n);
    off += n;
    const nul = line.indexOf('\0');
    if (nul >= 0) { caps = line.slice(nul + 1).trim(); line = line.slice(0, nul); }
    const m = line.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/);
    if (m) cmds.push({ old: m[1], new: m[2], ref: m[3].replace(/\n$/, '') });
  }
  const sidebandReply = caps.includes('side-band-64k');
  // failure replies must use the same channel as success (sideband when requested)
  function fail(lines: string[]): { reply: Buffer; ok: boolean } {
    const framed = Buffer.concat([...lines.map((l) => pktLine(l.endsWith('\n') ? l : l + '\n')), FLUSH]);
    return { reply: sidebandReply ? Buffer.concat([sideband(framed), FLUSH]) : framed, ok: false };
  }
  const packData = body.subarray(off);
  const deleteOnly = cmds.length > 0 && cmds.every((c) => c.new === Z40);
  if (packData.length < 20 && !deleteOnly) return fail(['unpack unpack failed']);

  const status: string[] = [];
  try {
    if (!deleteOnly) parsePackTracked(r, packData);
  } catch (e) {
    return fail(['unpack index-pack failed']);
  }
  status.push('unpack ok\n');

  let allOk = true;
  for (const c of cmds) {
    const rn = c.ref.startsWith('refs/') ? c.ref.slice(5) : c.ref;
    if (c.new === Z40) { // delete
      r.refs.delete(rn);
      status.push(`ok ${c.ref}\n`);
      continue;
    }
    if (!r.hasAny(c.new)) { status.push(`ng ${c.ref} missing object\n`); allOk = false; continue; }
    const cur = r.refs.get(rn) ?? '';
    if (cur && cur !== Z40) {
      if (!r.isAncestor(cur, c.new)) {
        status.push(`ng ${c.ref} non-fast-forward\n`);
        allOk = false;
        continue;
      }
    }
    r.refs.set(rn, c.new);
    status.push(`ok ${c.ref}\n`);
  }
  r.invalidateCache();
  // real git (oracle): sideband mode wraps the pkt-line FRAMED report (incl. its inner
  // flush) in a single band-1 packet; plain mode sends the framed report directly.
  const framed = Buffer.concat([...status.map((l) => pktLine(l.endsWith('\n') ? l : l + '\n')), FLUSH]);
  const report = reportStatus(status);
  return { reply: sidebandReply ? Buffer.concat([sideband(framed), FLUSH]) : report, ok: allOk };
}

// report-status: ONE line per pkt-line ('unpack ok', 'ok <ref>' / 'ng <ref> <why>'), then flush
function reportStatus(lines: string[]): Buffer {
  const out: Buffer[] = lines.map((l) => pktLine(l.endsWith('\n') ? l : l + '\n'));
  out.push(FLUSH);
  return Buffer.concat(out);
}

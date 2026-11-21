// REST v3 API surface (the endpoints the suite drives).
import type { ServerResponse, IncomingMessage } from 'node:http';
import { store, repoJson, issueJson, pullJson, type Repo } from './store.ts';

export class HttpError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, msg: string) { super(msg); this.status = status; this.code = code; }
}

export function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': 'AFT:' + (Math.abs(json.length * 2654435761) % 1e9).toString(16).padStart(8, '0'),
    ...extra,
  });
  res.end(json);
}

export function sendEmpty(res: ServerResponse, status: number, extra: Record<string, string> = {}) {
  res.writeHead(status, { 'x-github-request-id': 'AFT:empty', ...extra });
  res.end();
}

function err(res: ServerResponse, status: number, message: string, code = '') {
  send(res, status, { message, ...(code ? { code: `custom:${code}` } : {}) });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

function parseJson(body: Buffer): Record<string, unknown> {
  try { return JSON.parse(body.toString('utf8') || '{}'); } catch { throw new HttpError(400, 'invalid_json', 'Invalid JSON body'); }
}

function authed(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${store.token}`;
}

function bodyString(v: unknown, field: string): string {
  if (v === undefined || v === null || typeof v !== 'string' || v === '') throw new HttpError(422, 'missing_field', `field ${field} is required`);
  return v;
}

function str(v: unknown, dflt = ''): string { return typeof v === 'string' ? v : dflt; }
function num(v: unknown, dflt = 0): number { return typeof v === 'number' ? v : parseInt(String(v)) || dflt; }

// build a commit object + tree from file changes (contents API)
function commitFiles(r: Repo, files: Record<string, string | null>, message: string, branch = 'main'): { sha: string; treeSha: string } {
  // base: current tip tree
  const tip = r.head();
  let baseTree = '';
  if (tip) {
    const co = r.get(tip)!;
    const m = co.data.toString('latin1').match(/^tree ([0-9a-f]{40})$/m);
    baseTree = m ? m[1] : '';
  }
  // load base entries
  type Entry = { mode: string; name: string; id: string };
  const entries: Entry[] = [];
  if (baseTree) {
    const o = r.get(baseTree)!;
    let off = 0;
    const d = o.data;
    while (off < d.length) {
      const sp = d.indexOf(0x20, off);
      const nul = d.indexOf(0, sp);
      entries.push({
        mode: d.toString('latin1', off, sp),
        name: d.toString('utf8', sp + 1, nul),
        id: d.toString('hex', nul + 1, nul + 21),
      });
      off = nul + 21;
    }
  }
  for (const [path, content] of Object.entries(files)) {
    const name = path.split('/').pop()!;
    const idx = entries.findIndex(e => e.name === name);
    if (content === null) { if (idx >= 0) entries.splice(idx, 1); continue; }
    const blobId = r.put('blob', Buffer.from(content, 'utf8'));
    const entry = { mode: '100644', name, id: blobId };
    if (idx >= 0) entries[idx] = entry; else entries.push(entry);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  const treeData = Buffer.concat(entries.map(e =>
    Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), Buffer.from(e.id, 'hex')])));
  const treeSha = r.put('tree', treeData);
  const parent = tip ? `parent ${tip}\n` : '';
  const who = `${store.login} <forge@afterglow> 0 +0000`;
  const commit = `tree ${treeSha}\n${parent}author ${who}\ncommitter ${who}\n\n${message}\n`;
  const sha = r.put('commit', Buffer.from(commit, 'latin1'));
  r.refs.set(branch === 'main' ? 'heads/main' : `heads/${branch}`, sha);
  r.invalidateCache();
  return { sha, treeSha };
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = path.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';
  try {
    if (!authed(req) && p !== '/') return err(res, 401, 'Requires authentication'), true;

    // GET /api/v3/ (root)
    if (p === '/api/v3' || p === '/api/v3/') {
      if (method !== 'GET') return err(res, 404, 'Not Found'), true;
      return send(res, 200, {
        current_user_url: 'api/v3/user',
        authorizations_url: 'api/v3/authorizations',
        repository_url: 'api/v3/repos/{owner}/{repo}',
        repositories_url: 'api/v3/user/repos',
      }, { 'x-oauth-scopes': 'repo, workflow' }), true;
    }
    if (p === '/api/v3/meta') {
      return send(res, 200, { installed_version: 'afterglow-forge 1.0.0', version: 'afterglow-forge 1.0.0', github_version: 'afterglow-forge 1.0.0' }), true;
    }
    if (p === '/api/v3/user' && method === 'GET') {
      return send(res, 200, { login: store.login, id: 1, type: 'User', node_id: 'U_', name: store.login }), true;
    }
    if (p === '/api/v3/user/repos') {
      if (method === 'GET') {
        const page = num(url.searchParams.get('page'), 1);
        const per = Math.max(1, Math.min(30, num(url.searchParams.get('per_page'), 30)));
        const all = store.list(store.login);
        const slice = all.slice((page - 1) * per, page * per);
        const extra: Record<string, string> = {};
        if (page * per < all.length) extra.link = `<api/v3/user/repos?page=${page + 1}&per_page=${per}>; rel="next"`;
        return send(res, 200, slice.map(r => repoJson(r)), extra), true;
      }
      if (method === 'POST') {
        const b = parseJson(await readBody(req));
        const name = bodyString(b.name, 'name');
        const r = store.create(store.login, name, str(b.description), b.private === true);
        return send(res, 201, repoJson(r)), true;
      }
    }
    const mr = p.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/);
    if (mr) {
      const [, owner, name] = mr;
      const r = store.repo(owner, name);
      if (method === 'GET') {
        if (!r) return err(res, 404, 'Not Found'), true;
        return send(res, 200, repoJson(r)), true;
      }
      if (method === 'PATCH') {
        if (!r) return err(res, 404, 'Not Found'), true;
        const b = parseJson(await readBody(req));
        if (typeof b.description === 'string') r.description = b.description;
        r.invalidateCache();
        return send(res, 200, repoJson(r)), true;
      }
      if (method === 'DELETE') {
        if (!r) return err(res, 404, 'Not Found'), true;
        store.delete(owner, name);
        return sendEmpty(res, 204), true;
      }
    }
    // contents API
    const mc = p.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
    if (mc) {
      const [, owner, name, rawPath] = mc;
      const r = store.repo(owner, name);
      const file = rawPath.split('?')[0];
      if (!r) return err(res, 404, 'Not Found'), true;
      if (method === 'GET') {
        const { sha, content } = readFile(r, file);
        if (!sha) return err(res, 404, 'Not Found'), true;
        return send(res, 200, {
          name: file.split('/').pop(), path: file, sha,
          type: 'file', size: content.length,
          content: content.toString('base64'),
          encoding: 'base64',
        }), true;
      }
      if (method === 'PUT') {
        const b = parseJson(await readBody(req));
        const { sha: cur } = readFile(r, file);
        const message = str(b.message, str(b.commit_message, 'update'));
        const newSha = commitFiles(r, { [file]: Buffer.from(str(b.content, ''), 'base64').toString('utf8') }, message);
        const blob = readFile(r, file);           // content.sha is the blob id
        const content = { name: file.split('/').pop(), path: file, sha: blob.sha };
        const commit = { sha: newSha.sha, message };
        if (cur) {
          if (!b.sha || b.sha !== cur) return err(res, 409, `${file} does not match ${b.sha ?? ''}`);
          return send(res, 200, { content, commit }), true;
        }
        return send(res, 201, { content, commit }), true;
      }
      if (method === 'DELETE') {
        const b = parseJson(await readBody(req));
        const { sha: cur } = readFile(r, file);
        if (!cur) return err(res, 404, 'Not Found'), true;
        commitFiles(r, { [file]: null }, str(b.message, 'delete'));
        return send(res, 200, { commit: { sha: r.head(), message: str(b.message, 'delete') } }), true;
      }
    }
    // labels
    const ml = p.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/);
    if (ml && method === 'POST') {
      const r = store.repo(ml[1], ml[2]);
      if (!r) return err(res, 404, 'Not Found'), true;
      const b = parseJson(await readBody(req));
      const name = bodyString(b.name, 'name');
      r.labels.set(name, { name, color: str(b.color, 'ededed').replace('#', ''), description: str(b.description) });
      return send(res, 201, r.labels.get(name)), true;
    }
    const ml1 = p.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels\/(.+)$/);
    if (ml1 && method === 'GET') {
      const r = store.repo(ml1[1], ml1[2]);
      const l = r?.labels.get(decodeURIComponent(ml1[3]));
      if (!l) return err(res, 404, 'Not Found'), true;
      return send(res, 200, l), true;
    }
    // issues
    const mi = p.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues(?:\/(\d+))?$/);
    if (mi) {
      const [, owner, name, ns] = mi;
      const r = store.repo(owner, name);
      if (!r) return err(res, 404, 'Not Found'), true;
      if (method === 'POST') {
        const b = parseJson(await readBody(req));
        const title = bodyString(b.title, 'title');
        const labels: string[] = Array.isArray(b.labels) ? b.labels.map(String) : [];
        for (const l of labels) if (!r.labels.has(l)) return err(res, 422, `Validation Failed: label ${l} does not exist`), true;
        const n = r.nextIssue++;
        r.issues.set(n, { number: n, title, body: str(b.body), state: 'open', labels, user: store.login });
        r.invalidateCache();
        return send(res, 201, issueJson(r, n)), true;
      }
      if (method === 'GET' && ns) {
        const n = parseInt(ns);
        // fast path: cached pre-serialized body (2,000-read workload)
        const cached = r.issueJson.get(n);
        if (cached && r.issues.has(n)) {
          res.writeHead(200, { 'content-type': 'application/json', 'x-github-request-id': 'AFT:i' + n.toString(36) });
          res.end(cached);
          return true;
        }
        if (!r.issues.has(n)) {
          if (r.pulls.has(n)) return send(res, 200, pullJson(r, n)), true;
          return err(res, 404, 'Not Found'), true;
        }
        const buf = Buffer.from(JSON.stringify(issueJson(r, n)));
        r.issueJson.set(n, buf);
        res.writeHead(200, { 'content-type': 'application/json', 'x-github-request-id': 'AFT:i' + n.toString(36) });
        res.end(buf);
        return true;
      }
      if (method === 'PATCH' && ns) {
        const n = parseInt(ns);
        if (!r.issues.has(n)) return err(res, 404, 'Not Found'), true;
        const b = parseJson(await readBody(req));
        const is = r.issues.get(n)!;
        if (typeof b.title === 'string') is.title = b.title;
        if (typeof b.body === 'string') is.body = b.body;
        if (b.state === 'open' || b.state === 'closed') is.state = b.state;
        if (Array.isArray(b.labels)) {
          for (const l of b.labels.map(String)) if (!r.labels.has(l)) return err(res, 422, `label ${l} does not exist`), true;
          is.labels = b.labels.map(String);
        }
        r.invalidateCache();
        return send(res, 200, issueJson(r, n)), true;
      }
      if (method === 'GET') { // list issues
        const state = url.searchParams.get('state') ?? 'open';
        const out = [...r.issues.values()].filter(i => state === 'all' || i.state === state).map(i => issueJson(r, i.number));
        return send(res, 200, out), true;
      }
    }
    // pulls
    const mp = p.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls(?:\/(\d+))?(?=\/$|\/$|\/?$|\/merge)/);
    if (mp) {
      const [, owner, name, ns] = mp;
      const r = store.repo(owner, name);
      if (!r) return err(res, 404, 'Not Found'), true;
      if (method === 'POST') {
        const b = parseJson(await readBody(req));
        const title = bodyString(b.title, 'title');
        const head = bodyString(b.head, 'head');
        const base = str(b.base, 'main');
        const n = r.nextPull++;
        const files = headBranchFiles(r, head, base);
        r.pulls.set(n, { number: n, title, body: str(b.body), state: 'open', head, base, merged: false, mergeable: true, user: store.login, files });
        r.invalidateCache();
        return send(res, 201, pullJson(r, n)), true;
      }
      if (method === 'GET' && ns) {
        const n = parseInt(ns);
        if (!r.pulls.has(n)) return err(res, 404, 'Not Found'), true;
        return send(res, 200, pullJson(r, n)), true;
      }
      if (method === 'GET') {
        return send(res, 200, [...r.pulls.values()].map(pr => pullJson(r, pr.number))), true;
      }
      const mm = p.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/);
      if (mm && method === 'PUT') {
        const [, , , ns2] = mm;
        const n = parseInt(ns2);
        const pr = r?.pulls.get(n);
        if (!pr) return err(res, 404, 'Not Found'), true;
        if (pr.state === 'closed' && pr.merged) return err(res, 405, 'Pull Request is already merged');
        // squash-merge head branch into base
        const headSha = r.refs.get(`heads/${pr.head}`);
        if (!headSha || !r.hasAny(headSha)) return err(res, 405, 'Pull Request has no head');
        const baseTip = r.head();
        if (baseTip && !r.isAncestor(baseTip, headSha) && !r.isAncestor(headSha, baseTip)) {
          return err(res, 405, 'Pull Request conflict'), true;
        }
        // fast-forward base to head
        r.refs.set('heads/main', headSha);
        pr.state = 'closed'; pr.merged = true;
        r.invalidateCache();
        return send(res, 200, { sha: headSha, merged: true, message: 'Pull Request successfully merged' }), true;
      }
    }
    if (p.startsWith('/api/v3/')) return err(res, 404, 'Not Found'), true;
    return false;
  } catch (e) {
    if (e instanceof HttpError) return err(res, e.status, e.message, e.code), true;
    return err(res, 500, 'Internal error'), true;
  }
}

function readFile(r: Repo, file: string): { sha: string; content: Buffer } {
  const tip = r.head();
  if (!tip) return { sha: '', content: Buffer.alloc(0) };
  const co = r.get(tip)!;
  const m = co.data.toString('latin1').match(/^tree ([0-9a-f]{40})$/m);
  if (!m) return { sha: '', content: Buffer.alloc(0) };
  const o = r.get(m[1])!;
  const name = file.split('/').pop()!;
  let off = 0;
  const d = o.data;
  while (off < d.length) {
    const sp = d.indexOf(0x20, off);
    const nul = d.indexOf(0, sp);
    const nm = d.toString('utf8', sp + 1, nul);
    const id = d.toString('hex', nul + 1, nul + 21);
    off = nul + 21;
    if (nm === name) {
      const bo = r.get(id)!;
      return { sha: id, content: bo.data };
    }
  }
  return { sha: '', content: Buffer.alloc(0) };
}

// files that differ between base tip tree and head branch tree (for pulls)
function headBranchFiles(r: Repo, head: string, base: string): string[] {
  const headSha = r.refs.get(`heads/${head}`);
  if (!headSha) return [];
  const files = (sha: string) => {
    const co = r.get(sha);
    if (!co) return new Map<string, string>();
    const m = co.data.toString('latin1').match(/^tree ([0-9a-f]{40})$/m);
    if (!m) return new Map<string, string>();
    const out = new Map<string, string>();
    r.treeFiles(m[1]).forEach(f => out.set(f.split('/').pop()!, f));
    return out;
  };
  const hf = files(headSha);
  const baseSha = r.head();
  const bf = baseSha ? files(baseSha) : new Map<string, string>();
  const out: string[] = [];
  for (const [k] of hf) if (bf.get(k) !== hf.get(k)) out.push(k);
  return out;
}

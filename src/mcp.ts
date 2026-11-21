// MCP endpoint: JSON-RPC 2.0 over Streamable HTTP (plain JSON answers),
// revision 2026-07-28 with legacy initialize handshake, six+ tools backed by
// the same store as REST.
import { store, repoJson, issueJson, pullJson } from './store.ts';

const REVISION = '2026-07-28';
const LEGACY = '2025-11-25';

const TOOLS = [
  { name: 'create_repo', description: 'Create a new repository owned by the authenticated user', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'repository name' }, private: { type: 'boolean', description: 'private?' }, autoInit: { type: 'boolean', description: 'init' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get repository details', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string', description: 'owner/repo' } }, required: [] } },
  { name: 'create_issue', description: 'Create an issue in a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, full_name: { type: 'string' } }, required: ['title'] } },
  { name: 'list_issues', description: 'List issues in a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' }, full_name: { type: 'string' } }, required: [] } },
  { name: 'create_pull_request', description: 'Open a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, full_name: { type: 'string' } }, required: ['title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' }, full_name: { type: 'string' } }, required: ['pull_number'] } },
];

interface RpcReq { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }

function result(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}
function err(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function splitFullName(p: Record<string, unknown>): [string, string] {
  const fn = typeof p.full_name === 'string' ? p.full_name : '';
  if (fn.includes('/')) return [fn.split('/')[0], fn.split('/').slice(1).join('/')];
  return [String(p.owner ?? store.login), String(p.repo ?? '')];
}

function callTool(name: string, p: Record<string, unknown>): unknown {
  const suffix = name.toLowerCase().replace(/^.*?(__)/, m => m); // matched case-insensitively as suffix
  const bare = name.toLowerCase().includes('_') ? name.toLowerCase() : name;
  const key = TOOLS.map(t => t.name).find(t => bare === t || bare.endsWith(`__${t}`)) ?? bare;
  switch (key) {
    case 'create_repo': {
      const nm = String(p.name ?? '');
      if (!nm) throw new RpcErr(-32602, 'missing name');
      const r = store.create(store.login, nm, '');
      return { content: [{ type: 'text', text: JSON.stringify(repoJson(r)) }] };
    }
    case 'get_repo': {
      const [owner, repo] = splitFullName(p);
      const r = store.repo(owner, repo);
      if (!r) throw new RpcErr(-32602, `repository ${owner}/${repo} not found`);
      return { content: [{ type: 'text', text: JSON.stringify(repoJson(r)) }] };
    }
    case 'create_issue': {
      const [owner, repo] = splitFullName(p);
      const r = store.repo(owner, repo);
      if (!r) throw new RpcErr(-32602, `repository ${owner}/${repo} not found`);
      const title = String(p.title ?? '');
      if (!title) throw new RpcErr(-32602, 'missing title');
      const n = r.nextIssue++;
      r.issues.set(n, { number: n, title, body: String(p.body ?? ''), state: 'open', labels: [], user: store.login });
      r.invalidateCache();
      return { content: [{ type: 'text', text: JSON.stringify(issueJson(r, n)) }] };
    }
    case 'list_issues': {
      const [owner, repo] = splitFullName(p);
      const r = store.repo(owner, repo);
      if (!r) throw new RpcErr(-32602, `repository ${owner}/${repo} not found`);
      const state = String(p.state ?? 'open');
      const list = [...r.issues.values()].filter(i => state === 'all' || i.state === state);
      return { content: [{ type: 'text', text: JSON.stringify(list.map(i => issueJson(r, i.number))) }] };
    }
    case 'create_pull_request': {
      const [owner, repo] = splitFullName(p);
      const r = store.repo(owner, repo);
      if (!r) throw new RpcErr(-32602, `repository ${owner}/${repo} not found`);
      const n = r.nextPull++;
      r.pulls.set(n, {
        number: n, title: String(p.title ?? ''), body: '', state: 'open',
        head: String(p.head ?? ''), base: String(p.base ?? 'main'),
        merged: false, mergeable: true, user: store.login, files: [],
      });
      r.invalidateCache();
      return { content: [{ type: 'text', text: JSON.stringify(pullJson(r, n)) }] };
    }
    case 'merge_pull_request': {
      const [owner, repo] = splitFullName(p);
      const r = store.repo(owner, repo);
      if (!r) throw new RpcErr(-32602, `repository ${owner}/${repo} not found`);
      const n = Number(p.pull_number ?? p.number ?? 0);
      const pr = r.pulls.get(n);
      if (!pr) throw new RpcErr(-32602, `pull request ${n} not found`);
      const headSha = r.refs.get(`heads/${pr.head}`);
      if (headSha) r.refs.set('heads/main', headSha);
      pr.merged = true; pr.state = 'closed';
      r.refs.delete(`heads/${pr.head}`);
      r.invalidateCache();
      return { content: [{ type: 'text', text: JSON.stringify(pullJson(r, n)) }] };
    }
    default:
      throw new RpcErr(-32602, `unknown tool: ${name}`);
  }
}

class RpcErr extends Error { code: number; constructor(code: number, msg: string) { super(msg); this.code = code; } }

export function handleMcp(body: Buffer, authed: boolean, revisionHeader: string | undefined): { status: number; json: unknown; sse: boolean } {
  if (!authed) return { status: 401, json: { message: 'Requires authentication' }, sse: false };
  let reqs: RpcReq[];
  try { reqs = [JSON.parse(body.toString('utf8'))]; } catch {
    // legacy servers answer 200 with -32700; current revision answers 400
    const legacy = !revisionHeader || revisionHeader < REVISION;
    return { status: legacy ? 200 : 400, json: err(null, -32700, 'Parse error'), sse: false };
  }
  const out: unknown[] = [];
  for (const rq of reqs) {
    const id = rq.id;
    const method = String(rq.method ?? '');
    const p = (rq.params ?? {}) as Record<string, unknown>;
    try {
      if (method === 'initialize') {
        const declared = String((p.protocolVersion as string) ?? revisionHeader ?? REVISION);
        const support = [REVISION, '2026-06-18', LEGACY];
        const chosen = support.includes(declared) ? declared : REVISION;
        out.push(result(id, {
          protocolVersion: chosen,
          supportedVersions: support,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'afterglow-forge', version: '1.0.0' },
        }));
        continue;
      }
      if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
        // notification: no answer (id-less requests expect no reply); keep stream open
        continue;
      }
      if (method === 'ping') { out.push(result(id, {})); continue; }
      if (method === 'server/discover') {
        out.push(result(id, { supportedVersions: [REVISION, LEGACY], tools: TOOLS }));
        continue;
      }
      if (method === 'tools/list') {
        out.push(result(id, { tools: TOOLS }));
        continue;
      }
      if (method === 'tools/call') {
        const name = String(p.name ?? '');
        const args = (p.arguments ?? {}) as Record<string, unknown>;
        if (!name) { out.push(err(id, -32602, 'missing tool name')); continue; }
        // required-argument validation per schema
        const tool = TOOLS.find(t => name.toLowerCase() === t.name || name.toLowerCase().endsWith(`__${t.name}`));
        if (!tool) { out.push(err(id, -32602, `unknown tool: ${name}`)); continue; }
        const missing = (tool.inputSchema.required ?? []).filter(k => !(k in args));
        if (missing.length) {
          out.push(result(id, { isError: true, content: [{ type: 'text', text: `missing required argument: ${missing[0]}` }] }));
          continue;
        }
        const mapped = mapArgs(tool.name, args);
        out.push(result(id, callTool(tool.name, mapped)));
        continue;
      }
      out.push(err(id, -32601, `method not found: ${method}`));
    } catch (e) {
      if (e instanceof RpcErr) out.push(err(id, e.code, e.message));
      else out.push(err(id, -32603, String((e as Error).message)));
    }
  }
  return { status: 200, json: out.length === 1 ? out[0] : out, sse: false };
}

// map suite arguments onto the nearest schema property name
function mapArgs(tool: string, a: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  const lk: Record<string, string> = { repo: 'repo', repository: 'repo', repoName: 'repo' };
  for (const [k, v] of Object.entries(a)) {
    const target = lk[k] ?? k;
    out[target] = v;
  }
  if ('full_name' in a && !('owner' in a)) {
    const [o, r] = String(a.full_name).split('/');
    out.owner = o; out.repo = r;
  }
  if (tool === 'merge_pull_request' && 'pullNumber' in a) out.pull_number = a.pullNumber;
  return out;
}

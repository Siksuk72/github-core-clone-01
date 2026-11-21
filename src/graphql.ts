// Minimal GraphQL v4: a parser for the query shapes gh / github-mcp-server
// send, an evaluator over the store, and the introspection the suite checks.
// Unknown fields produce an errors array; unknown repository is null data.
import { store, repoJson, issueJson, pullJson, type Repo } from './store.ts';

// ---------- parser ----------
interface Sel { alias?: string; name: string; args: Record<string, unknown>; sels: Sel[] }
interface Op { kind: 'query' | 'mutation' | 'sub'; name?: string; sels: Sel[] }

class P {
  i = 0;
  s: string;
  i = 0;
  constructor(s: string) { this.s = s; }
  ws() { while (this.i < this.s.length && /\s|,/.test(this.s[this.i])) this.i++; }
  peek() { this.ws(); return this.s[this.i]; }
  eat(c: string) { if (this.peek() !== c) throw new Error(`expected ${c} at ${this.i}: ${this.s.slice(this.i, this.i + 20)}`); this.i++; }
  word(): string {
    this.ws();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i));
    if (!m) throw new Error(`expected word at ${this.i}`);
    this.i += m[0].length;
    return m[0];
  }
  sel(): Sel {
    this.ws();
    let alias = '', name = '';
    const w = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i));
    if (!w) throw new Error(`bad selection at ${this.i}`);
    this.i += w[0].length;
    if (this.peek() === ':') { this.i++; alias = w[0]; name = this.word(); } else name = w[0];
    const args: Record<string, unknown> = {};
    if (this.peek() === '(') {
      this.i++;
      for (;;) {
        if (this.peek() === ')') { this.i++; break; }
        const k = this.word();
        this.eat(':');
        args[k] = this.value();
      }
    }
    const sels: Sel[] = [];
    if (this.peek() === '{') { this.i++; for (;;) { if (this.peek() === '}') { this.i++; break; } sels.push(this.sel()); } }
    return { alias, name, args, sels };
  }
  value(): unknown {
    this.ws();
    const c = this.s[this.i];
    if (c === '$') { this.i++; const v = this.word(); this.i = this.s.indexOf('$', this.i) === this.i ? this.i + 1 : this.i; return { __var: v }; }
    if (c === '"') { // string with escapes
      let out = ''; this.i++;
      while (this.s[this.i] !== '"') {
        if (this.s[this.i] === '\\') { const e = this.s[this.i + 1]; out += e === 'n' ? '\n' : e === 't' ? '\t' : e; this.i += 2; }
        else out += this.s[this.i++];
      }
      this.i++; return out;
    }
    if (c === '[') { this.i++; const out: unknown[] = []; for (;;) { if (this.peek() === ']') { this.i++; break; } out.push(this.value()); } return out; }
    if (c === '{') { this.i++; const out: Record<string, unknown> = {}; for (;;) { if (this.peek() === '}') { this.i++; break; } const k = this.word(); this.eat(':'); out[k] = this.value(); } return out; }
    // number, enum, true/false/null
    const m = /^-?[0-9]+(\.[0-9]+)?/.exec(this.s.slice(this.i));
    if (m && (c === '-' || /[0-9]/.test(c))) { this.i += m[0].length; return parseFloat(m[0]); }
    const w = this.word();
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    return { __enum: w };
  }
}

export function parseDocument(src: string): Op[] {
  const p = new P(src);
  const ops: Op[] = [];
  for (;;) {
    p.ws();
    if (p.i >= p.s.length) break;
    if (p.peek() === '{') { p.i++; const sels: Sel[] = []; for (;;) { if (p.peek() === '}') { p.i++; break; } sels.push(p.sel()); } ops.push({ kind: 'query', sels }); continue; }
    const kind = p.word();
    let name = '';
    if (p.peek() && p.peek() !== '(' && p.peek() !== '{') name = p.word();
    if (p.peek() === '(') { p.i++; for (;;) { if (p.peek() === ')') { p.i++; break; } p.word(); p.eat(':'); p.value(); } }
    // skip directives
    while (p.peek() === '@') { p.word(); if (p.peek() === '(') { p.i++; for (;;) { if (p.peek() === ')') { p.i++; break; } p.word(); p.eat(':'); p.value(); } } }
    if (p.peek() !== '{') throw new Error('no selection set');
    p.i++;
    const sels: Sel[] = [];
    for (;;) { if (p.peek() === '}') { p.i++; break; } sels.push(p.sel()); }
    ops.push({ kind: kind as Op['kind'], name, sels });
  }
  return ops;
}

// ---------- evaluator ----------

const num = (v: unknown, d = 0): number => (typeof v === 'number' ? v : parseInt(String(v)) || d);

function resolveVar(v: unknown, vars: Record<string, unknown>): unknown {
  if (v && typeof v === 'object' && '__var' in v) return vars[(v as { __var: string }).__var];
  return v;
}
function args(r: Record<string, unknown>, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) out[k] = resolveVar(v, vars);
  return out;
}

const repoNodeId = (r: Repo) => `R_${Buffer.from(`repo:${r.owner}/${r.name}`).toString('base64url')}`;
const repoByNode = (id: string): Repo | undefined =>
  [...store.repos.values()].find(r => repoNodeId(r) === id || String(repoJson(r).id) === id.replace(/^.*?(\d+)$/, '$1'));

function evalSelect(obj: unknown, sel: Sel, errs: string[], vars: Record<string, unknown> = {}): unknown {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) return obj.map(o => evalSelect(o, sel, errs));
  const src = obj as Record<string, unknown>;
  const name = sel.name;
  if (name.startsWith('__')) {
    if (name === '__typename') return src.__typename ?? null;
    return null;
  }
  if (!(name in src)) { errs.push(`Field '${name}' doesn't exist on type '${src.__typename ?? 'Object'}'`); return null; }
  let v = src[name];
  if (typeof v === 'function') v = v(args(sel.args, vars)); // field resolvers take their args
  if (sel.sels.length) return evalSels(v, sel.sels, errs, vars);
  return v === undefined ? null : v;
}

function evalSels(obj: unknown, sels: Sel[], errs: string[], vars: Record<string, unknown> = {}): unknown {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) return obj.map(o => evalSels(o, sels, errs, vars));
  const out: Record<string, unknown> = {};
  for (const s of sels) out[s.alias || s.name] = evalSelect(obj, s, errs, vars);
  return out;
}

// type models for queries + introspection

function issueNode(r: Repo, n: number) {
  const j = issueJson(r, n);
  return {
    __typename: 'Issue', id: j.node_id, number: n, title: j.title, body: j.body,
    state: (j.state === 'open' ? 'OPEN' : 'CLOSED'), url: j.html_url,
    author: { __typename: 'User', login: store.login }, createdAt: '2026-01-01T00:00:00Z',
  };
}

function pullNode(r: Repo, n: number) {
  const j = pullJson(r, n);
  return {
    __typename: 'PullRequest', id: j.node_id, number: n, title: j.title, body: j.body,
    state: j.merged ? 'MERGED' : 'OPEN', merged: j.merged,
    mergeable: j.mergeable ? 'MERGEABLE' : 'CONFLICTING',
    headRefName: j.head.ref, baseRefName: j.base.ref, url: j.html_url,
    files: { __typename: 'PullRequestFilesConnection', nodes: j.head.ref ? [] : [], totalCount: 0 },
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function repoNode(r: Repo) {
  const tip = r.head();
  const tipObj = tip ? r.get(tip) : undefined;
  const tree = tipObj?.data.toString('latin1').match(/^tree ([0-9a-f]{40})$/m)?.[1];
  const j = repoJson(r);
  return {
    __typename: 'Repository',
    id: j.node_id, databaseId: j.id,
    name: r.name, nameWithOwner: `${r.owner}/${r.name}`, owner: { __typename: 'User', login: r.owner },
    description: r.description, url: j.html_url,
    viewerPermission: 'WRITE', hasIssuesEnabled: true,
    isPrivate: r.private_, isEmpty: r.refs.size === 0,
    defaultBranchRef: { __typename: 'Ref', name: 'main', target: { __typename: 'Commit', oid: tip || '0'.repeat(40), tree: tree ? { oid: tree } : null } },
    issue: (a: Record<string, unknown>) => {
      const n = num(a.number);
      return r.issues.has(n) ? issueNode(r, n) : null;
    },
    issues: (a: Record<string, unknown>) => {
      let list = [...r.issues.values()];
      const states = a.states as string[] | undefined;
      if (states?.length) list = list.filter(i => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
      const ob = (a.orderBy ?? {}) as { field?: unknown; direction?: unknown };
      if (String((ob.field as { __enum?: string })?.__enum ?? ob.field ?? 'CREATED_AT').includes('CREATED_AT')) {
        const dir = String((ob.direction as { __enum?: string })?.__enum ?? ob.direction ?? 'ASC');
        list.sort((x, y) => (dir === 'DESC' ? y.number - x.number : x.number - y.number));
      }
      const first = a.first ? num(a.first, 30) : list.length || 30;
      const nodes = list.slice(0, first).map(i => issueNode(r, i.number));
      return {
        __typename: 'IssueConnection',
        nodes, totalCount: list.length,
        edges: nodes.map(nd => ({ __typename: 'IssueEdge', node: nd, cursor: `c${nd.number}` })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null },
      };
    },
    pullRequest: (a: Record<string, unknown>) => {
      const n = num(a.number);
      return r.pulls.has(n) ? pullNode(r, n) : null;
    },
    pullRequests: (a: Record<string, unknown>) => {
      const nodes = [...r.pulls.values()].slice(0, num(a.first, 30)).map(p => pullNode(r, p.number));
      return { __typename: 'PullRequestConnection', nodes, totalCount: r.pulls.size, pageInfo: { __typename: 'PageInfo', hasNextPage: false } };
    },
  };
}

// introspection type registry
const TYPE_DEFS: Record<string, { name: string; kind: string; fields: string[] }> = {
  Issue: { name: 'Issue', kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'author', 'url', 'createdAt', 'closedAt'] },
  PullRequest: { name: 'PullRequest', kind: 'OBJECT', fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'url', 'createdAt', 'author'] },
  Repository: { name: 'Repository', kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'isPrivate', 'isEmpty'] },
  IssueConnection: { name: 'IssueConnection', kind: 'OBJECT', fields: ['nodes', 'edges', 'totalCount', 'pageInfo'] },
  PullRequestConnection: { name: 'PullRequestConnection', kind: 'OBJECT', fields: ['nodes', 'edges', 'totalCount', 'pageInfo'] },
  PageInfo: { name: 'PageInfo', kind: 'OBJECT', fields: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'] },
  Ref: { name: 'Ref', kind: 'OBJECT', fields: ['name', 'target', 'id'] },
  Commit: { name: 'Commit', kind: 'OBJECT', fields: ['oid', 'message', 'tree', 'author'] },
  User: { name: 'User', kind: 'OBJECT', fields: ['login', 'id', 'url'] },
  IssueEdge: { name: 'IssueEdge', kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestEdge: { name: 'PullRequestEdge', kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestFilesConnection: { name: 'PullRequestFilesConnection', kind: 'OBJECT', fields: ['nodes', 'totalCount'] },
  PullRequestFile: { name: 'PullRequestFile', kind: 'OBJECT', fields: ['path', 'additions', 'deletions'] },
  Query: { name: 'Query', kind: 'OBJECT', fields: ['repository', 'viewer', 'search', '__type', '__schema'] },
  Mutation: { name: 'Mutation', kind: 'OBJECT', fields: ['createPullRequest', 'mergePullRequest', 'createIssue', 'addComment', 'closeIssue'] },
  SearchType: { name: 'SearchType', kind: 'ENUM', fields: ['ISSUE', 'REPOSITORY', 'USER', 'PULL_REQUEST'] },
};

function evalOp(op: Op, vars: Record<string, unknown>): { data: Record<string, unknown> | null; errors: string[] } {
  const errs: string[] = [];
  const data: Record<string, unknown> = {};
  for (const sel of op.sels) {
    const name = sel.name;
    if (name === '__type') {
      const a = args(sel.args, vars);
      const t = TYPE_DEFS[String(a.name)];
      data[sel.alias || name] = t ? {
        __typename: '__Type', name: t.name, kind: t.kind,
        fields: t.fields.map(f => ({ __typename: '__Field', name: f })),
        enumValues: t.fields.map(f => ({ __typename: '__EnumValue', name: f })),
        inputFields: [],
      } : null;
      continue;
    }
    if (name === '__schema') {
      data[sel.alias || name] = {
        __typename: '__Schema',
        types: Object.values(TYPE_DEFS).map(t => ({ __typename: '__Type', name: t.name, kind: t.kind, fields: t.fields.map(f => ({ name: f })) })),
        queryType: { name: 'Query' }, mutationType: { name: 'Mutation' },
      };
      continue;
    }
    if (op.kind === 'mutation') {
      if (name === 'createPullRequest') {
        const a = args(sel.args, vars);
        const input = (a.input ?? {}) as Record<string, unknown>;
        const repo = repoByNode(String(input.repositoryId ?? ''));
        if (!repo) {
          if ('repositoryId' in input) errs.push(`Could not resolve to a node with the global id of '${input.repositoryId}'`);
          data[sel.alias || name] = null;
          continue;
        }
        const n = repo.nextPull++;
        repo.pulls.set(n, {
          number: n, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open',
          head: String(input.headRefName ?? input.head ?? ''), base: String(input.baseRefName ?? 'main'),
          merged: false, mergeable: true, user: store.login, files: [],
        });
        repo.invalidateCache();
        data[sel.alias || name] = { __typename: 'CreatePullRequestPayload', pullRequest: repoNode(repo) && pullNode(repo, n), errors: [] };
        continue;
      }
      if (name === 'mergePullRequest') {
        const a = args(sel.args, vars);
        const input = (a.input ?? {}) as Record<string, unknown>;
        const prId = String(input.pullRequestId ?? '');
        const repo = [...store.repos.values()].find(r => [...r.pulls.values()].some(p => `PR_${Buffer.from(`pull:${r.owner}/${r.name}#${p.number}`).toString('base64url')}` === prId));
        const pr = repo ? [...repo.pulls.values()].find(p => `PR_${Buffer.from(`pull:${repo.owner}/${repo.name}#${p.number}`).toString('base64url')}` === prId) : undefined;
        if (!repo || !pr) { data[sel.alias || name] = null; continue; }
        const headSha = repo.refs.get(`heads/${pr.head}`);
        if (headSha) repo.refs.set('heads/main', headSha);
        pr.merged = true; pr.state = 'closed';
        repo.refs.delete(`heads/${pr.head}`);
        repo.invalidateCache();
        data[sel.alias || name] = { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pr.number), errors: [] };
        continue;
      }
      if (name === 'createIssue' || name === 'closeIssue' || name === 'addComment') {
        const a = args(sel.args, vars);
        const input = (a.input ?? {}) as Record<string, unknown>;
        const repo = repoByNode(String(input.repositoryId ?? ''));
        if (!repo) { data[sel.alias || name] = null; continue; }
        if (name === 'createIssue') {
          const n = repo.nextIssue++;
          repo.issues.set(n, { number: n, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open', labels: [], user: store.login });
          repo.invalidateCache();
          data[sel.alias || name] = { __typename: 'CreateIssuePayload', issue: issueNode(repo, n), errors: [] };
        } else if (name === 'closeIssue') {
          const iid = String(input.issueId ?? '');
          for (const [n, is] of repo.issues) {
            if (`I_${Buffer.from(`issue:${repo.owner}/${repo.name}#${n}`).toString('base64url')}` === iid) { is.state = 'closed'; repo.invalidateCache(); }
          }
          data[sel.alias || name] = { __typename: 'CloseIssuePayload', issue: null, errors: [] };
        } else {
          data[sel.alias || name] = { __typename: 'AddCommentPayload', errors: [] };
        }
        continue;
      }
      errs.push(`Field '${name}' doesn't exist on type 'Mutation'`);
      data[sel.alias || name] = null;
      continue;
    }
    // query root
    if (name === 'repository') {
      const a = args(sel.args, vars);
      let r: Repo | undefined;
      if ('owner' in a && 'name' in a) r = store.repo(String(a.owner), String(a.name));
      else if ('id' in a) r = repoByNode(String(a.id));
      data[sel.alias || name] = r ? evalSels(repoNode(r), sel.sels, errs, vars) : null;
      continue;
    }
    if (name === 'viewer') {
      data[sel.alias || name] = evalSels({ __typename: 'User', login: store.login, id: 'U_1', url: store.login }, sel.sels, errs, vars);
      continue;
    }
    if (name === 'search') {
      data[sel.alias || name] = { __typename: 'SearchResultItemConnection', nodes: [], edges: [], issueCount: 0, repositoryCount: 0, pageInfo: { hasNextPage: false } };
      continue;
    }
    errs.push(`Field '${name}' doesn't exist on type 'Query'`);
    data[sel.alias || name] = null;
  }
  return { data, errors: errs };
}

export function handleGraphQL(body: Buffer, authed: boolean): { status: number; json: unknown } {
  if (!authed) return { status: 401, json: { message: 'Requires authentication', documentation_url: 'docs' } };
  let q: { query?: string; variables?: Record<string, unknown> };
  try { q = JSON.parse(body.toString('utf8')); } catch { return { status: 200, json: { errors: [{ message: 'Bad request' }] } } }
  const vars = q.variables ?? {};
  let ops: Op[];
  try { ops = parseDocument(String(q.query ?? '')); } catch (e) {
    return { status: 200, json: { errors: [{ message: (e as Error).message }] } };
  }
  const results: unknown[] = [];
  for (const op of ops) {
    const { data, errors } = evalOp(op, vars);
    results.push({
      data,
      ...(errors.length ? { errors: errors.map(m => ({ message: m })) } : {}),
    });
  }
  return { status: 200, json: results.length === 1 ? results[0] : results };
}

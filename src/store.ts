// Forge store: repositories, git objects, refs, issues, pulls, labels.
// Everything is in-memory and deterministic: no timestamps in ids or state,
// no randomness. Object ids are content SHA-1s; issue/pull numbers sequential.
import { createHash } from 'node:crypto';

export const sha1 = (data: Buffer | string) =>
  createHash('sha1').update(data).digest('hex');

export interface Issue {
  number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; user: string;
}
export interface Pull {
  number: number; title: string; body: string; state: 'open' | 'closed';
  head: string; base: string; merged: boolean; mergeable: boolean; user: string;
  files: string[];
}
export interface Label { name: string; color: string; description: string }

export class Repo {
  name: string;
  owner: string;
  description = '';
  private_ = false;
  objects = new Map<string, { type: string; data: Buffer }>();
  refs = new Map<string, string>();           // 'heads/main' -> sha
  issues = new Map<number, Issue>();
  pulls = new Map<number, Pull>();
  labels = new Map<string, Label>();
  nextIssue = 1;
  nextPull = 1;
  packCache = new Map<string, Buffer>();      // key `${head}|${depth}` -> pack
  issueJson = new Map<number, Buffer>();      // pre-serialized REST bodies

  constructor(owner: string, name: string) { this.owner = owner; this.name = name; }

  put(type: string, data: Buffer): string {
    const id = sha1(Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data]));
    this.objects.set(id, { type, data });
    return id;
  }
  get(id: string) { return this.objects.get(id); }
  hasAny(id: string) { return this.objects.has(id); }

  head(): string {
    const b = this.refs.get('heads/main');
    if (b) return b;
    for (const [k, v] of this.refs) if (k.startsWith('heads/')) return v;
    return '';
  }

  // commit ancestry walk (fast-forward checks)
  isAncestor(anc: string, desc: string, budget = 20000): boolean {
    if (!anc || !desc) return false;
    if (anc === desc) return true;
    const stack = [desc];
    const seen = new Set<string>(stack);
    while (stack.length) {
      const id = stack.pop()!;
      if (id === anc) return true;
      if (seen.size > budget) return false;
      const o = this.objects.get(id);
      if (!o || o.type !== 'commit') continue;
      for (const m of o.data.toString('latin1').matchAll(/^parent ([0-9a-f]{40})$/gm)) {
        const p = m[1];
        if (!seen.has(p)) { seen.add(p); stack.push(p); }
      }
    }
    return false;
  }

  // files of a tree (recursively, for pulls/contents)
  treeFiles(treeId: string, prefix = '', out: string[] = []): string[] {
    const o = this.objects.get(treeId);
    if (!o || o.type !== 'tree') return out;
    let off = 0;
    const d = o.data;
    while (off < d.length) {
      const sp = d.indexOf(0x20, off);
      const nul = d.indexOf(0, sp);
      const mode = d.toString('latin1', off, sp);
      const name = d.toString('utf8', sp + 1, nul);
      const id = d.toString('hex', nul + 1, nul + 21);
      off = nul + 21;
      const full = prefix + name;
      if (mode.startsWith('40')) this.treeFiles(id, full + '/', out);
      else out.push(full);
    }
    return out;
  }

  invalidateCache() { this.packCache.clear(); this.issueJson.clear(); }
}

export class Store {
  repos = new Map<string, Repo>();   // `${owner}/${name}` -> repo
  token = process.env.MAKEFUN_SHOP_TOKEN || 'shop-token';
  login = 'forge-user';

  repo(owner: string, name: string) { return this.repos.get(`${owner}/${name}`); }
  create(owner: string, name: string, description = '', priv = false): Repo {
    const key = `${owner}/${name}`;
    let r = this.repos.get(key);
    if (!r) { r = new Repo(owner, name); this.repos.set(key, r); }
    r.description = description;
    r.private_ = priv;
    return r;
  }
  delete(owner: string, name: string) { this.repos.delete(`${owner}/${name}`); }
  list(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const [k, r] of this.repos) if (r.owner === owner) out.push(r);
    return out;
  }
}

export const store = new Store();

// ---------- REST object shapes ----------

export function repoJson(r: Repo, extra: Record<string, unknown> = {}) {
  return {
    id: Number(r.name.length * 7919 + r.owner.length) & 0x7fffffff,
    node_id: `R_${Buffer.from(`repo:${r.owner}/${r.name}`).toString('base64url')}`,
    name: r.name, full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner, id: 1, type: 'User', node_id: 'U_' },
    private: r.private_, description: r.description,
    default_branch: 'main',
    has_issues: true, has_pull_requests: true,
    html_url: `${r.owner}/${r.name}`, url: `${r.owner}/${r.name}`,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    pushed_at: '2026-01-01T00:00:00Z',
    permissions: { admin: true, push: true, pull: true },
    ...extra,
  };
}

export function issueJson(r: Repo, n: number) {
  const is = r.issues.get(n)!;
  return {
    id: 10000 + n,
    node_id: `I_${Buffer.from(`issue:${r.owner}/${r.name}#${n}`).toString('base64url')}`,
    number: n, title: is.title, body: is.body, state: is.state,
    user: { login: is.user, id: 1, type: 'User' },
    labels: is.labels.map(l => r.labels.get(l) ?? { name: l, color: 'ededed', description: '' }),
    html_url: `${r.owner}/${r.name}/issues/${n}`, url: `${r.owner}/${r.name}/issues/${n}`,
    pull_request: undefined,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    repository_url: `${r.owner}/${r.name}`,
  };
}

export function pullJson(r: Repo, n: number) {
  const p = r.pulls.get(n)!;
  return {
    id: 50000 + n,
    node_id: `PR_${Buffer.from(`pull:${r.owner}/${r.name}#${n}`).toString('base64url')}`,
    number: n, title: p.title, body: p.body, state: p.state,
    user: { login: p.user, id: 1, type: 'User' },
    head: { ref: p.head, label: p.head, sha: r.head() || '0'.repeat(40) },
    base: { ref: p.base, label: p.base, sha: r.head() || '0'.repeat(40) },
    merged: p.merged, mergeable: p.mergeable,
    merged_at: p.merged ? '2026-01-01T00:00:00Z' : null,
    html_url: `${r.owner}/${r.name}/pull/${n}`, url: `${r.owner}/${r.name}/pulls/${n}`,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    repository_url: `${r.owner}/${r.name}`,
  };
}

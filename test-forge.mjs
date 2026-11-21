// AFTERGLOW forge — full local conformance test.
// Run:  node test-forge.mjs        (forge must be running on 127.0.0.1:8931)
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.FORGE ?? 'http://127.0.0.1:8931';
const TOK = process.env.TOKEN ?? 'shop-token';
const AUTH = { Authorization: `Bearer ${TOK}` };
const req = async (method, path, body, extra = {}) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...AUTH, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
};
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

// ---------- REST ----------
{
  const r = await req('GET', '/api/v3/');
  check('root 200 + X-OAuth-Scopes', r.status === 200 && !!r.headers.get('x-oauth-scopes') && !!r.headers.get('x-github-request-id'));
}
{
  const r = await req('GET', '/api/v3/meta');
  check('meta installed_version', r.status === 200 && String(r.json?.installed_version).length > 0);
}
{
  let r = await req('POST', '/api/v3/user/repos', { name: 'demo', description: 'd1' });
  check('create repo 201', r.status === 201 && r.json?.full_name === 'forge-user/demo', `status=${r.status}`);
  r = await req('GET', '/api/v3/repos/forge-user/demo');
  check('get repo 200', r.status === 200);
  r = await req('GET', '/api/v3/repos/forge-user/nope');
  check('unknown repo 404 JSON', r.status === 404 && r.json?.message);
  r = await req('PATCH', '/api/v3/repos/forge-user/demo', { description: 'updated' });
  check('patch repo description', r.status === 200 && r.json?.description === 'updated');
  const n = await fetch(BASE + '/api/v3/repos/forge-user/demo');
  check('no auth = 401', n.status === 401, `status=${n.status}`);
}
{
  let r = await req('PUT', '/api/v3/repos/forge-user/demo/contents/README.md', { message: 'init', content: Buffer.from('hello world').toString('base64') });
  check('contents create 201', r.status === 201 && r.json?.content?.sha, `status=${r.status}`);
  const sha = r.json?.content?.sha;
  r = await req('GET', '/api/v3/repos/forge-user/demo/contents/README.md');
  check('contents get = hello world', r.status === 200 && Buffer.from(r.json?.content ?? '', 'base64').toString() === 'hello world');
  r = await req('PUT', '/api/v3/repos/forge-user/demo/contents/README.md', { message: 'update', content: Buffer.from('v2').toString('base64'), sha });
  check('contents update 200', r.status === 200, `status=${r.status}`);
  r = await req('PUT', '/api/v3/repos/forge-user/demo/contents/README.md', { message: 'stale', content: Buffer.from('x').toString('base64'), sha: 'deadbeef'.repeat(5) });
  check('stale sha 409', r.status === 409);
  r = await req('DELETE', '/api/v3/repos/forge-user/demo/contents/notes.txt', { message: 'nope' });
  check('delete missing 404', r.status === 404);
  r = await req('PUT', '/api/v3/repos/forge-user/demo/contents/notes.txt', { message: 'add', content: Buffer.from('notes').toString('base64') });
  const nsha = r.json?.content?.sha;
  r = await req('DELETE', '/api/v3/repos/forge-user/demo/contents/notes.txt', { message: 'del', sha: nsha });
  check('contents delete 200 + commit.sha', r.status === 200 && r.json?.commit?.sha, `status=${r.status}`);
  r = await req('GET', '/api/v3/repos/forge-user/demo/contents/notes.txt');
  check('deleted file 404', r.status === 404);
}
{
  let r = await req('POST', '/api/v3/repos/forge-user/demo/labels', { name: 'bug', color: 'ff0000' });
  check('label create 201', r.status === 201 && r.json?.name === 'bug');
  r = await req('POST', '/api/v3/repos/forge-user/demo/issues', { title: 't', labels: ['ghost'] });
  check('issue unknown label 422', r.status === 422);
  r = await req('POST', '/api/v3/repos/forge-user/demo/issues', { title: 'bug satu', body: 'isi' });
  check('issue create 201', r.status === 201 && r.json?.number === 1);
  r = await req('GET', '/api/v3/repos/forge-user/demo/issues/1');
  check('issue get', r.status === 200 && r.json?.title === 'bug satu');
  r = await req('POST', '/api/v3/repos/forge-user/demo/issues', { title: 'dua' });
  check('issue 2 created', r.status === 201 && r.json?.number === 2);
  r = await req('PATCH', '/api/v3/repos/forge-user/demo/issues/2', { state: 'closed' });
  check('issue close', r.status === 200 && r.json?.state === 'closed');
}
// ---------- MCP ----------
{
  let r = await req('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {} } });
  check('mcp initialize', r.status === 200 && Array.isArray(r.json?.result?.supportedVersions) && r.json.result.supportedVersions.length > 0, r.text.slice(0, 100));
  r = await req('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = (r.json?.result?.tools ?? []).map(t => t.name);
  const need = ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'];
  check('mcp tools/list 6 tools', need.every(n => names.includes(n)), names.join(','));
  check('mcp tools have descriptions + schemas', (r.json?.result?.tools ?? []).every(t => t.description && t.inputSchema?.type === 'object'));
  const r2 = await req('POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list' });
  check('mcp tools/list byte-identical x2', JSON.stringify(r.json?.result) === JSON.stringify(r2.json?.result));
  r = await req('POST', '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'forge-user', repo: 'demo', title: 'from mcp' } } });
  check('mcp create_issue', r.json?.result?.content?.[0]?.text?.includes('"number"'), r.text.slice(0, 100));
  const restIssue = await req('GET', '/api/v3/repos/forge-user/demo/issues/3');
  check('mcp issue readable over REST (same store)', restIssue.status === 200 && restIssue.json?.title === 'from mcp');
  r = await req('POST', '/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'create_repo', arguments: { name: 'mcp-repo' } } });
  const restRepo = await req('GET', '/api/v3/repos/forge-user/mcp-repo');
  check('mcp repo readable over REST', restRepo.status === 200);
  r = await req('POST', '/mcp', { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
  check('mcp unknown tool -32602', r.json?.error?.code === -32602, r.text.slice(0, 80));
  r = await req('POST', '/mcp', { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'forge-user', repo: 'demo' } } });
  check('mcp missing arg isError', r.json?.result?.isError === true || r.json?.error?.code === -32602, r.text.slice(0, 80));
  const rawMcp = await fetch(BASE + '/mcp', { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: 'not-json' });
  const rawMcpJson = await rawMcp.json().catch(() => null);
  check('mcp bad json -32700', rawMcpJson?.error?.code === -32700 && (rawMcp.status === 200 || rawMcp.status === 400), `status=${rawMcp.status}`);
  const noAuth = await fetch(BASE + '/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  check('mcp no auth 401', noAuth.status === 401);
  // two concurrent calls keep their ids
  const [a, b] = await Promise.all([
    req('POST', '/mcp', { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'get_repo', arguments: { owner: 'forge-user', repo: 'demo' } } }),
    req('POST', '/mcp', { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'get_repo', arguments: { owner: 'forge-user', repo: 'gq' } } }),
  ]);
  check('mcp concurrent ids match args', (a.json?.id === 10 && b.json?.id === 11) && (a.json?.result?.content?.[0]?.text?.includes('demo')), '');
}

// ---------- GIT: create via REST, then real git client ----------
{
  await req('POST', '/api/v3/user/repos', { name: 'gitdemo' });
  const dir = mkdtempSync(join(tmpdir(), 'forge-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', HOME: process.env.HOME };
  const candidates = ['C:/Program Files/Git/bin/git.exe', 'C:/Program Files/Git/cmd/git.exe', 'git', 'C:/Program Files (x86)/Git/bin/git.exe'];
  let GITBIN = 'git';
  for (const c of candidates) { try { execFileSync(c, ['--version'], { stdio: 'pipe' }); GITBIN = c; break; } catch {} }
  env.GIT_TRACE = '1';
  const git = (args, cwd = dir) => {
    const p = spawnSync(GITBIN, args, { cwd, env, encoding: 'buffer' });
    const out = (p.stdout?.toString() ?? '');
    const err = (p.stderr?.toString() ?? '');
    if (p.status !== 0) return `GITERR(status=${p.status}): ${out} | ${err}`.slice(0, 4000);
    return out + (err ? ` [stderr: ${err.trim().slice(0, 4000)}]` : '');
  };
  const url = `${BASE}/forge-user/gitdemo.git`;
  let out = git(['clone', url, 'clone1']);
  console.log('CLONE FULL OUT:', out);
  console.log('clone1 contents:', existsSync(join(dir, 'clone1')) ? readdirSync(join(dir, 'clone1')).join(',') : '(missing)');
  try { console.log('.git contents:', readdirSync(join(dir, 'clone1', '.git')).join(',')); } catch (e) { console.log('.git unreadable:', e.message); }
  check('git clone (empty repo)', existsSync(join(dir, 'clone1', '.git', 'HEAD')) && !out.startsWith('GITERR'), `out=${out.slice(0, 400)}`);
  writeFileSync(join(dir, 'clone1', 'a.txt'), 'alpha\n');
  out = git(['-C', 'clone1', 'add', '.']); out = git(['-C', 'clone1', 'commit', '-m', 'c1']);
  console.log('DIAG symbolic-ref:', git(['-C', 'clone1', 'symbolic-ref', 'HEAD']));
  console.log('DIAG for-each-ref:', git(['-C', 'clone1', 'for-each-ref']));
  console.log('DIAG branch:', git(['-C', 'clone1', 'branch', '--show-current']));
  out = git(['-C', 'clone1', 'push', 'origin', 'main:main']);
  check('git push main', !out.startsWith('GITERR'), out.slice(0, 4000));
  out = git(['-C', 'clone1', 'log', '--oneline']);
  check('git log sees c1', out.includes('c1'), out.slice(0, 4000));
  // second clone sees pushed content
  out = git(['clone', '-c', 'core.autocrlf=false', url, 'clone2']);
  console.log('CLONE2 OUT:', out);
  console.log('CLONE2 branch:', git(['-C', 'clone2', 'branch', '--show-current']), '| log:', git(['-C', 'clone2', 'log', '--oneline']));
  console.log('CLONE2 ls:', existsSync(join(dir, 'clone2')) ? readdirSync(join(dir, 'clone2')).join(',') : '(missing)');
  const a2 = existsSync(join(dir, 'clone2', 'a.txt')) ? readFileSync(join(dir, 'clone2', 'a.txt'), 'utf8') : '';
  console.log('CLONE2 a2=', JSON.stringify(a2));
  check('git clone back = alpha', a2 === 'alpha\n', `a2=${JSON.stringify(a2)}`);
  // shallow clone depth 1
  out = git(['clone', '-c', 'core.autocrlf=false', '--depth', '1', url, 'clone3']);
  out = git(['-C', 'clone3', 'log', '--oneline']);
  check('shallow clone depth 1', existsSync(join(dir, 'clone3', 'a.txt')), out.slice(0, 4000));
  // push a branch
  writeFileSync(join(dir, 'clone1', 'b.txt'), 'beta\n');
  git(['-C', 'clone1', 'add', '.']); git(['-C', 'clone1', 'commit', '-m', 'c2']);
  out = git(['-C', 'clone1', 'push', 'origin', 'main:feat']);
  check('push branch feat', !out.startsWith('GITERR'), out.slice(0, 4000));
  const pr = await req('POST', '/api/v3/repos/forge-user/gitdemo/pulls', { title: 'PR', head: 'feat', base: 'main' });
  check('pull create 201 open over pushed branch', pr.status === 201 && pr.json?.state === 'open', `status=${pr.status}`);
  const prg = await req('GET', `/api/v3/repos/forge-user/gitdemo/pulls/${pr.json?.number}`);
  check('pull get head/base', prg.status === 200 && prg.json?.head?.ref === 'feat' && prg.json?.base?.ref === 'main');
  const pr404 = await req('GET', '/api/v3/repos/forge-user/gitdemo/pulls/999');
  check('pull 404', pr404.status === 404);
  const mg = await req('PUT', `/api/v3/repos/forge-user/gitdemo/pulls/${pr.json?.number}/merge`, { commit_title: 'merge' });
  check('pull merge 200 merged:true', mg.status === 200 && mg.json?.merged === true && mg.json?.sha, `status=${mg.status} body=${mg.text.slice(0, 4000)}`);
  const mg2 = await req('PUT', `/api/v3/repos/forge-user/gitdemo/pulls/${pr.json?.number}/merge`, {});
  check('merge merged pr 405', mg2.status === 405, `status=${mg2.status}`);
  // non-fast-forward: divergent clone pushes old head
  out = git(['-C', 'clone2', 'fetch', 'origin']); console.log('FETCH2:', out);
  out = git(['-C', 'clone2', 'reset', '--hard', 'HEAD']); console.log('RESET2:', out);
  out = git(['-C', 'clone2', 'push', 'origin', 'main:main']);
  check('non-ff push refused', !out.startsWith('GITERR') || out.includes('non-fast-forward'), out.slice(0, 4000));
  // ref delete via push
  out = git(['-C', 'clone1', 'push', 'origin', ':feat']);
  check('push delete ref', !out.startsWith('GITERR'), out.slice(0, 4000));
  rmSync(dir, { recursive: true, force: true });
}

const pass = results.filter(r => r.ok).length;
console.log(`\n===== ${pass}/${results.length} PASSED =====`);
for (const r of results.filter(r => !r.ok)) console.log('FAILED:', r.name, '—', r.detail);

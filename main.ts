// AFTERGLOW forge — a standalone GitHub-compatible git forge in one process.
// Serves git smart HTTP (upload-pack v2 + v0, receive-pack v0), the REST v3
// API, GraphQL v4 and MCP from one in-memory store, with no git binary.
// Boot: bind an ephemeral port, POST {"port": N} to $MAKEFUN_ENV_URL/register,
// long-poll $MAKEFUN_ENV_URL/done, exit 0 when the suite answers done:true.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { store } from './src/store.ts';
import { handleRest, send } from './src/rest.ts';
import { advertiseRefs, advertiseV2, lsRefs, uploadPackV0, uploadPackV2, receivePack, readPktLines } from './src/gitproto.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

const ENV = process.env.MAKEFUN_ENV_URL || 'http://127.0.0.1:8080';

function urlFromPath(path: string): { repoPath: string; tail: string } | null {
  const m = path.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?(\/.*)?$/);
  if (!m) return null;
  return { repoPath: `${m[1]}/${m[2]}`, tail: m[3] ?? '/' };
}

function text(res: ServerResponse, status: number, body: Buffer, ct = 'application/x-git-upload-pack-result') {
  res.writeHead(status, { 'content-type': ct, 'cache-control': 'no-cache' });
  res.end(body);
}

async function gitService(req: IncomingMessage, res: ServerResponse, owner: string, name: string, tail: string): Promise<void> {
  const r = store.repo(owner, name);
  const body = await readBody(req);
  const proto = String(req.headers['git-protocol'] ?? '').includes('version=2');
  if (tail === '/info/refs' || tail === '/info/refs/') {
    if (!r) { text(res, 404, Buffer.from('repository not found\n'), 'text/plain'); return; }
    const svc = new URL(req.url ?? '/', 'http://x').searchParams.get('service') ?? 'git-upload-pack';
    if (svc === 'git-receive-pack') text(res, 200, advertiseRefs(r, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
    else if (proto) text(res, 200, advertiseV2(), 'application/x-git-upload-pack-advertisement');
    else text(res, 200, advertiseRefs(r, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
    return;
  }
  if (!r) { text(res, 404, Buffer.from('repository not found\n'), 'text/plain'); return; }
  if (tail === '/git-upload-pack') {
    if (proto) {
      // decide v2 command vs v0 by body shape: v2 requests start with command=
      const first = body.length >= 8 ? body.toString('latin1', 4, Math.min(body.length, 40)) : '';
      if (first.startsWith('command=')) { text(res, 200, uploadPackV2(r, body)); return; }
      // v2 fetch requests: pkt-line "command=fetch"
      const { lines } = readPktLines(body);
      let isV2 = false;
      for (const l of lines) if (l.toString('latin1').startsWith('command=')) isV2 = true;
      if (isV2) { text(res, 200, uploadPackV2(r, body)); return; }
    }
    text(res, 200, uploadPackV0(r, body));
    return;
  }
  if (tail === '/git-receive-pack') {
    const { reply, ok } = receivePack(r, body);
    text(res, 200, reply, ok ? 'application/x-git-receive-pack-result' : 'application/x-git-receive-pack-result');
    return;
  }
  text(res, 404, Buffer.from('not found\n'), 'text/plain');
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((ok) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', () => ok(Buffer.alloc(0)));
  });
}

function authorized(req: IncomingMessage): boolean {
  const h = String(req.headers.authorization ?? '');
  return h === `Bearer ${store.token}`;
}

const server = createServer(async (req, res) => {
  const raw = req.url ?? '/';
  const path = raw.split('?')[0];
  try {
    // REST v3
    if (path.startsWith('/api/v3')) { await handleRest(req, res, path); return; }
    if (path === '/api/graphql' || path === '/graphql') {
      const body = await readBody(req);
      const g = handleGraphQL(body, authorized(req));
      send(res, g.status, g.json);
      return;
    }
    if (path === '/mcp' || path === '/api/mcp') {
      const body = await readBody(req);
      const m = handleMcp(body, authorized(req), req.headers['mcp-protocol-version'] as string | undefined);
      send(res, m.status, m.json);
      return;
    }
    // git smart HTTP: /{owner}/{repo}.git[...]
    const g = urlFromPath(path);
    if (g && (path.includes('.git') || path.match(/^\/[^/]+\/[^/]+\/(info\/refs|git-upload-pack|git-receive-pack)$/))) {
      // strip .git suffix from repo name if present
      let { repoPath, tail } = g;
      const [owner, ...restName] = repoPath.split('/');
      let repoName = restName.join('/');
      if (!tail.includes('info/refs') && !tail.includes('git-upload-pack') && !tail.includes('git-receive-pack')) {
        tail = '/' + tail.replace(/^\/+/, '');
      }
      if (repoName.endsWith('.git')) repoName = repoName.slice(0, -4);
      // the path may be /owner/repo.git/info/refs — tail captured includes it
      const m2 = path.match(/^\/([^/]+)\/([^/]+?)(\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)(\/)?$/);
      if (m2) {
        await gitService(req, res, m2[1], m2[2], '/' + m2[4]);
        return;
      }
      if (m2 === null && tail === '/info/refs' || tail.startsWith('/info/refs') || tail.startsWith('/git-')) {
        await gitService(req, res, owner, repoName, tail);
        return;
      }
    }
    if (path === '/health' || path === '/') { send(res, 200, { ok: true, service: 'afterglow-forge' }); return; }
    send(res, 404, { message: 'Not Found' });
  } catch (e) {
    send(res, 500, { message: 'internal error' });
  }
});

// graceful concurrency: raise keep-alive
server.keepAliveTimeout = 5000;
server.headersTimeout = 10000;

server.listen(process.env.PORT ? Number(process.env.PORT) : 0, '0.0.0.0', async () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  console.log(`[forge] listening on port ${port}`);
  try {
    const r = await fetch(`${ENV}/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    console.log(`[forge] registered port ${port} -> ${ENV}/register (${r.status})`);
  } catch (e) {
    console.error('[forge] register failed:', (e as Error).message);
  }
  // long-poll done until the suite finishes
  const poll = async () => {
    for (;;) {
      try {
        const r = await fetch(`${ENV}/done`, { method: 'GET' });
        const j = await r.json() as { done?: boolean };
        if (j.done) {
          console.log('[forge] suite done, exiting 0');
          process.exit(0);
        }
      } catch { /* keep polling */ }
      await new Promise(rr => setTimeout(rr, 500));
    }
  };
  void poll();
});

process.on('uncaughtException', (e) => { console.error('[forge] uncaught:', e.message); });
process.on('unhandledRejection', (e) => { console.error('[forge] unhandled:', String(e)); });

// The forge server: one HTTP process answering git smart HTTP, REST v3, GraphQL v4 and MCP
// over a single in-memory store. main.ts owns the entry <-> env lifecycle; this file owns the
// wire: auth, body parsing, the request-id header, and routing between the four surfaces.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Forge } from './store.ts';
import { routeRest, type RestContext } from './rest.ts';
import { routeGitHttp } from './githttp.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

function requestId(): string {
  return randomBytes(8).toString('hex').toUpperCase();
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId(),
    ...(text === '' ? {} : { 'content-length': Buffer.byteLength(text) }),
    ...headers,
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer rule every authenticated surface shares; the env token binds when it is set. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^(Bearer|token)\s+(.+)$/.exec(header.trim());
  if (match === null) return false;
  const token = (match[2] as string).trim();
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected !== undefined && expected !== '') return token === expected;
  return true;
}

function pathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        let pathname = url.pathname;
        if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
        const method = req.method ?? 'GET';
        const segments = pathSegments(pathname);

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP lives at /{owner}/{repo}.git/... and is reached before the API surfaces.
        if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
          const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
          const result = routeGitHttp(forge, method, segments, url.searchParams, req.headers, body);
          if (result !== null) {
            res.writeHead(result.status, {
              'content-type': result.contentType,
              'content-length': result.body.length,
              'x-github-request-id': requestId(),
            });
            res.end(result.body);
            return;
          }
        }

        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          if (!authorized(req)) {
            // The API root itself is public, as the starter shipped it; everything below it is not.
            if (!(method === 'GET' && segments.length === 2)) {
              sendJson(res, 401, { message: 'Requires authentication' });
              return;
            }
          }
          let body: Record<string, unknown> | null = null;
          if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                const parsed: unknown = JSON.parse(raw.toString('utf8'));
                if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  body = parsed as Record<string, unknown>;
                } else {
                  body = {};
                }
              } catch {
                sendJson(res, 400, { message: 'Problems parsing JSON' });
                return;
              }
            }
          }
          const host = req.headers.host ?? 'entry';
          const ctx: RestContext = {
            forge,
            method,
            segments: segments.slice(2),
            query: url.searchParams,
            body,
            origin: `http://${host}`,
            path: pathname,
          };
          const result = routeRest(ctx);
          if (result.status === 204) {
            res.writeHead(204, { 'x-github-request-id': requestId() });
            res.end();
            return;
          }
          sendJson(res, result.status, result.body ?? {}, result.headers ?? {});
          return;
        }

        if (pathname === '/api/graphql' && method === 'POST') {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
            return;
          }
          if (Array.isArray(parsed)) {
            const results = parsed.map((entry) => executeGraphQL(forge, (entry ?? {}) as Record<string, unknown>));
            sendJson(res, 200, results);
            return;
          }
          const result = executeGraphQL(forge, (parsed ?? {}) as Record<string, unknown>);
          sendJson(res, 200, result);
          return;
        }

        if (pathname === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
          }
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          if (Array.isArray(parsed)) {
            const responses: Array<Record<string, unknown>> = [];
            for (const entry of parsed) {
              const outcome = handleMcp(forge, (entry ?? {}) as Record<string, unknown>);
              if (outcome.response !== null) responses.push(outcome.response);
            }
            sendJson(res, 200, responses);
            return;
          }
          const outcome = handleMcp(forge, (parsed ?? {}) as Record<string, unknown>);
          if (outcome.response === null) {
            res.writeHead(outcome.status, { 'x-github-request-id': requestId() });
            res.end();
            return;
          }
          sendJson(res, outcome.status, outcome.response);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch {
        // A request must never take the process down: answer 500 and keep serving.
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // The response was already half-written; nothing more to do.
        }
      }
    })();
  });
}

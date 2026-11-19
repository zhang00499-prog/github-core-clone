// The MCP endpoint (POST /mcp): JSON-RPC 2.0 over Streamable HTTP, answering both the
// 2026-07-28 server/discover era and the legacy initialize era. The six tools are thin wrappers
// over the same store the REST surface uses, so objects agree across surfaces by construction.

import { mergePull, nextTimestamp, VIEWER, type Forge, type IssueRecord, type PullRecord, type Repo } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' } as const;
const MODERN_VERSION = '2026-07-28';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The tool table: built once, serialized identically on every tools/list. */
const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user and return it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository and return it.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch and return it.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash) and return it.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export interface McpOutcome {
  status: number;
  /** The JSON-RPC response object, or null for notifications (answered 202 with no body). */
  response: Record<string, unknown> | null;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolSuccess(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' ? value : null;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const repoOf = (): Repo | null => {
    const owner = stringArg(args, 'owner') ?? VIEWER.login;
    const repoName = stringArg(args, 'repo');
    return repoName === null ? null : forge.getRepo(owner, repoName);
  };

  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      if (repoName === null || repoName === '') return toolFailure('name is required');
      if (forge.getRepo(VIEWER.login, repoName) !== null) return toolFailure(`repository ${repoName} already exists`);
      const repo = forge.createRepo(repoName, stringArg(args, 'description') ?? '', args.private === true);
      return toolSuccess(repoJson(repo));
    }
    case 'get_repo': {
      const repo = repoOf();
      if (repo === null) return toolFailure('repository not found');
      return toolSuccess(repoJson(repo));
    }
    case 'create_issue': {
      const repo = repoOf();
      if (repo === null) return toolFailure('repository not found');
      const title = stringArg(args, 'title');
      if (title === null) return toolFailure('title is required');
      const now = nextTimestamp();
      const issue: IssueRecord = {
        kind: 'issue',
        id: repo.allocateRecordId(),
        number: repo.allocateNumber(),
        title,
        body: stringArg(args, 'body') ?? '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: now,
        updatedAt: now,
      };
      repo.issues.set(issue.number, issue);
      return toolSuccess(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = repoOf();
      if (repo === null) return toolFailure('repository not found');
      const state = stringArg(args, 'state') ?? 'open';
      const issues = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return toolSuccess(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoOf();
      if (repo === null) return toolFailure('repository not found');
      const title = stringArg(args, 'title');
      const head = stringArg(args, 'head');
      const base = stringArg(args, 'base');
      if (title === null || head === null || base === null) return toolFailure('title, head and base are required');
      if (repo.branchTip(head) === null || repo.branchTip(base) === null) return toolFailure('head or base branch does not exist');
      const now = nextTimestamp();
      const pull: PullRecord = {
        kind: 'pull',
        id: repo.allocateRecordId(),
        number: repo.allocateNumber(),
        title,
        body: stringArg(args, 'body') ?? '',
        state: 'open',
        headRef: head,
        baseRef: base,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        comments: [],
        createdAt: now,
        updatedAt: now,
      };
      repo.pulls.set(pull.number, pull);
      return toolSuccess(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (repo === null) return toolFailure('repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return toolFailure('pull request not found');
      if (!pull.merged) {
        const sha = mergePull(repo, pull, 'squash');
        if (sha === null) return toolFailure('pull request is not mergeable');
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = nextTimestamp();
        pull.mergeCommitSha = sha;
        pull.updatedAt = pull.mergedAt;
      }
      return toolSuccess(pullJson(repo, pull));
    }
    default:
      return toolFailure(`unknown tool ${name}`);
  }
}

/** Handle one JSON-RPC request object. `isNotification` requests answer with no body. */
export function handleMcp(forge: Forge, request: Record<string, unknown>): McpOutcome {
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const isNotification = id === undefined;

  if (method === 'server/discover') {
    return {
      status: 200,
      response: rpcResult(id, {
        supportedVersions: [MODERN_VERSION, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      }),
    };
  }
  if (method === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    return {
      status: 200,
      response: rpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }),
    };
  }
  if (method.startsWith('notifications/')) {
    return { status: 202, response: null };
  }
  if (method === 'ping') return { status: 200, response: rpcResult(id, {}) };
  if (method === 'tools/list') {
    return { status: 200, response: rpcResult(id, { tools: TOOLS }) };
  }
  if (method === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = TOOLS_BY_NAME.get(name);
    if (tool === undefined) {
      return { status: 200, response: rpcError(id, -32602, `unknown tool: ${name}`) };
    }
    const args = (params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
    const schema = tool.inputSchema as { required?: string[] };
    const missing = (schema.required ?? []).filter((key) => args[key] === undefined || args[key] === null);
    if (missing.length > 0) {
      return { status: 200, response: rpcError(id, -32602, `missing required arguments: ${missing.join(', ')}`) };
    }
    if (isNotification) return { status: 202, response: null };
    return { status: 200, response: rpcResult(id, callTool(forge, name, args)) };
  }
  if (isNotification) return { status: 202, response: null };
  return { status: 200, response: rpcError(id, -32601, `method not found: ${method}`) };
}

export { MODERN_VERSION };

// A small GraphQL engine for the v4 surface: tokenizer, parser (operations, fragments, variables,
// inline fragments, directives), and an executor over the forge store, with the introspection
// answers gh's feature probes read. Only the schema the suite exercises is implemented, but the
// engine itself is general: unknown fields answer a 200 with an errors array naming the field.

import { isoOf, mergePull, nextTimestamp, pullFiles, pullMergeable, VIEWER, type Forge, type IssueRecord, type PullRecord, type Repo } from './store.ts';

// ------------------------------------------------------------------------------------------------
// Global ids: opaque, stable, decodable by prefix + base64url("<Type>:<numeric id>").
// ------------------------------------------------------------------------------------------------

const ID_PREFIX: Record<string, string> = { Repository: 'R_', Issue: 'I_', PullRequest: 'PR_', User: 'U_', IssueComment: 'C_' };

export function globalId(type: string, numericId: number): string {
  return `${ID_PREFIX[type] ?? 'N_'}${Buffer.from(`${type}:${numericId}`).toString('base64url')}`;
}

export function decodeGlobalId(id: string): { type: string; numericId: number } | null {
  const underscore = id.indexOf('_');
  if (underscore === -1) return null;
  try {
    const decoded = Buffer.from(id.slice(underscore + 1), 'base64url').toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/.exec(decoded);
    if (match === null) return null;
    return { type: match[1] as string, numericId: Number(match[2]) };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------
// Schema metadata for introspection.
// ------------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'url', 'createdAt', 'updatedAt',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'comments', 'labels',
    'createdAt', 'updatedAt', 'closedAt', 'url', 'repository',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName',
    'mergeable', 'files', 'author', 'comments', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit',
    'url', 'repository',
  ],
  Ref: ['id', 'name', 'prefix', 'target'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED'],
};

// ------------------------------------------------------------------------------------------------
// Tokenizer and parser.
// ------------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'punct'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) { i += 1; continue; }
    if (source.startsWith('...', i)) { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('!$():=@[]{}|&'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end === -1 ? source.length : end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc ?? '';
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      if (match !== null) {
        tokens.push({ kind: 'number', value: Number(match[0]) });
        i += match[0].length;
        continue;
      }
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
      if (match !== null) {
        tokens.push({ kind: 'name', value: match[0] });
        i += match[0].length;
        continue;
      }
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  return tokens;
}

interface ValueNode { kind: string; value?: unknown; values?: ValueNode[]; fields?: Array<{ name: string; value: ValueNode }> }
interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  directives: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }>;
  selectionSet: SelectionNode[] | null;
}
type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] };
interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}
interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }
  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) { this.pos += 1; return true; }
    return false;
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token !== undefined && token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | null = null;
        const ahead = this.peek();
        if (ahead !== undefined && ahead.kind === 'name') name = this.expectName();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseVariableDefinitions();
        this.parseDirectives();
        operations.push({ type: keyword === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected definition "${keyword}"`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.parseDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseDirectives(): FieldNode['directives'] {
    const directives: FieldNode['directives'] = [];
    while (this.skipPunct('@')) {
      const name = this.expectName();
      const args = this.peek()?.kind === 'punct' && this.peek()?.value === '(' ? this.parseArguments() : [];
      directives.push({ name, args });
    }
    return directives;
  }

  private parseArguments(): FieldNode['args'] {
    const args: FieldNode['args'] = [];
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', value: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value token');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.skipPunct('...')) {
      const ahead = this.peek();
      if (ahead !== undefined && ahead.kind === 'name' && ahead.value === 'on') {
        this.expectName();
        const typeCondition = this.expectName();
        this.parseDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (ahead !== undefined && ahead.kind === 'name') {
        const name = this.expectName();
        this.parseDirectives();
        return { kind: 'spread', name };
      }
      // "... {" inline fragment without a type condition.
      this.parseDirectives();
      return { kind: 'inline', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.peek()?.kind === 'punct' && this.peek()?.value === '(' ? this.parseArguments() : [];
    const directives = this.parseDirectives();
    const selectionSet = this.peek()?.kind === 'punct' && this.peek()?.value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }
}

// ------------------------------------------------------------------------------------------------
// Execution.
// ------------------------------------------------------------------------------------------------

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
  errors: Array<{ message: string }>;
}

type Source = Record<string, unknown> & { __typename: string };

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.value as string];
    case 'list': return (node.values ?? []).map((entry) => valueOf(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields ?? []) out[field.name] = valueOf(field.value, variables);
      return out;
    }
    default: return node.value ?? null;
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, ctx.variables);
  return out;
}

function directivesAllow(directives: FieldNode['directives'], ctx: ExecContext): boolean {
  for (const directive of directives) {
    const args: Record<string, unknown> = {};
    for (const arg of directive.args) args[arg.name] = valueOf(arg.value, ctx.variables);
    if (directive.name === 'skip' && args.if === true) return false;
    if (directive.name === 'include' && args.if === false) return false;
  }
  return true;
}

const userSource = (): Source => ({ __typename: 'User' });

function repoSource(repo: Repo): Source {
  return { __typename: 'Repository', repo };
}

function issueSource(repo: Repo, issue: IssueRecord): Source {
  return { __typename: 'Issue', repo, issue };
}

function pullSource(repo: Repo, pull: PullRecord): Source {
  return { __typename: 'PullRequest', repo, pull };
}

function commentSource(repo: Repo, comment: { id: number; body: string; createdAt: number }): Source {
  return { __typename: 'IssueComment', repo, comment };
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`).toString('base64url');
}

function numberOfCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface ConnectionItem {
  number: number;
  source: Source;
}

/** Slice an ordered connection by first/after and shape nodes + pageInfo. */
function connection(typeName: string, items: ConnectionItem[], args: Record<string, unknown>): Source {
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : items.length;
  let startIndex = 0;
  if (typeof args.after === 'string') {
    const afterNumber = numberOfCursor(args.after);
    const at = items.findIndex((item) => item.number === afterNumber);
    if (at !== -1) startIndex = at + 1;
  }
  const slice = items.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + slice.length < items.length;
  return {
    __typename: typeName,
    nodes: slice.map((item) => item.source),
    edges: slice.map((item) => ({ __typename: 'Edge', node: item.source, cursor: cursorOf(item.number) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: startIndex > 0,
      startCursor: slice.length > 0 ? cursorOf((slice[0] as ConnectionItem).number) : null,
      endCursor: slice.length > 0 ? cursorOf((slice[slice.length - 1] as ConnectionItem).number) : null,
    },
    totalCount: items.length,
  };
}

function findRepoById(forge: Forge, numericId: number): Repo | null {
  for (const repo of forge.listRepos()) if (repo.id === numericId) return repo;
  return null;
}

function findIssueById(forge: Forge, numericId: number): { repo: Repo; issue: IssueRecord } | null {
  for (const repo of forge.listRepos()) {
    for (const issue of repo.issues.values()) if (issue.id === numericId) return { repo, issue };
  }
  return null;
}

function findPullById(forge: Forge, numericId: number): { repo: Repo; pull: PullRecord } | null {
  for (const repo of forge.listRepos()) {
    for (const pull of repo.pulls.values()) if (pull.id === numericId) return { repo, pull };
  }
  return null;
}

/** The raw (pre-selection) value of one field on one source object. */
function resolveField(ctx: ExecContext, source: Source, field: string, args: Record<string, unknown>): unknown {
  const type = source.__typename;

  if (field === '__typename') return type;
  if (type === 'Query' && field === '__type') {
    const name = typeof args.name === 'string' ? args.name : '';
    if (TYPE_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
    return { __typename: '__Type', name };
  }
  if (type === 'Query' && field === '__schema') {
    return {
      __typename: '__Schema',
      queryType: { __typename: '__Type', name: 'Query' },
      mutationType: { __typename: '__Type', name: 'Mutation' },
      types: Object.keys({ ...TYPE_FIELDS, ...ENUM_VALUES }).map((name) => ({ __typename: '__Type', name })),
    };
  }
  if (type === '__Type') {
    const name = source.name as string;
    if (field === 'name') return name;
    if (field === 'kind') return ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT';
    if (field === 'fields') {
      const fields = TYPE_FIELDS[name];
      return fields === undefined ? null : fields.map((fieldName) => ({ __typename: '__Field', name: fieldName }));
    }
    if (field === 'enumValues') {
      const values = ENUM_VALUES[name];
      return values === undefined ? null : values.map((valueName) => ({ __typename: '__EnumValue', name: valueName }));
    }
    if (field === 'description') return null;
    return null;
  }
  if (type === '__Field' || type === '__EnumValue') {
    if (field === 'name') return source.name;
    return null;
  }
  if (type === '__Schema') {
    if (field in source) return source[field];
    return null;
  }

  switch (type) {
    case 'Query': {
      if (field === 'viewer') return userSource();
      if (field === 'repository') {
        const repo = ctx.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === null ? null : repoSource(repo);
      }
      if (field === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (decoded === null) return null;
        if (decoded.type === 'Repository') {
          const repo = findRepoById(ctx.forge, decoded.numericId);
          return repo === null ? null : repoSource(repo);
        }
        if (decoded.type === 'Issue') {
          const found = findIssueById(ctx.forge, decoded.numericId);
          return found === null ? null : issueSource(found.repo, found.issue);
        }
        if (decoded.type === 'PullRequest') {
          const found = findPullById(ctx.forge, decoded.numericId);
          return found === null ? null : pullSource(found.repo, found.pull);
        }
        if (decoded.type === 'User') return userSource();
        return null;
      }
      break;
    }
    case 'Mutation': {
      return resolveMutation(ctx, field, args);
    }
    case 'User': {
      if (field === 'id') return globalId('User', VIEWER.id);
      if (field === 'databaseId') return VIEWER.id;
      if (field === 'login') return VIEWER.login;
      if (field === 'name') return VIEWER.name;
      if (field === 'email') return VIEWER.email;
      if (field === 'url') return `https://forge.local/${VIEWER.login}`;
      break;
    }
    case 'Repository': {
      const repo = source.repo as Repo;
      switch (field) {
        case 'id': return globalId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.fullName;
        case 'owner': return userSource();
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'url': return `https://forge.local/${repo.fullName}`;
        case 'createdAt': return isoOf(repo.createdAt);
        case 'updatedAt': return isoOf(repo.updatedAt);
        case 'defaultBranchRef': {
          const tip = repo.branchTip(repo.defaultBranch);
          return tip === null ? null : { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/' };
        }
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueSource(repo, issue);
        }
        case 'issues': {
          let issues = [...repo.issues.values()];
          const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
          if (states !== null) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
          const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
          issues.sort((a, b) => a.number - b.number);
          if (orderBy?.direction === 'DESC') issues.reverse();
          return connection('IssueConnection', issues.map((issue) => ({ number: issue.number, source: issueSource(repo, issue) })), args);
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullSource(repo, pull);
        }
        case 'pullRequests': {
          let pulls = [...repo.pulls.values()];
          const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
          if (states !== null) {
            pulls = pulls.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
          }
          pulls.sort((a, b) => a.number - b.number);
          return connection('PullRequestConnection', pulls.map((pull) => ({ number: pull.number, source: pullSource(repo, pull) })), args);
        }
        default: break;
      }
      break;
    }
    case 'Issue': {
      const repo = source.repo as Repo;
      const issue = source.issue as IssueRecord;
      switch (field) {
        case 'id': return globalId('Issue', issue.id);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'author': return userSource();
        case 'repository': return repoSource(repo);
        case 'createdAt': return isoOf(issue.createdAt);
        case 'updatedAt': return isoOf(issue.updatedAt);
        case 'closedAt': return issue.state === 'closed' ? isoOf(issue.updatedAt) : null;
        case 'url': return `https://forge.local/${repo.fullName}/issues/${issue.number}`;
        case 'comments': {
          return connection('IssueCommentConnection', issue.comments.map((comment) => ({ number: comment.id, source: commentSource(repo, comment) })), args);
        }
        case 'labels': return { __typename: 'LabelConnection', nodes: [] };
        default: break;
      }
      break;
    }
    case 'PullRequest': {
      const repo = source.repo as Repo;
      const pull = source.pull as PullRecord;
      switch (field) {
        case 'id': return globalId('PullRequest', pull.id);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable': {
          if (pull.merged) return 'UNKNOWN';
          return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'author': return userSource();
        case 'repository': return repoSource(repo);
        case 'createdAt': return isoOf(pull.createdAt);
        case 'updatedAt': return isoOf(pull.updatedAt);
        case 'mergedAt': return pull.mergedAt === null ? null : isoOf(pull.mergedAt);
        case 'mergeCommit': return pull.mergeCommitSha === null ? null : { __typename: 'Commit', oid: pull.mergeCommitSha };
        case 'url': return `https://forge.local/${repo.fullName}/pull/${pull.number}`;
        case 'comments': {
          return connection('IssueCommentConnection', pull.comments.map((comment) => ({ number: comment.id, source: commentSource(repo, comment) })), args);
        }
        case 'files': {
          const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : 10;
          const files = pullFiles(repo, pull).slice(0, first);
          return {
            __typename: 'PullRequestChangedFileConnection',
            nodes: files.map((file) => ({
              __typename: 'PullRequestChangedFile',
              path: file.filename,
              additions: file.additions,
              deletions: file.deletions,
              changeType: file.status.toUpperCase(),
            })),
            totalCount: files.length,
          };
        }
        default: break;
      }
      break;
    }
    case 'IssueComment': {
      const comment = source.comment as { id: number; body: string; createdAt: number };
      switch (field) {
        case 'id': return globalId('IssueComment', comment.id);
        case 'databaseId': return comment.id;
        case 'body': return comment.body;
        case 'author': return userSource();
        case 'createdAt': return isoOf(comment.createdAt);
        case 'updatedAt': return isoOf(comment.createdAt);
        default: break;
      }
      break;
    }
    case 'Ref': {
      if (field === 'name') return source.name;
      if (field === 'prefix') return source.prefix ?? 'refs/heads/';
      if (field === 'id') return null;
      break;
    }
    default: {
      // Plain shaped objects (connections, pageInfo, payloads): read the property directly.
      if (field in source) return source[field];
      break;
    }
  }
  return undefined; // signals "unknown field"
}

function resolveMutation(ctx: ExecContext, field: string, args: Record<string, unknown>): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field) {
    case 'createIssue': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.type === 'Repository' ? findRepoById(ctx.forge, decoded.numericId) : null;
      if (repo === null) throw new Error('repository not found for createIssue');
      const now = nextTimestamp();
      const issue: IssueRecord = {
        kind: 'issue',
        id: repo.allocateRecordId(),
        number: repo.allocateNumber(),
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        comments: [],
        createdAt: now,
        updatedAt: now,
      };
      repo.issues.set(issue.number, issue);
      return { __typename: 'CreateIssuePayload', issue: issueSource(repo, issue), clientMutationId: input.clientMutationId ?? null };
    }
    case 'closeIssue': {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      const found = decoded !== null ? findIssueById(ctx.forge, decoded.numericId) : null;
      if (found === null) throw new Error('issue not found for closeIssue');
      found.issue.state = 'closed';
      found.issue.updatedAt = nextTimestamp();
      return { __typename: 'CloseIssuePayload', issue: issueSource(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
    }
    case 'createPullRequest': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.type === 'Repository' ? findRepoById(ctx.forge, decoded.numericId) : null;
      if (repo === null) throw new Error('repository not found for createPullRequest');
      const headRefName = String(input.headRefName ?? '');
      const baseRefName = String(input.baseRefName ?? '');
      if (repo.branchTip(headRefName) === null || repo.branchTip(baseRefName) === null) {
        throw new Error('head or base branch not found for createPullRequest');
      }
      const now = nextTimestamp();
      const pull: PullRecord = {
        kind: 'pull',
        id: repo.allocateRecordId(),
        number: repo.allocateNumber(),
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        headRef: headRefName,
        baseRef: baseRefName,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        comments: [],
        createdAt: now,
        updatedAt: now,
      };
      repo.pulls.set(pull.number, pull);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(repo, pull), clientMutationId: input.clientMutationId ?? null };
    }
    case 'mergePullRequest': {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      const found = decoded !== null ? findPullById(ctx.forge, decoded.numericId) : null;
      if (found === null) throw new Error('pull request not found for mergePullRequest');
      const method = String(input.mergeMethod ?? 'SQUASH').toUpperCase();
      if (!found.pull.merged) {
        const sha = mergePull(found.repo, found.pull, method === 'MERGE' ? 'merge' : 'squash');
        if (sha === null) throw new Error('pull request is not mergeable');
        found.pull.merged = true;
        found.pull.state = 'closed';
        found.pull.mergedAt = nextTimestamp();
        found.pull.mergeCommitSha = sha;
        found.pull.updatedAt = found.pull.mergedAt;
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullSource(found.repo, found.pull), clientMutationId: input.clientMutationId ?? null };
    }
    case 'addComment': {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded === null) throw new Error('subject not found for addComment');
      const body = String(input.body ?? '');
      if (decoded.type === 'Issue') {
        const found = findIssueById(ctx.forge, decoded.numericId);
        if (found === null) throw new Error('subject not found for addComment');
        const comment = { id: found.repo.allocateCommentId(), body, createdAt: nextTimestamp() };
        found.issue.comments.push(comment);
        return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node: commentSource(found.repo, comment) }, clientMutationId: input.clientMutationId ?? null };
      }
      if (decoded.type === 'PullRequest') {
        const found = findPullById(ctx.forge, decoded.numericId);
        if (found === null) throw new Error('subject not found for addComment');
        const comment = { id: found.repo.allocateCommentId(), body, createdAt: nextTimestamp() };
        found.pull.comments.push(comment);
        return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node: commentSource(found.repo, comment) }, clientMutationId: input.clientMutationId ?? null };
      }
      throw new Error('subject is not commentable');
    }
    default:
      return undefined;
  }
}

const KNOWN_FIELDS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(TYPE_FIELDS).map(([type, fields]) => [type, new Set([...fields, '__typename'])]),
);

function applySelectionSet(ctx: ExecContext, source: Source, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const runtimeType = source.__typename;
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (fragment.typeCondition !== null && fragment.typeCondition !== runtimeType && fragment.typeCondition !== 'Node') continue;
      Object.assign(out, applySelectionSet(ctx, source, fragment.selectionSet));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== runtimeType && selection.typeCondition !== 'Node') continue;
      Object.assign(out, applySelectionSet(ctx, source, selection.selectionSet));
      continue;
    }
    if (!directivesAllow(selection.directives, ctx)) continue;
    const key = selection.alias ?? selection.name;
    const args = argsOf(selection, ctx);
    let raw: unknown;
    try {
      raw = resolveField(ctx, source, selection.name, args);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[key] = null;
      continue;
    }
    if (raw === undefined) {
      const known = KNOWN_FIELDS[runtimeType];
      if (known !== undefined && !known.has(selection.name) && selection.name !== '__type' && selection.name !== '__schema') {
        ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${runtimeType}'` });
      } else if (known === undefined && !(selection.name in source)) {
        ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${runtimeType}'` });
      }
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, raw, selection.selectionSet);
  }
  return out;
}

function completeValue(ctx: ExecContext, raw: unknown, selectionSet: SelectionNode[] | null): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((entry) => completeValue(ctx, entry, selectionSet));
  if (typeof raw === 'object') {
    const source = raw as Source;
    if (selectionSet === null) return source;
    if (typeof source.__typename === 'string') return applySelectionSet(ctx, source, selectionSet);
    return source;
  }
  return raw;
}

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

/** Execute one operation document (the body of one POST, or one entry of a batch). */
export function executeGraphQL(forge: Forge, body: Record<string, unknown>): GraphQLResult {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (body.variables !== null && typeof body.variables === 'object' ? body.variables : {}) as Record<string, unknown>;
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
  }
  const operation = document.operations.find((candidate) => operationName === null || candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const ctx: ExecContext = { forge, variables, fragments: document.fragments, errors: [] };
  const root: Source = { __typename: operation.type === 'mutation' ? 'Mutation' : 'Query' };
  // Mutation fields resolve on the Mutation root; query fields on Query. resolveField keys off
  // __typename, so present the right root and let Query-typed meta fields ride along.
  const data = applySelectionSet(ctx, root, operation.selectionSet);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

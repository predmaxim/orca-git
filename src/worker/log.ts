import type { BranchRef, CommitDetails, CommitRow, FileChange, LogFilter, LogPage, RefsResult } from '../shared/protocol.ts'
import type { Git } from './git.ts'
import { t } from '../shared/i18n.ts'

const FS = '\x1f'
const RS = '\x1e'
export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ct', '%D', '%s'].join('%x1f') + '%x1e'

const REMOTE_HEAD = /^refs\/remotes\/[^/]+\/HEAD$/

export function parseDecorations(text: string): string[] {
  const refs: string[] = []
  for (const raw of text.split(', ')) {
    const part = raw.trim()
    if (!part) continue
    if (part.startsWith('HEAD -> ')) refs.push(part.slice(8))
    else if (part.startsWith('tag: ')) refs.push(part.slice(5))
    else if (!REMOTE_HEAD.test(part)) refs.push(part)
  }
  return refs
}

export function parseLog(stdout: string): CommitRow[] {
  const rows: CommitRow[] = []
  for (const record of stdout.split(RS)) {
    const line = record.replace(/^\r?\n/, '')
    if (!line) continue
    const [hash, parents, author, email, at, committer, ct, decorations, ...subject] = line.split(FS)
    if (!hash || hash.length < 40) continue
    rows.push({
      hash,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      author,
      email,
      authorTime: Number(at) || 0,
      committer,
      commitTime: Number(ct) || 0,
      subject: subject.join(FS),
      refs: parseDecorations(decorations ?? '')
    })
  }
  return rows
}

export function escapeRegex(text: string): string {
  return text.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')
}

const gitDate = (seconds: number) => new Date(seconds * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000')

function assertRevision(rev: string): string {
  if (!rev || rev.startsWith('-') || /[\s~^:?*[\\]/.test(rev.replace(/^refs\//, ''))) throw new Error(t('invalidRevision', { rev }))
  return rev
}

export const isHashLike = (text: string) => /^[0-9a-f]{4,40}$/i.test(text)

/** `git log` arguments for one page: everything but the format and the page window. */
export function logArgs(filter: LogFilter): string[] {
  const args = ['--date-order', '--decorate=full', '-E']
  const text = filter.text?.trim()
  if (text) {
    args.push(`--grep=${filter.regex ? text : escapeRegex(text)}`)
  }
  for (const user of filter.users ?? []) args.push(`--author=${escapeRegex(user)}`)
  if (text || filter.users?.length) {
    if (!filter.matchCase) args.push('--regexp-ignore-case')
  }
  if (filter.since) args.push(`--since=${gitDate(filter.since)}`)
  if (filter.until) args.push(`--until=${gitDate(filter.until)}`)
  const branches = (filter.branches ?? []).filter(Boolean)
  if (branches.length) args.push(...branches.map(assertRevision))
  else args.push('--branches', '--remotes', '--tags', 'HEAD')
  args.push('--')
  for (const path of filter.paths ?? []) if (path.trim()) args.push(path.trim())
  return args
}

export async function readLogPage(git: Git, filter: LogFilter, skip: number, limit: number): Promise<LogPage> {
  const result = await git.run(['log', `--format=${LOG_FORMAT}`, `--skip=${skip}`, `-n${limit + 1}`, ...logArgs(filter)])
  // An empty repository (no HEAD yet) is an empty log, not an error.
  if (!result.ok) {
    if (!(await readHead(git)).hash) return { commits: [], hasMore: false }
    throw new Error(result.stderr.trim() || t('gitLogFailed'))
  }
  const commits = parseLog(result.stdout)
  const hasMore = commits.length > limit
  if (hasMore) commits.length = limit
  const text = filter.text?.trim()
  if (skip === 0 && text && isHashLike(text)) {
    const found = await git.run(['log', '-1', '--decorate=full', `--format=${LOG_FORMAT}`, `${text}^{commit}`, '--'])
    const exact = found.ok ? parseLog(found.stdout)[0] : undefined
    if (exact && !commits.some((c) => c.hash === exact.hash)) commits.unshift(exact)
  }
  return { commits, hasMore }
}

export async function readHead(git: Git): Promise<{ branch: string | null; hash: string | null }> {
  const [branch, hash] = await Promise.all([
    git.run(['symbolic-ref', '-q', '--short', 'HEAD']),
    git.run(['rev-parse', '-q', '--verify', 'HEAD'])
  ])
  return {
    branch: branch.ok ? branch.stdout.trim() || null : null,
    hash: hash.ok ? hash.stdout.trim() || null : null
  }
}

export function parseRefs(stdout: string): Pick<RefsResult, 'locals' | 'remotes' | 'tags'> {
  const locals: BranchRef[] = []
  const remotes: BranchRef[] = []
  const tags: BranchRef[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue
    const [full, object, peeled, upstream] = line.split(FS)
    const hash = peeled || object
    if (full.startsWith('refs/heads/')) locals.push({ name: full.slice(11), full, hash, ...(upstream ? { upstream } : {}) })
    else if (full.startsWith('refs/remotes/')) {
      if (!REMOTE_HEAD.test(full)) remotes.push({ name: full.slice(13), full, hash })
    } else if (full.startsWith('refs/tags/')) tags.push({ name: full.slice(10), full, hash })
  }
  return { locals, remotes, tags }
}

export async function readRefs(git: Git): Promise<RefsResult> {
  const [refs, head, users, me] = await Promise.all([
    git.out([
      'for-each-ref',
      '--format=%(refname)%1f%(objectname)%1f%(*objectname)%1f%(upstream:short)',
      'refs/heads',
      'refs/remotes',
      'refs/tags'
    ]),
    readHead(git),
    git.run(['log', '--branches', '--remotes', '--format=%an', '-n5000']),
    git.run(['config', 'user.name'])
  ])
  const names = new Set<string>()
  if (users.ok) for (const name of users.stdout.split(/\r?\n/)) if (name.trim()) names.add(name.trim())
  return {
    head,
    ...parseRefs(refs),
    users: [...names].sort((a, b) => a.localeCompare(b)),
    me: me.ok ? me.stdout.trim() || null : null
  }
}

export function parseNameStatus(stdout: string): FileChange[] {
  const tokens = stdout.split('\0')
  const files: FileChange[] = []
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++]?.trim()
    if (!status) continue
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = tokens[i++]
      const path = tokens[i++]
      files.push({ status: status[0], path, oldPath })
    } else {
      files.push({ status: status[0], path: tokens[i++] })
    }
  }
  return files
}

export async function readDetails(git: Git, hash: string): Promise<CommitDetails> {
  assertRevision(hash)
  const show = await git.out(['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B', hash, '--'])
  const [full, parents, author, email, at, committer, committerEmail, ct, ...message] = show.split(FS)
  const parentList = parents ? parents.split(' ').filter(Boolean) : []
  const diff = parentList.length > 1
    ? await git.run(['diff', '--name-status', '-z', '-M', parentList[0], full, '--'])
    : await git.run(['diff-tree', '--no-commit-id', '-r', '-M', '--name-status', '-z', '--root', full, '--'])
  const containing = await git.run(['for-each-ref', '--contains', full, '--count=50', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])
  return {
    hash: full,
    parents: parentList,
    author,
    email,
    authorTime: Number(at) || 0,
    committer,
    committerEmail,
    commitTime: Number(ct) || 0,
    message: message.join(FS).replace(/\s+$/, ''),
    files: diff.ok ? parseNameStatus(diff.stdout) : [],
    branches: containing.ok
      ? containing.stdout.split(/\r?\n/).filter((name) => name && !name.endsWith('/HEAD'))
      : []
  }
}

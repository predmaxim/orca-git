import type { BranchRef, CommitDetails, CommitRow, FileChange, LogFilter, LogPage, RefsResult } from '../shared/protocol.ts'
import type { Git } from './git.ts'
import { t } from '../shared/i18n.ts'

const HASH = /^[0-9a-f]{40}$/
/** Fields end with NUL, and with `git log -z` so does each record: no commit message, name or path can hold one. */
export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ct', '%D', '%s'].join('%x00')
const LOG_FIELDS = 9

export const REMOTE_HEAD = /^refs\/remotes\/[^/]+\/HEAD$/

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
  const fields = stdout.split('\0')
  const seen = new Set<string>()
  for (let i = 0; i + LOG_FIELDS <= fields.length; i += LOG_FIELDS) {
    const [hash, parents, author, email, at, committer, ct, decorations, subject] = fields.slice(i, i + LOG_FIELDS)
    // A hash that is not one, or that came already, is not a commit of this log.
    if (!HASH.test(hash) || seen.has(hash)) continue
    seen.add(hash)
    rows.push({
      hash,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      author,
      email,
      authorTime: Number(at) || 0,
      committer,
      commitTime: Number(ct) || 0,
      subject,
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
  // --encoding=UTF-8 here and below: i18n.logOutputEncoding would garble the text, or (UTF-16) every field.
  const result = await git.run(['log', '-z', '--encoding=UTF-8', `--format=${LOG_FORMAT}`, `--skip=${skip}`, `-n${limit + 1}`, ...logArgs(filter)])
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
    const found = await git.run(['log', '-z', '--encoding=UTF-8', '-1', '--decorate=full', `--format=${LOG_FORMAT}`, `${text}^{commit}`, '--'])
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
  // Each field ends with NUL and each record with a newline after that: an upstream name from the config can hold a newline, never a NUL.
  const fields = stdout.split('\0')
  for (let i = 0; i + 4 <= fields.length; i += 4) {
    const [ref, object, peeled, upstream] = fields.slice(i, i + 4)
    const full = ref.replace(/^\n/, '')
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
      '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream:short)%00',
      'refs/heads',
      'refs/remotes',
      'refs/tags'
    ]),
    readHead(git),
    git.run(['log', '--encoding=UTF-8', '--branches', '--remotes', '--format=%an', '-n5000']),
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
  const show = await git.out(['show', '-s', '-z', '--encoding=UTF-8', '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B', hash, '--'])
  const [full, parents, author, email, at, committer, committerEmail, ct, message = ''] = show.split('\0')
  const parentList = parents ? parents.split(' ').filter(Boolean) : []
  const diff = parentList.length > 1
    ? await git.run(['diff', '--name-status', '-z', '-M', parentList[0], full, '--'])
    : await git.run(['diff-tree', '--no-commit-id', '-r', '-M', '--name-status', '-z', '--root', full, '--'])
  // %(refname): the short name of a remote's HEAD is the remote's own name.
  const containing = await git.run(['for-each-ref', '--contains', full, '--count=50', '--format=%(refname)', 'refs/heads', 'refs/remotes'])
  return {
    hash: full,
    parents: parentList,
    author,
    email,
    authorTime: Number(at) || 0,
    committer,
    committerEmail,
    commitTime: Number(ct) || 0,
    message: message.replace(/\s+$/, ''),
    files: diff.ok ? parseNameStatus(diff.stdout) : [],
    branches: containing.ok
      ? containing.stdout.split(/\r?\n/).filter((ref) => ref && !REMOTE_HEAD.test(ref)).map((ref) => ref.replace(/^refs\/(heads|remotes)\//, ''))
      : []
  }
}

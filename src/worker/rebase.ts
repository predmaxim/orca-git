import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlanItem, RangeCommit, RewriteKind } from '../shared/protocol.ts'
import { lastLines, type Git } from './git.ts'
import { t } from '../shared/i18n.ts'

export interface HistoryEntry extends RangeCommit {
  parents: string[]
}

/** How far back the first-parent history is read for a rewrite. */
export const HISTORY_LIMIT = 3000

const HASH = /^[0-9a-f]{40}$/

export async function readFirstParentHistory(git: Git, limit = HISTORY_LIMIT): Promise<HistoryEntry[]> {
  // -z ends each record with NUL, and NUL ends each field: no commit message, name or path can hold one.
  const fields = (await git.out(['log', '-z', '--first-parent', '--format=%H%x00%P%x00%s%x00%B', `-n${limit}`, 'HEAD', '--'])).split('\0')
  const entries: HistoryEntry[] = []
  for (let i = 0; i + 4 <= fields.length; i += 4) {
    const [hash, parents, subject, message] = fields.slice(i, i + 4)
    entries.push({ hash, parents: parents ? parents.split(' ') : [], subject, message: message.replace(/\s+$/, '') })
  }
  // A forged record cannot pass: every commit appears once, and each is the first parent of the one before it.
  const chained = entries.every((entry, i) =>
    HASH.test(entry.hash) && entry.parents.every((parent) => HASH.test(parent)) && (i + 1 === entries.length || entry.parents[0] === entries[i + 1].hash))
  if (fields.length % 4 !== 1 || !chained || new Set(entries.map((entry) => entry.hash)).size !== entries.length) {
    throw new Error(t('gitOutputUnreadable', { command: 'log' }))
  }
  return entries
}

export interface Range {
  /** Parent of the oldest rewritten commit; null to rebase from the root. */
  base: string | null
  /** Oldest first, up to HEAD. */
  commits: HistoryEntry[]
}

/** The commits from the oldest of `hashes` up to HEAD, checked to be a linear first-parent run. */
export function selectRange(history: HistoryEntry[], hashes: string[]): Range {
  if (!hashes.length) throw new Error(t('selectAtLeastOne'))
  let oldest = -1
  for (const hash of hashes) {
    const index = history.findIndex((entry) => entry.hash === hash)
    if (index < 0) throw new Error(t('commitNotOnBranch', { hash: hash.slice(0, 8) }))
    oldest = Math.max(oldest, index)
  }
  const commits = history.slice(0, oldest + 1).reverse()
  const merge = commits.find((entry) => entry.parents.length > 1)
  if (merge) throw new Error(t('rewriteAcrossMergeError', { hash: merge.hash.slice(0, 8) }))
  return { base: commits[0].parents[0] ?? null, commits }
}

/** Selected commits plus, for a single-commit fixup, the parent it folds into. */
export function rangeHashes(kind: RewriteKind, hashes: string[], history: HistoryEntry[]): string[] {
  if (kind === 'fixup' && hashes.length === 1) {
    const entry = history.find((e) => e.hash === hashes[0])
    const parent = entry?.parents[0]
    if (!parent) throw new Error(t('noPreviousCommit'))
    return [hashes[0], parent]
  }
  return hashes
}

/**
 * The rebase plan for a context-menu action over `range`. Squash and fixup fold the selected
 * commits into the oldest one (into the parent for a single fixup), moving later ones next to it.
 */
export function planFor(
  kind: 'squash' | 'fixup' | 'drop' | 'reword',
  range: Range,
  hashes: string[],
  message?: string
): PlanItem[] {
  const selected = new Set(hashes)
  const commits = range.commits
  if (kind === 'drop') return commits.map((c) => ({ hash: c.hash, action: selected.has(c.hash) ? 'drop' : 'pick' }))
  if (kind === 'reword') {
    return commits.map((c) => (selected.has(c.hash) ? { hash: c.hash, action: 'reword', message } : { hash: c.hash, action: 'pick' }))
  }
  // squash / fixup: range[0] is the target (oldest selected, or the parent for a single fixup).
  const [target, ...rest] = commits
  const folded = rest.filter((c) => selected.has(c.hash))
  if (kind === 'squash' && folded.length === 0) throw new Error(t('squashNeedTwo'))
  const head: PlanItem = kind === 'squash' && message !== undefined
    ? { hash: target.hash, action: 'pick', message }
    : { hash: target.hash, action: 'pick' }
  return [
    head,
    ...folded.map((c): PlanItem => ({ hash: c.hash, action: 'fixup' })),
    ...rest.filter((c) => !selected.has(c.hash)).map((c): PlanItem => ({ hash: c.hash, action: 'pick' }))
  ]
}

/** A POSIX-shell single-quoted word; git runs the sequence editor and `exec` lines through sh. */
export function shQuote(text: string): string {
  return `'${text.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`
}

/**
 * The todo file for `plan`. Squash and reword become `fixup`/`pick` followed by an `exec` that
 * amends the message from a file, so git never opens an editor.
 */
export function buildTodo(
  plan: PlanItem[],
  messages: Map<string, string>,
  writeMessage: (text: string) => string,
  gitBin = 'git'
): string {
  const lines: string[] = []
  let group: { message: string; explicit?: string; reword?: string; squashes: string[] } | null = null
  const close = () => {
    if (!group) return
    let final: string | undefined = group.explicit
    if (final === undefined && group.squashes.length) final = [group.reword ?? group.message, ...group.squashes].join('\n\n')
    if (final === undefined) final = group.reword
    if (final !== undefined) {
      if (!final.trim()) throw new Error(t('commitMessageEmpty'))
      // As `git commit -F` cleans up: a line that starts with # (an issue number) is part of the message, not a comment.
      lines.push(`exec ${shQuote(gitBin)} commit --amend --allow-empty --no-verify --cleanup=whitespace -F ${shQuote(writeMessage(final))}`)
    }
    group = null
  }
  const seen = new Set<string>()
  for (const item of plan) {
    if (!/^[0-9a-f]{40}$/.test(item.hash)) throw new Error(t('invalidCommitHash', { hash: item.hash }))
    if (seen.has(item.hash)) throw new Error(t('commitTwice', { hash: item.hash.slice(0, 8) }))
    seen.add(item.hash)
    const original = messages.get(item.hash) ?? ''
    switch (item.action) {
      case 'drop':
        lines.push(`drop ${item.hash}`)
        break
      case 'pick':
      case 'reword':
        close()
        lines.push(`pick ${item.hash}`)
        group = {
          message: original,
          squashes: [],
          ...(item.action === 'pick' && item.message !== undefined ? { explicit: item.message } : {}),
          ...(item.action === 'reword' ? { reword: item.message ?? original } : {})
        }
        break
      case 'fixup':
      case 'squash':
        if (!group) throw new Error(t('noEarlierCommit', { hash: item.hash.slice(0, 8), action: item.action }))
        lines.push(`fixup ${item.hash}`)
        if (item.action === 'squash') group.squashes.push(item.message ?? original)
        break
      default:
        throw new Error(t('unknownRebaseAction', { action: (item as PlanItem).action }))
    }
  }
  close()
  return lines.join('\n') + '\n'
}

export async function gitPath(git: Git, name: string): Promise<string> {
  return (await git.out(['rev-parse', '--path-format=absolute', '--git-path', name])).trim()
}

export async function operationInProgress(git: Git): Promise<'rebase' | 'merge' | 'cherry-pick' | 'revert' | null> {
  const checks: [string, 'rebase' | 'merge' | 'cherry-pick' | 'revert'][] = [
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert']
  ]
  for (const [name, kind] of checks) if (existsSync(await gitPath(git, name))) return kind
  // A cherry-pick or revert of several commits keeps its todo list here, also once a stop was committed by hand.
  const todo = join(await gitPath(git, 'sequencer'), 'todo')
  if (existsSync(todo)) return readFileSync(todo, 'utf8').startsWith('revert') ? 'revert' : 'cherry-pick'
  return null
}

/** A cherry-pick or revert of several commits that left only its todo list (.git/sequencer): no commit is stopped on. */
export async function todoOnly(git: Git, operation: string | null): Promise<boolean> {
  return (operation === 'cherry-pick' || operation === 'revert') && !existsSync(await gitPath(git, operation === 'revert' ? 'REVERT_HEAD' : 'CHERRY_PICK_HEAD'))
}

/** Why an action that moves HEAD must not run now, or null. A lone todo list gets `--quit` as the way out: `--abort` resets staged changes. */
export async function operationRefusal(git: Git): Promise<string | null> {
  const operation = await operationInProgress(git)
  if (!operation) return null
  return t((await todoOnly(git, operation)) ? 'opTodoLeft' : 'opInProgress', { operation })
}

/** Files staged against HEAD. */
async function stagedFiles(git: Git): Promise<string[]> {
  const result = await git.run(['diff', '--cached', '--name-only', '-z', '--'])
  return result.ok ? result.stdout.split('\0').filter(Boolean) : []
}

/**
 * Runs `run`, an operation with --autostash, and says so in its message when files staged before are staged no
 * more: git puts the stash back without the staging (new files stay added), whether the operation ran or was aborted.
 */
export async function noteUnstaged<R extends { message: string }>(git: Git, run: () => Promise<R>): Promise<R> {
  const before = await stagedFiles(git)
  const result = await run()
  if (!before.length) return result
  const after = new Set(await stagedFiles(git))
  return before.some((file) => !after.has(file)) ? { ...result, message: `${result.message} ${t('stagingLost')}` } : result
}

/** git exits 0 when the autostash does not apply cleanly: the changes stay in the stash and the tree has conflicts. */
export async function autostashConflict(git: Git): Promise<boolean> {
  return Boolean((await git.run(['diff', '--name-only', '--diff-filter=U', '--'])).stdout.trim())
}

/** Remote branches that already contain `hash`: rewriting it then needs a force push. */
export async function pushedTo(git: Git, hash: string): Promise<string[]> {
  const result = await git.run(['for-each-ref', '--contains', hash, '--format=%(refname:short)', 'refs/remotes'])
  return result.ok ? result.stdout.split(/\r?\n/).filter((name) => name && !name.endsWith('/HEAD')) : []
}

/** Runs `git rebase -i` with `todo` as the whole todo list; aborts and throws on any failure. */
export async function runRebase(git: Git, base: string | null, plan: PlanItem[], messages: Map<string, string>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-git-log-'))
  try {
    let count = 0
    const todo = buildTodo(plan, messages, (text) => {
      const file = join(dir, `message-${++count}.txt`)
      writeFileSync(file, text.endsWith('\n') ? text : text + '\n')
      return file
    }, git.gitPath)
    const todoFile = join(dir, 'todo')
    writeFileSync(todoFile, todo)
    const result = await git.run(
      [
        '-c', 'rebase.abbreviateCommands=false',
        '-c', 'rebase.updateRefs=false',
        '-c', 'rebase.missingCommitsCheck=ignore',
        '-c', 'advice.waitingForEditor=false',
        'rebase', '-i', '--autostash', '--no-autosquash', '--empty=drop',
        base ?? '--root'
      ],
      {
        env: { GIT_SEQUENCE_EDITOR: `cp ${shQuote(todoFile)}`, GIT_EDITOR: ':' },
        timeoutMs: 120_000
      }
    )
    if (!result.ok || (await operationInProgress(git)) === 'rebase') {
      const reason = lastLines(result.stderr || result.stdout, 4)
      if ((await operationInProgress(git)) === 'rebase') await git.run(['rebase', '--abort'])
      throw new Error(`${t('rebaseFailed')}${reason ? `\n${reason}` : ''}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

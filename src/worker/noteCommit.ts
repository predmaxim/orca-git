import type { NoteAnchor } from '../shared/protocol.ts'
import type { Git } from './git.ts'
import { parseRaw, RAW_ENTRY } from './log.ts'

const HASH = /^[0-9a-f]{40}$/

/**
 * The full hash of the commit whose own diff (with its first parent) changes the content of a note on the note's side, so
 * the Diff tab shows the note there: on the new side the newest from `rev` back (when the newest whose diff holds the
 * content does not change it, as a pure rename, the first that does among the 50 newest that hold it); on the old side the
 * oldest after `rev` on HEAD's history, else on every branch, remote branch and tag. Null when there is none, when `rev` or
 * `blob` is not 40 hex, or when git refuses (a revision it does not know). Throws when git was stopped (the time limit of
 * a read on a long history): the commit may be there.
 */
export async function findNoteCommit(git: Git, note: Pick<NoteAnchor, 'side' | 'blob' | 'rev'>): Promise<string | null> {
  const { side, blob, rev } = note
  if (!HASH.test(blob) || !HASH.test(rev)) return null
  const changes = (oldBlob?: string, newBlob?: string) => (side === 'new' ? newBlob === blob && oldBlob !== blob : oldBlob === blob && newBlob !== blob)
  /** The commits git shows (their diff holds the content), and of them those whose diff changes it. */
  const search = async (revisions: string[]) => {
    // --encoding=UTF-8: under i18n.logOutputEncoding=UTF-16 git would print even the hashes in UTF-16.
    // --root: under log.showRoot=false git would show no diff for a root commit, which writes content too.
    const log = await git.run(['log', '--encoding=UTF-8', '-M', '--root', '--diff-merges=first-parent', '--raw', '--no-abbrev', '-z', `--find-object=${blob}`, '--format=%H', ...revisions, '--'])
    // Stopped, not refused: git gave no answer, which is not "no commit".
    if (log.code === null) throw new Error(log.stderr)
    const shown: string[] = []
    const found: string[] = []
    if (!log.ok) return { shown, found }
    // Per commit: `<hash>\0`, then a newline and `:<modes> <blobs> <status>\0<path>\0` (two paths for a rename) per file.
    const fields = log.stdout.split('\0')
    for (let i = 0; HASH.test(fields[i] ?? ''); ) {
      const hash = fields[i++]
      const start = i
      while (RAW_ENTRY.test(fields[i] ?? '')) i += / [RC]\d*$/.test(fields[i]) ? 3 : 2
      shown.push(hash)
      // --find-object also gives a pure rename, whose two sides are both the note's content: its diff is empty.
      if (parseRaw(fields.slice(start, i).join('\0')).some((f) => changes(f.oldBlob, f.newBlob))) found.push(hash)
    }
    return { shown, found }
  }
  if (side === 'new') {
    // -n counts the commits shown, and git walks on until it has them: -n 1 stops at the newest that holds the content.
    const newest = await search(['-n', '1', rev])
    if (newest.found.length || !newest.shown.length) return newest.found[0] ?? null
    return (await search(['-n', '50', rev])).found[0] ?? null
  }
  return (await search(['HEAD', `^${rev}`])).found.at(-1) ?? (await search(['--branches', '--remotes', '--tags', `^${rev}`])).found.at(-1) ?? null
}

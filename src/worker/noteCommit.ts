import type { NoteAnchor } from '../shared/protocol.ts'
import type { Git } from './git.ts'
import { parseRaw, RAW_ENTRY } from './log.ts'

const HASH = /^[0-9a-f]{40}$/

/**
 * The full hash of the commit whose own diff (with its first parent) changes the content of a note on the note's side, so
 * the Diff tab shows the note there: on the new side the newest from `rev` back (of the first 50 whose diff holds the
 * content: pure renames hold it too); on the old side the oldest after `rev` on HEAD's history, else on every branch,
 * remote branch and tag. Null when there is none, when `rev` or `blob` is not 40 hex, or when git refuses (a revision it
 * does not know).
 */
export async function findNoteCommit(git: Git, note: Pick<NoteAnchor, 'side' | 'blob' | 'rev'>): Promise<string | null> {
  const { side, blob, rev } = note
  if (!HASH.test(blob) || !HASH.test(rev)) return null
  const changes = (oldBlob?: string, newBlob?: string) => (side === 'new' ? newBlob === blob && oldBlob !== blob : oldBlob === blob && newBlob !== blob)
  const search = async (revisions: string[]): Promise<string[]> => {
    // --encoding=UTF-8: under i18n.logOutputEncoding=UTF-16 git would print even the hashes in UTF-16.
    const log = await git.run(['log', '--encoding=UTF-8', '-M', '--diff-merges=first-parent', '--raw', '--no-abbrev', '-z', `--find-object=${blob}`, '--format=%H', ...revisions, '--'])
    if (!log.ok) return []
    // Per commit: `<hash>\0`, then a newline and `:<modes> <blobs> <status>\0<path>\0` (two paths for a rename) per file.
    const fields = log.stdout.split('\0')
    const found: string[] = []
    for (let i = 0; HASH.test(fields[i] ?? ''); ) {
      const hash = fields[i++]
      const start = i
      while (RAW_ENTRY.test(fields[i] ?? '')) i += / [RC]\d*$/.test(fields[i]) ? 3 : 2
      // --find-object also gives a pure rename, whose two sides are both the note's content: its diff is empty.
      if (parseRaw(fields.slice(start, i).join('\0')).some((f) => changes(f.oldBlob, f.newBlob))) found.push(hash)
    }
    return found
  }
  if (side === 'new') return (await search(['-n', '50', rev]))[0] ?? null
  return (await search(['HEAD', `^${rev}`])).at(-1) ?? (await search(['--branches', '--remotes', '--tags', `^${rev}`])).at(-1) ?? null
}

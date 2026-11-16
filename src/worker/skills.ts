// Review skills of a repository: up to MAX_REVIEW_SKILLS paths the user sets, named first in the notes an agent gets.
import { createHash } from 'node:crypto'
import { readdirSync, statSync, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { t } from '../shared/i18n.ts'
import { MAX_REVIEW_SKILLS } from '../shared/notes.ts'
import type { NoteStore } from './notes.ts'

// A control character in a path would forge lines of notes.md.
const CONTROL = /[\x00-\x1f\x7f]/

/** A path as it is stored: trimmed, without trailing slashes (a lone «/» stays), so `docs` and `docs/` are one entry. */
const tidy = (path: string): string => path.trim().replace(/(?<=.)\/+$/, '')

export function skillsKey(root: string): string {
  return 'skills:' + createHash('sha256').update(root).digest('hex')
}

/** The path as the file system has it: `~` and `~/…` from the home folder, a relative path from `root`. */
export function skillPathAbs(path: string, root: string): string {
  if (path === '~' || /^~[\\/]/.test(path)) return join(homedir(), path.slice(1))
  return isAbsolute(path) ? path : join(root, path)
}

/** What the path is once links are followed; undefined when it is missing or cannot be read (a broken link, a loop). */
function kind(path: string): Stats | undefined {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

const exists = (path: string): boolean => {
  const stat = kind(path)
  return stat !== undefined && (stat.isFile() || stat.isDirectory())
}

// shortcut: a folder of tens of thousands of entries is listed whole and its answer may pass Orca's 1 MiB; filter by the typed name here if that matters.
export function browseSkills(dir: string, root: string, wanted: (name: string) => boolean = (name) => /\.md$/i.test(name)): { dirs: string[]; files: string[] } {
  const abs = skillPathAbs(dir, root)
  let names: string[]
  try {
    names = readdirSync(abs).filter((name: string) => name !== '.git').sort()
  } catch {
    return { dirs: [], files: [] }
  }
  const dirs: string[] = []
  const files: string[] = []
  for (const name of names) {
    const stat = kind(join(abs, name))
    if (stat?.isDirectory()) dirs.push(name)
    else if (stat?.isFile() && wanted(name)) files.push(name)
  }
  return { dirs, files }
}

/**
 * The list as it can be stored: strings trimmed and without trailing slashes, empty ones and repeats dropped; or why not.
 * Only a path not in `stored` (the list stored now) has to exist: a skill gone from the disk can stay or go.
 */
export function checkSkills(input: unknown, root: string, stored: string[] = []): { ok: true; skills: string[] } | { ok: false; reason: string } {
  const invalid = { ok: false as const, reason: t('skillInvalid') }
  if (!Array.isArray(input)) return invalid
  const known = new Set(stored.map(tidy))
  const skills: string[] = []
  for (const item of input) {
    if (typeof item !== 'string') return invalid
    const path = tidy(item)
    if (path.length > 1024 || CONTROL.test(path)) return invalid
    if (path && !skills.includes(path)) skills.push(path)
  }
  if (skills.length > MAX_REVIEW_SKILLS) return { ok: false, reason: t('skillsFull') }
  const missing = skills.find((path) => !known.has(path) && !exists(skillPathAbs(path, root)))
  return missing === undefined ? { ok: true, skills } : { ok: false, reason: t('skillMissing', { path: missing }) }
}

export async function listSkills(store: NoteStore, root: string): Promise<string[]> {
  const value = (await store.get(skillsKey(root))) as { skills?: unknown } | null | undefined
  return Array.isArray(value?.skills) ? value.skills.filter((path): path is string => typeof path === 'string') : []
}

export async function saveSkills(store: NoteStore, root: string, skills: string[]): Promise<void> {
  if (skills.length) await store.set(skillsKey(root), { root, skills })
  else await store.delete(skillsKey(root))
}

/**
 * The stored skills that exist now, as full paths, in order, each once (`a.md` and `./a.md` are one: the first stays).
 * Frames share the storage: what `checkSkills` refuses is dropped here too.
 */
export async function skillsForReview(store: NoteStore, root: string): Promise<string[]> {
  const found: string[] = []
  const seen = new Set<string>()
  for (const stored of await listSkills(store, root)) {
    if (!stored.trim()) continue
    const path = skillPathAbs(stored.trim(), root)
    if (CONTROL.test(path) || seen.has(resolve(path)) || !exists(path)) continue
    seen.add(resolve(path))
    found.push(path)
  }
  return found.slice(0, MAX_REVIEW_SKILLS)
}

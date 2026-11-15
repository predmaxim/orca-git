import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '../shared/i18n.ts'
import { MAX_REPLY } from '../shared/notes.ts'
import type { NoteReply, NoteVerdict, ReviewNote } from '../shared/protocol.ts'
import { REVIEW_GUIDE } from './reviewGuide.ts'

export interface ReviewPaths { dir: string; notes: string; guide: string; answers: string }

const FOLDER = '.orca-git-log'
const ID = /^[0-9a-f]{12}$/

/** <root>/.orca-git-log/review-<review>/ with notes.md, SKILL.md and answers/. */
export function reviewPaths(root: string, review: string): ReviewPaths {
  const dir = join(root, FOLDER, `review-${review}`)
  return { dir, notes: join(dir, 'notes.md'), guide: join(dir, 'SKILL.md'), answers: join(dir, 'answers') }
}

const indent = (text: string): string => text.split(/\r?\n/).map((line) => `    ${line}`).join('\n')

export function notesFile(notes: ReviewNote[], paths: ReviewPaths): string {
  const head = [
    '# Review notes',
    `Write one answer file per note to \`${join(paths.answers, '<note id>.md')}\`. The first line is \`verdict: confirmed | refuted | unclear\`, the second \`fixed: yes | no\`, then a blank line, then markdown: what you checked, the evidence, your confidence (0-100), what you changed and what you did not check. Write each answer file once, when you are done with that note — after the fix, if you make one.`
  ].join('\n\n')
  const each = notes.map((n) =>
    [
      `## Note ${n.id}`,
      `File: ${n.path}`,
      `Lines: ${n.start.line}-${n.end.line}, ${n.side} side, as of commit ${n.rev} (git show ${n.rev}:${n.path})`,
      'Selected:',
      indent(n.quote),
      'Comment:',
      n.body
    ].join('\n')
  )
  return `${[head, ...each].join('\n\n')}\n`
}

export function reviewPrompt(paths: ReviewPaths): string {
  return `Review notes from the user are in ${paths.notes}. Work through every note: check it against the code, answer it (confirmed, refuted or unclear) with your evidence, and fix the code for each note you confirm. Use this project's own review skills and rules first (.claude/skills, .agents/skills, AGENTS.md, CLAUDE.md); where they say nothing, follow ${paths.guide}. Write one answer file per note into ${paths.answers}, in the form the notes file describes.`
}

/** Why `prompt` cannot go to `agent.launch`, or null: Orca takes at most 4096 characters, and the prompt must stay one line with no backtick whatever the repository path holds. */
export function promptRefusal(prompt: string): string | null {
  if (prompt.length > 4096) return t('reviewPromptTooLong')
  if (/[\x00-\x1f\x7f`]/.test(prompt)) return t('reviewPathUnusable')
  return null
}

/** Whether `path` is a real folder: a link or a file in its place is not. */
function isFolder(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Makes the folder and its files; on a refusal or a failed write removes what it made. */
export function writeReview(root: string, review: string, notes: ReviewNote[]): { ok: true; paths: ReviewPaths } | { ok: false; reason: string } {
  const paths = reviewPaths(root, review)
  const parent = join(root, FOLDER)
  if (!ID.test(review)) return { ok: false, reason: t('reviewDirTaken', { path: paths.dir }) }
  let madeParent = false
  let madeDir = false
  try {
    try {
      mkdirSync(parent)
      madeParent = true
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
    }
    if (!isFolder(parent)) return { ok: false, reason: t('reviewDirTaken', { path: parent }) }
    try {
      mkdirSync(paths.dir)
      madeDir = true
    } catch (error: any) {
      if (error?.code === 'EEXIST') return { ok: false, reason: t('reviewDirTaken', { path: paths.dir }) }
      throw error
    }
    mkdirSync(paths.answers)
    for (const [file, text] of [[paths.notes, notesFile(notes, paths)], [paths.guide, REVIEW_GUIDE]]) {
      // wx: never follows a link and never replaces a file.
      const fd = openSync(file, 'wx')
      try {
        writeFileSync(fd, text)
      } finally {
        closeSync(fd)
      }
    }
    return { ok: true, paths }
  } catch (error: any) {
    if (madeDir) rmSync(paths.dir, { recursive: true, force: true })
    if (madeParent) {
      try {
        rmdirSync(parent)
      } catch {
        // Not empty: not ours to take.
      }
    }
    return { ok: false, reason: t('reviewWriteFailed', { code: error?.code ?? String(error) }) }
  }
}

/** Removes the folder of a review; nothing but a real folder named review-<12 hex> inside a real .orca-git-log. Best effort: never throws. */
export function removeReview(root: string, review: string): void {
  if (!ID.test(review)) return
  const { dir } = reviewPaths(root, review)
  try {
    if (isFolder(join(root, FOLDER)) && isFolder(dir)) rmSync(dir, { recursive: true, force: true })
  } catch {
    // The folder stays; the caller has nothing to do about it.
  }
}

const VERDICTS: readonly string[] = ['confirmed', 'refuted', 'unclear']
const MAX_ANSWER = 65536

const blank = (line: string): boolean => line.trim() === ''

/**
 * Blank lines and one markdown heading may come first; then `verdict:` and `fixed:` lines in any order and case, up to
 * a blank line, then the markdown. Keys may be wrapped in `*`, `_` or backticks, values also in quotes and end with a
 * period, as agents decorate them. Null without a known verdict, or with any other line before the blank one.
 */
export function parseAnswer(text: string, now = Date.now()): NoteReply | null {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n')
  let at = 0
  while (at < lines.length && blank(lines[at])) at++
  if (at < lines.length && lines[at].trimStart().startsWith('#')) {
    at++
    while (at < lines.length && blank(lines[at])) at++
  }
  const head = new Map<string, string>()
  for (; at < lines.length && !blank(lines[at]); at++) {
    const colon = lines[at].indexOf(':')
    const key = colon < 0 ? '' : lines[at].slice(0, colon).replace(/^[\s*_`]+|[\s*_`]+$/g, '').toLowerCase()
    if (key !== 'verdict' && key !== 'fixed') return null
    const value = lines[at].slice(colon + 1).replace(/^[\s*_`'"]+|[\s*_`'"]+$/g, '').replace(/\.$/, '').trim().toLowerCase()
    if (!head.has(key)) head.set(key, value)
  }
  const verdict = head.get('verdict')
  if (!verdict || !VERDICTS.includes(verdict)) return null
  let body = lines.slice(at + 1).join('\n').trim().slice(0, MAX_REPLY)
  // The cut must not leave half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(body)) body = body.slice(0, -1)
  return { verdict: verdict as NoteVerdict, fixed: ['yes', 'true'].includes(head.get('fixed') ?? ''), body, at: now }
}

const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = constants

/** The text of an answer file; null unless it is a regular file of at most MAX_ANSWER bytes, never through a link. */
function readAnswerFile(path: string): string | null {
  let fd: number
  try {
    fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_ANSWER) return null
    const bytes = new Uint8Array(stat.size)
    const read = readSync(fd, bytes, 0, bytes.length, 0)
    return new TextDecoder().decode(bytes.subarray(0, read))
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/**
 * The answers found for the sent notes, answered ones too (the agent may have rewritten its file): answers/<note id>.md,
 * a regular file of at most 65536 bytes, never through a link. A note whose id is not 12 hex is skipped: frames share the
 * storage, so a stored id is not guaranteed.
 */
export function readAnswers(root: string, notes: ReviewNote[], now = Date.now()): Map<string, NoteReply> {
  const found = new Map<string, NoteReply>()
  for (const note of notes) {
    if (!note.review || !ID.test(note.review) || !ID.test(note.id)) continue
    const text = readAnswerFile(join(reviewPaths(root, note.review).answers, `${note.id}.md`))
    const reply = text === null ? null : parseAnswer(text, now)
    if (reply) found.set(note.id, reply)
  }
  return found
}

import { closeSync, lstatSync, mkdirSync, openSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '../shared/i18n.ts'
import type { ReviewNote } from '../shared/protocol.ts'
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
    `Write one answer file per note to \`${join(paths.answers, '<note id>.md')}\`. The first line is \`verdict: confirmed | refuted | unclear\`, the second \`fixed: yes | no\`, then a blank line, then markdown: what you checked, the evidence, your confidence (0-100), what you changed and what you did not check.`
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

/** Removes the folder of a review; nothing but a real folder named review-<12 hex> inside a real .orca-git-log. */
export function removeReview(root: string, review: string): void {
  if (!ID.test(review)) return
  const { dir } = reviewPaths(root, review)
  if (isFolder(join(root, FOLDER)) && isFolder(dir)) rmSync(dir, { recursive: true, force: true })
}

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { t } from '../shared/i18n.ts'
import { IMAGE_ID, lastAnswer, MAX_REPLY, unsentOf, waitingFor } from '../shared/notes.ts'
import type { NoteMessage, NoteReply, NoteVerdict, ReviewNote } from '../shared/protocol.ts'
import { REVIEW_GUIDE } from './reviewGuide.ts'

export interface ReviewPaths { dir: string; notes: string; guide: string; answers: string }

const FOLDER = '.orca-git-log'
const ID = /^[0-9a-f]{12}$/

/** <root>/.orca-git-log/review-<review>/ with notes.md, SKILL.md and answers/. */
export function reviewPaths(root: string, review: string): ReviewPaths {
  const dir = join(root, FOLDER, `review-${review}`)
  return { dir, notes: join(dir, 'notes.md'), guide: join(dir, 'SKILL.md'), answers: join(dir, 'answers') }
}

// Every line break a reader may start a line at, so no body line is left at column 0.
const indent = (text: string): string => text.split(/\r\n|[\n\r\v\f\x85\u2028\u2029]/).map((line) => `    ${line}`).join('\n')

export function notesFile(notes: ReviewNote[], paths: ReviewPaths, skills: string[] = []): string {
  const head = [
    '# Review notes',
    `Write one answer file per thread to \`${join(paths.answers, '<thread id>.md')}\`. The first line is \`verdict: answered | confirmed | refuted | unclear\` (\`answered\` — the note was a question and you answered it), the second \`fixed: yes | no\`, then a blank line, then the answer in markdown, very short and with no filler: the answer itself (to a question — what the user asked; to a request or a claim — what you did or why you did not), with the facts (a code snippet, a file:line reference, or a screenshot of the design mockup, saved next to the answer file and shown as \`![caption](file-name.png)\` with the file's bare name). Write each answer file once, when you are done with that note — after the fix, if you make one. A thread can hold earlier messages: read them all, answer the messages marked NEW, and do not repeat what was already answered. A line starting with "Images:" under a message lists the files attached to that message: open them.`,
    ...(skills.length ? [['Review skills to use first, in this order (each is a file, or a folder with a SKILL.md):', ...skills.map((path, i) => `${i + 1}. ${path}`)].join('\n')] : [])
  ].join('\n\n')
  const each = notes.map((n) => {
    const fresh = new Set(unsentOf(n))
    return [
      `## Thread ${n.id}`,
      `File: ${n.path}`,
      `Lines: ${n.start.line}-${n.end.line}, ${n.side} side, as of commit ${n.rev} (git show ${n.rev}:${n.path})`,
      'Selected:',
      indent(n.quote),
      'Messages, oldest first:',
      ...n.messages.flatMap((m, i) => {
        const time = new Date(m.at).toISOString()
        // An agent's message names the user's messages of the send it answers: a reply written meanwhile may stand between.
        const asked = m.author === 'agent' && m.review !== undefined ? n.messages.flatMap((u, j) => (u.author === 'user' && u.review === m.review ? [`[${j + 1}]`] : [])) : []
        const who = m.author === 'agent' ? `agent (${m.verdict ?? 'unclear'}, fixed: ${m.fixed ? 'yes' : 'no'}), ${time}${asked.length ? `, answers ${asked.join(', ')}` : ''}` : `user, ${time}${fresh.has(m) ? ' — NEW, answer this' : ''}`
        const files = (m.images ?? []).filter((image) => IMAGE_ID.test(image.id)).map((image) => join(dirname(paths.dir), 'images', image.id))
        // Structure at column 0, the body indented: a body line `Images: …` never passes for an attachment.
        return [`[${i + 1}] ${who}:`, ...(files.length ? [`Images: ${files.join(', ')}`] : []), indent(m.body)]
      })
    ].join('\n')
  })
  return `${[head, ...each].join('\n\n')}\n`
}

/**
 * With `withSkills`, the review skills `notesFile` lists come first; their paths stay out of the prompt. The fixed words
 * hold no shell metacharacter, so only a path can bring one (`promptRefusal` with `typed`).
 */
export function reviewPrompt(paths: ReviewPaths, withSkills = false): string {
  const rules = withSkills
    ? `The review skills listed at the top of ${paths.notes} come first, then the review skills and rules of this project - .claude/skills, .agents/skills, AGENTS.md, CLAUDE.md.`
    : 'The review skills and rules of this project come first - .claude/skills, .agents/skills, AGENTS.md, CLAUDE.md.'
  // The user's skills and the project's rules win over the plugin's guide; what they do not contradict of it still applies.
  return `Review notes from the user are in ${paths.notes}. Work through every note: answer a question, make a requested change or say why it should not be made, check a claim against the code and fix the code when it holds. Answer each note as answered, confirmed, refuted or unclear, with your evidence. ${rules} A rule of ${paths.guide} that contradicts them does not apply, the rest of ${paths.guide} applies with them. Write one answer file per note into ${paths.answers}, in the form the notes file describes.`
}

/**
 * Why `prompt` cannot be delivered, or null: Orca takes at most 4096 characters, and the prompt must stay one line with no
 * backtick whatever the repository path holds. One `typed` into a terminal also holds no shell metacharacter: a line that
 * reaches a shell instead of an agent must hold no substitution, redirection, glob or second command.
 */
export function promptRefusal(prompt: string, typed = false): string | null {
  if (prompt.length > 4096) return t('reviewPromptTooLong')
  if (/[\x00-\x1f\x7f`]/.test(prompt) || (typed && /['"$;&|<>()\\*?!#~{}[\]]/.test(prompt))) return t('reviewPathUnusable')
  return null
}

/** Whether `path` is a real folder: a link or a file in its place is not. */
export function isFolder(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Makes the folder and its files; on a refusal or a failed write removes what it made. */
export function writeReview(root: string, review: string, notes: ReviewNote[], skills: string[] = []): { ok: true; paths: ReviewPaths } | { ok: false; reason: string } {
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
    for (const [file, text] of [[paths.notes, notesFile(notes, paths, skills)], [paths.guide, REVIEW_GUIDE]]) {
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

const VERDICTS: readonly string[] = ['answered', 'confirmed', 'refuted', 'unclear']
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
 * The answers found by note id, each for the send the note waits for, else for the send its last answer is for (the agent
 * may have rewritten its file): answers/<note id>.md, a regular file of at most 65536 bytes, never through a link. A note
 * or send whose id is not 12 hex is skipped: frames share the storage, so a stored id is not guaranteed.
 */
export function readAnswers(root: string, notes: ReviewNote[], now = Date.now()): Map<string, Omit<NoteMessage, 'id' | 'author'> & { review: string }> {
  const found = new Map<string, Omit<NoteMessage, 'id' | 'author'> & { review: string }>()
  for (const note of notes) {
    const review = waitingFor(note) ?? lastAnswer(note)?.review
    if (!review || !ID.test(review) || !ID.test(note.id)) continue
    // The folders above the file are real ones: a link in any of them is not followed.
    if (!isFolder(join(root, FOLDER)) || !isFolder(reviewPaths(root, review).dir) || !isFolder(reviewPaths(root, review).answers)) continue
    const text = readAnswerFile(join(reviewPaths(root, review).answers, `${note.id}.md`))
    const reply = text === null ? null : parseAnswer(text, now)
    // The kind of agent is on the user's messages the send marked.
    const agent = note.messages.find((m) => m.author === 'user' && m.review === review)?.agent
    if (reply) found.set(note.id, { ...reply, review, ...(agent ? { agent } : {}) })
  }
  return found
}

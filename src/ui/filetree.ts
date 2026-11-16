// The file tree of a commit selection, drawn; the tree itself is built in shared/filetree.ts.
import type { ReviewNote, SelectionFile } from '../shared/protocol.ts'
import type { FileNode } from '../shared/filetree.ts'
import { t, type MessageKey } from '../shared/i18n.ts'
import { lastAnswer, noteTone, type NoteTone } from '../shared/notes.ts'
import { h, icon, mountTree } from './dom.ts'
import { fileIcon, folderIcon } from './fileicons.ts'
import { shortHash, statusName } from './format.ts'
import { active } from './notemodel.ts'

export interface FileTreeHost {
  /** Paths of the open folders. */
  expanded: Set<string>
  /** Path of the file shown as current. */
  current: string | null
  open(file: SelectionFile): void
  onToggle(): void
  /** The review notes shown under `file`, in their order: its own, those carried to it, and the outdated ones with `outdated`. */
  notes?(file: SelectionFile): ReviewNote[]
  /** Opens `file` in the Diff tab, scrolled to the card of `note`; an outdated note, in the commit it was written in. */
  openNote?(file: SelectionFile, note: ReviewNote): void
}

const STATE: Record<NoteTone, MessageKey> = { unsent: 'noteUnsent', waiting: 'noteSent', answered: 'noteAnswered', done: 'noteConfirmed', resolved: 'noteResolve' }

/** The tooltip of a note row: path, lines, side and state of the note, that its lines changed when outdated, then its first message whole. */
export function noteTip(note: ReviewNote): string {
  const tone = noteTone(note)
  const lines = note.start.line === note.end.line ? `${note.start.line}` : `${note.start.line}-${note.end.line}`
  const outdated = note.outdated ? `${t('noteOutdatedTip', { rev: shortHash(note.rev) })}\n` : ''
  return t('fileNoteTip', {
    path: note.path,
    lines,
    side: t(note.side === 'old' ? 'noteSideOld' : 'noteSideNew'),
    state: t(tone === 'done' && lastAnswer(note)?.fixed ? 'noteFixed' : STATE[tone]),
    message: outdated + (note.messages[0]?.body ?? '')
  })
}

/** Every folder path in `nodes`, for expand all. */
export function dirPaths(nodes: FileNode[]): string[] {
  return nodes.flatMap((node) => (node.kind === 'dir' ? [node.path, ...dirPaths(node.children)] : []))
}

export function renderFileTree(container: HTMLElement, nodes: FileNode[], host: FileTreeHost): void {
  const rows: HTMLElement[] = []
  const depths: number[] = []
  const walk = (list: FileNode[], depth: number): void => {
    for (const node of list) {
      depths.push(depth)
      const pad = `${6 + depth * 14}px`
      if (node.kind === 'dir') {
        const open = host.expanded.has(node.path)
        const toggle = () => {
          if (open) host.expanded.delete(node.path)
          else host.expanded.add(node.path)
          host.onToggle()
        }
        rows.push(
          h(
            'div',
            {
              class: 'ft-row ft-dir',
              style: `padding-left:${pad}`,
              dataset: { key: node.path },
              role: 'treeitem',
              'aria-expanded': String(open),
              onclick: toggle
            },
            icon(open ? 'chevronDown' : 'chevronRight'),
            folderIcon(),
            h('span', { class: 'name' }, node.name),
            h('span', { class: 'ft-count' }, String(node.count))
          )
        )
        if (open) walk(node.children, depth + 1)
      } else {
        const { file } = node
        const letter = file.status[0] ?? 'M'
        const open = () => host.open(file)
        const notes = host.notes?.(file) ?? []
        const unresolved = active(notes).length
        rows.push(
          h(
            'div',
            {
              class: `ft-row file openable st-${letter}${host.current === file.path ? ' current' : ''}`,
              style: `padding-left:${pad}`,
              dataset: { key: file.path },
              role: 'treeitem',
              title: `${statusName(letter) ?? file.status}: ${file.oldPath ? `${file.oldPath} → ` : ''}${file.path}`,
              onclick: open
            },
            h('span', { class: 'status-letter' }, letter),
            fileIcon(node.name),
            h('span', { class: 'name' }, node.name),
            unresolved > 0 && h('span', { class: 'ft-count ft-notes' }, icon('note'), String(unresolved))
          )
        )
        // Its notes, as Azure DevOps lists the threads of a file under it: leaves one level deeper, open ones first.
        for (const note of notes) {
          depths.push(depth + 1)
          const tone = noteTone(note)
          rows.push(
            h(
              'div',
              {
                class: `ft-row ft-note${tone === 'resolved' ? ' resolved' : ''}`,
                style: `padding-left:${6 + (depth + 1) * 14}px`,
                // Starts with the file path and a slash: focus falls back to the file when the row goes.
                dataset: { key: `${file.path}/#${note.id}` },
                role: 'treeitem',
                title: noteTip(note),
                onclick: () => host.openNote?.(file, note)
              },
              // An outdated note (its lines changed in this version) stands at its own line, with a dashed circle.
              note.outdated ? h('span', { class: 'note-dot outdated' }) : tone === 'resolved' ? icon('check') : h('span', { class: `note-dot tone-${tone}` }),
              h('span', { class: 'mono muted' }, note.start.line),
              h('span', { class: 'name' }, (note.messages[0]?.body ?? '').split('\n', 1)[0])
            )
          )
        }
      }
    }
  }
  walk(nodes, 0)
  mountTree(container, rows, depths, 'ft')
}

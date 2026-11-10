// The files changed by a commit selection as a folder tree. Pure tree building on top, DOM below.
import type { SelectionFile } from '../shared/protocol.ts'
import { h, icon, mountTree } from './dom.ts'
import { fileIcon, folderIcon } from './fileicons.ts'
import { statusName } from './format.ts'

export type FileNode =
  | { kind: 'dir'; name: string; path: string; count: number; children: FileNode[] }
  | { kind: 'file'; name: string; file: SelectionFile }

interface Folder {
  dirs: Map<string, Folder>
  files: SelectionFile[]
}

const byName = (a: FileNode, b: FileNode): number => a.name.localeCompare(b.name)

/** Folders first, then files, each by name; a folder whose only child is a folder merges with it (`web/app`). */
export function buildFileTree(files: SelectionFile[]): FileNode[] {
  const root: Folder = { dirs: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let folder = root
    for (const part of parts.slice(0, -1)) {
      if (!folder.dirs.has(part)) folder.dirs.set(part, { dirs: new Map(), files: [] })
      folder = folder.dirs.get(part)!
    }
    folder.files.push(file)
  }
  const convert = (folder: Folder, prefix: string): FileNode[] => {
    const dirs: FileNode[] = [...folder.dirs].map(([name, child]) => {
      let label = name
      let path = prefix + name
      let node = child
      while (node.files.length === 0 && node.dirs.size === 1) {
        const [[next, inner]] = node.dirs
        label += `/${next}`
        path += `/${next}`
        node = inner
      }
      const children = convert(node, `${path}/`)
      const count = children.reduce((sum, c) => sum + (c.kind === 'dir' ? c.count : 1), 0)
      return { kind: 'dir', name: label, path, count, children }
    })
    const leaves: FileNode[] = folder.files.map((file) => ({ kind: 'file', name: file.path.slice(file.path.lastIndexOf('/') + 1), file }))
    return [...dirs.sort(byName), ...leaves.sort(byName)]
  }
  return convert(root, '')
}

/** The files in the order the tree draws them. */
export function orderedFiles(nodes: FileNode[]): SelectionFile[] {
  return nodes.flatMap((node) => (node.kind === 'file' ? [node.file] : orderedFiles(node.children)))
}

export interface FileTreeHost {
  /** Paths of the open folders. */
  expanded: Set<string>
  /** Path of the file shown as current. */
  current: string | null
  open(file: SelectionFile): void
  onToggle(): void
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
            h('span', { class: 'name' }, node.name)
          )
        )
      }
    }
  }
  walk(nodes, 0)
  mountTree(container, rows, depths, 'ft')
}

// The file tree of a commit selection, drawn; the tree itself is built in shared/filetree.ts.
import type { SelectionFile } from '../shared/protocol.ts'
import type { FileNode } from '../shared/filetree.ts'
import { h, icon, mountTree } from './dom.ts'
import { fileIcon, folderIcon } from './fileicons.ts'
import { statusName } from './format.ts'

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

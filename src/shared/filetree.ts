// The files changed by a commit selection as a folder tree, in the order the panel draws it. Shared: the worker opens the Diff tab in the same order.
import type { SelectionFile } from './protocol.ts'

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

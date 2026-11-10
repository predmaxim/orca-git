import type { ActionRequest, ActionResult, BackupDelete, BackupRequest, BranchAction, BranchActionResult, BranchRef, CommitDetails, CommitRow, LogFilter, RefsResult, RepoInfo, RepoResult, RewriteKind, SelectionFile, WorkspaceChoice } from '../shared/protocol.ts'
import { api, copyText, errorMessage, orca } from './api.ts'
import { backupBlock, suggestBackupName, type BackupBlock } from './backup.ts'
import { buildFileTree, dirPaths, orderedFiles, renderFileTree, type FileNode } from './filetree.ts'
import { renderBranches } from './branches.ts'
import { renderCommitList, renderPlaceholder } from './details.ts'
import { askName, askPatch, askRebasePlan, askReset, busy, confirm, editMessage, pushedWarning } from './dialogs.ts'
import { h, icon } from './dom.ts'
import { createFilterBar } from './filters.ts'
import { reachableFrom, refLabels, relativeDate, fullDate, shortHash } from './format.ts'
import { computeGraph, graphSvg, ROW_HEIGHT, TWO_LINE_ROW_HEIGHT, type GraphRow } from './graph.ts'
import { showMenu, type MenuEntry } from './menu.ts'
import { createColumn, normalizeSections, type SectionPrefs } from './sections.ts'
import { pickLocale, setLocale, t } from '../shared/i18n.ts'

setLocale(pickLocale(orca.locale))

const PREFS_KEY = 'git-log.prefs.panel'

interface Prefs {
  regex: boolean
  matchCase: boolean
  sections: SectionPrefs
  collapsed: string[]
  /** Workspace picked by the user, keyed by the ids of the same-named workspaces it was picked among. */
  picked: Record<string, string>
}

const stored = (() => {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
  } catch {
    return {}
  }
})()
const prefs: Prefs = {
  regex: false,
  matchCase: false,
  collapsed: ['tags'],
  picked: {},
  ...stored,
  sections: normalizeSections(stored?.sections)
}
const savePrefs = () => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))

// ---------- State ----------

let repo: RepoInfo | null = null
let refs: RefsResult | null = null
let rows: CommitRow[] = []
let graph: GraphRow[] = []
let reachable = new Set<string>()
/** First-parent chain from HEAD within the loaded rows, newest first. */
let mainline: CommitRow[] = []
let indexByHash = new Map<string, number>()
let hasMore = false
let loading = false
let loadToken = 0
let loadError: string | null = null
let choices: WorkspaceChoice[] = []
let filter: LogFilter = {}
const selected = new Set<string>()
let anchor = -1
let cursor = -1
const collapsed = new Set(prefs.collapsed)

const isFiltered = () =>
  Boolean(filter.text?.trim() || filter.users?.length || filter.since || filter.until || filter.paths?.length)

// ---------- Layout ----------

const app = document.getElementById('app')!

const searchInput = h('input', { placeholder: t('searchPlaceholder'), spellcheck: false, 'aria-label': t('searchAria') }) as HTMLInputElement
const regexToggle = h('button', { class: `toggle${prefs.regex ? ' on' : ''}`, title: t('regexTip') }, '.*')
const caseToggle = h('button', { class: `toggle${prefs.matchCase ? ' on' : ''}`, title: t('matchCaseTip') }, 'Cc')
const refreshButton = h('button', { class: 'tool', title: t('refresh') }, icon('refresh'))
const fetchButton = h('button', { class: 'tool', title: t('fetch') }, icon('down'))

const filterBar = createFilterBar({
  get filter() {
    return filter
  },
  get refs() {
    return refs
  },
  apply: (change) => applyFilter(change)
})

const toolbar = h('div', { class: 'toolbar' }, h('div', { class: 'spacer' }), refreshButton, fetchButton)
const filterRow = h('div', { class: 'toolbar' }, h('label', { class: 'search' }, icon('search'), searchInput, regexToggle, caseToggle), ...filterBar.elements)

const bannerText = h('div', { class: 'text' })
const bannerActions = h('div', { style: 'display:flex;gap:12px' })
const banner = h(
  'div',
  { class: 'banner', role: 'status' },
  bannerText,
  bannerActions,
  h('button', { class: 'tool', title: t('dismiss'), onclick: () => hideBanner() }, icon('close'))
)

const treeSearch = h('input', { class: 'field tree-search', placeholder: t('searchBranches'), spellcheck: false }) as HTMLInputElement
const tree = h('div', { class: 'tree' })

const header = h(
  'div',
  { class: 'header columns' },
  h('div', { class: 'subject' }, t('colSubject')),
  h('div', { class: 'author' }, t('colAuthor')),
  h('div', { class: 'date' }, t('colDate')),
  h('div', { class: 'hash' }, t('colHash'))
)
const sizer = h('div', { class: 'sizer' })
const viewport = h('div', { class: 'viewport', tabindex: 0, role: 'grid', 'aria-multiselectable': 'true' }, sizer)
const empty = h('div', { class: 'empty' })
const logPane = h('section', { class: 'pane log' }, header, viewport, empty)

const column = createColumn(['branches', 'commits', 'files', 'details'], prefs.sections, onSections)
column.section('branches').body.append(treeSearch, tree)
column.section('commits').body.append(filterRow, logPane)
const filesSection = column.section('files')
const filesPane = filesSection.body
filesSection.header.append(
  h('button', { class: 'tool', title: t('expandAll'), 'aria-label': t('expandAll'), onclick: () => setAllFolders(true) }, icon('chevronDown')),
  h('button', { class: 'tool', title: t('collapseAll'), 'aria-label': t('collapseAll'), onclick: () => setAllFolders(false) }, icon('chevronRight'))
)
renderFilesNote(t('filesPlaceholder'))
const detailsPane = column.section('details').body

app.append(toolbar, banner, column.element)

function onSections(): void {
  savePrefs()
  if (detailsStale) updateDetails()
}

// The visible rows depend on the log's own height, which the section splitters change too.
// Below 520 px the log shows two lines per row; the row height follows so scrolling stays consistent.
const TWO_LINE_BELOW = 520
let rowH = ROW_HEIGHT
function fitRowHeight(): void {
  // offsetWidth includes the scrollbar, so the mode never changes the measured width; the gap is hysteresis.
  const width = viewport.offsetWidth
  const narrow = width > 0 && (rowH === TWO_LINE_ROW_HEIGHT ? width < TWO_LINE_BELOW + 20 : width < TWO_LINE_BELOW)
  const next = narrow ? TWO_LINE_ROW_HEIGHT : ROW_HEIGHT
  if (next !== rowH) {
    const firstRow = viewport.scrollTop / rowH
    rowH = next
    logPane.classList.toggle('two-line', next === TWO_LINE_ROW_HEIGHT)
    viewport.style.setProperty('--row-h', `${rowH}px`)
    // Grow the sizer now, or scrollTop is clamped to the old scroll height.
    sizer.style.height = `${(rows.length + (hasMore ? 1 : 0)) * rowH}px`
    viewport.scrollTop = firstRow * rowH
  }
  renderRows()
}
// Hiding the header resizes the viewport, so apply on the next frame to avoid a resize loop.
new ResizeObserver(() => requestAnimationFrame(fitRowHeight)).observe(viewport)

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

// ---------- Banner ----------

let bannerTimer: ReturnType<typeof setTimeout> | undefined

function showBanner(text: string, kind: 'success' | 'error' | 'info', actions: { label: string; run: () => void }[] = [], sticky = false): void {
  clearTimeout(bannerTimer)
  banner.className = `banner show ${kind}`
  bannerText.textContent = text
  bannerActions.replaceChildren(
    ...actions.map((a) =>
      h(
        'button',
        {
          class: 'link',
          onclick: () => {
            hideBanner()
            a.run()
          }
        },
        a.label
      )
    )
  )
  if (!sticky && kind !== 'error') bannerTimer = setTimeout(hideBanner, actions.length ? 15_000 : 6_000)
}

function hideBanner(): void {
  clearTimeout(bannerTimer)
  banner.className = 'banner'
  if (repo?.operation) showOperationBanner()
}

function showOperationBanner(): void {
  if (!repo?.operation) return
  showBanner(
    t(repo.todoOnly ? 'opTodoLeft' : 'operationBanner', { operation: repo.operation }),
    'info',
    [],
    true
  )
}

// ---------- Rows ----------

function recompute(): void {
  indexByHash = new Map(rows.map((row, i) => [row.hash, i]))
  graph = computeGraph(rows, isFiltered())
  reachable = reachableFrom(repo?.head.hash ?? null, rows)
  mainline = []
  for (let i = indexByHash.get(repo?.head.hash ?? ''); i !== undefined; i = indexByHash.get(rows[i].parents[0] ?? '')) {
    mainline.push(rows[i])
  }
}

/** Why the selection can't be rewritten by a rebase from HEAD (mirrors the worker's checks), if it can't. */
function rewriteBlocker(hashes: string[], fixupParent: boolean): string | undefined {
  if (isFiltered()) return undefined
  const position = new Map(mainline.map((row, i) => [row.hash, i]))
  let oldest = -1
  for (const hash of hashes) {
    const i = position.get(hash)
    if (i === undefined) {
      return reachable.has(hash)
        ? t('rewriteMergedBranch')
        : t('rewriteOnlyCurrent')
    }
    oldest = Math.max(oldest, i)
  }
  if (fixupParent) oldest++
  const merge = mainline.slice(0, oldest + 1).find((row) => row.parents.length > 1)
  if (merge) return t('rewriteAcrossMerge', { hash: shortHash(merge.hash) })
  return undefined
}

function renderEmpty(): void {
  let text = ''
  let retry = false
  if (!repo) text = loadError ?? t('diffLoading')
  else if (loadError) {
    text = loadError
    retry = true
  } else if (!rows.length) text = loading ? t('diffLoading') : isFiltered() || filter.branches?.length ? t('noCommitsMatch') : t('noCommitsYet')
  empty.style.display = text ? '' : 'none'
  if (!repo && choices.length) {
    empty.replaceChildren(
      h('div', {}, text),
      h(
        'div',
        { class: 'choices' },
        ...choices.map((choice) =>
          h(
            'button',
            { class: 'choice', title: choice.path, onclick: () => pick(choice) },
            h('span', { class: 'choice-path' }, choice.path),
            choice.branch ? h('span', { class: 'choice-branch' }, choice.branch) : ''
          )
        )
      )
    )
    return
  }
  empty.replaceChildren(text, retry ? h('button', { class: 'btn', onclick: () => void refreshAll() }, t('retry')) : '')
}

const choiceKey = (list: WorkspaceChoice[]) => list.map((c) => c.id).sort().join('|')

function pick(choice: WorkspaceChoice): void {
  prefs.picked[choiceKey(choices)] = choice.id
  savePrefs()
  void start()
}

function rowElement(index: number): HTMLElement {
  const commit = rows[index]
  const isHead = commit.hash === repo?.head.hash
  const dim = !isFiltered() && reachable.size > 0 && !reachable.has(commit.hash)
  const labels = refLabels(commit.refs, repo?.head.branch ?? null)
  const subject = h('div', { class: 'cell subject' })
  subject.innerHTML = graphSvg(graph[index], { head: isHead, dim, merge: commit.parents.length > 1, height: rowH })
  const twoLine = rowH === TWO_LINE_ROW_HEIGHT
  const line = twoLine ? h('div', { class: 'line' }) : subject
  if (twoLine) subject.append(h('div', { class: 'stack' }, line, h('div', { class: 'meta' }, `${commit.author} \u00b7 ${relativeDate(commit.authorTime)}`)))
  line.append(h('span', { class: 'text' }, commit.subject))
  if (labels.length) {
    line.append(
      h(
        'span',
        { class: 'refs' },
        ...labels.map((label) =>
          h(
            'span',
            { class: `ref ${label.kind}${label.current ? ' current' : ''}`, title: label.refs.join(', ') },
            icon(label.kind === 'tag' ? 'tag' : label.current ? 'star' : 'branch'),
            h('span', null, label.text)
          )
        )
      )
    )
  }
  const committerDiffers = commit.committer !== commit.author
  return h(
    'div',
    {
      class: `row ${twoLine ? 'two' : 'columns'}${selected.has(commit.hash) ? ' selected' : ''}${dim ? ' dim' : ''}${isHead ? ' head' : ''}`,
      style: `top:${index * rowH}px`,
      dataset: { index: String(index) },
      role: 'row',
      'aria-selected': String(selected.has(commit.hash))
    },
    subject,
    ...(twoLine ? [] : [h(
      'div',
      {
        class: `cell author${refs?.me && commit.author === refs.me ? ' me' : ''}`,
        title: `${commit.author} <${commit.email}>${committerDiffers ? `\n${t('authorCommittedBy', { name: commit.committer })}` : ''}`
      },
      commit.author + (committerDiffers ? '*' : '')
    ),
    h('div', { class: 'cell date', title: fullDate(commit.authorTime) }, relativeDate(commit.authorTime)),
    h('div', { class: 'cell hash mono', title: commit.hash }, shortHash(commit.hash))])
  )
}

let renderQueued = false
function renderRows(): void {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    const top = viewport.scrollTop
    const height = viewport.clientHeight || 600
    const first = Math.max(0, Math.floor(top / rowH) - 10)
    const last = Math.min(rows.length, Math.ceil((top + height) / rowH) + 10)
    sizer.style.height = `${(rows.length + (hasMore ? 1 : 0)) * rowH}px`
    const children: HTMLElement[] = []
    for (let i = first; i < last; i++) children.push(rowElement(i))
    if (hasMore && last >= rows.length) {
      children.push(h('div', { class: 'loading-more', style: `top:${rows.length * rowH}px` }, h('div', { class: 'spin' })))
    }
    sizer.replaceChildren(...children)
    renderEmpty()
    if (hasMore && !loading && !loadError && last >= rows.length - 40) void loadMore()
  })
}

viewport.addEventListener('scroll', renderRows, { passive: true })

// ---------- Loading ----------

async function reloadLog(keepCount = false): Promise<void> {
  if (!repo) return
  const token = ++loadToken
  loading = true
  loadError = null
  if (!keepCount) {
    rows = []
    recompute()
  }
  renderRows()
  const limit = keepCount && rows.length > 300 ? Math.min(rows.length, 2000) : undefined
  try {
    const page = await api.page(repo.root, filter, 0, limit)
    if (token !== loadToken) return
    rows = page.commits
    hasMore = page.hasMore
  } catch (error) {
    if (token !== loadToken) return
    rows = []
    hasMore = false
    loadError = errorMessage(error)
  }
  loading = false
  recompute()
  const before = selected.size
  for (const hash of [...selected]) if (!indexByHash.has(hash)) selected.delete(hash)
  cursor = selected.size ? Math.min(...[...selected].map((h) => indexByHash.get(h)!)) : -1
  if (anchor >= rows.length) anchor = cursor
  renderRows()
  if (selected.size !== before) updateFiles()
  updateDetails()
}

/** The page being fetched, so a second caller waits for it instead of returning at once. */
let pageLoad: Promise<void> | null = null

function loadMore(): Promise<void> {
  if (loading) return pageLoad ?? filterReload
  if (!repo || !hasMore) return Promise.resolve()
  const load = loadPage().finally(() => {
    if (pageLoad === load) pageLoad = null
  })
  pageLoad = load
  return load
}

/** Pages in rows until `done()`, the log ends or 10 000 rows are loaded; stops when a page changes nothing. */
async function loadUntil(done: () => boolean): Promise<void> {
  await filterReload
  while (!done() && hasMore && rows.length < 10_000) {
    const token = loadToken
    const before = rows.length
    await loadMore()
    if (token !== loadToken) await filterReload // a reload replaced the list; start over on the new one
    else if (rows.length === before && hasMore) return
  }
}

async function loadPage(): Promise<void> {
  if (!repo) return
  const token = loadToken
  loading = true
  try {
    const page = await api.page(repo.root, filter, rows.length)
    if (token !== loadToken) return
    const known = new Set(rows.map((r) => r.hash))
    rows = rows.concat(page.commits.filter((c) => !known.has(c.hash)))
    hasMore = page.hasMore && page.commits.length > 0
  } catch (error) {
    if (token !== loadToken) return
    hasMore = false
    showBanner(t('loadMoreFailed', { error: errorMessage(error) }), 'error')
  } finally {
    if (token === loadToken) loading = false
  }
  recompute()
  renderRows()
}

async function loadRefs(): Promise<void> {
  if (!repo) return
  try {
    refs = await api.refs(repo.root)
    repo.head = refs.head
  } catch (error) {
    refs = null
    showBanner(t('refsFailed', { error: errorMessage(error) }), 'error')
  }
  renderTree()
  filterBar.update()
}

let refreshing: Promise<void> | null = null
async function refreshAll(): Promise<void> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    if (!repo) return start()
    const result = await api.resolve(repo.root).catch((error) => ({ ok: false as const, reason: errorMessage(error) }))
    if (!result.ok) {
      loadError = result.reason
      renderEmpty()
      return
    }
    const wasOperation = repo.operation
    repo = { ...result.repo, workspaceId: repo.workspaceId }
    if (repo.operation) showOperationBanner()
    else if (wasOperation) hideBanner()
    // A jump waits for this reload too, so it lands on the refreshed rows.
    filterReload = reloadLog(true)
    await Promise.all([loadRefs(), filterReload])
  })().finally(() => (refreshing = null))
  return refreshing
}

let changeTimer: ReturnType<typeof setTimeout> | undefined
const scheduleRefresh = (delay = 200) => {
  clearTimeout(changeTimer)
  changeTimer = setTimeout(() => void refreshAll(), delay)
}

function setRepo(next: RepoInfo): void {
  const same = repo?.root === next.root
  repo = next
  loadError = null
  if (!same) {
    selected.clear()
    detailsKey = ''
    detailsCache.clear()
    anchor = cursor = -1
    updateFiles()
    filter = { ...filter, branches: [] }
    viewport.scrollTop = 0
    document.title = t('docTitle', { name: next.name })
    void api.watch(next.root).catch(() => undefined)
  }
  if (next.operation) showOperationBanner()
  void loadRefs()
  filterReload = reloadLog(same)
}

async function start(): Promise<void> {
  try {
    let result: RepoResult = await api.resolve()
    if (!result.ok && result.choices?.length) {
      const saved = prefs.picked[choiceKey(result.choices)]
      if (saved && result.choices.some((c) => c.id === saved)) result = await api.resolve(undefined, saved)
    }
    choices = !result.ok ? (result.choices ?? []) : []
    if (result.ok) setRepo(result.repo)
    else {
      repo = null
      rows = []
      refs = null
      loadError = result.reason
      selected.clear()
      recompute()
      renderTree()
      renderRows()
      updateFiles()
      updateDetails()
    }
  } catch (error) {
    loadError = errorMessage(error)
    renderEmpty()
  }
}

// ---------- Filters ----------

/** The reload the latest filter change started; a jump waits for it so it lands on the new rows. */
let filterReload: Promise<void> = Promise.resolve()

function applyFilter(change: Partial<LogFilter>): void {
  filter = { ...filter, ...change }
  for (const key of Object.keys(filter) as (keyof LogFilter)[]) {
    const value = filter[key]
    if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) delete filter[key]
  }
  filterBar.update()
  renderTree()
  filterReload = reloadLog()
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => applyFilter({ text: searchInput.value.trim() }), 300)
})
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    clearTimeout(searchTimer)
    applyFilter({ text: searchInput.value.trim() })
  } else if (event.key === 'Escape' && searchInput.value) {
    searchInput.value = ''
    applyFilter({ text: '' })
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    viewport.focus()
    if (!selected.size && rows.length) selectOnly(0)
  }
})
const toggleOption = (button: HTMLElement, key: 'regex' | 'matchCase') => {
  prefs[key] = !prefs[key]
  button.classList.toggle('on', prefs[key])
  savePrefs()
  applyFilter({ [key]: prefs[key] || undefined })
}
regexToggle.addEventListener('click', () => toggleOption(regexToggle, 'regex'))
caseToggle.addEventListener('click', () => toggleOption(caseToggle, 'matchCase'))
if (prefs.regex) filter.regex = true
if (prefs.matchCase) filter.matchCase = true

// ---------- Branches tree ----------

/** The ref "Show Backup" highlighted in the tree. */
let revealed: string | null = null

function renderTree(): void {
  const head = repo?.head
  column.section('branches').setSummary(head?.branch ?? (head?.hash ? shortHash(head.hash) : ''))
  renderBranches(
    tree,
    {
      refs,
      filtered: filter.branches ?? [],
      collapsed,
      onCollapse: () => {
        prefs.collapsed = [...collapsed]
        savePrefs()
        renderTree()
      },
      select: (hash) => void jumpTo(hash),
      revealed,
      filterTo: (full) => applyFilter({ branches: filter.branches?.length === 1 && filter.branches[0] === full ? [] : [full] }),
      menu: (event, ref) => branchMenu(event, ref)
    },
    treeSearch.value
  )
}
treeSearch.addEventListener('input', renderTree)
// Any click in the tree ends the "Show Backup" highlight.
tree.addEventListener('mousedown', () => (revealed = null))

/** Opens the branches section and the folders down to `full`, highlights it and scrolls to it. */
function reveal(full: string): void {
  // The header's own click handler opens the section and saves the layout.
  if (prefs.sections.collapsed.branches) column.section('branches').header.click()
  const parts = full.split('/').slice(2, -1)
  const ids = full.startsWith('refs/tags/') ? ['tags'] : ['local', ...parts.map((_, i) => `local:${parts.slice(0, i + 1).join('/')}`)]
  for (const id of ids) collapsed.delete(id)
  prefs.collapsed = [...collapsed]
  savePrefs()
  treeSearch.value = ''
  revealed = full
  renderTree()
  tree.querySelector('.node-row.active')?.scrollIntoView({ block: 'nearest' })
}

function branchMenu(event: MouseEvent, ref: BranchRef & { kind: 'local' | 'remote' | 'tag' | 'head' }): void {
  if (!repo) return
  const scope = scopeOf(repo)
  const current = ref.kind === 'local' && ref.name === repo.head.branch
  const localName = ref.kind === 'remote' ? ref.name.slice(ref.name.indexOf('/') + 1) : ref.name
  const entries: MenuEntry[] = [
    ref.kind === 'local'
      ? { label: t('checkout'), icon: 'checkout', disabled: current, hint: t('checkoutAlready'), run: () => void act(scope, { kind: 'checkout', target: ref.name }, t('checkingOut', { name: ref.name })) }
      : ref.kind === 'remote'
        ? {
            label: t('checkoutAs', { name: localName }),
            icon: 'checkout',
            disabled: Boolean(refs?.locals.some((l) => l.name === localName)),
            hint: t('localBranchExists', { name: localName }),
            run: () => void act(scope, { kind: 'checkout', target: localName }, t('checkingOut', { name: localName }))
          }
        : { label: t('checkoutRevision'), icon: 'checkout', disabled: ref.kind === 'head', run: () => void act(scope, { kind: 'checkout', target: ref.hash }, t('checkingOutBare')) },
    { label: t('newBranchFrom', { name: ref.name }), icon: 'branch', run: () => void newBranch(scope, ref.hash) },
    'separator',
    { icon: 'search', label: filter.branches?.includes(ref.full) ? t('showAllBranches') : t('showOnly', { name: ref.name }), run: () => applyFilter({ branches: filter.branches?.includes(ref.full) ? [] : [ref.full] }) },
    { label: t('copyName'), icon: 'copy', run: () => copyText(ref.name) }
  ]
  const backup = (ref.kind === 'local' || ref.kind === 'tag') && ref.name.startsWith('backup/')
  const deleteBackupEntry: MenuEntry = { label: t('backupDelete'), icon: 'drop', run: () => void removeBackup(scope, ref) }
  if (backup) {
    const operation = repo.operation
    entries.unshift(
      {
        label: t('backupRestore', { name: repo.head.branch ?? 'HEAD' }),
        icon: 'reset',
        disabled: current || Boolean(operation),
        hint: operation ? t('hintOperation', { operation }) : t('checkoutAlready'),
        run: () => void restoreBackup(scope, ref)
      },
      'separator'
    )
    if (ref.kind === 'tag') entries.push('separator', deleteBackupEntry)
  }
  if (ref.kind === 'local' || ref.kind === 'remote') {
    entries.push('separator')
    if (ref.kind === 'local') {
      entries.push({ label: t('branchRename'), icon: 'edit', run: () => void renameBranch(scope, ref.name) })
      if (!current) entries.push(backup ? deleteBackupEntry : { label: t('branchDelete'), icon: 'drop', run: () => void deleteBranch(scope, ref.name, ref.hash) })
    }
    if (!current) {
      entries.push(
        // The worker takes the full ref: a short name can mean another ref (heads/x, tags/x, a tag named like the branch).
        { label: t('branchMerge'), icon: 'branch', run: () => void act(scope, { kind: 'merge', name: ref.full }, t('branchMerging', { name: ref.name })) },
        { label: t('branchRebase'), icon: 'rebase', run: () => void rebaseOnto(scope, ref) }
      )
    }
  }
  showMenu(event.clientX, event.clientY, entries)
}

// ---------- Selection ----------

function selectedHashes(): string[] {
  return [...selected].sort((a, b) => (indexByHash.get(a) ?? 0) - (indexByHash.get(b) ?? 0))
}

function ensureVisible(index: number): void {
  const top = index * rowH
  if (top < viewport.scrollTop) viewport.scrollTop = top
  else if (top + rowH > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + rowH - viewport.clientHeight
}

function selectionChanged(): void {
  renderRows()
  updateFiles()
  updateDetails()
}

function selectOnly(index: number): void {
  if (index < 0 || index >= rows.length) return
  selected.clear()
  selected.add(rows[index].hash)
  anchor = cursor = index
  ensureVisible(index)
  selectionChanged()
}

function selectRange(to: number, additive: boolean): void {
  if (to < 0 || to >= rows.length) return
  if (anchor < 0) anchor = to
  if (!additive) selected.clear()
  for (let i = Math.min(anchor, to); i <= Math.max(anchor, to); i++) selected.add(rows[i].hash)
  cursor = to
  ensureVisible(to)
  selectionChanged()
}

async function jumpTo(hash: string): Promise<void> {
  await loadUntil(() => indexByHash.has(hash))
  const index = indexByHash.get(hash)
  if (index === undefined) {
    showBanner(isFiltered() || filter.branches?.length ? t('commitHidden') : t('commitNotInLog'), 'info')
    return
  }
  selectOnly(index)
  viewport.scrollTop = Math.max(0, index * rowH - viewport.clientHeight / 3)
  viewport.focus({ preventScroll: true })
}

viewport.addEventListener('mousedown', (event) => {
  const row = (event.target as HTMLElement).closest<HTMLElement>('.row')
  if (!row) return
  const index = Number(row.dataset.index)
  const hash = rows[index]?.hash
  if (!hash) return
  viewport.focus({ preventScroll: true })
  if (event.button === 2) {
    if (!selected.has(hash)) selectOnly(index)
    return
  }
  if (event.button !== 0) return
  if (event.shiftKey) selectRange(index, event.ctrlKey || event.metaKey)
  else if (event.ctrlKey || event.metaKey) {
    if (selected.has(hash)) selected.delete(hash)
    else selected.add(hash)
    anchor = cursor = index
    selectionChanged()
  } else selectOnly(index)
})

viewport.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  if ((event.target as HTMLElement).closest('.row') && selected.size) commitMenu(event.clientX, event.clientY)
})

viewport.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey
  const page = Math.max(1, Math.floor(viewport.clientHeight / rowH) - 1)
  const move = (to: number) => {
    to = clamp(to, 0, rows.length - 1)
    if (event.shiftKey) selectRange(to, mod)
    else selectOnly(to)
  }
  switch (event.key) {
    case 'ArrowDown':
      move(cursor + 1)
      break
    case 'ArrowUp':
      move(cursor < 0 ? 0 : cursor - 1)
      break
    case 'PageDown':
      move(cursor + page)
      break
    case 'PageUp':
      move(cursor - page)
      break
    case 'Home':
      move(0)
      break
    case 'End':
      move(rows.length - 1)
      break
    case 'a':
    case 'A':
      if (!mod) return
      rows.forEach((r) => selected.add(r.hash))
      anchor = 0
      cursor = rows.length - 1
      selectionChanged()
      break
    case 'c':
    case 'C':
      if (!mod || !selected.size) return
      copyHashes()
      break
    case 'F10':
      if (!event.shiftKey) return
    // falls through
    case 'ContextMenu': {
      if (!selected.size) return
      const rect = viewport.getBoundingClientRect()
      commitMenu(rect.left + 40, rect.top + Math.max(0, (cursor + 1) * rowH - viewport.scrollTop))
      break
    }
    case 'Escape':
      if (!selected.size) return
      selected.clear()
      selectionChanged()
      break
    default:
      return
  }
  event.preventDefault()
})

function copyHashes(): void {
  const hashes = selectedHashes()
  if (copyText(hashes.join(' '))) showBanner(hashes.length === 1 ? t('copiedHash', { hash: shortHash(hashes[0]) }) : t('copiedHashes', { count: hashes.length }), 'success')
}

// ---------- Files ----------

/** The files changed by the whole selection, in drawn order; the diff shows one of them. */
let selectionFiles: SelectionFile[] = []
let fileTree: FileNode[] = []
let currentFile: string | null = null
let filesToken = 0
const openFolders = new Set<string>()

function renderFilesNote(text: string): void {
  filesPane.replaceChildren(h('div', { class: 'sec-note' }, text))
}

function drawFiles(): void {
  renderFileTree(filesPane, fileTree, {
    expanded: openFolders,
    current: currentFile,
    open: (file) => openFile(selectionFiles.indexOf(file)),
    onToggle: drawFiles
  })
}

function setAllFolders(open: boolean): void {
  openFolders.clear()
  if (open) for (const path of dirPaths(fileTree)) openFolders.add(path)
  if (fileTree.length) drawFiles()
}

/** Makes `selectionFiles[index]` the current file and shows its diff in the Diff tab. */
function openFile(index: number): void {
  if (!repo || index < 0 || index >= selectionFiles.length) return
  currentFile = selectionFiles[index].path
  drawFiles()
  void openDiff(repo.root, index)
}

function updateFiles(): void {
  const token = ++filesToken
  const hashes = selectedHashes()
  selectionFiles = []
  fileTree = []
  if (!repo || !hashes.length) {
    currentFile = null
    filesSection.setSummary('')
    renderFilesNote(t('filesPlaceholder'))
    return
  }
  filesSection.setSummary('…')
  api
    .selectionFiles(repo.root, hashes)
    .then((files) => {
      if (token !== filesToken) return
      fileTree = buildFileTree(files)
      selectionFiles = orderedFiles(fileTree)
      openFolders.clear()
      for (const path of dirPaths(fileTree)) openFolders.add(path)
      // The open file stays open when the new selection still changes it.
      if (!selectionFiles.some((file) => file.path === currentFile)) currentFile = null
      filesSection.setSummary(t('filesCount', { count: files.length }))
      if (files.length) drawFiles()
      else renderFilesNote('')
    })
    .catch((error) => {
      if (token !== filesToken) return
      currentFile = null
      filesSection.setSummary('')
      renderFilesNote(errorMessage(error))
    })
}

// ---------- Details ----------

/** Open rows of the details list; reset when the selection changes: one commit opens, several stay closed. */
const expanded = new Set<string>()
let detailsKey = ''
/** Details by hash, until the repository changes. */
const detailsCache = new Map<string, Promise<CommitDetails>>()
/** The selection changed while the details section was collapsed: render it when it opens. */
let detailsStale = false
function updateDetails(): void {
  const hashes = selectedHashes()
  column.section('commits').setSummary(selected.size ? t('selectedCount', { count: selected.size }) : '')
  column.section('details').setSummary(hashes.length ? t('commitsCount', { count: hashes.length }) : '')
  detailsStale = prefs.sections.collapsed.details
  if (detailsStale) return
  if (!repo || !hashes.length) {
    detailsKey = ''
    renderPlaceholder(detailsPane, repo ? t('detailsPlaceholder') : '')
    return
  }
  if (hashes.join() !== detailsKey) {
    detailsKey = hashes.join()
    expanded.clear()
    if (hashes.length === 1) expanded.add(hashes[0])
  }
  const root = repo.root
  renderCommitList(
    detailsPane,
    hashes.map((hash) => rows[indexByHash.get(hash)!]).filter(Boolean),
    {
      expanded,
      load: (hash) => {
        const key = `${root}\0${hash}`
        let details = detailsCache.get(key)
        if (!details) {
          details = api.details(root, hash)
          detailsCache.set(key, details)
          // A failed load must not stay cached.
          details.catch(() => detailsCache.delete(key))
        }
        return details
      },
      select: (hash) => void jumpTo(hash),
      onToggle: () => {}
    }
  )
}

// ---------- Actions ----------

const UNDOABLE = new Set<string>(['cherryPick', 'revert', 'reset', 'squash', 'fixup', 'drop', 'reword', 'rebase', 'merge', 'rebaseOnto'])
const BRANCH_KINDS = new Set<string>(['rename', 'delete', 'merge', 'rebaseOnto'])
/** Actions on the current branch: they run only on the HEAD the user saw when the flow started. */
const ON_HEAD = new Set<string>([...UNDOABLE, 'undo'])

/** The repository a flow acts on and the HEAD it saw, taken before the flow's first dialog. */
interface Scope {
  root: string
  /** Undefined skips the HEAD check. */
  head?: string | null
}

const scopeOf = (info: RepoInfo): Scope => ({ root: info.root, head: info.head.hash })

/**
 * Whether the shown repository is still the one `scope` was taken on (and, with `onHead`, still at
 * its HEAD); a workspace switch swaps it while a dialog is open. When not, a banner says nothing ran.
 */
function unchanged(scope: Scope, onHead = false): boolean {
  if (repo?.root === scope.root && (!onHead || scope.head === undefined || repo.head.hash === scope.head)) return true
  showBanner(t('repoChanged'), 'error')
  return false
}

/**
 * Runs `action` on the repository of `scope`. The worker refuses an action on the current branch when HEAD
 * is no longer the one `scope` saw, and makes `backup` before anything else.
 */
async function act(scope: Scope, action: ActionRequest | BranchAction | BackupDelete, progress: string, backup?: BackupRequest): Promise<BranchActionResult | null> {
  const onHead = ON_HEAD.has(action.kind)
  if (!unchanged(scope, onHead)) return null
  const root = scope.root
  const guard = { ...(onHead && scope.head ? { expectHead: scope.head } : {}), ...(backup ? { backup } : {}) }
  const done = busy(progress)
  let result: BranchActionResult
  try {
    if (action.kind === 'deleteBackup') result = await api.deleteBackup(root, action)
    else result = BRANCH_KINDS.has(action.kind) ? await api.branch(root, action as BranchAction, guard) : await api.run(root, action as ActionRequest, guard)
  } catch (error) {
    result = { ok: false, message: errorMessage(error) }
  } finally {
    done()
  }
  // The worker reports a backup it made even when the action then failed.
  const made = backup && result.backup ? `refs/${backup.kind === 'tag' ? 'tags' : 'heads'}/${result.backup}` : null
  const show = made ? [{ label: t('showBackup'), run: () => reveal(made) }] : []
  const text = [result.message, result.backup && t('backupMade', { name: result.backup }), result.stash && t('backupStashed', { hash: shortHash(result.stash) })].filter(Boolean).join(' ')
  if (result.ok) {
    if (action.kind === 'rename') followBranch(action.name, action.newName)
    else if (action.kind === 'delete') followBranch(action.name)
    else if (action.kind === 'deleteBackup') dropFilter(`refs/${action.ref === 'tag' ? 'tags' : 'heads'}/${action.name}`)
    const previous = result.previousHead
    // The Undo stays bound to this repository and, through the worker, to the HEAD this action left.
    const undo = previous && UNDOABLE.has(action.kind)
      ? [{ label: t('undo'), run: () => void act({ root, head: result.head }, { kind: 'reset', hash: previous, mode: 'keep' }, t('progUndoing')).then((r) => r?.ok && showBanner(t('restoredHead', { hash: shortHash(previous) }), 'success')) }]
      : []
    showBanner(text, result.warning ? 'info' : 'success', [...undo, ...show], result.warning)
  } else if (!result.needsForce) showBanner(text, 'error', show)
  await refreshAll()
  return result
}

/** Moves the log's branch filter to a renamed branch, or drops a deleted one: git fails on a missing ref. */
function followBranch(name: string, newName?: string): void {
  const old = `refs/heads/${name}`
  if (!filter.branches?.includes(old)) return
  applyFilter({ branches: filter.branches.flatMap((ref) => (ref !== old ? [ref] : newName ? [`refs/heads/${newName}`] : [])) })
}

const dropFilter = (full: string) => filter.branches?.includes(full) && applyFilter({ branches: filter.branches.filter((ref) => ref !== full) })

/** The backup offer for a confirmation; none when the `offerBackup` setting is off or there is no commit to keep. */
async function offerBackup(root: string, branch: string | null, target: string | null | undefined): Promise<BackupBlock | undefined> {
  if (!target) return undefined
  const settings = await orca.settings.get().catch((): Record<string, unknown> => ({}))
  if (settings.offerBackup === false) return undefined
  const taken = new Set([...(refs?.locals ?? []), ...(refs?.tags ?? [])].map((ref) => ref.name))
  return backupBlock({
    label: branch ?? 'HEAD',
    name: suggestBackupName(branch, target, taken, new Date()),
    target,
    kind: settings.backupKind === 'tag' ? 'tag' : 'branch',
    taken,
    onKind: (kind) => void orca.settings.set('backupKind', kind).catch(() => undefined),
    check: (kind, name) =>
      api.backupCheck(root, kind, name).then(
        (result) => (result.ok ? null : result.reason),
        (error) => errorMessage(error)
      )
  })
}

/** A backup of the current branch at the HEAD `scope` saw. */
const offerHeadBackup = (scope: Scope) => offerBackup(scope.root, repo?.head.branch ?? null, scope.head)

/** Confirms a rewrite of the current branch with the pushed warning and the backup offer; no dialog when there is neither. */
function confirmRewrite(title: string, pushed: string[], ok: string, backup?: BackupBlock): Promise<boolean> {
  if (!pushed.length && !backup) return Promise.resolve(true)
  return confirm(title, [t('rewriteConfirm', { name: repo?.head.branch ?? 'HEAD' }), pushed.length ? pushedWarning(pushed) : null], ok, pushed.length > 0, backup)
}

async function checked(scope: Scope, kind: RewriteKind, hashes: string[]) {
  const done = busy(t('checking'))
  try {
    const check = await api.check(scope.root, kind, hashes)
    if (!check.ok) {
      showBanner(check.reason, 'error')
      return null
    }
    return check
  } catch (error) {
    showBanner(errorMessage(error), 'error')
    return null
  } finally {
    done()
  }
}

const confirmPushed = (pushed: string[], what: string) =>
  pushed.length ? confirm(t('pushedTitle'), pushedWarning(pushed), what, true) : Promise.resolve(true)

async function squash(scope: Scope, hashes: string[]): Promise<void> {
  const check = await checked(scope, 'squash', hashes)
  if (!check) return
  const chosen = new Set(hashes)
  const combined = check.commits.filter((c) => chosen.has(c.hash)).map((c) => c.message).join('\n\n')
  const backup = await offerHeadBackup(scope)
  const message = await editMessage(t('squashTitle'), combined, t('btnSquash'), check.pushed.length ? pushedWarning(check.pushed) : null, backup)
  if (message) await act(scope, { kind: 'squash', hashes, message }, t('progSquashing', { count: hashes.length }), backup?.value())
}

async function fixup(scope: Scope, hashes: string[]): Promise<void> {
  const check = await checked(scope, 'fixup', hashes)
  if (!check) return
  const backup = await offerHeadBackup(scope)
  if (await confirmRewrite(hashes.length > 1 ? t('cmFixupMany') : t('cmFixupPrev'), check.pushed, t('btnFixup'), backup)) {
    await act(scope, { kind: 'fixup', hashes }, t('progFixingUp'), backup?.value())
  }
}

async function drop(scope: Scope, hashes: string[]): Promise<void> {
  const check = await checked(scope, 'drop', hashes)
  if (!check) return
  const backup = await offerHeadBackup(scope)
  if (await confirmRewrite(t('dropTitle', { count: hashes.length }), check.pushed, t('btnDrop'), backup)) {
    await act(scope, { kind: 'drop', hashes }, t('progDropping', { count: hashes.length }), backup?.value())
  }
}

async function reword(scope: Scope, hash: string): Promise<void> {
  const check = await checked(scope, 'reword', [hash])
  if (!check) return
  const current = check.commits.find((c) => c.hash === hash)?.message ?? ''
  const backup = await offerHeadBackup(scope)
  const message = await editMessage(t('rewordTitle'), current, t('ok'), check.pushed.length ? pushedWarning(check.pushed) : null, backup)
  if (message && message !== current) await act(scope, { kind: 'reword', hash, message }, t('progUpdatingMessage'), backup?.value())
}

async function rebaseFrom(scope: Scope, hash: string): Promise<void> {
  const check = await checked(scope, 'rebase', [hash])
  if (!check) return
  const backup = await offerHeadBackup(scope)
  const plan = await askRebasePlan(check.commits, check.pushed, backup)
  if (plan) await act(scope, { kind: 'rebase', plan }, t('progRebasing'), backup?.value())
}

async function undoCommit(scope: Scope, hash: string): Promise<void> {
  const check = await checked(scope, 'undo', [hash])
  if (check && (await confirmPushed(check.pushed, t('btnUndoCommit')))) await act(scope, { kind: 'undo', hash }, t('progUndoingCommit'))
}

async function newBranch(scope: Scope, hash: string): Promise<void> {
  const answer = await askName(t('newBranchTitle'), t('branchNameLabel'), t('create'), { label: t('checkoutBranchLabel'), checked: true })
  if (answer) await act(scope, { kind: 'branch', hash, name: answer.name, checkout: answer.checked }, t('progCreatingBranch'))
}

async function renameBranch(scope: Scope, name: string): Promise<void> {
  const answer = await askName(t('branchRenameTitle'), t('branchNewName'), t('branchRenameOk'), undefined, name)
  if (answer && answer.name !== name) await act(scope, { kind: 'rename', name, newName: answer.name }, t('branchRenaming', { name }))
}

/** `hash`: the branch tip the menu showed; the backup of an unmerged branch keeps it. */
async function deleteBranch(scope: Scope, name: string, hash: string): Promise<void> {
  if (!(await confirm(t('branchDeleteTitle'), t('branchDeleteConfirm', { name }), t('branchDelete'), true))) return
  const result = await act(scope, { kind: 'delete', name, force: false }, t('branchDeleting', { name }))
  if (!result?.needsForce) return
  const backup = await offerBackup(scope.root, name, hash)
  if (await confirm(t('branchDeleteTitle'), t('branchDeleteForce', { name }), t('branchDelete'), true, backup)) {
    await act(scope, { kind: 'delete', name, force: true }, t('branchDeleting', { name }), backup?.value())
  }
}

async function rebaseOnto(scope: Scope, ref: BranchRef): Promise<void> {
  const name = ref.name
  const done = busy(t('checking'))
  let pushed: string[]
  try {
    pushed = (await api.branchCheck(scope.root, ref.full)).pushed
  } catch (error) {
    showBanner(errorMessage(error), 'error')
    return
  } finally {
    done()
  }
  const backup = await offerHeadBackup(scope)
  if (await confirmRewrite(t('rebaseOntoTitle', { name: repo?.head.branch ?? 'HEAD', target: name }), pushed, t('btnRebase'), backup)) {
    await act(scope, { kind: 'rebaseOnto', name: ref.full }, t('branchRebasing', { name }), backup?.value())
  }
}

async function newTag(scope: Scope, hash: string): Promise<void> {
  const answer = await askName(t('newTagTitle', { hash: shortHash(hash) }), t('tagNameLabel'), t('create'))
  if (answer) await act(scope, { kind: 'tag', hash, name: answer.name }, t('progCreatingTag'))
}

async function reset(scope: Scope, hash: string): Promise<void> {
  const backup = await offerHeadBackup(scope)
  const mode = await askReset(repo?.head.branch ?? null, hash, backup)
  if (!mode) return
  const request = backup?.value()
  // Changes saved to the stash are not lost, so the warning is only for a hard reset without it.
  if (mode === 'hard' && !request?.stash && !(await confirm(t('hardResetTitle'), t('hardResetConfirm'), t('reset'), true))) return
  await act(scope, { kind: 'reset', hash, mode }, t('progResetting'), request)
}

/** Resets the current branch to a backup with --keep: git refuses rather than overwrite local changes. */
async function restoreBackup(scope: Scope, ref: BranchRef): Promise<void> {
  const backup = await offerHeadBackup(scope)
  const text = t('backupRestoreConfirm', { name: repo?.head.branch ?? 'HEAD', backup: ref.name, hash: shortHash(ref.hash) })
  if (await confirm(t('backupRestoreTitle'), text, t('btnRestore'), false, backup)) {
    await act(scope, { kind: 'reset', hash: ref.hash, mode: 'keep' }, t('progResetting'), backup?.value())
  }
}

async function removeBackup(scope: Scope, ref: BranchRef & { kind: string }): Promise<void> {
  if (await confirm(t('backupDelete'), t('backupDeleteConfirm', { name: ref.name }), t('branchDelete'), true)) {
    await act(scope, { kind: 'deleteBackup', ref: ref.kind === 'tag' ? 'tag' : 'branch', name: ref.name, hash: ref.hash }, t('branchDeleting', { name: ref.name }))
  }
}

async function createPatch(scope: Scope, hashes: string[]): Promise<void> {
  const root = scope.root
  const done = busy(t('progCreatingPatch'))
  let preview
  try {
    preview = await api.patch(root, hashes)
  } catch (error) {
    preview = { ok: false as const, reason: errorMessage(error) }
  } finally {
    done()
  }
  if (!preview.ok) return showBanner(preview.reason, 'error')
  const choice = await askPatch(hashes.length, preview.size, preview.name, Boolean(preview.text))
  if (!choice || !unchanged(scope)) return
  if (choice.action === 'copy') {
    if (copyText(preview.text!)) showBanner(hashes.length === 1 ? t('patchCopiedOne', { hash: shortHash(hashes[0]) }) : t('patchCopiedMany', { count: hashes.length }), 'success')
    else showBanner(t('clipboardFailed'), 'error')
    return
  }
  try {
    let saved = await api.patch(root, hashes, choice.path)
    if (!saved.ok && saved.exists) {
      if (!(await confirm(t('fileExistsTitle'), t('overwriteQuestion', { reason: saved.reason }), t('overwrite'), true)) || !unchanged(scope)) return
      saved = await api.patch(root, hashes, choice.path, true)
    }
    if (!saved.ok) return showBanner(saved.reason, 'error')
    const path = saved.path!
    showBanner(t('patchSaved', { path }), 'success', [{ label: t('copyPath'), run: () => void copyText(path) }])
  } catch (error) {
    showBanner(errorMessage(error), 'error')
  }
}

function commitMenu(x: number, y: number): void {
  if (!repo) return
  const scope = scopeOf(repo)
  const hashes = selectedHashes()
  const commits = hashes.map((hash) => rows[indexByHash.get(hash)!])
  const n = hashes.length
  const single = n === 1 ? commits[0] : null
  const merges = commits.some((c) => c.parents.length > 1)
  const operation = repo.operation
  const hintBusy = operation ? t('hintOperation', { operation }) : undefined
  const rewriteHint = hintBusy ?? rewriteBlocker(hashes, false)
  const rewriteOff = Boolean(rewriteHint)
  const fixupHint = operation ? rewriteHint : rewriteBlocker(hashes, n === 1)

  const entries: MenuEntry[] = [
    { label: t('cmCopyRevision', { count: n }), icon: 'copy', shortcut: 'Ctrl+C', run: copyHashes },
    {
      label: t('cmCherryPick'),
      icon: 'cherry',
      disabled: Boolean(operation) || (!isFiltered() && hashes.some((hash) => reachable.has(hash))) || merges,
      hint: hintBusy ?? (merges ? t('hintCherryMerge') : t('hintInCurrent')),
      run: () => void act(scope, { kind: 'cherryPick', hashes }, t('progCherryPick'))
    },
    {
      label: t('cmCreatePatch'),
      icon: 'patch',
      disabled: merges,
      hint: t('hintPatchMerge'),
      run: () => void createPatch(scope, hashes)
    },
    'separator',
    { label: t('checkoutRevision'), icon: 'checkout', disabled: !single, hint: t('hintSelectOne'), run: () => void act(scope, { kind: 'checkout', target: single!.hash }, t('checkingOutBare')) }
  ]
  if (single) {
    for (const label of refLabels(single.refs, repo.head.branch)) {
      if (label.kind === 'local' && !label.current) {
        const name = label.refs[0]
        entries.push({ label: t('checkoutQuoted', { name }), run: () => void act(scope, { kind: 'checkout', target: name }, t('checkingOut', { name })) })
      } else if (label.kind === 'remote') {
        const name = label.text.slice(label.text.indexOf('/') + 1)
        if (!refs?.locals.some((l) => l.name === name)) {
          entries.push({ label: t('checkoutQuotedAs', { remote: label.text, name }), run: () => void act(scope, { kind: 'checkout', target: name }, t('checkingOut', { name })) })
        }
      }
    }
  }
  entries.push(
    'separator',
    {
      label: t('cmResetHere'),
      icon: 'reset',
      disabled: !single || Boolean(operation),
      hint: hintBusy ?? t('hintSelectOne'),
      run: () => void reset(scope, single!.hash)
    },
    {
      label: t('cmRevert', { count: n }),
      icon: 'revert',
      disabled: Boolean(operation) || merges,
      hint: hintBusy ?? t('hintRevertMerge'),
      run: () => void act(scope, { kind: 'revert', hashes }, t('progReverting'))
    },
    {
      label: t('cmUndoCommit'),
      icon: 'undo',
      disabled: !single || single.hash !== repo.head.hash || Boolean(operation),
      hint: t('hintOnlyLatest'),
      run: () => void undoCommit(scope, single!.hash)
    },
    'separator',
    { label: t('cmEditMessage'), icon: 'edit', disabled: !single || rewriteOff, hint: rewriteHint ?? t('hintSelectOne'), run: () => void reword(scope, single!.hash) },
    { label: n > 1 ? t('cmFixupMany') : t('cmFixupPrev'), icon: 'fixup', disabled: Boolean(fixupHint), hint: fixupHint, run: () => void fixup(scope, hashes) },
    { label: t('cmSquash'), icon: 'squash', disabled: n < 2 || rewriteOff, hint: rewriteHint ?? t('hintSelectTwo'), run: () => void squash(scope, hashes) },
    { label: t('cmDrop', { count: n }), icon: 'drop', disabled: rewriteOff, hint: rewriteHint, run: () => void drop(scope, hashes) },
    {
      label: t('cmRebase'),
      icon: 'rebase',
      disabled: !single || rewriteOff,
      hint: rewriteHint ?? t('hintSelectOne'),
      run: () => void rebaseFrom(scope, single!.hash)
    },
    'separator',
    { label: t('cmNewBranch'), icon: 'branch', disabled: !single, hint: t('hintSelectOne'), run: () => void newBranch(scope, single!.hash) },
    { label: t('cmNewTag'), icon: 'tag', disabled: !single, hint: t('hintSelectOne'), run: () => void newTag(scope, single!.hash) }
  )
  showMenu(x, y, entries, viewport)
}

// ---------- Toolbar & host events ----------

refreshButton.addEventListener('click', () => void refreshAll())
fetchButton.addEventListener('click', async () => {
  if (!repo) return
  fetchButton.disabled = true
  try {
    const result = await api.fetch(repo.root)
    showBanner(result.message, result.ok ? 'success' : 'error')
  } catch (error) {
    showBanner(errorMessage(error), 'error')
  } finally {
    fetchButton.disabled = false
  }
})
async function openDiff(root: string, index: number): Promise<void> {
  // shortcut: the worker takes at most 2000 files, so a larger selection sends the 2000 around the clicked one; send them all once the limit goes.
  const first = clamp(index - 1000, 0, Math.max(0, selectionFiles.length - 2000))
  try {
    const result = await api.openDiff({ root, files: selectionFiles.slice(first, first + 2000), index: index - first })
    if (!result.ok) showBanner(result.reason ?? t('openDiffFailed'), 'error')
  } catch (error) {
    showBanner(errorMessage(error), 'error')
  }
}

// The Diff tab stepped to another file: highlight it here too, if it is still in this selection. No diff.open: it is already shown.
orca.plugin.on('diff.current', ({ root, path }: { root: string; path: string }) => {
  if (root !== repo?.root || !selectionFiles.some((file) => file.path === path)) return
  currentFile = path
  for (const dir of dirPaths(fileTree)) if (path.startsWith(`${dir}/`)) openFolders.add(dir)
  drawFiles()
  filesPane.querySelector('.ft-row.current')?.scrollIntoView({ block: 'nearest' })
})

orca.plugin.on('repo.changed', ({ root }: { root: string }) => {
  if (root === repo?.root) {
    detailsCache.clear()
    scheduleRefresh()
  }
})

// The first event is the current context (already handled by start()); later ones mean focus moved.
let lastContext: string | null = null
orca.on('workspace.changed', ({ context }: { context: { branch: string; displayName: string } | null }) => {
  const key = context ? `${context.displayName}\n${context.branch}` : ''
  const first = lastContext === null
  if (key === lastContext) return
  lastContext = key
  if (!first) void start()
})

let lastFocusRefresh = 0
addEventListener('focus', () => {
  if (Date.now() - lastFocusRefresh < 3000) return
  lastFocusRefresh = Date.now()
  if (repo) scheduleRefresh(50)
})

renderEmpty()
void start()

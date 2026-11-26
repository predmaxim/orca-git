// Only the Orca host/worker boundary is faked. Clicks, file trees, log pages and frame reloads use the actual panel.
const a = '/project', b = '/worktrees/project'
let shift = 0, reveal = null, count = 70
let root = a, branches = ['main', 'topic'], openCount = 0, panel, listeners, holdFiles, holdPage
const hash = (n) => n.toString(16).padStart(40, '0')
const topic = 'refs/heads/topic'
const repo = (root) => ({ root, workspaceId: root, name: 'project', head: { hash: hash(0), branch: 'main' }, operation: null, todoOnly: false, autostashOnly: false })
const context = () => ({ context: { workspaceId: root, branch: 'main', displayName: 'project' } })

window.bridge = () => {
  listeners = {}
  return {
    locale: 'en', on(name, fn) { listeners[name] = fn; if (name === 'workspace.changed') fn(context()) },
    plugin: {
      on(name, fn) { listeners[name] = fn },
      async request(name, arg) {
        if (name === 'reveal.take') { const target = reveal; reveal = null; return target }
        if (name === 'repo.resolve') return { ok: true, repo: repo(arg.root || root) }
        if (name === 'repo.refs') return { head: repo(arg.root).head, locals: branches.map((name) => ({ name, full: 'refs/heads/' + name, hash: hash(0) })), remotes: [], tags: [], users: [], me: null }
        if (name === 'log.selectionDepth') return arg.hashes.reduce((depth, h) => {
          const i = Number.parseInt(h, 16) + shift
          return i < count + shift ? Math.max(depth, i + 1) : depth
        }, arg.skip)
        if (name === 'log.page') {
          if (holdPage) { const wait = holdPage; holdPage = null; await wait }
          if (arg.filter.branches?.includes(topic) && !branches.includes('topic')) throw Error('missing ref')
          const total = arg.filter.text ? 1 : count + shift
          const length = Math.min(arg.limit ?? 48, total - arg.skip)
          const commits = Array.from({ length }, (_, i) => ({ hash: hash(arg.skip + i < shift ? 9000 : arg.skip + i - shift), parents: [], author: 'A', committer: 'A', authorTime: 1, commitTime: 1, email: 'a@e', refs: [], subject: 'commit ' + (arg.skip + i) }))
          return { commits, hasMore: arg.skip + length < total }
        }
        if (name === 'selection.files') {
          if (holdFiles) { const wait = holdFiles; holdFiles = null; await wait }
          return ['a.ts', ...Array.from({ length: 60 }, (_, i) => 'src/a' + i + '.ts'), 'src/chosen.ts'].map((path) => ({ path, status: 'A', from: null, to: arg.hashes[0] }))
        }
        if (name === 'commit.details') return { ...repo(arg.root), hash: arg.hash, parents: [], branches: [], authorTime: 1, commitTime: 1 }
        if (name === 'diff.open') { openCount++; return { ok: true } }
        if (name === 'notes.list') return { notes: [] }
        if (name === 'repo.watch') return { ok: true }
        throw Error(name)
      }
    }
  }
}

const $ = (s) => panel.contentDocument.querySelector(s)
const expect = (ok, message) => { if (!ok) throw Error(message) }
async function until(fn, reason) {
  const end = performance.now() + 1800
  while (!fn()) {
    if (performance.now() > end) throw Error(reason)
    await new Promise((done) => setTimeout(done, 16))
  }
}
function mount() {
  panel?.remove()
  panel = document.createElement('iframe')
  panel.style = 'width:800px;height:650px'
  panel.src = '/src/ui/panel.html'
  document.body.append(panel)
}
const switchTo = (next) => { root = next; listeners['workspace.changed'](context()) }
const branchIs = (name) => $('.node-row.filtered')?.dataset.key === name
const selected = () => [...panel.contentDocument.querySelectorAll('.row.selected')].map((n) => n.dataset.index).join(',')
const mouse = (n, ctrlKey = false) => $(`.row[data-index="${n}"]`).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey }))
const file = (path) => $(`.file[data-key="${path}"]`)
const restore = () => branchIs(topic) && selected() === '54,56' && file('src/chosen.ts')?.classList.contains('current')
async function run() {
  mount()
  await until(() => branchIs('HEAD') && $('.row'), 'first opening on HEAD')
  $('.node-row[data-key="' + topic + '"]').click()
  await until(() => branchIs(topic) && $('.row'), 'branch selected')
  $('.viewport').scrollTop = 20000
  await until(() => $('.row[data-index="54"]'), 'second page visible')
  mouse(54); mouse(56, true)
  await until(() => selected() === '54,56' && file('src/chosen.ts'), 'multi-select shows its files')
  file('src/chosen.ts').click()
  expect(openCount === 1, 'opening the file reaches the diff')
  switchTo(b)
  await until(() => branchIs('HEAD') && selected() === '' && !file('src/chosen.ts'), 'untouched worktree on HEAD with empty selection')
  mouse(2)
  await until(() => selected() === '2' && file('a.ts'), 'second worktree selection')
  file('a.ts').click()
  switchTo(a)
  await until(restore, 'return restores branch, deep multi-selection and file')
  mount()
  await until(restore, 'a new frame restores branch, deep multi-selection and file')
  const chosen = file('src/chosen.ts').getBoundingClientRect()
  const tree = $('.ft').getBoundingClientRect()
  expect(chosen.top >= tree.top - 1 && chosen.bottom <= tree.bottom + 1, 'the restored file must be visible in its tree')
  expect(openCount === 2, 'restoring the file must leave the Diff tab alone')
  let release
  holdFiles = new Promise((done) => { release = done })
  mouse(54)
  switchTo(b)
  await until(() => selected() === '2' && file('a.ts')?.classList.contains('current'), 'second worktree restores its own file')
  release()
  await new Promise((done) => setTimeout(done, 50))
  expect(selected() === '2' && file('a.ts').classList.contains('current'), 'late file response must preserve current worktree')
  holdPage = new Promise((done) => { release = done })
  switchTo(a)
  await until(() => !holdPage, 'delayed log request started')
  switchTo(b)
  await until(() => selected() === '2' && file('a.ts')?.classList.contains('current'), 'newer worktree restored before stale page')
  release()
  await new Promise((done) => setTimeout(done, 50))
  expect(selected() === '2', 'stale page must leave current selection intact')
  branches = ['main']
  switchTo(a)
  await until(() => branchIs('HEAD') && selected() === '54', 'removed branch falls back to HEAD and restores surviving commit')
  $('.node-row[data-key="HEAD"]').click()
  await until(() => !$('.node-row.filtered') && $('.row'), 'explicit all branches')
  mount()
  await until(() => $('.row') && $('.node-row') && !$('.node-row.filtered'), 'all branches also survives a fresh frame')
  count = 350
  switchTo('/third')
  await until(() => branchIs('HEAD') && $('.row'), 'large worktree')
  await until(() => { $('.viewport').scrollTop = 100000; return $('.row[data-index="349"]') }, 'oldest loaded commit')
  mouse(349)
  await until(() => selected() === '349', 'oldest selected')
  shift = 1
  listeners['repo.changed']({root})
  await until(() => selected() === '350', 'refresh keeps the selected commit below the old page boundary')
  const search = $('.search input')
  search.value = 'narrow filter'
  search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await until(() => $('.row[data-index="0"]') && !$('.row[data-index="1"]'), 'filtered to a single commit')
  reveal = {repo: repo(root), hash: hash(6)}
  mount()
  await until(() => selected() === '7' && !$('.search input').value, 'Workflow reveal takes precedence over persisted search')
}
run().then(() => 'ok', (error) => String(error.stack)).then((body) => fetch('/result', { method: 'POST', body }))

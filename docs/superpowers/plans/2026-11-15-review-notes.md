# Заметки ревью для агента (этап 1) — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** во вкладке Diff пользователь оставляет заметки к выделенному тексту, одним нажатием отдаёт их новому агенту и видит ответ агента под каждой заметкой.

**Architecture:** дифф отдаёт id блобов обеих сторон (`--full-index`), заметка привязана к блобу своей стороны. Заметки ведёт worker в хранилище плагина; фрейм шлёт операции по одной заметке и перерисовывается по событию `notes.changed`. Отправка — папка `.orca-git-log/review-<id>/` в worktree (заметки, руководство, ответы) и `agent.launch` с промптом из путей; ответы worker читает по событию `agent.status.changed` и при запросе списка. Markdown — лексер `marked` и свой рендерер в узлы DOM.

**Tech Stack:** TypeScript без сборки (Orca транспилирует), DOM, `node:test` и `orca/testing` через `orca plugin test .`, git ≥ 2.31, `marked` 18.2.0 (вендорный ESM-файл), host API Orca 1.9.

**Spec:** `docs/superpowers/specs/2026-11-15-review-notes-design.md`, раздел «Этап 1» (читать вместе с планом). Этап 2 («Смотреть все») в этот план не входит.

## Global Constraints

- Лимиты: до 200 заметок на репозиторий; `quote` до 2000 символов, `body` 1–4000, ответ до 8000; файл ответа до 65536 байт; промпт до 4096 символов. Значение хранилища до 262144 байт, сообщение фрейма до 64 КиБ, ответ worker'а до 1 МиБ.
- Состояние заметок — только в хранилище (`orca.storage`): простаивающий worker Orca останавливает через 5 минут, память между запросами не держится.
- Данные заметок и ответов никогда не попадают в `innerHTML`, в имя файла или в аргумент команды. Путь файла ответа worker строит из id заметки.
- Запись в worktree: `.orca-git-log` — настоящая папка (не ссылка, не файл), файлы создаются с флагом `wx`, чтение — `O_NOFOLLOW | O_NONBLOCK`, как `claimAnchor` и `isOurAnchor` в `src/worker/main.ts`.
- Строки интерфейса и worker'а — через `t()`, в `en` и `ru` (`src/shared/i18n.ts`; пропуск ключа в `ru` — ошибка типов).
- Вид — как у боковой панели Orca (скилл `orca-plugin-ui`): цвета только из существующих переменных `src/ui/styles.css` и `--orca-*`; свои цвета только для состояний (жёлтый `#fbbf24`, зелёный `#4ade80`, синий `#7aa7ff`) через `color-mix`; кнопки-иконки 26×26 с `aria-label` и `title`; иконки Lucide 0.469.0 в `src/ui/dom.ts`.
- Код фрейма импортирует только относительные файлы. Модули с чистой логикой (`notemodel.ts`, `markdown.ts` кроме `mdDom`) не трогают DOM: их тесты идут в Node.
- Исходники в `src/` — CRLF, новые файлы тоже; `src/vendor/marked/*` — байт в байт из пакета. Файлы со смешанными концами строк (`src/worker/main.test.ts`, `src/worker/git.test.ts`, `src/ui/graph.test.ts`) не править: новые тесты worker'а — в новых файлах. Документы в `docs/` и `README.md` — LF.
- Ошибок типов не больше базы: `npx -y -p typescript@5 tsc -p . --noEmit` — 129 на `c99da78`; в изменённых и новых строках — 0.
- Тесты: `orca plugin test .` — все зелёные (18 файлов на `c99da78`).
- git: правила `docs/git-safety.md`; изменённая команда git — правка её строки в таблице и тест.
- Orca: `orca plugin dev load|unload|enable|disable|update` — только с согласия пользователя, одной живой сессией в Task 8. `test`, `validate`, `check` — можно.
- Документация меняется в том же коммите, что поведение. Без ИИ-соавторов в коммитах.
- `engines.orca` не меняется: всё используемое есть в `>=1.4.248`.

## Review Focus

1. Выделение, начатое на одной стороне и протянутое через строки другой (unified: через `-` и `+`; split: через обе колонки), даёт заметку только на своей стороне с верными строками и смещениями (Task 3, тесты `anchor` и `pickSide`; Task 5, проверка в headless Chromium).
2. Ответ агента с сырым HTML, `javascript:`-ссылкой или картинкой показывается текстом и ничего не исполняет (Task 4, тест «raw HTML and unsafe links stay text»).
3. В репозитории `.orca-git-log` — ссылка наружу или файл: отправка отклонена, вне папки ничего не записано; файл ответа — ссылка или больше 64 КиБ: пропущен (Task 6 и 7, тесты в `review.test.ts`).
4. Orca отклонила запись в хранилище (значение больше 256 КиБ): заметка не сохранена, причина показана, прежние заметки целы (Task 2, тест «a refused write keeps the notes»).
5. Worker остановлен между отправкой и ответом: после запуска нового worker'а событие `agent.status.changed` подбирает ответ (Task 7, тест «a new worker picks up the answer»).

---

## Файлы

| Файл | Что в нём |
|---|---|
| `src/shared/protocol.ts` | типы заметки, запросы `notes.*`, событие `notes.changed`, блобы в `FileDiff` |
| `src/shared/notes.ts` (новый) | лимиты |
| `src/worker/diff.ts`, `src/worker/selection.ts` | `--full-index`, разбор строки `index` |
| `src/worker/notes.ts` (новый) | хранилище заметок |
| `src/worker/review.ts` (новый) | папка отправки, файл заметок, промпт, чтение ответов |
| `src/worker/reviewGuide.ts` (новый) | текст руководства |
| `src/worker/testkit.ts` (новый) | репозиторий и хост для новых тестов worker'а |
| `src/worker/main.ts` | обработчики `notes.*`, событие агента |
| `src/ui/notemodel.ts` (новый) | чистая логика: сторона, привязка, отбор заметок |
| `src/ui/markdown.ts` (новый) | markdown в дерево и в DOM |
| `src/ui/notes.ts` (новый) | DOM заметок: выделение, редактор, карточка, поповер, меню отправки |
| `src/ui/diff.ts`, `src/ui/diff-app.ts`, `src/ui/api.ts`, `src/ui/dom.ts`, `src/ui/styles.css` | подключение |
| `src/vendor/marked/` (новый) | `marked.esm.js`, `LICENSE` |

---

### Task 1: Блобы сторон в диффе и типы заметок

**Files:**
- Modify: `src/shared/protocol.ts`, `src/worker/diff.ts`, `src/worker/selection.ts`, `docs/git-safety.md` (строки 42 и 43 таблицы)
- Test: `src/worker/selection.test.ts`

**Interfaces:**
- Produces в `src/shared/protocol.ts`:

```ts
export interface FileDiff { /* как было */ oldBlob?: string; newBlob?: string }
export type NoteSide = 'old' | 'new'
export interface NotePoint { line: number; col: number }
export type NoteVerdict = 'confirmed' | 'refuted' | 'unclear'
export interface NoteReply { verdict: NoteVerdict; fixed: boolean; body: string; at: number }
export interface NoteDraft { path: string; side: NoteSide; blob: string; rev: string; start: NotePoint; end: NotePoint; quote: string; body: string }
export interface ReviewNote extends NoteDraft { id: string; createdAt: number; updatedAt?: number; review?: string; sentAt?: number; reply?: NoteReply }
export type NoteResult = { ok: true; note: ReviewNote } | { ok: false; reason: string }
// PluginRequests
'notes.list': { input: { root: string }; output: { notes: ReviewNote[] } }
'notes.add': { input: { root: string; draft: NoteDraft }; output: NoteResult }
'notes.update': { input: { root: string; id: string; body: string }; output: NoteResult }
'notes.delete': { input: { root: string; ids: string[] }; output: { ok: boolean } }
'notes.send': { input: { root: string; ids: string[]; agent: string }; output: { ok: true; review: string } | { ok: false; reason: string } }
// PluginPanelEvents
'notes.changed': { root: string }
```

- [ ] **Step 1: тест** в `src/worker/selection.test.ts`:

```ts
test('a range diff names the blob of each side', async () => {
  const { root, hashes: h } = repoWith([write('a.txt', 'one\n'), write('a.txt', 'two\n'), write('b.txt', 'x\n')])
  const git = createGit(root)
  const diff = await readRangeDiff(git, h[0], h[1], 'a.txt')
  assert.equal(diff.oldBlob, sh(root, 'rev-parse', `${h[0]}:a.txt`))
  assert.equal(diff.newBlob, sh(root, 'rev-parse', `${h[1]}:a.txt`))
  // The same content on a side is the same blob, whatever the commits.
  assert.equal((await readRangeDiff(git, h[0], h[2], 'a.txt')).newBlob, diff.newBlob)
  const added = await readRangeDiff(git, null, h[0], 'a.txt')
  assert.equal(added.oldBlob, undefined)
  assert.equal(added.newBlob, diff.oldBlob)
})
```

- [ ] **Step 2:** `orca plugin test .` — новый тест падает (`oldBlob` undefined).
- [ ] **Step 3:** `parseUnifiedDiff` возвращает ещё `oldBlob` и `newBlob`: до первого ханка строка `index <old>..<new>` с id в 40 или 64 hex; id из одних нулей не возвращается. В `readFileDiff` (оба варианта команды) и `readRangeDiff` к опциям добавить `--full-index`. Добавить типы и запросы из блока Interfaces.
- [ ] **Step 4:** `orca plugin test .` — зелёные. В `docs/git-safety.md`, строки 42 и 43, дописать `--full-index` в команды.
- [ ] **Step 5:** commit: `Give each side of a diff its blob id (--full-index) and declare the review note types`.

### Task 2: Хранилище заметок

**Files:**
- Create: `src/shared/notes.ts`, `src/worker/notes.ts`, `src/worker/testkit.ts`, `src/worker/notes.test.ts`
- Modify: `src/worker/main.ts`, `src/shared/i18n.ts`, `orca-plugin.json` (capability `storage:own`)

**Interfaces:**
- Consumes: типы Task 1.
- Produces:

```ts
// src/shared/notes.ts
export const MAX_NOTES = 200
export const MAX_QUOTE = 2000
export const MAX_BODY = 4000
export const MAX_REPLY = 8000

// src/worker/notes.ts
export interface NoteStore { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> }   // orca.storage подходит
export function notesKey(root: string): string                      // 'notes:' + sha256(root) hex
export function checkDraft(input: unknown): NoteDraft | null
export function listNotes(store: NoteStore, root: string): Promise<ReviewNote[]>
export function addNote(store: NoteStore, root: string, draft: unknown, now?: number): Promise<NoteResult>
export function updateNote(store: NoteStore, root: string, id: unknown, body: unknown, now?: number): Promise<NoteResult>
export function deleteNotes(store: NoteStore, root: string, ids: unknown): Promise<ReviewNote[]>   // удалённые
export function markSent(store: NoteStore, root: string, ids: string[], review: string, now?: number): Promise<void>
export function setReplies(store: NoteStore, root: string, replies: Map<string, NoteReply>): Promise<boolean>   // изменилось ли
export function pendingRoots(store: NoteStore): Promise<string[]>

// src/worker/testkit.ts — fixture() и host() как в main.test.ts (workspace 'wt-1' на корне), плюс заготовки заметок
export function fixture(): string
export function host(root: string, results?: Record<string, unknown>, storage?: Record<string, JsonValue>): MockHost
/** A valid draft: new side of src/a.ts, lines 3-4, with `over` on top. */
export function draft(over?: Record<string, unknown>): NoteDraft
/** A NoteStore on a Map. */
export function memory(): NoteStore
```

Правила:
- Значение ключа — `{ root, notes }`. Ключ `pending` — массив корней, где есть заметка с `review` и без `reply`; пересчитывается для корня после каждой записи.
- `checkDraft`: `path` — непустая строка до 4096; `side` — `old` или `new`; `blob` и `rev` — 40 или 64 hex, `blob` не из одних нулей; `start` и `end` — целые, `line ≥ 1`, `col ≥ 0`, `end` строго после `start`; `quote` — строка, обрезается до `MAX_QUOTE`; `body` после `trim()` — от 1 до `MAX_BODY`. Иначе `null`.
- `addNote`: больше `MAX_NOTES` — `t('notesFull')`; плохой черновик — `t('noteInvalid')`; `id` — `randomBytes(6).toString('hex')`.
- Отказ `store.set` — `{ ok: false, reason: t('notesSaveFailed', { error }) }`; сохранённое не меняется.
- `updateNote`: новый `body` по правилу `checkDraft`; ставит `updatedAt`, убирает `review`, `sentAt`, `reply`; нет заметки — `t('noteMissing')`.
- `deleteNotes`: после удаления последней заметки ключ удаляется.
- Изменения идут по одному: общая цепочка промисов модуля.
- `main.ts`: `notes.list`, `notes.add`, `notes.update`, `notes.delete`; корень проверяет `gitFor(root)`; после каждого изменения `orca.panels.post('notes.changed', { root })`.

Строки (`en` / `ru`): `notesFull` — «Too many notes for this repository: delete some first.» / «Слишком много заметок в этом репозитории: сначала удалите часть.»; `noteInvalid` — «This note cannot be saved.» / «Эту заметку нельзя сохранить.»; `noteMissing` — «The note no longer exists.» / «Заметки уже нет.»; `notesSaveFailed` — «Could not save the note: {error}» / «Не удалось сохранить заметку: {error}».

- [ ] **Step 1: тесты** в `src/worker/notes.test.ts` (`memory()` и `draft()` — из `testkit.ts`):

```ts
test('a note is stored with an id and a cut quote', async () => {
  const store = memory()
  const added = await addNote(store, '/r', draft({ quote: 'q'.repeat(2500) }), 5)
  assert.equal(added.ok, true)
  const [note] = await listNotes(store, '/r')
  assert.match(note.id, /^[0-9a-f]{12}$/)
  assert.equal(note.quote.length, 2000)
  assert.equal(note.createdAt, 5)
})
test('a draft that is not a note is refused and nothing is stored', async () => {
  const store = memory()
  for (const bad of [null, draft({ side: 'both' }), draft({ blob: '0'.repeat(40) }), draft({ body: '  ' }), draft({ body: 'b'.repeat(4001) }),
    draft({ start: { line: 2, col: 0 }, end: { line: 2, col: 0 } }), draft({ start: { line: 0, col: 0 } }), draft({ path: '' })]) {
    assert.equal((await addNote(store, '/r', bad)).ok, false)
  }
  assert.deepEqual(await listNotes(store, '/r'), [])
})
test('the 201st note is refused', async () => { /* 200 раз addNote ok, затем ok === false */ })
test('a refused write keeps the notes', async () => {
  const store = memory()
  await addNote(store, '/r', draft())
  store.set = async () => { throw new Error('value exceeds 262144 bytes') }
  const second = await addNote(store, '/r', draft())
  assert.equal(second.ok, false)
  assert.equal((await listNotes(store, '/r')).length, 1)
})
test('an edit clears what was sent and answered', async () => { /* markSent + setReplies, затем updateNote: review, sentAt, reply === undefined; updatedAt задан */ })
test('deleting the last note removes the key', async () => { /* await store.get(notesKey('/r')) === null */ })
test('a root is pending from the send to the last answer', async () => {
  /* markSent двух заметок: pendingRoots === ['/r']; setReplies одной: ['/r']; второй: [] */
})
test('the worker stores a note and tells the frames', async () => {
  const root = fixture()
  const h = host(root)
  const worker = await mountWorker(main, { host: h })
  const added = await worker.request('notes.add', { root, draft: draft() })
  assert.equal(added.ok, true)
  assert.deepEqual(worker.posts.slice(-1), [{ event: 'notes.changed', payload: { root } }])
  assert.equal((await worker.request('notes.list', { root })).notes.length, 1)
  assert.deepEqual(worker.refusals, [])
})
```

- [ ] **Step 2:** `orca plugin test .` — новые тесты падают (модуля нет).
- [ ] **Step 3:** написать `src/shared/notes.ts`, `src/worker/notes.ts`, `src/worker/testkit.ts`, обработчики в `main.ts`, строки, capability `{ "kind": "storage:own" }`.
- [ ] **Step 4:** `orca plugin test .` — зелёные; `orca plugin validate .` — код 0.
- [ ] **Step 5:** commit: `Keep review notes in the plugin's storage: the worker adds, edits and deletes them one at a time`.

### Task 3: Привязка выделения (чистая логика)

**Files:**
- Create: `src/ui/notemodel.ts`, `src/ui/notemodel.test.ts`

**Interfaces:**
- Consumes: типы Task 1; `DiffMode` из `src/ui/diff.ts` — только `import type`.
- Produces:

```ts
/** Split: the column the selection starts in. Unified: a deleted line starts an old-side selection, any other a new-side one. */
export function pickSide(mode: DiffMode, column: 'left' | 'right', kind: DiffLine['kind']): NoteSide
/** The numbered lines of one side of the hunks. */
export function sideLines(hunks: DiffHunk[], side: NoteSide): Map<number, string>
/** A selection fitted to the side's lines, with its text; null when nothing of the side is selected. */
export function anchor(lines: Map<number, string>, from: NotePoint, to: NotePoint): { start: NotePoint; end: NotePoint; quote: string } | null
/** The notes whose side of this diff is their blob. */
export function notesOf(notes: ReviewNote[], diff: Pick<FileDiff, 'oldBlob' | 'newBlob'>): ReviewNote[]
/** The part [from, to) of a line a note covers; null when it covers none of it. */
export function coveredRange(note: ReviewNote, side: NoteSide, line: number, length: number): [number, number] | null
export function unsent(notes: ReviewNote[]): ReviewNote[]
/** All notes as markdown, for Copy all. */
export function notesText(notes: ReviewNote[]): string
```

Правила `anchor`: точки упорядочиваются; `col` зажимается в длину строки; точка на строке, которой нет на стороне, сдвигается: начало — к началу следующей строки стороны, конец — к концу предыдущей; конец в `col 0` более поздней строки уходит в конец предыдущей строки стороны; начало в конце строки при более позднем конце — в начало следующей; пустой результат или начало после конца — `null`; `quote` — куски строк через `\n`.

`notesText`: на заметку — `path:line` или `path:line-line`, сторона в скобках, цитата строками с `> `, пустая строка, текст; между заметками `\n\n---\n\n`.

- [ ] **Step 1: тесты** (`hunks` — один ханк: `-` «const a = 1» (old 1), `+` «const a = 2» (new 1), ` ` «» (old 2, new 2), ` ` «export { a }» (old 3, new 3)):

```ts
test('the side comes from where the selection starts', () => {
  assert.equal(pickSide('split', 'left', ' '), 'old')
  assert.equal(pickSide('split', 'right', ' '), 'new')
  assert.equal(pickSide('unified', 'left', '-'), 'old')
  assert.equal(pickSide('unified', 'left', '+'), 'new')
  assert.equal(pickSide('unified', 'left', ' '), 'new')
})
test('a selection inside one line', () => {
  assert.deepEqual(anchor(sideLines(hunks, 'new'), { line: 1, col: 6 }, { line: 1, col: 11 }), { start: { line: 1, col: 6 }, end: { line: 1, col: 11 }, quote: 'a = 2' })
})
test('a reversed selection, and columns past the line', () => {
  assert.deepEqual(anchor(sideLines(hunks, 'new'), { line: 3, col: 99 }, { line: 1, col: 6 }),
    { start: { line: 1, col: 6 }, end: { line: 3, col: 12 }, quote: 'a = 2\n\nexport { a }' })
})
test('a selection that ends at the start of the next line stops at the end of the line before', () => {
  assert.deepEqual(anchor(sideLines(hunks, 'old'), { line: 1, col: 0 }, { line: 2, col: 0 }), { start: { line: 1, col: 0 }, end: { line: 1, col: 11 }, quote: 'const a = 1' })
})
test('points on lines the side lacks move onto it', () => {
  // old side has no line 4; new side of a hunk starting at 5 has no line 1
  assert.deepEqual(anchor(sideLines(hunks, 'old'), { line: 3, col: 0 }, { line: 9, col: 2 })?.end, { line: 3, col: 12 })
})
test('nothing selected', () => {
  assert.equal(anchor(sideLines(hunks, 'new'), { line: 1, col: 3 }, { line: 1, col: 3 }), null)
  assert.equal(anchor(new Map(), { line: 1, col: 0 }, { line: 2, col: 4 }), null)
})
test('a note shows where its blob is, on its side only', () => {
  const note = { side: 'new', blob: 'b'.repeat(40) } as ReviewNote
  assert.deepEqual(notesOf([note], { newBlob: 'b'.repeat(40) }), [note])
  assert.deepEqual(notesOf([note], { oldBlob: 'b'.repeat(40) }), [])
})
test('the part of each line a note covers', () => {
  const note = { side: 'new', start: { line: 1, col: 6 }, end: { line: 3, col: 6 } } as ReviewNote
  assert.deepEqual(coveredRange(note, 'new', 1, 11), [6, 11])
  assert.equal(coveredRange(note, 'new', 2, 0), null)
  assert.deepEqual(coveredRange(note, 'new', 3, 12), [0, 6])
  assert.equal(coveredRange(note, 'old', 1, 11), null)
  assert.equal(coveredRange(note, 'new', 4, 5), null)
})
```

- [ ] **Step 2:** `orca plugin test .` — падают. **Step 3:** написать модуль. **Step 4:** зелёные.
- [ ] **Step 5:** commit: `Fit a text selection in a diff to the lines of one side`.

### Task 4: Markdown без innerHTML

**Files:**
- Create: `src/vendor/marked/marked.esm.js`, `src/vendor/marked/LICENSE`, `src/ui/markdown.ts`, `src/ui/markdown.test.ts`
- Modify: `src/ui/vendor.d.ts`, `README.md` («Third-party code»)

**Interfaces:**
- Produces:

```ts
export type MdTag = 'p' | 'h4' | 'strong' | 'em' | 'del' | 'code' | 'pre' | 'a' | 'ul' | 'ol' | 'li' | 'blockquote' | 'hr' | 'br' | 'table' | 'tr' | 'th' | 'td'
export type MdNode = string | { tag: MdTag; href?: string; children: MdNode[] }
export function mdTree(source: string): MdNode[]
/** The tree as DOM nodes, built with createElement and text nodes only; a link calls `open` instead of navigating. */
export function mdDom(source: string, open: (url: string) => void): DocumentFragment
```

Токен `marked` → узел: `paragraph` → `p`; `heading` → `h4`; `strong`, `em`, `del`, `blockquote`, `hr`, `br` → одноимённый тег; `codespan` → `code` с текстом; `code` → `pre` с одним `code`; `list` → `ol` при `ordered`, иначе `ul`; `list_item` → `li`; `checkbox` → строка `☑ ` или `☐ `; `table` → `table` из `tr` с `th` (заголовок) и `td`; `link` → `a` с `href`, только если адрес начинается с `http:`, `https:` или `mailto:` (без учёта регистра), иначе одни дети; `image` → строка подписи; `html` и любой неизвестный тип → строка `text ?? raw`; `text` с `tokens` → дети, без — строка; `escape` → строка; `space` — ничего. В строках `&amp; &lt; &gt; &quot; &#39;` заменяются символами. Соседние строки среди детей склеиваются в одну.

- [ ] **Step 1:** положить файлы: `curl -sL https://unpkg.com/marked@18.2.0/lib/marked.esm.js -o src/vendor/marked/marked.esm.js`, `curl -sL https://unpkg.com/marked@18.2.0/LICENSE -o src/vendor/marked/LICENSE`. Проверить: `sha256sum src/vendor/marked/marked.esm.js` → `162194ea902a9d6eca6011bb42b5732991ca650e017d0375b76f4204810c6c14`; в файле нет `import`.
- [ ] **Step 2:** в `src/ui/vendor.d.ts` объявить модуль `*/marked/marked.esm.js` с `lexer(source: string): MarkedToken[]`, где `MarkedToken = { type: string; raw?: string; text?: string; href?: string; ordered?: boolean; checked?: boolean; tokens?: MarkedToken[]; items?: MarkedToken[]; header?: { tokens: MarkedToken[] }[]; rows?: { tokens: MarkedToken[] }[][] }`.
- [ ] **Step 3: тесты** в `src/ui/markdown.test.ts`:

```ts
const el = (tag: string, ...children: unknown[]) => ({ tag, children })
test('inline marks', () => {
  assert.deepEqual(mdTree('a **b** *c* `d <e>` ~~f~~'), [el('p', 'a ', el('strong', 'b'), ' ', el('em', 'c'), ' ', el('code', 'd <e>'), ' ', el('del', 'f'))])
})
test('raw HTML and unsafe links stay text', () => {
  assert.deepEqual(mdTree('<script>alert(1)</script>'), ['<script>alert(1)</script>'])
  assert.deepEqual(mdTree('x <img src=x onerror=alert(1)> [y](javascript:alert(1)) ![alt](https://a/b.png)'),
    [el('p', 'x <img src=x onerror=alert(1)> y alt')])
})
test('a web link keeps its address', () => {
  assert.deepEqual(mdTree('[docs](https://a.b/c)'), [el('p', { tag: 'a', href: 'https://a.b/c', children: ['docs'] })])
})
test('blocks', () => {
  assert.deepEqual(mdTree('# T\n\n- one\n- [x] two\n\n1. first\n\n> q\n\n```ts\na < b\n```\n\n---'), [
    el('h4', 'T'), el('ul', el('li', 'one'), el('li', '☑ two')), el('ol', el('li', 'first')),
    el('blockquote', el('p', 'q')), el('pre', el('code', 'a < b')), el('hr')
  ])
})
test('entities read as characters', () => {
  assert.deepEqual(mdTree('a &amp; b &lt;c&gt;'), [el('p', 'a & b <c>')])
})
test('a hard break', () => {
  assert.deepEqual(mdTree('one\ntwo  \nthree'), [el('p', 'one\ntwo', el('br'), 'three')])
})
test('a table', () => {
  assert.deepEqual(mdTree('| a | b |\n|---|---|\n| 1 | 2 |'), [el('table', el('tr', el('th', 'a'), el('th', 'b')), el('tr', el('td', '1'), el('td', '2')))])
})
```

- [ ] **Step 4:** `orca plugin test .` — падают. **Step 5:** написать `mdTree` и `mdDom` (`a` получает `href`, `rel="noreferrer"`; нажатие — `preventDefault()` и `open(href)`). **Step 6:** зелёные.
- [ ] **Step 7:** в `README.md`, «Third-party code», добавить абзац про `marked` 18.2.0 (MIT): один файл `lib/marked.esm.js` байт в байт в `src/vendor/marked/`, используется только лексер.
- [ ] **Step 8:** commit: `Render markdown as DOM nodes from marked's tokens, with raw HTML and unsafe links as text`.

### Task 5: Заметки во вкладке Diff

**Files:**
- Create: `src/ui/notes.ts`
- Modify: `src/ui/diff.ts`, `src/ui/diff-app.ts`, `src/ui/api.ts`, `src/ui/dom.ts` (иконки `note`, `send`), `src/ui/styles.css`, `src/shared/i18n.ts`, `README.md` («Features», клавиши вкладки Diff)

**Interfaces:**
- Consumes: Task 1 (типы), Task 2 (запросы), Task 3 (`pickSide`, `sideLines`, `anchor`, `notesOf`, `coveredRange`, `unsent`, `notesText`), Task 4 (`mdDom`).
- Produces:

```ts
// src/ui/api.ts
api.notes(root): Promise<{ notes: ReviewNote[] }>
api.noteAdd(root, draft: NoteDraft): Promise<NoteResult>
api.noteUpdate(root, id, body): Promise<NoteResult>
api.notesDelete(root, ids: string[]): Promise<{ ok: boolean }>
api.notesSend(root, ids: string[], agent: string): Promise<{ ok: true; review: string } | { ok: false; reason: string }>
// FrameOrca получает: shell?: { openExternal(url: string): Promise<unknown> }

// src/ui/notes.ts
export interface NotesView {
  /** The header buttons: Notes (N) and, from Task 6, Send to agent (N). */
  buttons: HTMLElement[]
  /** The rows that follow the row of `line` on `side`: the cards of the notes that end there, and the editor when it is open there. */
  rowsAfter(side: NoteSide, line: number, mode: DiffMode): HTMLElement[]
  /** The cell's HTML with the notes' ranges wrapped in <span class="note-mark">. */
  mark(html: string, side: NoteSide, line: number, length: number): string
  /** After each render: the container of the rows and what it shows. */
  attach(lines: HTMLElement, diff: FileDiff, file: SelectionFile, mode: DiffMode): void
  setNotes(notes: ReviewNote[]): void
  /** Ctrl+Shift+A: opens the editor on the current selection; false when there is none to note. */
  addFromSelection(): boolean
  dispose(): void
}
export function mountNotes(options: {
  root: string
  files: SelectionFile[]
  /** Redraws the rows, keeping the scroll position. */
  rerender(): void
  /** Shows `files[index]`, with the whole file when `whole`, then calls `then`. */
  show(index: number, whole: boolean, then: () => void): void
}): NotesView
```

Решения:
- Каждая ячейка кода (`.d-code`) несёт номера строк своих сторон: `data-old`, `data-new` (контекст в unified — оба). Строка без подсветки тоже проходит через `mark`: её текст экранируется, как в `highlightLines`.
- `mousedown` в `.diff-lines` ставит на контейнер `data-pick` (`pickSide`: колонка ячейки, вид строки); снимается, когда выделение схлопнулось. CSS: при `data-pick` текст другой стороны и карточки заметок — `user-select: none` (split: чужая колонка; unified: `old` — ячейки `.add`, `new` — ячейки `.del`).
- Точка выделения → `{ line, col }`: ячейка — ближайшая `.d-code` со строкой выбранной стороны (для начала — эта или следующая, для конца — эта или предыдущая); `col` — длина текста от начала ячейки до точки; заполнитель пустой строки `\u200b` не считается. Дальше `anchor(sideLines(diff.hunks, side), …)`.
- `rev` и `path` черновика: новая сторона — `file.to` и `file.path`; старая — `file.from` и `file.oldPath ?? file.path`. `blob` — `diff.newBlob` или `diff.oldBlob`; без блоба стороны заметка не создаётся.
- Кнопка «добавить заметку» (иконка `note`, 26×26) появляется у конца выделения, когда `anchor` не `null`; исчезает при прокрутке и схлопывании. `Ctrl+Shift+A` (`(ctrlKey || metaKey) && shiftKey && code === 'KeyA'`) в `onKey` вкладки делает то же.
- Строка заметки — `.d-row` с той же сеткой: карточка стоит в ячейке кода своей стороны (unified — в единственной), остальные ячейки пустые. Карточки одной строки — по `createdAt`. В unified после строки контекста идут карточки обеих её сторон.
- Редактор: `textarea` с `maxLength = MAX_BODY`; Enter сохраняет непустой текст, Shift+Enter — новая строка, Esc — отмена; причина отказа — под полем. Открытый редактор (привязка и набранный текст) переживает перерисовку.
- Карточка: текст (`mdDom`), метка состояния, кнопки-иконки «Изменить» (`edit`), «Удалить» (`drop`), у отправленной без ответа — «Отправить снова» (`refresh`; это `noteUpdate` с тем же текстом). Ответ: метки и `mdDom`. Цвета меток: подтверждено и исправлено — зелёный, опровергнуто — синий, нужно уточнение — жёлтый. Шрифт карточки — интерфейса, не кода.
- Ссылка в markdown открывается через `orca.shell?.openExternal(url)`.
- Поповер «Заметки» (`showPopover`): все заметки репозитория; строка — путь и строки, сторона, первая строка цитаты и текста, состояние, «Удалить». Вверху «Копировать все» (`copyText(notesText(…))`) и «Удалить все»: первое нажатие меняет подпись на `notesClearConfirm`, второе удаляет. Нажатие на заметку: файл с тем же путём и блобом стороны ищется среди `files` (по пути), `show(index, false, …)`; если карточки нет в строках — `show(index, true, …)`; затем прокрутка к карточке. Нет файла во вкладке — строка без перехода.
- `diff-app.ts`: при показе и по событию `notes.changed` своего корня — `api.notes(root)` → `setNotes` → `rerender()`.

Строки (`en` / `ru`):

| Ключ | en | ru |
|---|---|---|
| `notesButton` | Notes | Заметки |
| `notesButtonTip` | Review notes for the agent | Заметки для агента |
| `noteAdd` | Add a note (Ctrl+Shift+A) | Добавить заметку (Ctrl+Shift+A) |
| `notePlaceholder` | Note for the agent, in markdown. Enter saves, Shift+Enter adds a line, Esc cancels. | Заметка для агента, markdown. Enter — сохранить, Shift+Enter — новая строка, Esc — отмена. |
| `noteEdit` / `noteDelete` / `noteResend` | Edit / Delete / Send again | Изменить / Удалить / Отправить снова |
| `noteUnsent` / `noteSent` | Not sent / Sent, no answer yet | Не отправлена / Отправлена, ответа нет |
| `noteConfirmed` / `noteRefuted` / `noteUnclear` / `noteFixed` | Confirmed / Refuted / Needs clarification / Fixed | Подтверждено / Опровергнуто / Нужно уточнение / Исправлено |
| `noteReply` | Agent's answer | Ответ агента |
| `noteSideOld` / `noteSideNew` | old / new | было / стало |
| `notesEmpty` | No notes yet. Select text in the diff and press Ctrl+Shift+A. | Заметок нет. Выделите текст в диффе и нажмите Ctrl+Shift+A. |
| `notesCopyAll` / `notesClearAll` | Copy all / Delete all | Копировать все / Удалить все |
| `notesClearConfirm` | `{ one: 'Delete {count} note?', other: 'Delete {count} notes?' }` | `{ one: 'Удалить {count} заметку?', few: 'Удалить {count} заметки?', many: 'Удалить {count} заметок?', other: 'Удалить {count} заметки?' }` |

Иконки (`lucide-static` 0.469.0): `note` — `message-square`: `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`; `send` — `send`: `<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>`. Счётчик иконок в README («32 icons») поправить.

- [ ] **Step 1:** `api.ts`, иконки, строки.
- [ ] **Step 2:** `src/ui/notes.ts` и подключение в `diff.ts` (`renderLines` берёт `NotesView`: `mark` для ячеек, `rowsAfter` после строк; `attach` после `render()`; кнопки в `.diff-header` после `.spacer`; клавиша в `onKey`; `dispose`) и в `diff-app.ts`.
- [ ] **Step 3:** стили в `src/ui/styles.css` рядом с `.diff-lines`: `.note-mark` (жёлтый 28% через `color-mix`), `.d-note` (фон `var(--muted)`, радиус, отступы `8px 10px`), редактор, метки, правила `data-pick`, кнопка у выделения (`position: fixed`), список в поповере.
- [ ] **Step 4:** `orca plugin test .` — зелёные; `tsc` — 0 новых ошибок.
- [ ] **Step 5: проверка в headless Chromium** (вне репозитория, `/tmp/gitlog-notes-bench`):
  - `server.mjs <src> <port>`: отдаёт `<src>/**`; `.ts` — через `stripTypeScriptTypes` из `node:module` с `content-type: text/javascript`; `/bench.html` — страница.
  - `bench.html` ставит `window.orca`: `locale: 'en'`; `settings.get` → `{}`, `settings.onDidChange`; `host.has` → `false`; `on`; `document.get` → `{ content: { text: '{"root":"/r"}' } }`; `plugin.on`; `plugin.request`: `diff.state` → один файл `a.ts` (`from` — 40 единиц, `to` — 40 двоек), `range.diff` → ханк из Task 3 с `oldBlob` и `newBlob`, `notes.list` → `{ notes: window.notes }`, `notes.add` → кладёт черновик в `window.added` и в `window.notes`, отвечает `{ ok: true, note }`. Затем грузит `/ui/diff-app.ts`.
  - Сценарий после отрисовки: `Range` на тексте `a = 2` в правой ячейке первой строки; `mousedown` и `mouseup` на ячейке; `keydown` с `ctrlKey`, `shiftKey`, `code: 'KeyA'`; в `textarea` значение `why 2?`; `keydown` Enter; `JSON.stringify(window.added)` — в `<pre id="out">`.
  - Запуск: `chromium --headless --dump-dom --virtual-time-budget=10000 --user-data-dir=$(mktemp -d) http://127.0.0.1:<port>/bench.html`.
  - Ожидается в `#out`: `"side":"new"`, `"start":{"line":1,"col":6}`, `"end":{"line":1,"col":11}`, `"quote":"a = 2"`, `"body":"why 2?"`; в DOM есть `.d-note` и `.note-mark` с текстом `a = 2`.
  - Второй прогон в unified (`localStorage['git-log.prefs.diff'] = '{"diffMode":"unified"}'`) с выделением от начала `-` строки до середины `+` строки: `"side":"old"`, `"start":{"line":1,"col":0}`, `"end":{"line":1,"col":11}`, `"quote":"const a = 1"`.
- [ ] **Step 6:** README: в «Features» пункт «Review notes» (создание, карточка, список), в клавишах вкладки Diff — `Ctrl+Shift+A`.
- [ ] **Step 7:** commit: `Review notes in the Diff tab: select text, press Ctrl+Shift+A, and the note stays under its lines`.

### Task 6: Отправка новому агенту

**Files:**
- Create: `src/worker/review.ts`, `src/worker/reviewGuide.ts`, `src/worker/review.test.ts`
- Modify: `src/worker/main.ts`, `src/ui/notes.ts`, `src/shared/i18n.ts`, `orca-plugin.json` (capabilities `agent:launch`, `agent:read`), `README.md`

**Interfaces:**
- Consumes: Task 2 (`listNotes`, `markSent`), `workspaceFor` (`src/worker/diffTab.ts`), `exclude` (`src/worker/main.ts`).
- Produces:

```ts
// src/worker/reviewGuide.ts
export const REVIEW_GUIDE: string

// src/worker/review.ts
export interface ReviewPaths { dir: string; notes: string; guide: string; answers: string }
/** <root>/.orca-git-log/review-<review>/ with notes.md, SKILL.md and answers/. */
export function reviewPaths(root: string, review: string): ReviewPaths
export function notesFile(notes: ReviewNote[], paths: ReviewPaths): string
export function reviewPrompt(paths: ReviewPaths): string
/** Makes the folder and its files; on a refusal or a failed write removes what it made. */
export function writeReview(root: string, review: string, notes: ReviewNote[]): { ok: true; paths: ReviewPaths } | { ok: false; reason: string }
/** Removes the folder of a review; nothing but a real folder named review-<12 hex> inside a real .orca-git-log. */
export function removeReview(root: string, review: string): void
```

`notes.md` (английский): заголовок; абзац «Write one answer file per note to `<answers>/<note id>.md`» с формой ответа (`verdict: confirmed | refuted | unclear`, `fixed: yes | no`, пустая строка, markdown: что проверено, доказательство, уверенность 0–100, что изменено, что не проверено); затем на заметку: `## Note <id>`, `File: <path>`, `Lines: <a>-<b>, <new|old> side, as of commit <rev> (git show <rev>:<path>)`, `Selected:` и цитата с отступом в 4 пробела, `Comment:` и текст.

Промпт — одна строка без обратных кавычек:

```
Review notes from the user are in <notes>. Work through every note: check it against the code, answer it (confirmed, refuted or unclear) with your evidence, and fix the code for each note you confirm. Use this project's own review skills and rules first (.claude/skills, .agents/skills, AGENTS.md, CLAUDE.md); where they say nothing, follow <guide>. Write one answer file per note into <answers>, in the form the notes file describes.
```

`REVIEW_GUIDE` — дословно:

```markdown
# Working through review notes

You are a fresh, independent reviewer. The user left notes on a diff. Each note is a claim (something is wrong) or a request (change this). Your value is an independent check: do not agree to be agreeable, and do not defend the code.

## Stance

- Take neither the note nor the code at its word. Comments, names and commit messages are claims too: check what the code does.
- A note can be wrong. Refuting it with evidence is as useful as confirming it.
- A preference is not a defect. If the code is correct and the project's rules do not ask for the change, say so.
- The project's rules and its task description are the standard (AGENTS.md, CLAUDE.md, the project's skills and docs). Behaviour they prescribe is not a defect.

## For each note

1. Read the selected text in its place: `git show <commit>:<path>` prints the version the note was written on. Then find that code in the working tree and read the function, its callers and its tests, not only the selected lines.
2. Decide: `confirmed` (the note is right), `refuted` (it is not, and why), or `unclear` (you cannot tell: say what you would need to know).
3. Back the verdict with something that can be opened: `file:line`, a test you ran and its output, or the rule that applies. Give your confidence, 0-100.
4. If confirmed, fix it in the working tree with the smallest change that settles the note. Do not widen the fix to code the note does not cover; list anything else you noticed separately.
5. Do not switch branches, reset, stash or commit unless the project's rules tell you to.
6. If the code the note points at has already changed in the working tree, say so.

## Answer

One file per note, at the path the notes file gives: `verdict:` on the first line, `fixed: yes` or `fixed: no` on the second, a blank line, then markdown with what you checked, the evidence, your confidence, what you changed (files and lines) and what you did not check.

When every note is answered, report briefly in the chat: how many were confirmed, refuted and unclear, and what you changed.
```

Обработчик `notes.send` (`main.ts`), по порядку:
1. `gitFor(root)`; заметки — из `listNotes` по `ids`, без `sentAt`; пусто — `t('reviewNothing')`.
2. `agent` — строка по `/^[a-z0-9][a-z0-9._-]{0,63}$/i`, иначе `t('noteInvalid')`.
3. `workspaceFor(…)`; нет — `t('diffNoWorkspace')`.
4. `exclude(git, root, '.orca-git-log/')`.
5. `writeReview`; отказ — его причина (`t('reviewDirTaken', { path })` или `t('reviewWriteFailed', { code })`).
6. Промпт длиннее 4096 — `removeReview`, `t('reviewPromptTooLong')`.
7. `host.call('agent.launch', { workspaceId, agent, prompt })`; отказ — `removeReview`, `t('reviewLaunchFailed', { error })`.
8. `markSent`, `notes.changed`, `{ ok: true, review }`.

Интерфейс: кнопка «Отправить агенту (N)» (иконка `send` и число) в шапке, пока `unsent(notes).length > 0`. Меню (`showMenu`): строка-заголовок (выключенный пункт) `notesSendAll`, под ней по пункту на вид агента; если у текущего файла есть свои неотправленные и их меньше, чем всех, — разделитель, заголовок `notesSendFile` и те же пункты. Виды: уникальные непустые `agent` из `orca.host.call('agents.list')` (отказ — пусто), плюс `claude` и `codex`; последний выбранный (`noteAgent` в `git-log.prefs.diff`) — первым. Отказ отправки — причина в поповере под кнопкой.

Строки (`en` / `ru`): `notesSend` — «Send to a new agent ({count})» / «Отправить новому агенту ({count})»; `notesSendAll` — «All unsent ({count})» / «Все неотправленные ({count})»; `notesSendFile` — «This file ({count})» / «Этот файл ({count})»; `notesNewAgent` — «New agent: {agent}» / «Новый агент: {agent}»; `reviewNothing` — «No unsent notes to send.» / «Нет неотправленных заметок.»; `reviewDirTaken` — «{path} is not a folder the plugin can write to.» / «{path} — не папка, в которую плагин может писать.»; `reviewWriteFailed` — «Could not write the review notes: {code}» / «Не удалось записать заметки: {code}»; `reviewPromptTooLong` — «The path of this repository is too long to send notes.» / «Путь репозитория слишком длинный для отправки заметок.»; `reviewLaunchFailed` — «The agent did not start: {error}» / «Агент не запустился: {error}».

- [ ] **Step 1: тесты** в `src/worker/review.test.ts` (`note()` — `draft()` из `testkit.ts` с `id: 'aaaaaaaaaaaa'`, `createdAt: 1`: `path: 'src/a.ts'`, `side: 'new'`, `rev` из 40 `c`, `start: { line: 3, col: 0 }`, `end: { line: 4, col: 1 }`, `quote: 'x\ny'`, `body: 'why?'`):

```ts
test('a review folder holds the notes, the guide and a place for answers', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-log-review-'))
  const made = writeReview(root, 'bbbbbbbbbbbb', [note()])
  assert.equal(made.ok, true)
  const paths = reviewPaths(root, 'bbbbbbbbbbbb')
  assert.equal(paths.dir, join(root, '.orca-git-log', 'review-bbbbbbbbbbbb'))
  const text = readFileSync(paths.notes, 'utf8')
  for (const part of ['## Note aaaaaaaaaaaa', 'File: src/a.ts', 'Lines: 3-4, new side', `git show ${'c'.repeat(40)}:src/a.ts`, '    x\n    y', 'why?', join(paths.answers, '<note id>.md')]) assert.ok(text.includes(part), part)
  assert.equal(readFileSync(paths.guide, 'utf8'), REVIEW_GUIDE)
  assert.equal(statSync(paths.answers).isDirectory(), true)
})
test('a link or a file in place of the folder is refused and nothing is written through it', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-log-review-'))
  const outside = mkdtempSync(join(tmpdir(), 'git-log-outside-'))
  symlinkSync(outside, join(root, '.orca-git-log'))
  assert.equal(writeReview(root, 'bbbbbbbbbbbb', [note()]).ok, false)
  assert.deepEqual(readdirSync(outside), [])
  const other = mkdtempSync(join(tmpdir(), 'git-log-review-'))
  writeFileSync(join(other, '.orca-git-log'), '')
  assert.equal(writeReview(other, 'bbbbbbbbbbbb', [note()]).ok, false)
})
test('the prompt names three paths, has no backtick and fits', () => {
  const paths = reviewPaths('/r'.repeat(100), 'bbbbbbbbbbbb')
  const prompt = reviewPrompt(paths)
  for (const path of [paths.notes, paths.guide, paths.answers]) assert.ok(prompt.includes(path))
  assert.equal(prompt.includes('`'), false)
  assert.equal(prompt.includes('\n'), false)
  assert.ok(prompt.length <= 4096)
})
test('removing a review leaves everything else', () => { /* writeReview двух отправок; removeReview одной: её папки нет, вторая и .orca-git-log на месте; removeReview(root, '../x') ничего не трогает */ })
test('sending launches a new agent and marks the notes', async () => {
  const root = fixture()
  const h = host(root, { 'agent.launch': { terminalId: 't-1' } })
  const worker = await mountWorker(main, { host: h })
  const { note } = await worker.request('notes.add', { root, draft: draft() })
  const sent = await worker.request('notes.send', { root, ids: [note.id], agent: 'claude' })
  assert.equal(sent.ok, true)
  const [call] = h.callsOf('agent.launch') as { workspaceId: string; agent: string; prompt: string }[]
  assert.equal(call.workspaceId, 'wt-1')
  assert.equal(call.agent, 'claude')
  assert.ok(call.prompt.includes(reviewPaths(root, sent.review).notes))
  assert.ok(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8').split('\n').includes('.orca-git-log/'))
  assert.equal((await worker.request('notes.list', { root })).notes[0].review, sent.review)
  assert.deepEqual(worker.refusals, [])
})
test('a launch that fails leaves the notes unsent and no folder', async () => {
  /* 'agent.launch': () => { throw hostError('action_failed', 'no agent') }: ok === false; sentAt undefined; readdirSync(<root>/.orca-git-log) === [] */
})
test('nothing to send, a bad agent name', async () => { /* ids: [] → ok false; agent: '--help' → ok false; callsOf('agent.launch') пуст */ })
```

- [ ] **Step 2:** `orca plugin test .` — падают. **Step 3:** написать `review.ts`, `reviewGuide.ts`, обработчик, меню, строки, capabilities. **Step 4:** зелёные; `orca plugin validate .` — код 0.
- [ ] **Step 5:** README: в «Features» — отправка (новый агент в терминале, папка `.orca-git-log/review-<id>/`, что в ней, запись в `.git/info/exclude`); в «Install» — новые права и повторное одобрение; в «Limitations» — только новый агент в терминале, модель и вид запуска задаёт Orca, «отправлено» не значит «доставлено».
- [ ] **Step 6:** commit: `Send the unsent review notes to a new agent: a folder of notes and a guide in the worktree, and a prompt that names them`.

### Task 7: Ответы агента

**Files:**
- Modify: `src/worker/review.ts`, `src/worker/main.ts`, `orca-plugin.json` (`contributes.events`: `{ "on": "agent.status.changed" }`), `README.md`
- Test: `src/worker/review.test.ts`

**Interfaces:**
- Consumes: Task 2 (`listNotes`, `setReplies`, `pendingRoots`, `deleteNotes`), Task 6 (`reviewPaths`, `removeReview`).
- Produces:

```ts
/** `verdict:` and `fixed:` lines in any order and case, a blank line, the markdown; null without a known verdict. */
export function parseAnswer(text: string, now?: number): NoteReply | null
/** The answers found for the sent notes that have none: answers/<note id>.md, a regular file of at most 65536 bytes, never through a link. */
export function readAnswers(root: string, notes: ReviewNote[], now?: number): Map<string, NoteReply>
```

Правила:
- `parseAnswer`: BOM и `\r` убираются; заголовок — строки `ключ: значение` до первой пустой; `verdict` — `confirmed`, `refuted` или `unclear` без учёта регистра; `fixed` — `yes` означает `true`, всё прочее и отсутствие — `false`; тело — остаток после `trim()`, обрезанный до `MAX_REPLY`.
- `main.ts`, `ingest(root)`: `readAnswers` → непусто → `setReplies` → `notes.changed`. Вызывается в `notes.list` перед ответом и в `orca.events.on('agent.status.changed', …)` для каждого корня из `pendingRoots`; ошибки события только в `orca.log`.
- `notes.delete`: для каждой отправки удалённых заметок, на которую больше не ссылается ни одна заметка корня, — `removeReview`.

- [ ] **Step 1: тесты**:

```ts
test('an answer reads as a verdict, a fixed mark and markdown', () => {
  assert.deepEqual(parseAnswer('verdict: confirmed\nfixed: yes\n\nDone in `a.ts:3`.', 7), { verdict: 'confirmed', fixed: true, body: 'Done in `a.ts:3`.', at: 7 })
  assert.deepEqual(parseAnswer('\uFEFFFixed: no\r\nVerdict: Refuted\r\n\r\nNo.\r\n', 7), { verdict: 'refuted', fixed: false, body: 'No.', at: 7 })
  assert.deepEqual(parseAnswer('verdict: unclear\n\nWhich file?', 7), { verdict: 'unclear', fixed: false, body: 'Which file?', at: 7 })
  assert.equal(parseAnswer('verdict: maybe\n\nx'), null)
  assert.equal(parseAnswer('Looks fine to me.'), null)
  assert.equal(parseAnswer(`verdict: confirmed\n\n${'b'.repeat(9000)}`)?.body.length, 8000)
})
test('an answer that is a link, too large or not a file is skipped', () => {
  /* writeReview; answers/<id>.md — symlink на файл снаружи: Map пуст; файл в 70 000 байт: пуст; папка с этим именем: пуст; верный файл: одна запись */
})
test('the agent event brings the answer in', async () => {
  const root = fixture()
  const h = host(root, { 'agent.launch': { terminalId: 't-1' } })
  const worker = await mountWorker(main, { host: h, events: ['agent.status.changed'] })
  const { note } = await worker.request('notes.add', { root, draft: draft() })
  const sent = await worker.request('notes.send', { root, ids: [note.id], agent: 'claude' })
  writeFileSync(join(reviewPaths(root, sent.review).answers, `${note.id}.md`), 'verdict: refuted\nfixed: no\n\nIt is right as it is.')
  await worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'p', state: 'done', receivedAt: 1 })
  assert.deepEqual(worker.posts.slice(-1), [{ event: 'notes.changed', payload: { root } }])
  const [stored] = (await worker.request('notes.list', { root })).notes
  assert.equal(stored.reply.verdict, 'refuted')
  assert.deepEqual(h.data().storage.pending, [])
})
test('a new worker picks up the answer', async () => {
  /* первый worker: add, send; h.data().storage → host второго (третий параметр host()); второй worker: файл ответа, emit: в notes.list есть reply */
})
test('the list itself picks up an answer', async () => { /* без события: файл ответа, затем notes.list: reply есть */ })
test('deleting the last note of a review removes its folder', async () => { /* send, notes.delete: existsSync(paths.dir) === false */ })
```

- [ ] **Step 2:** `orca plugin test .` — падают. **Step 3:** написать. **Step 4:** зелёные; `orca plugin validate .` — код 0.
- [ ] **Step 5:** README: в «Features» — ответы под заметками и их метки; в «Limitations» — ответ появляется, когда агент записал файл в нужной форме, `fixed` — слова агента.
- [ ] **Step 6:** commit: `Show the agent's answer under each note: one file per note, read when the agent's status changes and when the notes are listed`.

### Task 8: Проверка целиком, живая Orca, версия

**Files:**
- Modify: `orca-plugin.json` и `package.json` (`version` → `0.8.0`), `README.md`, `docs/superpowers/specs/2026-11-10-next-version-backlog.md` («Состояние»), `docs/superpowers/specs/2026-11-15-review-notes-design.md` (статус)

- [ ] **Step 1:** `orca plugin test .` — все зелёные; `npx -y -p typescript@5 tsc -p . --noEmit` — не больше 129 ошибок, в новых файлах 0; `orca plugin validate .` и `orca plugin check .` — код 0.
- [ ] **Step 2:** `git ls-files --eol src | grep -v vendor` — у новых файлов `w/crlf`; у трёх файлов `w/mixed` нет изменений в `git diff --stat c99da78`.
- [ ] **Step 3: живая сессия в Orca** (только после согласия пользователя; команды: `orca plugin dev load .`, одобрение новых прав по отпечатку, в конце `orca plugin dev unload local.git-log`). Проверить и записать результат каждой строки:
  1. Выделение в split держится в одной колонке, в unified не захватывает строки другой стороны.
  2. `Ctrl+Shift+A` доходит до вкладки (Orca не перехватывает); заметка сохраняется и видна после перезапуска Orca.
  3. Заметка показывается в диффе другого выделения с тем же содержимым файла.
  4. Отправка `claude`: агент открылся в терминале workspace, получил промпт, прочитал `notes.md` и `SKILL.md` без запроса прав.
  5. Ответ появился под заметкой без открытия вкладки заново; то же после простоя worker'а больше 5 минут.
  6. Ссылка в ответе открывается через подтверждение Orca; ответ с `<img onerror>` показан текстом.
  7. `git status` в worktree чистый при существующей папке `.orca-git-log/`.
- [ ] **Step 4:** расхождения из шага 3 исправить с тестом; то, что упирается в Orca, записать в «Limitations» и в `docs/orca-issues.md`.
- [ ] **Step 5:** версия `0.8.0`; в бэклоге, «Состояние», — п. 13 сделан (этап 1), п. 11 ждёт этап 2; в спеке — статус «этап 1 реализован в 0.8.0».
- [ ] **Step 6:** commit: `Release 0.8.0: review notes on selected text, sent to a new agent, with the agent's answer under each note`. Выпуск (push, тег `v0.8.0`, `orca plugin update predmaxim.git-log`) — по README «Release», только с согласия пользователя.

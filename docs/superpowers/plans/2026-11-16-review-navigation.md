# Заметки ревью: переход к коммиту, кнопки, карта файла, заметки в «Файлах» — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** клик по заметке ведёт в коммит, где она видна; кнопки ревью выделены (вариант A); в «Весь файл» — карта изменений и заметок шириной 5 px; заметки строками под файлами в секции «Файлы» панели.

**Architecture:** у файлов выделения появляются id содержимого обеих сторон (`git --raw`), по ним вкладка и панель сопоставляют заметки так же, как вкладка уже делает по диффу. Коммит заметки, которой нет в текущей вкладке, worker находит по содержимому (`git log --find-object`), открывает вкладку на нём с id заметки для прокрутки и шлёт панели событие выделить этот коммит. Карта — отдельная полоса справа от `.diff-body`, метки ставятся по измерению DOM.

**Tech Stack:** TypeScript без сборки (Orca транспилирует), DOM, `node:test` и `orca/testing` через `orca plugin test .`, git 2.30+ (проверено на 2.56.0).

**Spec:** `docs/superpowers/specs/2026-11-16-review-navigation-design.md` (редакция 2); база — `2026-11-16-review-threads-design.md`.

## Global Constraints

- Ответ worker'а фрейму — до 1 МиБ: окно файлов вкладки — не больше 900 000 байт JSON (UTF-8). Id заметки — 12 hex (`randomBytes(6)`, `src/worker/notes.ts:18`); id коммита и blob'а — 40 hex (`HASH` в `selection.ts`).
- У файла с `oldBlob === newBlob` или статусом `T` заметок нет (панель и сопоставление по файлам выделения).
- Карта: только «Весь файл» и есть строки; ширина 5 px; изменения — `--st-added` / `--st-deleted` / `--st-modified`, не ниже 2 px; заметки — `--state-wait`, поверх, не ниже 3 px, решённые — непрозрачность 0.4; клик ставит место в 40 px от верха.
- Вид — `orca-plugin-ui`: только переменные `src/ui/styles.css` (`--input`, `--primary`, `--primary-fg`, `--fg`, `--muted-fg`, `--st-*`, `--state-*`); жёлтый — только предупреждение; в светлой теме жёлтый текст `color-mix(in srgb, var(--state-wait) 50%, black)` (как `.head-state .op`, `styles.css:287`).
- Строки — через `t()`, ключи в `en` и `ru` (`src/shared/i18n.ts`, `i18n.test.ts`).
- Концы строк: файл сохраняет свои (`git ls-files --eol`; почти все `src/` — CRLF, `protocol.ts`, `api.ts`, `app.ts`, `main.ts`, `reveal*.ts` — LF). Новые файлы в `src/` — CRLF (`sed -i 's/\r$//; s/$/\r/' <файл>`), документы — LF. Файлы со смешанными концами (`src/worker/main.test.ts`, `src/worker/git.test.ts`, `src/ui/graph.test.ts`) правятся только скриптом, меняющим нужные строки; после — `git diff --stat` без лишних строк. Новые тесты — в новых файлах.
- Ошибки tsc (`node ~/.npm/_npx/5abcb55351612887/node_modules/typescript/bin/tsc --noEmit -p .`; в worktree сначала скопировать `.orca/types` из основной копии): 190 на `7ab299c`; новые — только `TS2307`/`TS2591` на `node:*` в новых файлах.
- Тесты: `orca plugin test .` — все зелёные (363 на `7ab299c`); `orca plugin validate .`, `orca plugin check .` — код 0.
- Каждая новая команда git — строка в `docs/git-safety.md` в том же коммите. Документация — в том же коммите, что поведение. Без ИИ-соавторов в коммитах.
- Orca: `orca plugin dev load|unload|reload` — только контролёр. UI-задачи проверяются стендом в headless Chromium вне репозитория: вкладка — `/tmp/review-ux/bench` (`server.mjs <src-root> <port>` с `TS_PATH`, `cdp.mjs`, страница `diff.html` отвечает на запросы сама), панель — `/tmp/gitlog-bench` (настоящий worker с заглушкой хоста; нет `storage`: для заметок добавить ответы `storage.get/set` как в `refusingStorage` из `testkit.ts`). Скриншоты — тёмная и светлая темы, пути — в отчёте задачи.

## Review Focus

1. Коммит заметки удалён (rebase и сборка мусора) или содержимое не найдено: список «Заметки» говорит почему и остаётся рабочим (Task 4, тест «a note whose content no commit changes has no commit»; Task 5 — показ `refused`).
2. После перехода к заметке вкладка перемонтируется (клик по другому файлу в панели, перезагрузка фрейма): она не прыгает к заметке снова (Task 3, тест «the tab takes the note to reveal once»).
3. Панель показывает другой репозиторий, чем вкладка: событие `commit.reveal` ничего в ней не меняет (Task 6, проверка стендом).
4. Перенос строк, раскрытие карточки, загрузка картинки, смена ширины: метки карты остаются у своих строк (Task 9, `ResizeObserver` и проверка стендом с изменением ширины).
5. Длинные пути и тысячи файлов: окно вкладки укладывается в 900 000 байт и содержит выбранный файл (Task 3, тест «the tab's window of files fits the byte limit»); файл с равными blob'ами — без заметок (Task 2, тест).

---

### Task 1: Blob'ы сторон у файлов выделения

**Files:**
- Modify: `src/shared/protocol.ts` (`SelectionFile`), `src/worker/log.ts` (рядом с `parseNameStatus`), `src/worker/selection.ts`, `src/worker/selection.test.ts`, `docs/git-safety.md` (строка 43)

**Interfaces:**
- Produces: `SelectionFile.oldBlob?: string`, `SelectionFile.newBlob?: string` — полные id; стороны нет (id из нулей) — поля нет. `export interface RawChange extends FileChange { oldBlob?: string; newBlob?: string }`, `export function parseRaw(stdout: string): RawChange[]`, `export const RAW_ENTRY: RegExp` (`/^\n?:\d{6} \d{6} [0-9a-f]{40,64} [0-9a-f]{40,64} [A-Z]\d*$/`) — в `src/worker/log.ts`.

Формат `-z --raw` (проверено на git 2.56.0): запись `[\n]:<mode> <mode> <old> <new> <status>\0<path>\0`, у `R`/`C` — два пути (`old`, `new`); в `git log` перед первой записью коммита — `\n`, перед следующими — нет.

- [ ] **Step 1: Failing tests** в `selection.test.ts` (сохранить CRLF):
  - `test('each file carries the blobs of its two sides, as the range diff has them')`: модификация, добавление, удаление, переименование с правкой в одной выборке из нескольких коммитов и из одного; для каждого файла `oldBlob`/`newBlob` равны `readRangeDiff(...).oldBlob/newBlob`; у добавленного нет `oldBlob`, у удалённого нет `newBlob`.
  - `test('a pure rename has two equal blobs')`: `git mv` без правки → `oldBlob === newBlob`, оба заданы.
  - `parseRaw` на строке с `R079` и двумя путями, на пути с `\n` и `:` внутри.
  - Обновить существующие `deepEqual` с `SelectionFile` (строки 41, 52, 76, 87, 112, 148, 163, 175, 182, 201, 204): добавить blob'ы (через `git rev-parse <rev>:<path>`).
- [ ] **Step 2:** `orca plugin test .` — новые падают.
- [ ] **Step 3:** `parseRaw` и `RAW_ENTRY` в `log.ts`; в `readSelectionFiles` оба вызова git — `--raw --no-abbrev` вместо `--name-status`, обход полей по `RAW_ENTRY` (число путей — по букве статуса `R`/`C`), `Entry.only` и результаты групп несут blob'ы. `parseNameStatus` не трогать (им пользуется `readDetails`). У обработчика `selection.files` в `main.ts` — комментарий `shortcut:` (ответ растёт на 106 байт на файл, выделение больше ~3 800 файлов упрётся в 1 МиБ; разбить «Файлы» на страницы, когда это станет нужно).
- [ ] **Step 4:** `orca plugin test .` — всё зелёное; tsc — без новых ошибок.
- [ ] **Step 5:** строка 43 `docs/git-safety.md`: `--raw --no-abbrev` вместо `--name-status` в обеих командах. Commit `Give each file of a selection the blobs of its two sides, from git --raw`.

### Task 2: Какие заметки у файла выделения

**Files:**
- Modify: `src/shared/notes.ts`
- Create: `src/shared/notes.test.ts`

**Interfaces:**
- Consumes: `SelectionFile.oldBlob/newBlob` (Task 1).
- Produces (в `src/shared/notes.ts`, без DOM — им пользуются worker, вкладка и панель):
  - `notesOfFile(notes: ReviewNote[], file: SelectionFile): ReviewNote[]` — заметки, чей blob равен blob'у их стороны у файла; пусто, если `oldBlob === newBlob` или `status === 'T'`; порядок: незакрытые по `start.line`, затем решённые по `start.line`.
  - `noteFileIndex(files: SelectionFile[], note: ReviewNote, current: number): number` — индекс файла, где заметка видна: сначала `current`, затем файл с тем же путём (`side === 'new' ? path : oldPath ?? path`), затем первый; `-1` — нигде.
  - `type NoteTone = 'unsent' | 'waiting' | 'answered' | 'done' | 'resolved'`; `noteTone(note: ReviewNote): NoteTone` — `resolved` → `resolved`; `waiting` → `waiting`; `unsent` → `unsent`; последний ответ агента с вердиктом `confirmed` или `fixed` → `done`; иной ответ агента → `answered`; иначе (`idle`) → `unsent`.

- [ ] **Step 1: Failing tests** `src/shared/notes.test.ts`: `notesOfFile` — новая и старая стороны, чужой blob, файл с равными blob'ами → `[]`, статус `T` → `[]`, порядок (две незакрытые на строках 9 и 3, решённая на 1 → `[3, 9, 1]`); `noteFileIndex` — текущий файл первым, совпадение по пути среди двух файлов с одним blob'ом, `-1`; `noteTone` на каждом состоянии.
- [ ] **Step 2:** тест падает. **Step 3:** реализация. **Step 4:** `orca plugin test .` — зелёное.
- [ ] **Step 5:** Commit `Match review notes to the files of a selection by the blobs of their sides`.

### Task 3: Окно файлов вкладки по байтам и заметка для прокрутки

**Files:**
- Modify: `src/shared/protocol.ts` (`DiffTabState`, `diff.open`), `src/worker/diffTab.ts`, `src/worker/main.ts` (`openDiff`, `diff.state`, `diff.index`)
- Create: `src/worker/diffTab.test.ts`

**Interfaces:**
- Produces:
  - `DiffTabState.reveal?: string` — id заметки, к которой вкладка прокрутит после показа файла; `diff.open` input `note?: string` (12 hex, иначе игнорируется).
  - `fitWindow(files: SelectionFile[], index: number, limit = 900_000): { first: number; count: number }` в `src/worker/diffTab.ts`: окно вокруг `index` (по одному файлу после и до по очереди), сумма `Buffer.byteLength(JSON.stringify(file)) + 1` не больше `limit`; файл `index` всегда в окне.
  - `showDiff(root: string, files: SelectionFile[], index: number, reveal?: string): Promise<{ ok: boolean; reason?: string }>` в `main.ts` — общий хвост `openDiff` (окно `fitWindow`, состояние, `editor.open` с откатом, `diff.show`); им же пользуется Task 4.
  - `diff.state` отдаёт состояние и снимает с хранимого `reveal` (заметка показывается один раз: новый `diff.show` и перезагрузка фрейма её не повторяют); `diff.index` тоже снимает.

- [ ] **Step 1: Failing tests** `src/worker/diffTab.test.ts`:
  - `test('the tab\'s window of files fits the byte limit')`: 3000 файлов с путями по 300 символов и `oldPath` → сумма ≤ 900 000, `index` внутри, окно непрерывно; 10 коротких файлов → всё окно.
  - `test('the tab takes the note to reveal once')` через `mountWorker` и `host` из `testkit.ts` (как `main.test.ts` «opening a file shows it…»): `diff.open` с `note: 'abcdef012345'` → первый `diff.state` содержит `reveal`, второй — нет; `diff.open` без `note` — нет `reveal`; `note: 'x'` игнорируется.
- [ ] **Step 2:** тесты падают. **Step 3:** реализация; комментарий `shortcut:` у `main.ts:178` заменить на правило байтов. **Step 4:** `orca plugin test .` — зелёное (существующий тест `main.test.ts` «opening a file…» сравнивает состояние без `reveal` — должен пройти без правки).
- [ ] **Step 5:** Commit `Cut the Diff tab's files to 900000 bytes around the file opened, and let it take a note to scroll to once`.

### Task 4: Коммит заметки и `notes.open`

**Files:**
- Create: `src/worker/noteCommit.ts`, `src/worker/noteCommit.test.ts`
- Modify: `src/shared/protocol.ts` (запрос `notes.open`, событие `commit.reveal`), `src/worker/main.ts`, `src/shared/i18n.ts`, `docs/git-safety.md` (новая строка)

**Interfaces:**
- Consumes: `parseRaw`, `RAW_ENTRY` (Task 1); `noteFileIndex` (Task 2); `showDiff` (Task 3).
- Produces:
  - `findNoteCommit(git: Git, note: Pick<NoteAnchor, 'side' | 'blob' | 'rev'>): Promise<string | null>` — полный hash коммита, чей дифф с первым родителем меняет содержимое заметки на её стороне; `null` — не найден или `rev`/`blob` не 40 hex, или git отказал (неизвестная ревизия).
  - запрос `'notes.open': { input: { root: string; id: string }; output: { ok: boolean; reason?: string } }`;
  - событие панелям `'commit.reveal': { root: string; hash: string; path: string }`.

Команда (одна для обеих сторон): `git log -M --diff-merges=first-parent --raw --no-abbrev -z --find-object=<blob> --format=%H <ревизии> --`. Ревизии: новая сторона — `-n 50 <rev>`; старая — `HEAD ^<rev>`, без находки — `--branches --remotes --tags ^<rev>`. Подходит коммит, у которого есть запись `--raw` с `new === blob && old !== blob` (новая) или `old === blob && new !== blob` (старая): `--find-object` выдаёт и `R100`, их отбросить. Новая сторона — первый подходящий, старая — последний (самый старый). Вывод разбирается по структуре: hash, затем записи по `RAW_ENTRY` с путями по статусу.

- [ ] **Step 1: Failing tests** `noteCommit.test.ts` (временные репозитории как `repoWith` в `selection.test.ts`):
  - `test('a new-side note opens the commit that wrote its content')`: `rev` — сам коммит правки → он.
  - `test('a rename at the edge of the selection still finds the commit that changed the content')`: новая сторона — правка `b`, затем `git mv b c`, `rev` = переименование → коммит правки; старая — `a` в P, `git mv a b`, правка `b`, `rev` = P → коммит правки.
  - `test('a merge that keeps its first parent\'s file is not the commit of a note')`: `merge -s ours` не выбирается; правка на побочной ветке после слияния выбирается.
  - `test('a note whose content no commit changes has no commit')`: неизвестный blob → `null`; неизвестный `rev` → `null`; `rev` не hex → `null` без запуска git.
  - через `mountWorker`: `notes.open` для заметки из хранилища (seed `storage` в `host`, формат как в `notes.test.ts`) → `{ ok: true }`, `diff.state` с файлом заметки и `reveal`, последний пост — `commit.reveal { root, hash, path }`; неизвестный id → `{ ok: false, reason }`.
- [ ] **Step 2:** тесты падают. **Step 3:** `noteCommit.ts`; обработчик `notes.open` в `main.ts`: заметка из `listNotes(orca.storage, key)` → `findNoteCommit` → `orderedFiles(buildFileTree(readSelectionFiles(git, [hash])))` → `noteFileIndex(files, note, -1)` → `showDiff(key, files, index, note.id)` → `panels.post('commit.reveal', …)`. Причины отказа — новые ключи i18n: `noteGone` («This note is gone» / «Заметки больше нет»), `noteCommitMissing` («No commit shows this note: its content is not in the history any more» / «Нет коммита, где видна эта заметка: её содержимого больше нет в истории»), `noteFileMissing` («The commit of this note does not change its file» / «Коммит заметки не меняет её файл»).
- [ ] **Step 4:** `orca plugin test .` — зелёное; tsc — без новых ошибок, кроме `node:*` в новых файлах.
- [ ] **Step 5:** новая строка `docs/git-safety.md` после 43: где — `noteCommit.ts`; команда; входы — `rev` и `blob` из хранилища заметок; проверки — оба 40 hex, ревизии собираются только из них, `--` в конце; при отказе — `null`, вкладка показывает причину; тесты — имена из Step 1. Commit `Open the commit a review note shows in, found by its content, and ask the panel to select it`.

### Task 5: Вкладка — клик по заметке из любого коммита

**Files:**
- Modify: `src/ui/api.ts` (`notesOpen`, `openDiff(..., note?)`), `src/ui/notes.ts` (`item`, `reveal`, `NotesView`), `src/ui/diff.ts` (опция `reveal`), `src/ui/diff-app.ts`, `README.md` (абзац «A click on a note…»)

**Interfaces:**
- Consumes: `noteFileIndex` (Task 2); `DiffTabState.reveal` (Task 3); `notes.open` (Task 4).
- Produces: `api.notesOpen(root: string, id: string): Promise<{ ok: boolean; reason?: string }>`; `api.openDiff(root, hashes, file, note?: string)` (передаёт `note`, если задан); `DiffOptions.reveal?: string`; `NotesView.reveal(id: string): void` — показывает файл заметки этой вкладки и прокручивает к карточке (с «Весь файл», если строки вне кусков), после загрузки заметок и диффа, без второго запроса диффа.

- [ ] **Step 1:** `item(n)`: индекс — `noteFileIndex(files, n, files.indexOf(file))`; кнопка всегда активна, комментарий `notes.ts:845` убрать. Нажатие: индекс ≥ 0 → прежний `reveal(index, id)`; иначе закрыть список, `api.notesOpen(root, n.id)`; отказ или исключение → `notify(reason)` (строка наверху списка и жёлтая кнопка «Заметки»).
- [ ] **Step 2:** `diff-app.ts` передаёт `state.reveal` в `mountDiff`; `mountDiff` после загрузки заметок и первого показа файла вызывает `notes.reveal(id)` один раз (повторный вызов `show` до готовности `diff` не грузит дифф второй раз).
- [ ] **Step 3:** стенд `/tmp/review-ux/bench`: вкладка на коммите X, заметка из коммита Y (ответ `notes.open` → `diff.show` с новым состоянием и `reveal`) — после клика видна карточка; заметка этой же вкладки — прокрутка без запроса `notes.open`; отказ `notes.open` — текст наверху списка. Скриншоты.
- [ ] **Step 4:** `orca plugin test .` — зелёное; tsc — без новых ошибок.
- [ ] **Step 5:** README: клик открывает заметку там, где она видна: в файле этой вкладки, иначе в коммите, где написано её содержимое, а панель выделяет этот коммит. Commit `Open a review note from the Notes list wherever it shows: in a file of the tab, else in its own commit`.

### Task 6: Панель выделяет коммит заметки

**Files:**
- Modify: `src/ui/app.ts` (`revealCommit`, `jumpTo`, обработчик событий рядом с `diff.current`)

**Interfaces:**
- Consumes: событие `commit.reveal` (Task 4).
- Produces: `revealCommit(hash: string, options?: { focus?: boolean; file?: string })` — `focus: false` не трогает фокус (`jumpTo` без `viewport.focus`); `file` — путь, который станет текущим файлом, когда загрузятся файлы выделения (если он в них есть), с раскрытием папок и прокруткой к строке, как в обработчике `diff.current`.

- [ ] **Step 1:** `orca.plugin.on('commit.reveal', …)`: только `root === repo?.root`; `revealCommit(hash, { focus: false, file: path })`. Запрос из `reveal.json` (`start()`) — как был, с фокусом.
- [ ] **Step 2:** стенд `/tmp/gitlog-bench`: пост `commit.reveal` своего корня — коммит выделен, файл подсвечен, фокус не сдвинут; чужого корня — ничего. Скриншот.
- [ ] **Step 3:** `orca plugin test .` — зелёное; tsc — без новых ошибок.
- [ ] **Step 4:** Commit `Select in the Commits section the commit the Diff tab opened for a note`.

### Task 7: Заметки в секции «Файлы»

**Files:**
- Modify: `src/ui/filetree.ts`, `src/ui/app.ts` (заметки репозитория, `drawFiles`, `openFile`), `src/ui/styles.css`, `src/shared/i18n.ts`, `README.md` (Files of the selection)

**Interfaces:**
- Consumes: `notesOfFile`, `noteTone` (Task 2); `api.notes`; `api.openDiff(..., note)` (Task 5).
- Produces: `FileTreeHost.notes?(file: SelectionFile): ReviewNote[]` и `FileTreeHost.openNote?(file: SelectionFile, note: ReviewNote): void`.

- [ ] **Step 1:** `app.ts`: `let repoNotes: ReviewNote[]`; загрузка `api.notes(repo.root)` (с токеном против гонок) при смене репозитория в `setRepo` и по `notes.changed` с этим корнем; ошибка — `[]` молча; по загрузке — `drawFiles()`, если дерево есть. `openNote` → `openFile`-путь с `api.openDiff(root, filesHashes, file, note.id)`.
- [ ] **Step 2:** `renderFileTree`: у строки файла справа — значок `note` и число незакрытых из `host.notes(file)` (0 — ничего); сразу под файлом — строка на каждую заметку (`depth + 1`, лист, `role=treeitem`, `data-key = \`${file.path}/#${note.id}\``): кружок `note-dot tone-<tone>` (у `resolved` — значок `check`, вся строка класса `resolved`), номер `start.line` (моноширинный, приглушённый), первая строка первого сообщения с многоточием; `title` — `путь:строки (сторона) · состояние\nпервое сообщение` (новый ключ `fileNoteTip` в `en`/`ru`); клик/Enter → `host.openNote`.
- [ ] **Step 3:** CSS: высота строки как `.ft-row` (24 px); кружок 8 px: `unsent` — рамка 1.5 px `--muted-fg`, `waiting` — `--state-wait`, `answered` — `--state-info`, `done` — `--state-done`; `.resolved` — непрозрачность 0.5; текст 12 px.
- [ ] **Step 4:** стенд `/tmp/gitlog-bench` с заметками в заглушке хранилища: строки под файлами, решённая бледная и последней, файл без изменения содержимого — без строк, ← с заметки — к файлу, Enter — `diff.open` с `note`. Скриншоты при ширине 380 px.
- [ ] **Step 5:** `orca plugin test .` — зелёное; tsc. README. Commit `Show review notes under their files in the Files section, as Azure DevOps shows threads in its file tree`.

### Task 8: Кнопки ревью (вариант A)

**Files:**
- Modify: `src/ui/notes.ts` (кнопки шапки, `addButton`, шапка карточки), `src/ui/diff.ts` (порядок шапки), `src/ui/styles.css`, `src/shared/i18n.ts`, `README.md`

**Interfaces:**
- Consumes: ничего нового. Produces: классы `review-btn`, `review-btn primary`, `review-count`, `d-note-action`; ключи i18n `notesSendButton` («Send to an agent» / «Отправить агенту»), `noteAddShort` («Note» / «Заметка»).

- [ ] **Step 1:** шапка: `…, seg[Рядом|Вместе], Весь файл, sep, Заметки, Отправить агенту` (`notes.buttons` после `wholeButton` с `.sep` перед ними).
- [ ] **Step 2:** «Заметки» — `tool review-btn`: значок, подпись `t('notesButton')`, счётчик `review-count` с числом незакрытых (`title` и `notes-warn` как сейчас). «Отправить агенту» — `tool review-btn primary`: значок, подпись `t('notesSendButton')`, счётчик; `title`/`aria-label` — `t('notesSend', { count })`; без неотправленных скрыта, как сейчас.
- [ ] **Step 3:** плавающая кнопка: значок и подпись `t('noteAddShort')`, `title`/`aria-label` — `t('noteAdd')`, залита `--primary`. Карточка: «Отправить снова» и «Решено»/«Открыть снова» — `tool d-note-action` со значком и подписью; «Удалить» и «Изменить» — значки, как сейчас.
- [ ] **Step 4:** CSS: `.review-btn` — высота 28 px, отступы `0 10px`, рамка 1 px `--input`, фон `color-mix(in srgb, var(--input) 30%, transparent)`, текст `--fg`, hover 50 %; `.review-btn.primary` — фон и рамка `--primary`, текст `--primary-fg`, hover `color-mix(in srgb, var(--primary) 85%, var(--fg))`; `.review-count` — кружок 18 px, 11 px/600, фон `color-mix(in srgb, currentColor 18%, transparent)`; `.review-btn.notes-warn` — рамка и текст `--state-wait` (светлая тема — затемнённый); `.d-note-action` — 24 px, 12 px, `0 8px`, рамка и фон как `.review-btn`.
- [ ] **Step 5:** стенд `/tmp/review-ux/bench`: шапка (обычная, предупреждение, без неотправленных), выделение, карточка в ожидании ответа — тёмная и светлая, ширина 1400 и 760 px; сравнить с макетом A (`~/.config/orca/chat-scratch/9d87aaf374358966c4ec9ff27cf76800/review-buttons-a1.html`).
- [ ] **Step 6:** `orca plugin test .` — зелёное; tsc. README (шапка вкладки, карточка). Commit `Set the review buttons apart: their own group last in the header, Send to an agent as the primary button, labels on the thread's actions`.

### Task 9: Карта файла в «Весь файл»

**Files:**
- Modify: `src/ui/diffmodel.ts` (`changeStarts` → `changeBlocks`), `src/ui/graph.test.ts` (одна строка — скриптом), `src/ui/diff.ts` (`renderLines`, обёртка тела, обновление карты), `src/ui/notes.ts` (`NotesView.visible`), `src/ui/styles.css`, `src/shared/i18n.ts`, `README.md`
- Create: `src/ui/overview.ts`, `src/ui/diffmodel.test.ts`, `src/ui/overview.test.ts`

**Interfaces:**
- Produces:
  - `type ChangeKind = 'added' | 'deleted' | 'modified'`; `interface ChangeBlock { start: number; end: number; kind: ChangeKind }` (`end` включительно); `changeBlocks(rows: { add: boolean; del: boolean }[]): ChangeBlock[]` — подряд идущие строки с изменениями; только `add` → `added`, только `del` → `deleted`, оба в блоке → `modified`. Заменяет `changeStarts` (F7 берёт `rows[block.start]`).
  - `NotesView.visible(): ReviewNote[]` — заметки показанного диффа (`shown`).
  - `src/ui/overview.ts`: `interface OverviewMark { from: HTMLElement; to: HTMLElement; kind: ChangeKind | 'note' | 'note-resolved'; title: string }`; `stripSpan(top: number, bottom: number, total: number, height: number, min: number): { top: number; height: number }` — масштаб `height / total`, высота не меньше `min`, метка целиком в полосе; `mountOverview(body: HTMLElement): { el: HTMLElement; set(marks: OverviewMark[]): void; dispose(): void }`.

- [ ] **Step 1: Failing tests** `diffmodel.test.ts` (`changeBlocks`: `[+,+]` → added; `[-]` → deleted; `[-,+]` → modified; разрыв контекстом даёт два блока; пусто → `[]`) и `overview.test.ts` (`stripSpan`: середина, низ — метка не выходит за полосу, `min` у однострочной метки, `total = 0` → `{ top: 0, height: min }`). Строку `changeStarts` в `graph.test.ts` заменить скриптом на эквивалент через `changeBlocks` (концы строк файла не менять).
- [ ] **Step 2:** тесты падают. **Step 3:** `changeBlocks`; `renderLines` собирает `{ add, del }` по строкам (строка заметки берёт значение строки над ней, заголовок куска — пусто) и возвращает `blocks: { first: HTMLElement; last: HTMLElement; kind: ChangeKind }[]`; `changes` = `blocks.map(b => b.first)`.
- [ ] **Step 4:** `overview.ts`: полоса `div.diff-overview[aria-hidden=true]`, метки — `div.ov-<kind>` с `title`; позиция строки = `el.getBoundingClientRect().top − body.getBoundingClientRect().top + body.scrollTop`, всего — `body.scrollHeight`, высота полосы — её `clientHeight`; метки заметок рисуются после меток изменений; пересчёт по `ResizeObserver` (`body` и первый `.diff-lines` из `set`) не чаще раза за кадр (`requestAnimationFrame`); клик — `body.scrollTop = позиция − 40`; `set([])` прячет полосу (`hidden`).
- [ ] **Step 5:** `diff.ts`: `body` и полоса в обёртке `div.diff-main`; после `render()` — `overview.set(...)` при `wholeFile`, без `binary`, с кусками; иначе `set([])`. Метки заметок — из `notes.visible()`: строки `.d-code[data-<side>="<line>"]` начала и конца → их `.d-row`; нет строки — без метки. Подсказки — новые ключи: `overviewAdded`, `overviewDeleted`, `overviewModified` («Added, lines {lines}» / «Добавлено, строки {lines}» и т. д.), `overviewNote` («Note, lines {lines}: {text}» / «Заметка, строки {lines}: {text}»); строки блока — номера `data-new` (у `deleted` — `data-old`) первой и последней строки.
- [ ] **Step 6:** CSS: `.diff-main { flex: 1; min-height: 0; display: flex }`, `.diff-body` внутри — `flex: 1; min-width: 0`; `.diff-overview { width: 5px; flex: none; position: relative; background: color-mix(in srgb, var(--fg) 4%, transparent) }`; метки — `position: absolute; left: 0; right: 0`; цвета из Global Constraints; светлая тема — `--state-wait` затемнён до 75 % с чёрным.
- [ ] **Step 7:** стенд: «Весь файл» в «Рядом» и «Вместе», метки у своих мест; смена ширины окна (перенос строк), раскрытие решённой карточки — метки сдвигаются; клик по метке — место в 40 px от верха; без «Весь файл» полосы нет. Скриншоты тёмной и светлой тем.
- [ ] **Step 8:** `orca plugin test .` — зелёное; tsc. README (Whole file). Commit `Map the whole file at the right edge of the Diff tab: blocks of changes and the review notes, a click goes there`.

### Task 10: Проверка целиком и документы

**Files:**
- Modify: `docs/superpowers/specs/2026-11-16-review-navigation-design.md` (статус), `docs/superpowers/specs/2026-11-10-next-version-backlog.md` (п. 14 — сделано), `README.md` (сверка)

- [ ] **Step 1:** `orca plugin test .`, `orca plugin validate .`, `orca plugin check .` — зелёное и код 0; tsc — 190 плюс только `TS2307`/`TS2591` в новых файлах.
- [ ] **Step 2:** `git diff --stat 7ab299c` — файлы со смешанными концами строк меняются только в правленых строках.
- [ ] **Step 3:** спека — «реализовано в ветке, проверено стендом; живая проверка — после слияния»; бэклог п. 14 — сделано (ссылка на спеку). Commit `Mark the review navigation design done and item 14 of the backlog with it`.

### Task 11: Вкладка Diff переживает перезапуск worker'а и не теряет заметку для прокрутки

Причина (проверено 2026-11-16): состояние вкладки — только в памяти worker'а (`diffStates`, `src/worker/main.ts:34`); Orca останавливает простаивающий worker и запускает заново по следующему запросу («An idle worker stops and restarts on its next command, event or panel request», `orca skills get orca-plugin-authoring --reference recipes`, Orca 1.4.259). Вкладка, поднятая заново (другой проект, восстановление вкладок, `dev reload`), получает `diff.state = null` и показывает «Выберите файл в панели Git…». Живая проверка 17:25: `orca plugin dev request local.git-log diff.state --data '{"root":"/home/predmaxim/Projects/mrdonald"}'` → `null` при вкладке, открытой в 16:18.

Вторая причина, того же места (ревью Task 3 и Task 5, проверено по коду `src/ui/diff-app.ts:60-70`): `diff.state` отдаёт `reveal` один раз, а новая вкладка может прочитать состояние дважды — в `start()` и по `diff.show`; первый `show()` отменяется токеном (`if (mine !== token) return`) вместе с полученным `reveal`, второй его уже не получает — прокрутка к заметке теряется.

**Files:**
- Modify: `src/shared/protocol.ts` (`DiffTabState`), `src/worker/notes.ts` (ключ рядом с `notesKey`), `src/worker/main.ts` (`showDiff`, `diff.state`, `diff.index`, `activate`), `src/worker/diffTab.test.ts` (тест «takes the note to reveal once» — под новое правило), `src/ui/diff-app.ts`, `README.md` (Diff tab), `docs/git-safety.md` (строка 43: hashes ещё и из хранилища)
- Create: `src/worker/diffRestore.test.ts`, `src/ui/revealonce.ts`, `src/ui/revealonce.test.ts`

**Interfaces:**
- Consumes: `showDiff`, `fitWindow` (Task 3); `DiffTabState.reveal` (не хранится).
- Produces:
  - `diffKey(root: string): string` = `'diff:' + sha256(root)` в `src/worker/notes.ts`; хранимое значение `{ root: string; hashes: string[]; path: string; to: string; open: string; reveal?: string }` — выделение вкладки, её текущий файл, id открытия и заметка для прокрутки.
  - `DiffTabState.open: string` — id открытия: 12 hex, новый на каждый `showDiff` (`randomBytes(6)`). `reveal` больше не снимается при чтении: `diff.state` отдаёт его каждый раз вместе с тем же `open`; снимает только `diff.index` и новое открытие без заметки.
  - `src/ui/revealonce.ts`: `revealToDo(state: Pick<DiffTabState, 'root' | 'open' | 'reveal'>, done: string | null): string | null` — id заметки, если `reveal` есть и `open !== done`, иначе `null`; вкладка хранит последнее выполненное `open` в `localStorage` под ключом `git-log.revealed.<root>` (переживает и перемонтирование, и перезагрузку фрейма) и записывает его, когда передаёт `reveal` в `mountDiff`.

- [ ] **Step 1: Failing tests** `src/worker/diffRestore.test.ts` (`mountWorker` и `host` из `testkit.ts`, один и тот же `host` — одно хранилище — на оба запуска):
  - `test('the Diff tab shows the same files after the worker restarts')`: `diff.open` → `deactivate` → новый `mountWorker` → `diff.state` равен прежнему (файлы, индекс), без `reveal`.
  - `test('the restarted tab opens on the file it was moved to')`: `diff.index` на другой файл → перезапуск → `index` этого файла.
  - `test('a stored selection whose commits are gone shows the placeholder')`: в хранилище — `hashes` несуществующего коммита → `diff.state` → `null`, без исключения; мусор в значении (не массив, не 40 hex, больше 500) → `null`.
  - `test('every read of the state carries the note until the tab moves')` (в `diffTab.test.ts`, вместо «takes the note to reveal once»): два `diff.state` подряд — оба с `reveal` и тем же `open`; после `diff.index` — без `reveal`; новый `diff.open` — другой `open`.
  - `revealonce.test.ts`: `revealToDo` — нет `reveal` → `null`; `open === done` → `null`; иначе id; другой корень не мешает (ключ по корню — в `diff-app.ts`).
  - Перезапуск в тесте: `activate` начинает с пустой памяти (`diffStates.clear()` в начале `activate`) — как настоящий новый worker; без этого модуль в одном процессе Node помнит состояние и тест не проверит ничего.
- [ ] **Step 2:** тесты падают (`null` после перезапуска).
- [ ] **Step 3:** `showDiff` после записи состояния — `storage.set(diffKey(root), { root, hashes, path, to })` (hashes — те, из которых строились файлы: вход `diff.open` или `[hash]` у `notes.open`); `diff.index` обновляет `path`/`to`; ошибка записи — в `orca.log`, не мешает показу; хранится и `open`, и `reveal`. `diff.state` без состояния в памяти читает хранилище, проверяет значение (корень совпадает, 1–500 hashes по 40 hex, строки), строит файлы как `openDiff` (`readSelectionFiles` → `buildFileTree` → `orderedFiles`), индекс — по `path` и `to` (нет — 0), окно — `fitWindow`, кладёт в память и отдаёт; любая ошибка — `null` и строка в `orca.log`. Вкладка (`diff-app.ts`): `show()` передаёт в `mountDiff` `reveal: revealToDo(state, localStorage.getItem(key))` и записывает `state.open` в `localStorage` сразу после передачи; отменённый токеном `show()` ничего не записывает — его `reveal` достанется следующему.
- [ ] **Step 4:** `orca plugin test .` — зелёное; tsc — без новых ошибок, кроме `node:*` в новом файле.
- [ ] **Step 5:** README (вкладка Diff помнит выделение и файл в хранилище плагина и после перезапуска worker'а Orca показывает их снова), `docs/git-safety.md` строка 43. Commit `Keep the Diff tab's selection and file in the plugin's storage, so a restarted worker shows them again instead of the placeholder`.

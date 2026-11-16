# Заметки после изменения кода: перенос и «Устарела» — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** заметка с нетронутыми строками показывается в более поздних версиях файла на сдвинутых строках; заметка, чьи строки изменились, помечена «Устарела» в списке и в «Файлах»; агент узнаёт об этом.

**Architecture:** worker сравнивает blob заметки с blob'ом стороны показанного файла (`git diff -U0`) и отдаёт перенесённые позиции и устаревшие заметки новым запросом `notes.place`; вкладка и панель рисуют перенесённые как свои (копия заметки с новыми строками). «Устарела» относительно HEAD worker добавляет в ответ `notes.list` и в `notes.md` агента.

**Tech Stack:** TypeScript без сборки, DOM, `node:test` и `orca/testing` через `orca plugin test .`, git 2.31+ (проверено на 2.56.0).

**Spec:** `docs/superpowers/specs/2026-11-16-outdated-notes-design.md` (редакция 2, без пометки «с коммита»).

## Global Constraints

- Команда сравнения: `git diff -U0 --inter-hunk-context=0 --text --no-color --no-ext-diff --no-textconv <bN> <bT>`. Правило 4 спеки: кусок `@@ -a,b +c,d @@` (`b`, `d` по умолчанию 1); `b > 0` — строки `a..a+b-1`; `b = 0` — вставка после `a`, внутри заметки при `start <= a < end`; пересечение — устарела; иначе сдвиг на сумму `d - b` кусков целиком выше `start`; колонки не меняются.
- Не назад: `git merge-base --is-ancestor cT rev` с кодом 0 и `cT !== rev` — заметку не переносить и не помечать; код 1 и 128 — переносить.
- Устаревают только заметки новой стороны; старая сторона только переносится.
- Список «Заметки» и `notes.md`: «устарела» относительно HEAD только при `merge-base --is-ancestor rev HEAD` = 0; путь в HEAD отсутствует — устарела; blob тот же — нет; иначе правило 4. Пустой HEAD — меток нет.
- `outdated` нигде не хранится: вычисляется в `notes.list` и в отправке; кеш пар blob'ов — в памяти worker'а.
- Перенесённая заметка выглядит как своя, без пометок (решение пользователя).
- Сообщение фрейма — до 64 КиБ: панель шлёт `notes.place` только файлы-кандидаты (путь совпадает с путём какой-то заметки), не больше 100 файлов за запрос; worker отклоняет больше.
- Новые команды git — строки в `docs/git-safety.md` в том же коммите. Строки — `t()`, `en` и `ru`. Вид — `orca-plugin-ui` (только переменные `styles.css`). Концы строк: файл сохраняет свои (`git ls-files --eol`); новые файлы в `src/` — CRLF; документы — LF; смешанные (`src/worker/main.test.ts`, `src/worker/git.test.ts`, `src/ui/graph.test.ts`) — только скриптом, меняющим нужные строки; новые тесты — в новых файлах.
- tsc (`node ~/.npm/_npx/5abcb55351612887/node_modules/typescript/bin/tsc --noEmit -p .`): 228 ошибок на `b395f24`, из них 14 — не `TS2307`/`TS2591`; новые допустимы только `TS2307`/`TS2591` (`node:*`, `process`).
- Тесты: `orca plugin test .` — все зелёные (400 на `b395f24`); `orca plugin validate .`, `orca plugin check .` — код 0.
- Worktree — `~/Projects/orca-git-log-worktrees/outdated-notes` (вне папки плагина: правки в ней не перезагружают Orca пользователя). Orca не трогать: `orca plugin dev ...` — только контролёр. UI проверяется стендом: вкладка — `/tmp/review-ux/bench` (`server.mjs <src-root> <port>` с `TS_PATH`, страницы `*.html` со своими ответами на запросы), панель — `/tmp/gitlog-bench` (`server.mjs <src-root> <repo> <port>`, `BENCH=/tmp/gitlog-bench`, `TS_PATH`; заглушка хоста без хранилища заметок — добавить ответы как в `refusingStorage` из `testkit.ts`). Скриншоты тёмной и светлой тем — в отчёт. Без ИИ-соавторов в коммитах.

## Review Focus

1. Вставка строк выше заметки не делает её устаревшей, а только сдвигает (Task 1, тест «an insertion above moves a note and does not outdate it»).
2. После fixup/squash коммита заметки (её `rev` уже не предок) перенос и метка работают (Task 1, тест «a rewritten commit still carries its notes»).
3. `diff.interHunkContext` и `* -diff` в `.gitattributes` пользователя не ломают правило (Task 1, тест «user diff settings do not change the hunks»).
4. Заметка другой ветки не получает «Устарела» в списке (Task 2, тест «a note of another branch gets no outdated mark»).
5. Устаревшая заметка не рисуется в коде, а клик по ней в «Файлах» открывает её коммит (Task 4, стенд).

---

### Task 1: Перенос в worker'е и `notes.place`

**Files:**
- Create: `src/worker/notePlace.ts`, `src/worker/notePlace.test.ts`
- Modify: `src/shared/protocol.ts` (тип `NotePlace`, запрос `notes.place`), `src/worker/main.ts` (обработчик), `docs/git-safety.md` (строки на `merge-base --is-ancestor` и `diff -U0` двух blob'ов)

**Interfaces:**
- Produces:
  - `NotePlace = { id: string; start: NotePoint; end: NotePoint } | { id: string; outdated: true }` (protocol.ts).
  - `'notes.place': { input: { root: string; files: SelectionFile[] }; output: { places: NotePlace[][] } }` — по файлу в порядке входа; файлы без кандидатов — `[]`; больше 100 файлов — отказ (`throw` с `t('notesPlaceTooMany')`).
  - `src/worker/notePlace.ts`: `type Hunk = [oldStart: number, oldCount: number, newStart: number, newCount: number]`; `parseHunks(diff: string): Hunk[]`; `carryLines(hunks: Hunk[], start: number, end: number): { start: number; end: number } | null` (null — пересечение); `blobHunks(git: Git, from: string, to: string, cache: Map<string, Hunk[] | null>): Promise<Hunk[] | null>` (null — ошибка или «Binary files differ»; в кеш по ключу `from:to`); `placeNotes(git: Git, notes: ReviewNote[], files: SelectionFile[], cache: Map<string, Hunk[] | null>): Promise<NotePlace[][]>`.
- Кандидат на сторону s файла f — по спеке, правило 2: новая — `n.path === f.path || n.path === f.oldPath`; старая — `n.path === (f.oldPath ?? f.path)`; цель — `noteBlob(f, s)` из `src/shared/notes.ts` (нет — не кандидат); `n.blob === цель` — не кандидат (своя). Решённые тоже переносятся.

- [ ] **Step 1: Failing tests** `notePlace.test.ts`:
  - `parseHunks`: `@@ -3 +5 @@`, `@@ -0,0 +1,2 @@`, `@@ -7,2 +7,0 @@` и несколько кусков в одном выводе.
  - `carryLines`: вставка выше (`[0,0,1,2]`, строки 3–4 → 5–6); правка строки 3 (`[3,1,5,1]`) → null; вставка внутри (`[3,0,4,1]` для 3–4) → null; вставка ровно после конца (`[4,0,5,1]` для 3–4) → 3–4; удаление выше (`[1,2,1,0]`, 5–6 → 3–4); правка ниже — без сдвига.
  - Временный репозиторий (как `repoWith` в `selection.test.ts`): `test('an insertion above moves a note and does not outdate it')` — заметка на коммите A, коммит C вставил 2 строки сверху → `placeNotes` для выделения A..C даёт перенос на +2; `test('a changed line outdates a new-side note and leaves an old-side note out')`; `test('a newer note is not carried to an older version')` (цель — предок `rev`); `test('a rewritten commit still carries its notes')` (заметка на A, правка влита в A через `commit --fixup` и `rebase -i --autosquash`, `rev` не предок HEAD — перенос и «устарела» по-прежнему считаются); `test('user diff settings do not change the hunks')` (`-c diff.interHunkContext=3` в конфиге репозитория и `* -diff` в `.gitattributes`).
  - Через `mountWorker` (`testkit.ts`): `notes.place` с заметкой в хранилище → перенос; 101 файл → отказ.
- [ ] **Step 2:** тесты падают. **Step 3:** реализация; `merge-base --is-ancestor` — `git.run` (код возврата, не исключение); ошибки git и «Binary files differ» → `null`, строка в лог. **Step 4:** `orca plugin test .` — зелёное; tsc. **Step 5:** `docs/git-safety.md` — две строки (входы: blob'ы и коммиты из хранилища заметок и из файлов выделения, 40 hex; `--` не нужен, только id). Commit `Carry review notes to later versions of their file and tell the outdated ones, for a request of the frames`.

### Task 2: «Устарела» в списке и для агента

**Files:**
- Modify: `src/shared/protocol.ts` (`ReviewNote.outdated?: true` — «computed by notes.list and a send, never stored»), `src/worker/notePlace.ts` (`outdatedAtHead`), `src/worker/main.ts` (`notes.list`, отправка), `src/worker/review.ts` (`notesFile`, `writeReview`), `docs/git-safety.md` (строка на `cat-file --batch-check` и `rev-parse HEAD`)
- Create: `src/worker/outdated.test.ts`

**Interfaces:**
- Consumes: `blobHunks`, `carryLines`, кеш (Task 1).
- Produces: `outdatedAtHead(git: Git, notes: ReviewNote[], cache: Map<string, Hunk[] | null>): Promise<Set<string>>` — id устаревших; `notesFile(notes, paths, skills, outdated: Set<string> = new Set())` добавляет после строки `Lines:` строку `Outdated: the code at these lines changed after <rev>; compare with the current file before acting.`; `notes.list` отдаёт `outdated: true` у таких заметок (в хранилище не пишется: копия при ответе).

- [ ] **Step 1: Failing tests** `outdated.test.ts`: заметка из истории HEAD без изменений строк — нет; строки изменены позже — да; файл удалён в HEAD — да; `test('a note of another branch gets no outdated mark')`; заметка старой стороны — нет; пустой HEAD — нет; `notes.list` через `mountWorker` — поле `outdated` у нужной; `notesFile` с набором — строка `Outdated:`.
- [ ] **Step 2:** падают. **Step 3:** `cat-file --batch-check` одним процессом (ввод `HEAD:<path>\n` по одному на заметку; путь только во вводе), `merge-base --is-ancestor <rev> HEAD` по разным `rev` (кеш на время вызова), затем правило 4. Отправка (`notes.send`) считает набор перед `writeReview`. **Step 4:** тесты, tsc. **Step 5:** git-safety. Commit `Mark the review notes whose lines changed since their commit as outdated in the list and for the agent`.

### Task 3: Вкладка Diff — перенесённые на месте, «Устарела» в списке

**Files:**
- Modify: `src/ui/api.ts` (`notesPlace`), `src/ui/notes.ts` (`attach` и `shown`, `labels`, `item`, локальный показ), `src/ui/diff.ts` (если нужно для перерисовки после ответа), `src/shared/i18n.ts` (`noteOutdated` «Outdated» / «Устарела», подсказка `noteOutdatedTip` «The code at these lines changed after {rev}» / «Код этих строк изменился после коммита {rev}», `notesPlaceTooMany`), `src/ui/styles.css`, `README.md` (Review notes)

**Interfaces:**
- Consumes: `notes.place`, `ReviewNote.outdated` (Tasks 1–2).
- Produces: `api.notesPlace(root: string, files: SelectionFile[]): Promise<{ places: NotePlace[][] }>`.

- [ ] **Step 1:** при показе файла вкладка спрашивает `notes.place` для него (и снова при `notes.changed`); перенесённые — копии заметок с `start`/`end` из ответа — добавляются к `shown`: карточки, подсветка, карта файла, F7 — как у своих; устаревшие в коде не рисуются. Ответ для другого файла или устаревший (токен) игнорируется.
- [ ] **Step 2:** список «Заметки»: метка `noteOutdated` (приглушённая `d-label`, `title` — `noteOutdatedTip` с коротким `rev`) у `n.outdated`; клик по перенесённой в текущем файле прокручивает к ней без `notes.open`.
- [ ] **Step 3:** стенд `/tmp/review-ux/bench`: файл выделения A..C с заметкой A, сдвинутой на +2 — карточка на новых строках; A..B с изменённой строкой — карточки нет, в списке метка «Устарела». Скриншоты.
- [ ] **Step 4:** тесты, tsc, README. Commit `Show review notes carried to the file shown at their new lines and mark outdated ones in the Notes list`.

### Task 4: «Файлы» панели — перенесённые и устаревшие

**Files:**
- Modify: `src/ui/app.ts` (запрос `notes.place` после загрузки файлов выделения и при `notes.changed`; `host.notes`; клик по устаревшей → `api.notesOpen`), `src/ui/filetree.ts` (строка устаревшей заметки, подсказка), `src/ui/styles.css`, `README.md` (Files of the selection)

**Interfaces:**
- Consumes: `api.notesPlace`, `notesOfFile`, `noteTone`.
- Produces: `FileTreeHost.notes(file)` возвращает `(ReviewNote & { outdated?: true })[]`: свои, перенесённые (копии с новыми строками) и устаревшие (исходные строки, `outdated: true`); порядок — незакрытые по строке, затем решённые, устаревшие — в своей группе по состоянию.

- [ ] **Step 1:** панель шлёт только файлы-кандидаты, по 100 за запрос; ответ старого выделения или репозитория отбрасывается (токен).
- [ ] **Step 2:** строка устаревшей: приглушённый пунктирный кружок, исходный номер строки, первая строка первого сообщения; подсказка `noteTip` плюс `noteOutdatedTip`; клик и Enter — `api.notesOpen(root, id)` (как список вкладки), отказ — баннер. Счётчик у файла — незакрытые, устаревшие тоже.
- [ ] **Step 3:** стенд `/tmp/gitlog-bench`: выделение A..B — заметка A под файлом с меткой; A..C — на новой строке. Скриншоты 380 px.
- [ ] **Step 4:** тесты, tsc, README. Commit `Show carried and outdated review notes under their files in the Files section`.

### Task 5: Проверка целиком и документы

**Files:** Modify: `docs/superpowers/specs/2026-11-16-outdated-notes-design.md` (статус), `README.md` (сверка)

- [ ] **Step 1:** `orca plugin test .`, `validate`, `check` — зелёное, код 0; tsc — 228 плюс только `TS2307`/`TS2591`.
- [ ] **Step 2:** `git diff --stat b395f24` — смешанные файлы не тронуты или только нужные строки.
- [ ] **Step 3:** статус спеки — «реализовано в ветке, проверено стендом». Commit `Mark the outdated notes design done`.

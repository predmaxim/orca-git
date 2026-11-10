# Плагин «Git» в стиле WebStorm — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Переделать форк `emamalet.git-log` в плагин «Git» для Орки: вкладка редактора по варианту C1 (слева ветки, коммиты и файлы стопкой, справа дифф с подсветкой синтаксиса и описание коммитов под ним) и панель сайдбара из четырёх сворачиваемых секций. Главный сценарий — ревью нескольких выбранных коммитов.

**Architecture:** Движок форка (Node-воркер `src/worker/`, протокол `src/shared/protocol.ts`) остаётся. Новые возможности воркера — в новых файлах и новых запросах. Интерфейс (`src/ui/`, одна HTML-страница в режимах `panel` и `editor`) перестраивается: колонка сворачиваемых секций, встроенный дифф вместо оверлея, дерево файлов всего выделения, список описаний коммитов.

**Tech Stack:** TypeScript без сборки (Орка транспилирует `.ts` при загрузке), DOM-хелпер `h()` из `src/ui/dom.ts`, `node:test` и `orca/testing`, `git` через `execFile`, highlight.js 11 (ESM-сборка `@highlightjs/cdn-assets`, вендорится в репозиторий).

**Spec:** `docs/superpowers/specs/2026-11-09-orca-git-plugin-design.md` (макеты рядом: `layout-mockup.html` — C1, `sidebar-details-mockup.html` — сайдбар «Б» и описание «Б»; референс — локальный `.local/webstorm-reference.png`, в git его нет).

## Global Constraints

- Репозиторий: `~/Projects/orca-git-log`, ветка `main`, remote `origin` = `github.com/predmaxim/orca-git`, `upstream` = оригинал (push в него запрещён). Push делает только пользователь или с его разрешения.
- `engines.orca` остаётся `>=1.4.248`; установленная Орка 1.4.253.
- Сборки нет: фреймы импортируют только `orca`, `orca/*` и относительные файлы; npm-пакеты в рантайме запрещены, кроме вендоренных ESM-файлов в `src/vendor/`. Лимиты Орки: 2000 файлов и 50 MiB на плагин, 1 MiB на транспилированный файл.
- Движок меняем минимально: новое — в новых файлах. В существующих файлах движка разрешены только: `export` уже имеющихся функций, регистрация обработчиков в `src/worker/main.ts`, дописывание типов и запросов в `src/shared/protocol.ts`, изменение входа `tab.open`, замена видимых человеку строк на `t()` (Task 13) и передача языка в воркер (Task 4). Последнее увеличивает конфликты при переносе изменений апстрима — пользователь выбрал перевод сознательно.
- `git` вызывается только через `createGit` (`execFile`, без shell, `GIT_TERMINAL_PROMPT=0`); пути — через `:(literal)`; хеши проверяются регэкспом `^[0-9a-f]{40}$`; имена веток — `git check-ref-format --branch`; ревизии от пользователя — `git rev-parse --verify -q --end-of-options <rev>^{commit}`.
- Цвета интерфейса — только через переменные `--orca-*` (алиасы в `:root` у `src/ui/styles.css`). Исключение — палитры подсветки синтаксиса (Task 9): у тем Орки есть `tokenColors`, но фреймам Орка их не отдаёт (только `--orca-*` и класс `light`/`dark`). Читать файл активной темы с диска самим нельзя: это внутреннее состояние Орки, костыль по правилам пользователя. Поэтому своя палитра в стиле WebStorm и issue в Орку (Task 14).
- Язык интерфейса — язык Орки (`orca.locale` во фрейме, BCP-47). В плагине два каталога: `en` (по умолчанию, тексты как в WebStorm: «Branches», «Commits», «Files», «Details», «Text or hash») и `ru`. Каждая строка, которую видит человек, — и в интерфейсе, и в сообщениях воркера — идёт через `t()` из `src/shared/i18n.ts` (Task 4). Вывод самого `git` (stderr в ошибках) не переводится: движок запускает git с `LC_ALL=C`.
- Настройки раскладки хранятся в `localStorage` под ключом `git-log.prefs.${MODE}` (как в движке); новые поля добавляются в тот же объект `Prefs` с значениями по умолчанию.
- Тесты: весь набор — `orca plugin test . --json > /tmp/orca-git-log-test.log 2>&1`, затем читать лог; один файл на `node:test` — `node --test src/<путь>.test.ts > /tmp/<имя>.log 2>&1`. Вывод тестов никогда не пропускать через `grep`/`head`/`tail`.
- Типы: `npx -y -p typescript@5 tsc -p . --noEmit > /tmp/orca-git-log-tsc.log 2>&1` (перед этим `orca plugin types .`, если нет `.orca/types`). Каждая задача заканчивается без новых ошибок типов.
- Коммиты атомарные, сообщения на английском в стиле апстрима («Add …», «Show …»), без ИИ-соавторов и строк «Generated with …».
- Документация обновляется вместе с кодом: README форка, при отклонении от дизайна — сам дизайн-документ.
- Форк публичный: данные рабочих репозиториев пользователя (код, сообщения коммитов, имена коллег, номера задач, пути) в git не попадают никогда. Тестовые данные, примеры и скриншоты для README — только из синтетического демо-репозитория (`/tmp/git-demo`, вымышленные авторы и коммиты). Снимки и замеры на рабочем репозитории — только в `/tmp`. Путь к рабочему репозиторию и референс-скриншот — в `.local/` (исключена через `.git/info/exclude`). Перед каждым коммитом — `git diff --cached` глазами на такие данные.

## Review Focus

1. Выделение, которое пересекает merge-коммит или параллельные ветки графа (обычный случай на скриншоте): файлы объединяются по правилу дизайна, merge сравнивается с первым родителем. Тест — Task 2, `selection spanning a merge lists the merge's first-parent changes and the side commit's`.
2. Файл добавлен и удалён внутри выделения, или переименован и потом изменён: первый не попадает в список, второй — одна строка `R` со старым путём. Тесты — Task 2.
3. Ветка-операция при незавершённом rebase/merge, начатом в терминале: действие отказывает с понятным сообщением, а не портит состояние. Тест — Task 3, `merge is refused while a rebase is in progress`.
4. Fetch при недоступном remote или без remote: ошибка сообщением, без зависания и запроса пароля. Тесты — Task 3.
5. Сохранённые настройки раскладки от старой версии или повреждённые (нет полей, все секции свёрнуты): раскладка всё равно рисуется, хотя бы одна секция развёрнута. Тест — Task 5, `normalizeSections`.

---

## Карта файлов

| Файл | Ответственность |
| --- | --- |
| `src/shared/protocol.ts` (дописать) | Типы `SelectionFile`, `BranchAction`, `BranchActionResult`, `TabReveal`; запросы `selection.files`, `range.diff`, `branch.run`, `repo.fetch`, `tab.take`; событие `tab.reveal`; вход `tab.open` получает `reveal?` |
| `src/worker/selection.ts` (новый) | Файлы выделения коммитов и дифф файла между двумя ревизиями |
| `src/worker/branchActions.ts` (новый) | rename, delete, merge, rebase onto, fetch |
| `src/worker/main.ts` (правка) | Регистрация новых обработчиков, отложенный reveal для вкладки |
| `src/shared/i18n.ts` (новый) | Каталоги `en`/`ru`, `t()`, выбор языка по `orca.locale`, русские формы множественного числа |
| `src/ui/sections.ts` (новый) | Колонка сворачиваемых секций: чистая логика настроек и DOM |
| `src/ui/filetree.ts` (новый) | Дерево файлов выделения: построение и отрисовка |
| `src/ui/highlight.ts` (новый) | Язык по пути, подсветка строк диффа, разметка изменённых слов поверх токенов |
| `src/vendor/highlight/` (новый) | Вендоренные `core.min.js`, языки, `LICENSE` |
| `src/ui/diff.ts` (переделка) | Встроенная панель диффа вместо полноэкранного оверлея |
| `src/ui/details.ts` (переделка) | Список выбранных коммитов с раскрытием описания |
| `src/ui/branches.ts`, `src/ui/format.ts` (правка) | Папки по префиксу, клик фильтрует, новые пункты меню |
| `src/ui/app.ts`, `src/ui/styles.css` (переделка) | Сборка раскладки C1 и сайдбара, тулбар, проводка запросов |
| `src/ui/api.ts` (дописать) | Обёртки новых запросов |
| `docs/engine-review.md` (новый) | Итоги проверки движка |
| `README.md`, `orca-plugin.json` | Описание форка, имя «Git», версия |

---

### Task 1: Проверка движка и оформление форка

**Files:**
- Create: `docs/engine-review.md`
- Modify: `orca-plugin.json` (`name`, `description`, `version`, `repository`), `package.json` (`version`), `README.md` (раздел о форке сверху)

**Interfaces:**
- Consumes: —
- Produces: зелёный базовый прогон тестов и список найденных проблем движка; каждая исправленная проблема — отдельный коммит с регрессионным тестом.

- [ ] **Step 1: Базовый прогон.** `orca plugin test . --json > /tmp/orca-git-log-test.log 2>&1`. Ожидается exit 0 (на момент форка все тесты зелёные). Затем `orca plugin types .` и проверка типов; записать число ошибок типов как базу.
- [ ] **Step 2: Чтение воркера.** Прочитать `src/worker/*.ts` и проверить: каждый аргумент от фрейма проходит проверку (хеш, имя, путь, ревизия) до попадания в `git`; нет `shell: true` и склейки строк в команду; у долгих команд есть `timeoutMs`; `repo.watch` не плодит наблюдателей; `gitFor` отказывает чужим путям. Каждую находку записать в `docs/engine-review.md`: файл:строка, что не так, чем грозит.
- [ ] **Step 3: Замеры на большом репозитории пользователя.** Скрипт в `/tmp/engine-probe.ts` (не в репозитории) импортирует `createGit`, `readLogPage`, `readRefs`, `readDetails` по абсолютному пути форка и меряет время на рабочем репозитории из `.local/notes.md`: первая страница лога (300), `readRefs`, детали merge-коммита. Запуск `node /tmp/engine-probe.ts > /tmp/engine-probe.log 2>&1`. Результаты — в `docs/engine-review.md`. Операция больше 2 с — записать как проблему производительности.
- [ ] **Step 4: Исправить найденные ошибки.** На каждую: падающий тест в `src/worker/git.test.ts` или `main.test.ts` → исправление → зелёный тест → отдельный коммит «Fix …». В `docs/engine-review.md` у находки пометить «исправлено, коммит <hash>» и «предложить issue в апстрим» (issue не публиковать, решает пользователь). Если находок нет — так и записать.
- [ ] **Step 5: Оформить форк.** `orca-plugin.json`: `"name": "Git"`, `"description": "WebStorm-style Git log for Orca: branches, commits and the files of a multi-commit selection with a side-by-side diff. Fork of emamalet/Orca-git-log-panel."`, `"version": "0.2.0"`, `"repository": "https://github.com/predmaxim/orca-git"`; `package.json` `"version": "0.2.0"`. В начало `README.md` — раздел «About this fork»: чем отличается (ссылка на дизайн), как подтягивать апстрим (`git fetch upstream && git log --oneline main..upstream/main`, перенос нужного через `cherry-pick` или merge), что PR в апстрим не отправляются. `orca plugin validate . --json` → exit 0.
- [ ] **Step 6: Commit** — `git add docs/engine-review.md README.md orca-plugin.json package.json && git commit -m "Review the engine and describe the fork"`.

### Task 2: Воркер — файлы выделения и дифф между ревизиями

**Files:**
- Create: `src/worker/selection.ts`, `src/worker/selection.test.ts`
- Modify: `src/shared/protocol.ts` (дописать), `src/worker/main.ts` (два обработчика), `src/worker/actions.ts` (`export` у `oldestFirst`)

**Interfaces:**
- Consumes: `createGit`, `Git` (`src/worker/git.ts`); `parseNameStatus` (`log.ts`); `parseUnifiedDiff` (`diff.ts`); `oldestFirst(git, hashes): Promise<string[]>` (`actions.ts`, сделать экспортом).
- Produces:
  - `protocol.ts`: `interface SelectionFile extends FileChange { from: string | null; to: string }` — `from` равен `null`, когда файл впервые появился в корневом коммите.
  - Запросы `'selection.files': { input: { root: string; hashes: string[] }; output: SelectionFile[] }` и `'range.diff': { input: { root: string; from: string | null; to: string; path: string; oldPath?: string; wholeFile?: boolean }; output: FileDiff }`.
  - `selection.ts`: `readSelectionFiles(git: Git, hashes: string[]): Promise<SelectionFile[]>` и `readRangeDiff(git: Git, from: string | null, to: string, path: string, oldPath?: string, wholeFile?: boolean): Promise<FileDiff>`.

Алгоритм `readSelectionFiles` (тесты его не определяют полностью):

```
1. Проверить: 1..500 хешей, каждый ^[0-9a-f]{40}$; иначе throw Error('Invalid commit selection.').
2. order = oldestFirst(git, hashes)                          // топология, старые первыми
3. Один процесс: git log --no-walk=unsorted --format=%x1e%H%x1f%P -z --name-status -M
   --diff-merges=first-parent <order...> --                    // корневой коммит даёт свои файлы
   Разбить по \x1e; в записи: hash, parents, затем токены name-status → parseNameStatus.
4. entries: Map<текущий путь, { orig: string; from: string | null; to: string }>
   для каждого коммита c (старые первыми), parent = первый родитель c или null:
     для каждой записи f:
       если f.status == 'R': e = entries.get(f.oldPath) ?? { orig: f.oldPath, from: parent }
                             entries.delete(f.oldPath); entries.set(f.path, { ...e, to: c })
       иначе:                e = entries.get(f.path) ?? { orig: f.path, from: parent }
                             entries.set(f.path, { ...e, to: c })
5. Сгруппировать entries по паре (from, to). На группу один вызов:
   git diff --name-status -z -M <from ?? emptyTree> <to> -- :(literal)<path и orig каждого файла>
   Файл без строки в выводе (добавлен и удалён внутри выделения) — выбросить.
   Статус, path и oldPath берутся из этого вывода; from/to — из entries.
6. Отсортировать по path (localeCompare).
emptyTree: git rev-parse --show-object-format → 'sha1' ⇒ 4b825dc642cb6eb9a060e54bf8d69288fbee4904,
           'sha256' ⇒ 6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321.
```

`readRangeDiff`: проверить `from` (`null` или хеш) и `to` (хеш), `path` непустой; `git diff --no-ext-diff --no-textconv -M -U<wholeFile ? 1000000 : 3> <from ?? emptyTree> <to> -- :(literal)<oldPath>? :(literal)<path>` → `{ path, oldPath?, ...parseUnifiedDiff(stdout) }`.

- [ ] **Step 1: Написать падающие тесты** в `src/worker/selection.test.ts` (стиль `git.test.ts`: `node:test`, временные репозитории через `execFileSync('git', …)`, уборка в `after`). Свой хелпер `repoWith(steps)` внутри файла.

```ts
test('a contiguous selection lists each added file from its own parent', …)
  // c1..c4, коммит cN добавляет fN.txt; выделение [c4, c2, c3]
  // ожидание: [{path:'f2.txt',status:'A',from:c1,to:c2},{path:'f3.txt',status:'A',from:c2,to:c3},{path:'f4.txt',status:'A',from:c3,to:c4}]
test('a gap in the selection folds the unselected change in, like WebStorm', …)
  // c1 добавляет a.txt '1', c2 → '2', c3 → '3', c4 → '4'; выделение [c2, c4]
  // ожидание: [{path:'a.txt',status:'M',from:c1,to:c4}]; readRangeDiff(c1,c4,'a.txt') содержит строку '-1' и '+4'
test('a file added and deleted inside the selection is left out', …)
  // c2 добавляет tmp.txt, c3 удаляет; выделение [c2, c3] → tmp.txt отсутствует
test('a rename followed by an edit is one renamed file', …)
  // c1 a.txt; c2 git mv a.txt b.txt; c3 правит b.txt; выделение [c2, c3]
  // ожидание: [{path:'b.txt',status:'R',oldPath:'a.txt',from:c1,to:c3}]
test('the root commit diffs against the empty tree', …)
  // выделение [c1] → [{path:'f1.txt',status:'A',from:null,to:c1}]; readRangeDiff(null,c1,'f1.txt').hunks[0].lines[0] = {kind:'+',text:'1',new:1}
test("selection spanning a merge lists the merge's first-parent changes and the side commit's", …)
  // main: m1; ветка side от m1: s1 добавляет s.txt; main: m2 добавляет m.txt; merge side в main (--no-ff) = M
  // выделение [M] → [{path:'s.txt',status:'A'}]; выделение [M, s1] → s.txt один раз, from = m1, to = M
test('invalid hashes are refused', …)
  // readSelectionFiles(git, ['HEAD']) и readRangeDiff(git, '--x', c1, 'a') отклоняются с ошибкой
```

- [ ] **Step 2: Убедиться, что падают** — `node --test src/worker/selection.test.ts > /tmp/selection.log 2>&1`; ожидание: ошибка импорта `./selection.ts`.
- [ ] **Step 3: Реализовать** `selection.ts` по алгоритму выше; дописать протокол; `export` у `oldestFirst`; в `main.ts` обработчики `selection.files` → `readSelectionFiles(await gitFor(root), hashes)` и `range.diff` → `readRangeDiff(...)`.
- [ ] **Step 4: Тесты зелёные** — тот же запуск; затем полный `orca plugin test` и проверка типов.
- [ ] **Step 5: Commit** — `git add src/worker/selection.ts src/worker/selection.test.ts src/shared/protocol.ts src/worker/main.ts src/worker/actions.ts && git commit -m "Add the files and range diff of a commit selection"`.

### Task 3: Воркер — действия с ветками и fetch

**Files:**
- Create: `src/worker/branchActions.ts`, `src/worker/branchActions.test.ts`
- Modify: `src/shared/protocol.ts` (дописать), `src/worker/main.ts`, `src/worker/actions.ts` (`export` у `assertName`)

**Interfaces:**
- Consumes: `Git`, `lastLines` (`git.ts`); `readHead` (`log.ts`); `operationInProgress(git)` (`rebase.ts`); `assertName(git, name, 'branch')` (`actions.ts`).
- Produces:
  - `protocol.ts`: `type BranchAction = { kind: 'rename'; name: string; newName: string } | { kind: 'delete'; name: string; force: boolean } | { kind: 'merge'; name: string } | { kind: 'rebaseOnto'; name: string }`; `interface BranchActionResult extends ActionResult { needsForce?: boolean }`; запросы `'branch.run': { input: { root: string; action: BranchAction }; output: BranchActionResult }`, `'repo.fetch': { input: { root: string }; output: ActionResult }`.
  - `branchActions.ts`: `runBranchAction(git: Git, action: BranchAction): Promise<BranchActionResult>`, `fetchAll(git: Git): Promise<ActionResult>`. Оба никогда не бросают: ошибка — `{ ok: false, message }`. `previousHead` заполняется, как в `runAction`, чтобы интерфейс предложил Undo после merge и rebase.

Поведение (точные команды):
- `rename`: обе проверки `assertName`; `git branch -m <name> <newName>`; сообщение `Renamed <name> to <newName>.`
- `delete`: только локальная ветка (`refs/heads/<name>` существует, иначе `No local branch <name>.`); текущая ветка → `Cannot delete the current branch.`; `git branch -d <name>`, при `force` — `-D`. Отказ `-d` со словами `not fully merged` → `{ ok: false, needsForce: true, message: '<name> is not fully merged.' }`. Удалённые ветки не удаляются никогда.
- `merge` и `rebaseOnto`: если `operationInProgress` → `A <op> is in progress. Finish or abort it first.`; цель проверяется `rev-parse --verify -q --end-of-options <name>^{commit}`; `git merge --no-edit --autostash <name>` / `git rebase --autostash <name>`, `timeoutMs: 120_000`. Неудача: если операция осталась в процессе — `git merge --abort` / `git rebase --abort`; сообщение `Merge failed and was aborted.` / `Rebase failed and was aborted.` + `lastLines(stderr || stdout, 4)`.
- `fetchAll`: `git remote` пуст → `{ ok: false, message: 'No remotes configured.' }`; иначе `git fetch --all` (без `--prune`), `timeoutMs: 120_000`; успех → `Fetched all remotes.`; неудача → `Fetch failed.` + `lastLines(stderr, 4)`.
- `main.ts`: после `branch.run` и успешного `repo.fetch` — `orca.panels.post('repo.changed', { root })`, как после `action.run`.

- [ ] **Step 1: Падающие тесты** в `src/worker/branchActions.test.ts` (стиль `git.test.ts`):

```ts
test('rename moves the branch', …)                       // refs/heads/new есть, old нет
test('delete removes a merged branch and refuses the current one', …)
test('an unmerged branch needs force, and force deletes it', …)
  // первый вызов: ok false, needsForce true, ветка на месте; с force: true — ветки нет
test('merge brings the branch in and reports the previous head', …)
  // HEAD содержит коммит ветки; result.previousHead = прежний HEAD
test('a conflicting merge is aborted and the tree is left clean', …)
  // ok false, message начинается с 'Merge failed and was aborted.'; нет .git/MERGE_HEAD; git status --porcelain пуст
test('rebase onto replays the current branch on the target', …)
  // git log --format=%s показывает коммиты текущей ветки над целью линейно
test('merge is refused while a rebase is in progress', …)
  // довести rebase до конфликта через execFileSync (поймать исключение), затем merge → ok false, message содержит 'in progress'
test('fetch updates remote branches without touching the work tree', …)
  // bare-репозиторий + два клона; второй пушит коммит; fetchAll в первом → origin/main = новый коммит, HEAD прежний
test('fetch reports an unreachable remote instead of hanging', …)
  // remote add origin /nonexistent/repo.git → ok false, message начинается с 'Fetch failed.'
test('fetch without remotes says so', …)                 // message 'No remotes configured.'
```

- [ ] **Step 2: Убедиться, что падают** — `node --test src/worker/branchActions.test.ts > /tmp/branch-actions.log 2>&1`.
- [ ] **Step 3: Реализовать** `branchActions.ts`, протокол, обработчики в `main.ts`, `export` у `assertName`.
- [ ] **Step 4: Тесты зелёные**, полный прогон, типы.
- [ ] **Step 5: Commit** — `git commit -m "Add branch rename, delete, merge, rebase onto and fetch"` (с перечисленными файлами).

### Task 4: Перевод — каталоги и язык Орки

**Files:**
- Create: `src/shared/i18n.ts`, `src/shared/i18n.test.ts`
- Modify: `src/ui/api.ts` (язык в каждом запросе), `src/worker/main.ts` (язык из запроса)

**Interfaces:**
- Consumes: `orca.locale` (фрейм), `orca.panels.handle` (воркер).
- Produces:
  - `type Locale = 'en' | 'ru'`
  - `pickLocale(tag: string | undefined): Locale` — `ru`, `ru-RU`, `RU` → `ru`; остальное и пустое → `en`.
  - `setLocale(locale: Locale): void`, `getLocale(): Locale`.
  - `t(key: MessageKey, params?: Record<string, string | number>): string` — подставляет `{name}`; если значение — формы множественного числа (`{ one, few, many, other }`), форма выбирается по `params.count` через `Intl.PluralRules(locale)`; нет ключа в `ru` — берётся `en`.
  - `const en`, `const ru` — каталоги; `type MessageKey = keyof typeof en`. В этой задаче — только ключи для тестов; остальные добавляют задачи, которые вводят строки, сразу с переводом в `ru`.
  - `api.ts`: каждый `orca.plugin.request` получает в `input` поле `locale: orca.locale`. `main.ts`: обёртка над `orca.panels.handle`, которая перед обработчиком вызывает `setLocale(pickLocale(input?.locale))`.
  - Фрейм при старте вызывает `setLocale(pickLocale(orca.locale))` до первой отрисовки.

- [ ] **Step 1: Падающие тесты** `src/shared/i18n.test.ts`:

```ts
test('pickLocale maps Russian tags to ru and everything else to en', …)
  // 'ru', 'ru-RU', 'RU' → 'ru'; 'en-US', 'de', '', undefined → 'en'
test('t substitutes params and falls back to English', …)
  // ключ, которого нет в ru, при locale ru возвращает текст en с подставленными params
test('Russian plurals pick one, few and many', …)
  // ключ commitsSelected: en {one:'{count} commit selected', other:'{count} commits selected'};
  // ru {one:'Выбран {count} коммит', few:'Выбрано {count} коммита', many:'Выбрано {count} коммитов', other:'Выбрано {count} коммита'}
  // ru: 1 → 'Выбран 1 коммит', 3 → 'Выбрано 3 коммита', 5 → 'Выбрано 5 коммитов', 21 → 'Выбран 21 коммит'
test('every English key has a Russian translation', …)
  // Object.keys(en) ⊆ Object.keys(ru); у форм множественного числа в ru есть one, few, many
```

- [ ] **Step 2: Убедиться, что падают** — `node --test src/shared/i18n.test.ts > /tmp/i18n.log 2>&1`.
- [ ] **Step 3: Реализовать** `i18n.ts`, проводку языка в `api.ts` и `main.ts`.
- [ ] **Step 4: Тесты зелёные**, полный прогон (старые тесты воркера не ломаются от лишнего поля `locale`), типы.
- [ ] **Step 5: Commit** — `git commit -m "Add English and Russian catalogs that follow Orca's language"`.

С этой задачи каждая новая строка интерфейса и сообщение воркера в задачах 5–12 сразу добавляются ключом в `en` и `ru`. Тексты в описаниях задач ниже — значения `en`.

### Task 5: Колонка сворачиваемых секций и раскладка C1

**Files:**
- Create: `src/ui/sections.ts`, `src/ui/sections.test.ts`
- Modify: `src/ui/app.ts` (раскладка, тулбар, `Prefs`), `src/ui/styles.css`, `src/ui/api.ts` (обёртки `fetch`)

**Interfaces:**
- Consumes: `api` (`api.ts`), `h`, `icon` (`dom.ts`), `repo.fetch` (Task 3).
- Produces:
  - `type SectionId = 'branches' | 'commits' | 'files' | 'details'`
  - `interface SectionPrefs { collapsed: Record<SectionId, boolean>; weights: Record<SectionId, number> }`
  - `normalizeSections(stored: unknown): SectionPrefs` — значения по умолчанию: все развёрнуты, веса `branches 1, commits 2, files 1.5, details 1`; мусор и недостающие поля заменяются умолчаниями; если свёрнуто всё, разворачивается `commits`.
  - `resizePair(weights, above: SectionId, below: SectionId, deltaPx: number, pxPerWeight: number, minPx = 48): Record<SectionId, number>` — переносит вес между соседями, сумма пары сохраняется, ни одна не меньше `minPx`.
  - `createColumn(ids: SectionId[], prefs: SectionPrefs, onChange: () => void): { element: HTMLElement; section(id: SectionId): { body: HTMLElement; header: HTMLElement; setSummary(text: string): void } }` — заголовок секции: шеврон, название (`Branches`, `Commits`, `Files`, `Details`), итог справа, место под кнопки; клик по заголовку сворачивает; между развёрнутыми секциями — перетаскиваемые разделители.
  - Новые поля `Prefs` в `app.ts`: `sections: SectionPrefs`, `leftWidth: number` (по умолчанию 40, проценты ширины вкладки), `detailsHeight` (уже есть, переиспользовать для секции описания во вкладке).
  - `api.fetch(root): Promise<ActionResult>`.

Раскладка:
- Режим `editor` (вкладка): тулбар колонки сверху слева (`Refresh`, `Fetch`); слева колонка `['branches','commits','files']`; вертикальный разделитель (`leftWidth`); справа сверху контейнер диффа (`#diff`, заполняется в Task 8), под ним разделитель и секция `details` — сворачивается, высота `detailsHeight`.
- Режим `panel` (сайдбар): тулбар (`Refresh`, `Fetch`, `Open in editor tab`), колонка `['branches','commits','files','details']`.
- Существующие панели движка переезжают в секции: дерево веток с поиском → `branches`; строка поиска и фильтров + `viewport` лога → `commits`. Переключатели `treeToggle` и `detailsToggle` удаляются (их заменяет сворачивание). Тело `files` и `details` в этой задаче — заглушки с текстом `Select commits to see their files` и `Select a commit to see its details`.
- Итоги в заголовках: ветки — имя текущей ветки или короткий хеш при detached HEAD; коммиты — `N selected` (пусто при 0); файлы — число файлов.
- Fetch: кнопка блокируется на время запроса, результат — существующим баннером (`showBanner`), успех `success`, ошибка `error`.

- [ ] **Step 1: Падающие тесты** `src/ui/sections.test.ts` (`node:test`, только чистые функции):

```ts
test('normalizeSections fills defaults for missing or broken prefs', …)
  // normalizeSections(undefined), (null), ({collapsed:'x'}), ({weights:{commits:-3}}) → умолчания; веса > 0
test('normalizeSections keeps one section open when everything was collapsed', …)
  // все collapsed true → collapsed.commits === false
test('resizePair moves weight between neighbours and respects the minimum', …)
  // weights commits 2, files 2, pxPerWeight 100: delta +50 → commits 2.5, files 1.5; delta +1000 → files = 0.48
```

- [ ] **Step 2: Убедиться, что падают** — `node --test src/ui/sections.test.ts > /tmp/sections.log 2>&1`.
- [ ] **Step 3: Реализовать** `sections.ts`, затем перестроить раскладку в `app.ts` и стили в `styles.css`. Стиль заголовков секций — как `sec` в макете C1: мелкий капс, фон `--muted`, граница `--border`.
- [ ] **Step 4: Тесты зелёные**, полный прогон, типы.
- [ ] **Step 5: Визуальная проверка.** `orca plugin dev watch . --check --shot ./.orca/shots --json` в фоне (первый запуск попросит одобрение: показать пользователю список доступа и `--approve` только с его согласия). Снимок сайдбара — прочитать PNG: четыре секции, заголовки с итогами, ветки и лог работают. Вкладку — `orca plugin shot . --editor .orca-git-log.gitlog --width 1600 --height 900 --json` при открытом репозитории в Орке. Свернуть секцию, перезагрузить фрейм — состояние сохранилось.
- [ ] **Step 6: Commit** — `git commit -m "Lay out branches, commits and files as collapsible sections"`.

### Task 6: Строки коммитов для узкой колонки

**Files:**
- Modify: `src/ui/app.ts` (`rowElement`, высота строки виртуального списка), `src/ui/graph.ts` (`graphSvg` получает высоту), `src/ui/styles.css`

**Interfaces:**
- Consumes: `computeGraph`, `graphSvg` (`graph.ts`).
- Produces: `graphSvg(row, options: { head?: boolean; dim?: boolean; merge?: boolean; height?: number })` — по умолчанию `ROW_HEIGHT`.

Правило: если ширина секции коммитов меньше 520 px — строка в две линии высотой 40 px (сообщение с ref-метками; ниже автор · относительное время, приглушённо), как вариант «Б» сайдбара; иначе — строка в одну линию с колонками Subject | Author | Date, как в WebStorm. Колонка Hash остаётся, как в движке. Порог проверяется в существующем `ResizeObserver`.

- [ ] **Step 1: Реализовать** правило; граф рисуется на всю высоту строки.
- [ ] **Step 2: Проверка** — полный прогон тестов (`graph.test.ts` должен остаться зелёным), типы, снимки сайдбара (две линии) и вкладки (колонки).
- [ ] **Step 3: Commit** — `git commit -m "Show two-line commit rows in a narrow column"`.

### Task 7: Секция файлов — дерево всего выделения

**Files:**
- Create: `src/ui/filetree.ts`, `src/ui/filetree.test.ts`
- Modify: `src/ui/app.ts` (запрос файлов при смене выделения), `src/ui/api.ts`, `src/ui/styles.css`

**Interfaces:**
- Consumes: `selection.files` (Task 2), `createColumn(...).section('files')` (Task 5), `STATUS_NAMES` (`format.ts`).
- Produces:
  - `type FileNode = { kind: 'dir'; name: string; path: string; count: number; children: FileNode[] } | { kind: 'file'; name: string; file: SelectionFile }`
  - `buildFileTree(files: SelectionFile[]): FileNode[]` — папки с единственной подпапкой склеиваются (`web/app`), папки перед файлами, внутри — `localeCompare`; `count` — число файлов внутри.
  - `orderedFiles(nodes: FileNode[]): SelectionFile[]` — файлы в порядке отрисовки (для ← → в диффе).
  - `renderFileTree(container: HTMLElement, nodes: FileNode[], host: { expanded: Set<string>; current: string | null; open(file: SelectionFile): void; onToggle(): void }): void`
  - `api.selectionFiles(root, hashes): Promise<SelectionFile[]>`, `api.rangeDiff(root, file: SelectionFile, wholeFile: boolean): Promise<FileDiff>`.
  - В `app.ts`: `selectionFiles: SelectionFile[]` (текущий список), `openFile(index: number)` — точка, которую Task 8 подключит к диффу.

Поведение: при смене выделения — запрос с токеном; ответ на устаревшее выделение отбрасывается. Пока грузится — итог `…`. Папки по умолчанию развёрнуты; кнопки в заголовке секции `Expand all` / `Collapse all`. Строка файла: буква статуса и цвет (A зелёный, M синий, D красный, R фиолетовый — через существующие классы `st-*`), имя, для переименования подсказка `old → new`. Один клик или Enter — `openFile`. 0 выбранных коммитов — пусто с подсказкой.

- [ ] **Step 1: Падающие тесты** `src/ui/filetree.test.ts`:

```ts
test('single-child folders are merged into one row', …)
  // ['web/app/scripts/deploy/start.sh','web/app/Dockerfile']
  // → один dir 'web/app' (count 2), внутри dir 'scripts/deploy' и file 'Dockerfile'
test('folders come before files and both sort by name', …)
test('orderedFiles follows the drawn order', …)
```

- [ ] **Step 2: Убедиться, что падают** — `node --test src/ui/filetree.test.ts > /tmp/filetree.log 2>&1`.
- [ ] **Step 3: Реализовать** `filetree.ts`, проводку в `app.ts`, стили.
- [ ] **Step 4: Тесты зелёные**, полный прогон, типы, снимок: выделить 3 коммита — дерево файлов всех трёх.
- [ ] **Step 5: Commit** — `git commit -m "List the files of the whole selection as a tree"`.

### Task 8: Встроенный дифф справа

**Files:**
- Modify: `src/ui/diff.ts` (оверлей → встроенная панель), `src/ui/app.ts`, `src/ui/styles.css`

**Interfaces:**
- Consumes: `api.rangeDiff` (Task 7), `orderedFiles`, `openFile` (Task 7), `splitRows`, `changedRange`, `changeStarts` (`diffmodel.ts`), контейнер `#diff` (Task 5).
- Produces: `mountDiff(container: HTMLElement, options: { root: string; files: SelectionFile[]; index: number; mode: DiffMode; wholeFile: boolean; onPrefs(mode: DiffMode, wholeFile: boolean): void; onIndex(index: number): void }): { dispose(): void }` вместо `openDiff`. Функция `renderLines` остаётся точкой, куда Task 9 вставит подсветку.

Поведение:
- Шапка как в WebStorm: `↑ Change` / `↓ Change` (F7 / Shift+F7), `←` `i/N files` `→` (Alt+↑ / Alt+↓ и кнопки), путь файла, справа `split` / `unified` и `Whole file`. Строка под шапкой: короткие хеши `from..to` (`from` = `empty` для `null`) и путь, для переименования `old → new`.
- Esc больше ничего не закрывает. Пустое состояние: `Select a file to see its changes`. Бинарный файл: `Binary file`. Обрезанный: существующее предупреждение движка.
- Смена выделения коммитов, если текущий файл остался в новом списке, — дифф перечитывается для того же пути; иначе пустое состояние.
- В режиме `panel` контейнера диффа нет: `openFile` вызывает `api.openTab(workspaceId)` (reveal подключит Task 12).

- [ ] **Step 1: Переделать** `diff.ts` и подключить в `app.ts`; удалить код оверлея и `closeOpen`.
- [ ] **Step 2: Проверка** — полный прогон (`diffmodel`-тесты в `graph.test.ts` зелёные), типы, снимок вкладки: 3 коммита, клик по файлу — дифф справа, ← → по файлам, F7 по изменениям.
- [ ] **Step 3: Commit** — `git commit -m "Show the diff beside the selection instead of over the log"`.

### Task 9: Подсветка синтаксиса в диффе

**Files:**
- Create: `src/vendor/highlight/core.min.js`, `src/vendor/highlight/languages/*.min.js`, `src/vendor/highlight/LICENSE`, `src/ui/highlight.ts`, `src/ui/highlight.test.ts`
- Modify: `src/ui/diff.ts` (`renderLines`, `code`), `src/ui/styles.css` (палитры), `README.md` (сторонний код и лицензия)

**Interfaces:**
- Consumes: `renderLines` (Task 8), `wordRanges` (`diff.ts`).
- Produces:
  - `languageFor(path: string): string | null` — по расширению и имени файла (`Dockerfile`, `Makefile`).
  - `highlightLines(lines: string[], language: string | null): string[]` — HTML на каждую строку, текст экранирован; токен, который тянется через перевод строки (многострочный комментарий, шаблонная строка), закрывается в конце строки и заново открывается в начале следующей.
  - `markRange(html: string, start: number, end: number, cls: string): string` — оборачивает символы `[start, end)` текста строки в `<span class="cls">` поверх токенов, разрезая токены на границах.

Вендоринг: `npm pack @highlightjs/cdn-assets@11` в `/tmp/hljs`, распаковать, взять `package/es/core.min.js`, `package/LICENSE` и из `package/es/languages/` языки: `typescript javascript json yaml bash shell css scss less xml markdown python go rust java kotlin csharp php ruby sql dockerfile ini makefile nginx diff plaintext`. Проверить: в файлах нет импортов, кроме относительных (`grep -n "^import\|from '" src/vendor/highlight -r`). Размер каталога записать в README.

Подсветка в диффе: для каждого ханка отдельно подсвечиваются строки старой стороны (контекст + `-`) и новой (контекст + `+`), затем строки раскладываются обратно по своим местам; изменённые слова (`wordRanges`) накладываются через `markRange(..., 'word')`. Без подсветки (только экранирование), если язык неизвестен, в ханке больше 5000 строк или строка длиннее 2000 символов.

Палитры (классы `hljs-*`, выбор по классу `dark` / `light` на `<html>`, который ставит Орка), как в WebStorm:
- dark: keyword `#CF8E6D`, string `#6AAB73`, number `#2AACB8`, comment `#7A7E85` italic, title.function `#56A8F5`, attr/property `#C77DBB`, tag `#D5B778`, type/built_in `#16BAAC`, meta `#B3AE60`;
- light: keyword `#0033B3`, string `#067D17`, number `#1750EB`, comment `#8C8C8C` italic, title.function `#00627A`, attr/property `#871094`, tag `#0033B3`, type/built_in `#008080`, meta `#9E880D`.
- Остальной текст — `--fg`; фон строк диффа — существующие `add`/`del`.

- [ ] **Step 1: Вендорить** файлы и проверить импорты.
- [ ] **Step 2: Падающие тесты** `src/ui/highlight.test.ts`:

```ts
test('a token spanning lines is closed and reopened on each line', …)
  // highlightLines(['const a = `x', 'y`'], 'typescript') → строка 0 оканчивается '</span>', строка 1 начинается '<span class="hljs-string">'
test('unknown languages and long lines are only escaped', …)
  // highlightLines(['<b>'], null) → ['&lt;b&gt;']; строка из 2001 символа → без '<span'
test('markRange wraps text across token boundaries', …)
  // markRange('<span class="hljs-keyword">const</span> a', 3, 7, 'word') → текст 'st a' внутри word-спанов, разметка валидна (каждый открытый span закрыт)
test('languageFor maps extensions and well-known names', …)
  // 'a/b.ts' → 'typescript', 'Dockerfile' → 'dockerfile', 'x.unknown' → null
```

- [ ] **Step 3: Убедиться, что падают** — `node --test src/ui/highlight.test.ts > /tmp/highlight.log 2>&1`. `highlight.ts` импортирует `../vendor/highlight/core.min.js`; если `node --test` не грузит эти ESM-файлы, запускать через `orca plugin test`.
- [ ] **Step 4: Реализовать** `highlight.ts`, подключить в `diff.ts`, добавить палитры.
- [ ] **Step 5: Тесты зелёные**, полный прогон, типы, снимки вкладки в светлой и тёмной теме (`--theme light|dark`) на `.ts` и `.sh` файлах из выделения.
- [ ] **Step 6: Commit** — `git commit -m "Highlight syntax in the diff"`.

### Task 10: Описание коммитов — список с раскрытием

**Files:**
- Modify: `src/ui/details.ts` (переделка), `src/ui/app.ts`, `src/ui/styles.css`

**Interfaces:**
- Consumes: `api.details(root, hash)` (`commit.details` движка), секция `details` (Task 5), `rows`/`selectedHashes()` в `app.ts`.
- Produces: `renderCommitList(container: HTMLElement, commits: CommitRow[], host: { expanded: Set<string>; load(hash: string): Promise<CommitDetails>; select(hash: string): void; onToggle(): void }): void`. `renderMany` и старый `renderDetails` удаляются.

Поведение (дизайн, вариант «Б»):
- По строке на выбранный коммит в порядке лога (новый сверху): шеврон, короткий хеш (моноширинный), заголовок, автор.
- Клик по строке раскрывает блок: полное сообщение (моноширинное, выделяемое), `author <email>`, дата, коммитер и его дата, если отличаются, родители (клик выбирает родителя — `host.select`), ветки, где есть коммит (до 50, как в движке), полный хеш.
- Детали грузятся при первом раскрытии и кешируются по хешу до `repo.changed`.
- При одном выбранном коммите он раскрыт сразу; при нескольких все свёрнуты; раскрытые остаются раскрытыми, пока выделение не меняется.
- Итог в заголовке секции: `N commits` (пусто при 0).
- Во вкладке и в сайдбаре — четвёртая секция левой колонки (решение пользователя 2026-11-09, вместо секции под диффом). В этой задаче перенести секцию `details` во вкладке из-под диффа в левую колонку: колонка `['branches','commits','files','details']` в обоих режимах, дифф занимает всю высоту справа; убрать разделитель под диффом и поле `Prefs.detailsHeight` (старое значение в `localStorage` просто игнорируется).

- [ ] **Step 1: Реализовать** `details.ts` и проводку.
- [ ] **Step 2: Проверка** — полный прогон, типы, снимки: один коммит (раскрыт), три коммита (свёрнуты, раскрыть один), сайдбар.
- [ ] **Step 3: Commit** — `git commit -m "Show selected commits as an expandable list"`.

### Task 11: Ветки — папки по префиксу, фильтр кликом, новые действия

**Files:**
- Modify: `src/ui/format.ts` (`groupByPrefix`), `src/ui/graph.test.ts` (тест `groupByPrefix` рядом с тестами `format.ts`), `src/ui/branches.ts`, `src/ui/app.ts` (`branchMenu`), `src/ui/api.ts`

**Interfaces:**
- Consumes: `branch.run` (Task 3), `askName`, `confirm`, `busy` (`dialogs.ts`), баннер Undo (`act` в `app.ts`).
- Produces:
  - `type BranchNode = { kind: 'folder'; name: string; path: string; children: BranchNode[] } | { kind: 'branch'; label: string; ref: BranchRef }`
  - `groupByPrefix(refs: BranchRef[], strip?: string): BranchNode[]` — папка на каждый сегмент до `/`, вложенно; папки перед ветками, внутри `localeCompare`; `strip` — префикс, который отрезается от имени (имя remote для удалённых).
  - `api.branch(root, action: BranchAction): Promise<BranchActionResult>`.

Поведение:
- Local и каждый remote внутри Remote рисуются через `groupByPrefix`; папки сворачиваются, состояние — в существующем `collapsed`.
- Один клик по ветке или HEAD — фильтр лога этой веткой (`filterTo`); двойной клик — перейти к её коммиту (`select`), то есть наоборот по сравнению с движком; подсказка строки обновляется.
- Меню локальной ветки добавляет: `Rename…` (`askName`, начальное значение — текущее имя), `Delete` (не для текущей; `confirm`; ответ `needsForce` → второй `confirm` с текстом `<name> is not fully merged. Delete it anyway? Its commits may be lost.` и `force: true`), `Merge into Current`, `Rebase Current onto This`. Меню удалённой — `Merge into Current`, `Rebase Current onto This`. Для текущей ветки merge и rebase не показываются.
- Merge и rebase идут через тот же путь, что действия движка (`busy`, баннер, Undo по `previousHead`).

- [ ] **Step 1: Падающий тест** в `src/ui/graph.test.ts`:

```ts
test('groupByPrefix nests branches by their prefix', …)
  // ['fix/ABC-1', 'fix/ABC-2', 'feature/x/y', 'main', 'release-candidate']
  // → folder feature [folder x [y]], folder fix [ABC-1, ABC-2], branch main, branch release-candidate
```

- [ ] **Step 2: Убедиться, что падает** — `node --test src/ui/graph.test.ts > /tmp/graph.log 2>&1`.
- [ ] **Step 3: Реализовать** `groupByPrefix`, отрисовку, клики, меню.
- [ ] **Step 4: Тесты зелёные**, полный прогон, типы. Живая проверка на временном репозитории (`/tmp/branch-play`, не на рабочих): rename, delete обычной и неслитой ветки, merge, rebase onto, Undo.
- [ ] **Step 5: Commit** — `git commit -m "Group branches by prefix and add rename, delete, merge and rebase"`.

### Task 12: Из сайдбара во вкладку с тем же выделением

**Files:**
- Modify: `src/shared/protocol.ts` (`TabReveal`, вход `tab.open`, запрос `tab.take`, событие `tab.reveal`), `src/worker/main.ts`, `src/worker/main.test.ts`, `src/ui/api.ts`, `src/ui/app.ts`

**Interfaces:**
- Consumes: `openTab` (`main.ts`), `jumpTo`, `openFile` (`app.ts`).
- Produces:
  - `interface TabReveal { hashes: string[]; path?: string }`
  - `'tab.open': { input: { workspaceId?: string; reveal?: TabReveal }; output: { ok: boolean; reason?: string } }`
  - `'tab.take': { input: { root: string }; output: TabReveal | null }`
  - событие `'tab.reveal': { root: string } & TabReveal`
  - `api.openTab(workspaceId?, reveal?)`, `api.takeReveal(root)`.

Поведение: воркер при `tab.open` с `reveal` проверяет хеши (`^[0-9a-f]{40}$`, не больше 500), запоминает `pending.set(root, reveal)` и после `editor.open` шлёт `tab.reveal`. Вкладка при старте, после `setRepo`, вызывает `api.takeReveal(root)`, а уже открытая слушает `tab.reveal` со своим `root`. Применение: снять фильтры, выделить хеши (`jumpTo` к самому новому, затем добавить остальные в `selected`), после загрузки файлов открыть `path`, если он есть в списке. `tab.take` отдаёт reveal один раз.

- [ ] **Step 1: Падающий тест** в `src/worker/main.test.ts` (стиль файла, `mountWorker`):

```ts
test('opening the tab with a reveal posts it and hands it over once', …)
  // request('tab.open', { reveal: { hashes: [h], path: 'one.txt' } }) → ok true;
  // worker.posts содержит { event: 'tab.reveal', payload: { root, hashes: [h], path: 'one.txt' } };
  // request('tab.take', { root }) → { hashes: [h], path: 'one.txt' }; повторно → null
```

- [ ] **Step 2: Убедиться, что падает** — `orca plugin test . --json > /tmp/orca-git-log-test.log 2>&1`.
- [ ] **Step 3: Реализовать** воркер и интерфейс; в режиме `panel` клик по файлу вызывает `api.openTab(repo.workspaceId, { hashes: selectedHashes(), path: file.path })`.
- [ ] **Step 4: Тесты зелёные**, типы; живая проверка: в сайдбаре выделить 2 коммита, кликнуть файл — вкладка открылась с тем же выделением и диффом файла; повторить при уже открытой вкладке.
- [ ] **Step 5: Commit** — `git commit -m "Open the selection and file from the sidebar in the editor tab"`.

### Task 13: Перевод строк, оставшихся от движка

**Files:**
- Modify: `src/shared/i18n.ts` (ключи `en` и `ru`), `src/ui/dialogs.ts`, `src/ui/menu.ts`, `src/ui/filters.ts`, `src/ui/branches.ts`, `src/ui/format.ts` (`relativeDate`, `fullDate`, `STATUS_NAMES`), `src/ui/app.ts`, `src/worker/actions.ts`, `src/worker/rebase.ts`, `src/worker/repo.ts`, `src/worker/patch.ts`, `src/worker/main.ts`, `src/worker/branchActions.ts`, `src/worker/selection.ts`, тесты, которые сверяют тексты сообщений

**Interfaces:**
- Consumes: `t`, `setLocale`, `en`, `ru` (Task 4).
- Produces: в интерфейсе и сообщениях воркера не остаётся литералов, видимых человеку.

- [ ] **Step 1: Найти литералы.** Пройти перечисленные файлы: подписи кнопок, заголовки, подсказки (`title`), плейсхолдеры, тексты диалогов и меню, сообщения `ActionResult.message` и `throw new Error(...)`, которые доходят до человека. Каждый — ключ в `en` с прежним английским текстом и перевод в `ru`. Даты: `relativeDate` и `fullDate` форматируют через `Intl` с текущим языком.
- [ ] **Step 2: Тесты.** Тесты, которые сверяют английские сообщения (`git.test.ts`, `main.test.ts`, `branchActions.test.ts`), остаются зелёными при `en`. Добавить в `src/shared/i18n.test.ts` тест `worker messages switch to Russian with the request locale`: `mountWorker` + `action.run` (`drop` во временном репозитории) с `locale: 'ru'` → `message` из каталога `ru`. Тест полноты каталога из Task 4 ловит забытые переводы.
- [ ] **Step 3: Проверка** — полный прогон, типы, снимки сайдбара и вкладки при русском языке Орки (если в Орке нет русского языкового пакета, переключить `setLocale('ru')` во фрейме временно и не коммитить это).
- [ ] **Step 4: Commit** — `git commit -m "Translate the remaining interface and worker messages"`.

### Task 14: Финальная проверка, документация, установка

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-11-09-orca-git-plugin-design.md` (отклонения), при необходимости `src/ui/app.ts` и `orca-plugin.json` (`storage:own`)

- [ ] **Step 1: Сохранность настроек.** Свернуть секции, изменить размеры, перезапустить Орку (спросить пользователя перед перезапуском — это его рабочее окно). Если состояние потерялось — перевести `Prefs` на `storage:own` (`orca.host.call('storage.get'|'storage.set')`), добавить capability `{ "kind": "storage:own" }`, сообщить пользователю, что при установке появится новое разрешение.
- [ ] **Step 2: Полный прогон и проверки** — `orca plugin test . --json`, `orca plugin validate . --json`, `orca plugin check . --json`, типы. Всё зелёное.
- [ ] **Step 3: Живое ревью на рабочем репозитории** из `.local/notes.md`: открыть вкладку, выбрать HEAD, выделить 5 своих коммитов с merge между ними, пройти файлы, дифф, описание; сайдбар. Только чтение — действий, меняющих историю, на рабочем репозитории не выполнять.
- [ ] **Step 4: Документация.** README: возможности форка (раскладка, файлы выделения, дифф с подсветкой, действия с ветками, fetch), скриншоты в `images/` (заменить снимки апстрима) — только с демо-репозитория `/tmp/git-demo` (вымышленные авторы и коммиты, см. Global Constraints), лицензия highlight.js. В дизайн-документе отметить отклонения: палитры подсветки не из темы Орки (Орка не отдаёт цвета токенов фреймам) — свои, в стиле WebStorm для светлой и тёмной темы; язык интерфейса следует Орке, каталоги `en` и `ru`; правило двух линий для узкой колонки.
- [ ] **Step 5: Черновики issue в Орку** (`github.com/stablyai/orca`) — в `docs/orca-issues.md`, на английском: (1) API «открыть вкладку плагина без файла»; (2) отдавать фреймам плагинов цвета подсветки синтаксиса активной темы (`tokenColors`), например переменными `--orca-syntax-*` или полем в `FrameTheme`. Не публиковать: показать пользователю.
- [ ] **Step 6: Commit** — `git commit -m "Document the fork and its screenshots"`.
- [ ] **Step 7: Передать пользователю** (не делать самому без его слова): push в `origin`, установку `orca plugin install https://github.com/predmaxim/orca-git` с показом запрошенного доступа до `--approve`, выключение `emamalet.git-log`, публикацию issue.

### Task 15: Бэкап перед опасными операциями

Добавлена 2026-11-10 по решению пользователя; дизайн — раздел «Бэкап перед опасными операциями» в спецификации, макет `docs/superpowers/specs/backup-mockup.html` (вариант «А»).

**Files:**
- Create: `src/worker/backup.ts`, `src/worker/backup.test.ts`, `src/ui/backup.ts` (часть подтверждения: галочка, ветка/тег, имя; генерация имени)
- Modify: `src/shared/protocol.ts` (тип `BackupRequest`, необязательное поле `backup` во входе `action.run` и `branch.run`), `src/worker/main.ts` (создать бэкап до действия), `src/ui/app.ts` и `src/ui/dialogs.ts` (подтверждения опасных операций), `src/ui/branches.ts` (меню бэкапов), `src/shared/i18n.ts`, `orca-plugin.json` (`contributes.settings`: `offerBackup` boolean, по умолчанию `true`; `backupKind` `"branch" | "tag"`, по умолчанию `"branch"`), `README.md`

**Interfaces:**
- `interface BackupRequest { kind: 'branch' | 'tag'; name: string; target: string; stash?: boolean }` — `target` — 40-символьный хеш, на который ставится бэкап (вершина текущей ветки или удаляемой ветки).
- `createBackup(git: Git, request: BackupRequest): Promise<{ ok: true; name: string; stash?: string } | { ok: false; message: string }>` в `src/worker/backup.ts`: проверяет `target` (`^[0-9a-f]{40}$`), имя (`git check-ref-format --branch` для ветки, `git check-ref-format refs/tags/<имя>` для тега, не начинается с `-`), что ссылки ещё нет; затем `git branch --no-track <имя> <target>` или `git tag <имя> <target>` (без `-f`); при `stash: true` — `git stash create`, и если вывод не пуст — `git stash store -m "Git plugin backup before reset --hard (<ветка>)" <хеш>`.
- `suggestBackupName(branch: string | null, head: string, existing: Set<string>, now: Date): string` в `src/ui/backup.ts` — `backup/<ветка>-<ГГГГММДД-ЧЧММ>`, для `null` — `backup/detached-<первые 8 символов head>-<…>`, при занятом имени суффикс `-2`, `-3`…
- В `main.ts` обработчики `action.run` и `branch.run`: если во входе есть `backup`, сначала `createBackup`; при `ok: false` действие не запускается и возвращается `{ ok: false, message }`; при успехе к результату добавляется `backup: string` (имя) и `stash?: string`.

Поведение интерфейса — по спецификации: галочка включена по умолчанию (если настройка `offerBackup` не выключена), выбор ветка/тег запоминается в `backupKind`, баннер показывает имя бэкапа, Undo и «Show backup»; меню бэкапов (`backup/*` среди веток и тегов) — «Restore <ветка> to This Backup…» (`reset --keep` через существующее действие, с подтверждением и своим предложением бэкапа) и «Delete Backup» (подтверждение; ветка — `git branch -D <имя>` только для имён `backup/*`, тег — `git tag -d <имя>` только для имён `backup/*`). Одна операция — одно окно и один бэкап, сколько бы коммитов она ни затрагивала.

- [ ] **Step 1: Падающие тесты** `src/worker/backup.test.ts` (временные репозитории, стиль `branchActions.test.ts`):

```ts
test('a branch backup points at the old tip and survives the drop', …)
  // drop 2 коммитов с backup {kind:'branch', name:'backup/main-20261110-1432', target: HEAD} → ветка бэкапа = старая вершина, оба удалённых коммита достижимы из неё
test('a tag backup works the same way', …)
test('a taken name refuses the backup and the action does not run', …)
  // бэкап-ветка с таким именем уже есть → ok:false, история не изменилась
test('hostile names and targets are refused before git runs', …)
  // '-x', 'a..b', 'a b', 'a@{1}', target 'HEAD' / 'abc' → ok:false, ни одной новой ссылки
test('reset --hard with stash keeps the uncommitted changes in the stash', …)
  // грязное дерево, reset hard c backup {stash:true} → git stash show -p stash@{0} содержит изменения; рабочая копия чистая
test('deleting an unmerged branch with a backup keeps its commits reachable', …)
test('restoring to a backup refuses when it would overwrite local changes', …)
  // reset --keep к бэкапу при конфликтующих локальных изменениях → ok:false, файлы как были
```

И в `src/ui/backup.test.ts` — `suggestBackupName`: обычная ветка, ветка с `/`, detached HEAD, занятое имя → `-2`, `-3`.
- [ ] **Step 2: Убедиться, что падают** — `orca plugin test . --json > /tmp/orca-git-log-test.log 2>&1`.
- [ ] **Step 3: Реализовать** воркер, протокол, подтверждения, меню, настройки, строки `en`/`ru`.
- [ ] **Step 4: Тесты зелёные**, типы, `orca plugin validate`/`check`; снимок подтверждения на демо-репозитории (`/tmp/git-demo`).
- [ ] **Step 5: Commit** — `git commit -m "Offer a backup branch or tag before risky operations"` (можно двумя коммитами: воркер, интерфейс).

### Task 16: Безопасность git — тесты на вредные случаи и независимый аудит

Добавлена 2026-11-10 по требованию пользователя: пользователи плагина не должны навредить своим репозиториям через плагин.

**Files:**
- Create: `src/worker/safety.test.ts` (матрица), `docs/git-safety.md` (таблица операций: команда git с аргументами, откуда берутся входы, как проверяются, что при сбое, тест)
- Modify: код воркера и интерфейса только для исправления найденных ошибок — каждое исправление отдельным коммитом с регрессионным тестом.

Матрица: для каждой операции плагина — checkout (ветка, хеш, удалённая ветка), новая ветка, новый тег, cherry-pick, revert, reset soft/mixed/keep/hard, undo commit, squash, fixup, drop, reword, interactive rebase, create patch, rename, delete (`-d`/`-D`), merge, rebase onto, fetch, restore to backup, delete backup, Undo после действия — тесты во временных репозиториях на:
1. результат при нормальном вводе;
2. отказ до запуска git при неверном или враждебном вводе (имена с `-`, `..`, пробелами, `@{`, неверные хеши, чужие пути);
3. безопасный сбой: конфликт или ошибка → операция прервана, ветки, HEAD, индекс и файлы как были;
4. грязное рабочее дерево → локальные изменения не потеряны (или операция отказывается);
5. запушенные коммиты → интерфейс предупреждает до переписывания (проверка в воркере);
6. операция в процессе (rebase/merge/cherry-pick, начатые в терминале) → отказ.

- [ ] **Step 1:** составить `docs/git-safety.md` по коду (каждый вызов `git.run`/`git.out` в `src/worker/`).
- [ ] **Step 2:** написать матрицу тестов; падающие — это найденные ошибки.
- [ ] **Step 3:** исправить каждую найденную ошибку отдельным коммитом.
- [ ] **Step 4:** полный прогон, типы, `validate`/`check`.
- [ ] **Step 5: Commit** — `git commit -m "Test every git operation against harmful cases"` и коммиты исправлений.
- [ ] **Step 6:** независимый аудит всех вызовов git свежим агентом без общего контекста (самая сильная модель); найденное — исправить, повторный аудит исправлений.

### Task 14c: Сайдбар и одна вкладка «Diff» вместо вкладки «Git»

Добавлена 2026-11-10 по решению пользователя; дизайн — раздел «Раскладка» спецификации. Выполняется до Task 15.

**Files:**
- Create: `src/ui/diff.html`, `src/ui/diff-app.ts` (страница вкладки «Diff»: читает якорь, берёт состояние у воркера, монтирует `mountDiff` на всю страницу), `src/worker/diffTab.ts` (+ тесты в `src/worker/main.test.ts` или `src/worker/diffTab.test.ts`)
- Modify: `orca-plugin.json` (`customEditors`: вместо `log-tab`/`.gitlog` — `diff-tab`, `title: "Diff"`, `extensions: [".gitdiff"]`, `entry: "src/ui/diff.html"`; убрать команду `open-tab`), `src/shared/protocol.ts`, `src/worker/main.ts`, `src/ui/app.ts`, `src/ui/api.ts`, `src/ui/styles.css`, `src/shared/i18n.ts`, `README.md`, `images/`
- Delete: режим `editor` в `src/ui/app.ts` (раскладка C1, `#diff`, `leftWidth` и его разделитель, кнопка «Open in editor tab»), `src/ui/editor.html`, механизм reveal (`TabReveal`, `tab.open` с `reveal`, `tab.take`, событие `tab.reveal`, `applyReveal`, их тесты), `tab.open` и `ANCHOR = '.orca-git-log.gitlog'` в воркере, если больше не нужны.

**Interfaces:**
- Протокол: `interface DiffTabState { root: string; files: SelectionFile[]; index: number }`; запросы `'diff.open': { input: DiffTabState; output: { ok: boolean; reason?: string } }` и `'diff.state': { input: { root: string }; output: DiffTabState | null }`; событие `'diff.show': { root: string }`.
- Воркер `diff.open`: `root` — только тот, что воркер уже разрешил (`gitFor`); `files` — до 2000 элементов, у каждого `path`/`oldPath` — непустые строки без `\0`, `status` — одна буква из `AMDRCT`, `from` — `null` или 40-hex, `to` — 40-hex; `index` в пределах. Находит воркспейс, чей top level равен `root` (`workspace.list` + `toplevel`), пишет якорь `.orca-git-log.gitdiff` (`{ root, workspaceId }`) в его корень, дописывает его в `info/exclude` (существующий `exclude()`), хранит состояние по `root`, вызывает `editor.open({ workspaceId, path: '.orca-git-log.gitdiff' })` и шлёт `diff.show`. Если воркспейс для `root` не найден — `{ ok: false, reason }` (en + ru), ничего не пишет.
- Вкладка: при старте читает `root` из якоря (`orca.document.get()`), берёт `diff.state(root)`, монтирует дифф с `files`/`index`; на `diff.show` со своим `root` — перечитывает состояние. Пусто — заглушка «Select a file in the Git panel to see its changes» (en + ru).
- Сайдбар: клик или Enter по файлу — `api.openDiff({ root, files: selectionFiles, index })`; ошибка — баннер.

- [ ] **Step 1: Падающие тесты воркера**: `diff.open` с корректным состоянием → якорь записан и в `info/exclude`, `editor.open` вызван с найденным `workspaceId`, `diff.state` отдаёт состояние, `diff.show` отправлен; неверные `files`/`index`/хеши → `ok:false`, ничего не записано; корень без воркспейса → `ok:false`.
- [ ] **Step 2: Убедиться, что падают**; затем **Step 3: Реализовать** воркер, вкладку, проводку в сайдбаре; удалить режим `editor` и reveal.
- [ ] **Step 4:** полный прогон, типы, `orca plugin validate`/`check`; снимки сайдбара и вкладки «Diff» на демо-репозитории `/tmp/git-demo` (вкладку — `orca plugin shot local.git-log --editor /tmp/git-demo/.orca-git-log.gitdiff …`, предварительно положив якорь и состояние через `orca plugin dev request … diff.open` только для `/tmp/git-demo`). Ни одного вызова против других репозиториев.
- [ ] **Step 5:** README (раскладка, скриншоты с демо), дизайн-документ — отклонения; **Commit** — `git commit -m "Open diffs in one Diff tab and drop the Git tab"` (можно несколькими коммитами: воркер, вкладка, удаление).

### Task 17: Стиль интерфейса «как Орка»

Добавлена 2026-11-10 по решению пользователя: вариант «А. Как Орка» из `docs/superpowers/specs/styling-mockup.html`. Касается сайдбара и вкладки «Diff»; подсветка синтаксиса не меняется.

Проверено по исходникам Орки (main 3667cc1 от 2026-11-09, тот же файл, что в установленной 1.4.253): фрейм плагина получает ровно 20 переменных — `--orca-background`, `--orca-foreground`, `--orca-card(-foreground)`, `--orca-popover(-foreground)`, `--orca-primary(-foreground)`, `--orca-secondary(-foreground)`, `--orca-muted(-foreground)`, `--orca-accent(-foreground)`, `--orca-destructive(-foreground)`, `--orca-border`, `--orca-input`, `--orca-ring`, `--orca-radius` (`src/shared/plugins/frames/plugin-panel-design-tokens.ts:5-26`) — и класс `light`/`dark` на `<html>`. Цветов статусов git, фона диффа, сайдбара, вкладок и шрифтов фрейм не получает; CSP панели — `font-src data:`.

**Files:** `src/ui/styles.css` (основная работа), разметка в `src/ui/app.ts`, `src/ui/dialogs.ts`, `src/ui/menu.ts`, `src/ui/diff.ts`, `src/ui/diff-app.ts`, `src/ui/sections.ts`, `src/ui/filetree.ts`, `src/ui/branches.ts` — только классы и структура, нужные для стиля; README (снимки).

Правила:
- Всё, что покрывают 20 токенов, — только через них: фоны (`--orca-background`, `--orca-card`), текст и вторичный текст, рамки, поля ввода (`--orca-input`, фокус `--orca-ring` кольцом), выделение и наведение (`--orca-accent` / `--orca-accent-foreground`), меню и диалоги (`--orca-popover`), основная и вторичная кнопки (`--orca-primary`, `--orca-secondary`), опасные действия (`--orca-destructive`), скругления от `--orca-radius`.
- Формы — как в Орке (shadcn): скругления 6–10 px, строки списков с отступом от краёв и скруглённой заливкой выделения, кнопки-«таблетки», переключатели сегментами, заголовки секций обычным текстом, системный шрифт интерфейса (`system-ui`, затем распространённые sans).
- Чего нет в токенах — как в WebStorm New UI, отдельно для `light` и `dark`: цвета статусов файлов (A/M/D/R/C), фон добавленных и удалённых строк и изменённых слов в диффе, цвета веток графа. Шрифт кода — `"JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace, monospace`.
- Никаких зашитых цветов там, где есть токен; полосы прокрутки, выделение текста (`::selection`), плейсхолдеры, неактивные элементы — тоже из токенов.
- Обе темы: проверить снимками в светлой и тёмной (если окно Орки на экране и `--theme` не применяется — сказать об этом), только на демо-репозитории `/tmp/git-demo`; сайдбар показывает фокусный воркспейс пользователя — его не снимать, если там не демо.
- Без новых тестов на CSS; полный прогон тестов после правок (ничего не сломано), `orca plugin check`.
- Commit: `git commit -m "Style the panel and the Diff tab like Orca"` (можно несколькими коммитами по областям).

### Task 18: Иконки файлов как в WebStorm

Добавлена 2026-11-10 по решению пользователя: из WebStorm берём только иконки файлов; выделение, цвета и формы остаются «как Орка» (Task 17).

- Источник: `JetBrains/intellij-community`, `platform/icons/src/expui/fileTypes/*.svg` (66 типов, у каждого вариант `_dark.svg`; список проверен через `gh api`) и иконки папок New UI оттуда же (`expui/nodes`, найти точные имена). Открытые части репозитория — под Apache 2.0 (`LICENSE.txt`): положить рядом `LICENSE`/`NOTICE` и упомянуть в README в разделе стороннего кода.
- Вендорить только нужные SVG в `src/vendor/jetbrains-icons/` байт в байт; размер записать в README.
- Сопоставление по расширению и имени файла (`Dockerfile`, `.gitignore`, `package.json` и т. п.) в одном модуле (`src/ui/fileicons.ts`) с тестом на сопоставление; неизвестное — `unknown`/`text`.
- Светлая и тёмная тема — по классу `light`/`dark` на `<html>`.
- Где: дерево файлов (файлы и папки), шапка вкладки «Diff», строки файлов в описании коммита, если они есть.
- Проверка: снимок вкладки «Diff» на демо-репозитории, стенд для дерева в светлой и тёмной теме; полный прогон тестов, `orca plugin check`.
- Commit: `git commit -m "Show WebStorm's file icons in the file tree and the Diff tab"`.

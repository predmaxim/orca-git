# Система клавиш: буква — объект, Shift+буква — панель — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** действия с коммитами и ветками — по букве и из меню по `Space` с теми же буквами; действия панели — по Shift+букве, повторно — назад; буква, меняющая репозиторий, — через диалог; Checkout с изменениями предлагает стэш.

**Architecture:** таблица `KEYS` (`src/ui/keys.ts`) получает записи действий с объектами (`menu: true`) и переносит действия панели на Shift. Меню коммита и ветки строятся одной функцией и для мыши, и для букв: пункт меню знает свой `KeyId`, буква находит пункт и запускает его `run` или показывает его `hint`. Воркер перед переходом HEAD считает, что потеряется, и возвращает это, как сейчас `leaves`; панель спрашивает и повторяет запрос с `stash: true` или `carry: true`.

**Tech Stack:** TypeScript без сборки (Орка транспилирует), DOM, `node:test` через `orca plugin test .`, git ≥ 2.31.

**Spec:** `docs/superpowers/specs/2026-11-10-key-system-design.md` (читать вместе с планом). Первая часть клавиатуры — `docs/superpowers/specs/2026-11-10-keyboard-design.md`.

## Global Constraints

- Клавиши — по `event.code`; Ctrl/Alt/Meta выключают все записи (`findKey`, `src/ui/keys.ts`). Shift — только у записей с `shift: true`.
- Клавиши не срабатывают, если `defaultPrevented`, если цель в `input, textarea, select, [contenteditable], .overlay, .menu, .popover`, и пока на странице есть `.busy, .overlay, .layer` — в панели (`src/ui/panelkeys.ts:56`) и, после Task 1, во вкладке «Diff».
- Буква с `menu: true` — без Shift; любая другая буква (`code` начинается с `Key`) — с Shift. Вне правила: `Digit0`–`Digit4`, `Slash`, `Shift+Slash`, стрелки, Page Up/Down, Home/End, Enter, Space, Esc, `F7`, `Shift+F10`, `ContextMenu`, `Ctrl+A`, `Ctrl+C`.
- Строки интерфейса и воркера — через `t()`, в `en` и `ru` (`src/shared/i18n.ts`; пропуск ключа в `ru` — ошибка типов). Подпись клавиши (`label`) выводится без параметров: `t(label)` не содержит `{`.
- Исходники в `src/` — CRLF; файлы с `w/mixed` в `git ls-files --eol src` писать скриптом по байтам, не Edit (после правки — `git diff --stat`). Документы в `docs/` — LF.
- Ошибок типов не больше базы: `npx -y -p typescript@5 tsc -p . --noEmit` — 109 на `a9731cb`; в изменённых строках — 0 новых. ES2023 (`findLastIndex` и т. п.) нельзя.
- Тесты: `orca plugin test .` — все зелёные (186 на `a9731cb`).
- git: правила `docs/git-safety.md` — значение из фрейма никогда не становится опцией git; пути в pathspec — `:(literal)` или `GIT_LITERAL_PATHSPECS=1`; каждая новая команда git — строка в таблице `docs/git-safety.md` и тест.
- Агенту хук запрещает в Bash `git stash` и `git checkout -- <путь>` даже во временных папках: стэш проверяется только тестами плагина (`orca plugin test .`).
- Орка: `orca plugin dev load|unload|enable|disable|update` — только с согласия пользователя, одной живой сессией в Task 8 (в Орке работают его агенты). `test`, `validate`, `check` — можно.
- Документация (README, дизайн) меняется в том же коммите, что поведение; каждый коммит пушится (`git push`), ветка `key-system`. Без ИИ-соавторов в коммитах.

## Review Focus

1. `Space` на строке-папке в «Ветках» и «Файлах» раскрывает папку и не открывает меню: `mountTree` гасит событие (`src/ui/dom.ts:45`), диспетчер пропускает `defaultPrevented` (живая проверка, Task 8, пункт 2).
2. Пути с пробелом, юникодом, `*`, `:(` и `[` в проверке Checkout и в стэше берутся буквально (Task 5, тест «literal paths»).
3. Checkout на тот же коммит, что HEAD, с изменениями в файлах — без вопроса и без стэша (Task 5, тест «same commit»).
4. Стэш сделан, а переход не удался — изменения в стэше, HEAD прежний, сообщение называет стэш и ошибку git (Task 5, тест «stash kept when the switch fails»).
5. Буква недоступного или отсутствующего в меню действия показывает подсказку и ничего не запускает (Task 3, тесты `entityAction`).

---

### Task 1: Действия панели — на Shift+букву, повторно — назад

**Files:**
- Modify: `src/ui/keys.ts`, `src/ui/keys.test.ts`
- Modify: `src/ui/filters.ts:52-71` (`filterButton`: подсказка ✕ — `withKey(…, key)`, параметр `clearKey` убрать)
- Modify: `src/ui/app.ts:1491-1508` (карта `run` в `mountPanelKeys`)
- Modify: `src/ui/diff.ts:133-135, 244-259` (кнопки и `onKey`)
- Modify: `src/shared/i18n.ts` (подписи новых записей, en и ru)

**Interfaces:**
- Produces:
  - `KeyId` без `clearBranch`, `clearUser`, `clearDate`, `clearPaths`, `collapseAll`, `split`, `unified`; новые: `layout`, `folders` (вместо `expandAll`).
  - Записи: `fold` `Shift+KeyZ`, `refresh` `Shift+KeyR`, `fetch` `Shift+KeyF` (anywhere); `filterBranch|User|Date|Paths` `Shift+KeyB|U|D|P`, `regex` `Shift+KeyX`, `matchCase` `Shift+KeyC` (commits); `folders` `Shift+KeyE` (files); `layout` `Shift+KeyS`, `wholeFile` `Shift+KeyW` (diff). `shown` — `Shift+Z` и т. п.

- [ ] **Step 1: Тесты в `keys.test.ts`.** Поправить существующие под новые записи (`findKey(press('KeyU', { shiftKey: true }), ['anywhere','commits'])?.id === 'filterUser'`, `findKey(press('KeyU'), …) === null` пока нет букв объектов, `withKey('User','filterUser') === 'User (Shift+U)'`, `findKey(press('KeyZ',{shiftKey:true}),['anywhere'])?.id === 'fold'`). Добавить:
  - `test('a letter without Shift acts on a thing')`: для каждой записи с `code.startsWith('Key')` верно `Boolean(k.menu) !== Boolean(k.shift)`.
  - `test('no area key shadows a key that works anywhere')` — по **всем** областям (`branches`, `commits`, `files`, `details`, `diff`), а не только `commits`/`files`.
  - `test('labels print without parameters')`: `!t(k.label).includes('{')` для каждой записи.
- [ ] **Step 2:** `orca plugin test .` — новые тесты падают (нет поля `menu`, старые записи без Shift).
- [ ] **Step 3: `keys.ts`.** Добавить в `KeyBinding` поле `menu?: true` (запись действия с объектом; в этом Task таких записей ещё нет). Переписать записи по списку из Interfaces; удалить исчезнувшие `KeyId`.
- [ ] **Step 4: Потребители.**
  - `app.ts`, карта `run`: `filterBranch: () => filter.branches?.length ? filterBar.clear[0]() : filterBar.elements[0].click()` — так же для User/Date/Paths по их полям `filter` (какие поля — см. `createFilterBar`, `src/ui/filters.ts:138`); `folders: () => setAllFolders(!dirPaths(fileTree).every((path) => openFolders.has(path)))`; убрать `clear*`, `expandAll`, `collapseAll`. Подсказки кнопок «развернуть/свернуть все» (`app.ts:129-130`) — обе `withKey(…, 'folders')`.
  - `diff.ts`: обе кнопки раскладки — `withKey(…, 'layout')`; в `onKey` `layout` переключает `split` ↔ `unified`; первой строкой `onKey` — `if (document.querySelector('.busy, .overlay, .layer')) return` (мелочь 0.3.0).
- [ ] **Step 5:** `orca plugin test .` — всё зелёное; `tsc` — не больше 109.
- [ ] **Step 6: README**, раздел «Keyboard»: новые клавиши панели и правило «Shift+буква — панель, повторно — назад». Коммит и пуш: `git commit -m "Move the panel's own keys to Shift+letter, pressed again to undo"`.

### Task 2: Меню показывает и принимает буквы

**Files:**
- Modify: `src/ui/keys.ts`, `src/ui/keys.test.ts`
- Modify: `src/ui/menu.ts:3-13, 67-125`

**Interfaces:**
- Consumes: `KeyBinding`, `KEYS` (Task 1).
- Produces:
  - `MenuEntry` (объект) получает `key?: KeyId`.
  - `export function keyFor(id: KeyId): KeyBinding | undefined` и `export function pickByKey<T extends { key?: KeyId }>(entries: T[], event: Pick<KeyboardEvent, 'code' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>): T | undefined` — в `keys.ts` (чистые, без DOM).

- [ ] **Step 1: Тесты** в `keys.test.ts`: `pickByKey([{ key: 'fetch' }, { key: 'fold' }], press('KeyZ', { shiftKey: true }))` → вторая запись; `press('KeyZ')` без Shift → `undefined`; с `ctrlKey` → `undefined`; запись без `key` никогда не выбирается.
- [ ] **Step 2:** тесты падают (нет функций).
- [ ] **Step 3: `keys.ts`** — `keyFor`, `pickByKey` (тот же разбор модификаторов, что `findKey`).
- [ ] **Step 4: `menu.ts`.** Справа у пункта — `entry.shortcut ?? keyFor(entry.key)?.shown`. В обработчике `keydown` меню: если `pickByKey(items.map((i) => i.entry), event)` нашёл пункт — `choose(его индекс)` (недоступный `choose` и так пропускает) и `preventDefault()`. Стрелки, Enter, Space, Esc — как были.
- [ ] **Step 5:** тесты зелёные, `tsc` ≤ 109. Коммит и пуш: `git commit -m "Show each menu item's key and run it by that key"`.

### Task 3: Буквы коммитов и веток, меню по `Space`

**Files:**
- Modify: `src/ui/keys.ts`, `src/ui/keys.test.ts` (записи с `menu: true`)
- Modify: `src/ui/panelkeys.ts`; Create: `src/ui/panelkeys.test.ts`
- Modify: `src/ui/app.ts:645-698` (`branchMenu`), `:1300-1390` (`commitMenu`), `:772-824` (контекстное меню и `Shift+F10`/`ContextMenu` списка), `:1460-1508` (подсказка `?`, `mountPanelKeys`)
- Modify: `src/shared/i18n.ts`

**Interfaces:**
- Consumes: `MenuEntry.key`, `keyFor`, `pickByKey` (Task 2).
- Produces:
  - Записи `menu: true` (без Shift). «Коммиты»: `commitCopy` y, `commitCherryPick` c, `commitPatch` p, `commitCheckout` o, `commitReset` g, `commitRevert` v, `commitUndo` z, `commitReword` r, `commitFixup` f, `commitSquash` s, `commitDrop` d, `commitRebase` i, `commitBranch` n, `commitTag` t. «Ветки»: `branchCheckout` o, `branchNew` n, `branchShowOnly` l, `branchCopy` y, `branchRename` r, `branchDelete` d, `branchMerge` m, `branchRebase` b, `branchRestore` g. Подписи — без параметров (новые ключи i18n там, где у пункта меню есть `{count}`/`{name}`).
  - `panelkeys.ts`: `export type EntityTarget = { entries: MenuEntry[]; x: number; y: number; restore?: HTMLElement }`; в `PanelKeysHost` — `menu(id: SectionId): EntityTarget | null` и `notice(text: string): void`; чистая `export function entityAction(binding: KeyBinding, entries: MenuEntry[] | null): { run: () => void } | { notice: string }`.
  - `app.ts`: `commitEntries(): MenuEntry[] | null` (null без выделения) и `branchEntries(ref): MenuEntry[]` — тела нынешних `commitMenu`/`branchMenu` без `showMenu`, каждый пункт с `key`; `commitMenu`/`branchMenu` зовут их.

- [ ] **Step 1: Тесты** `panelkeys.test.ts` (`import type` для DOM-типов; модуль не трогает `document` при импорте):
  - доступный пункт с этим `key` → `{ run }`, и `run` — его `run`;
  - недоступный → `{ notice: его hint }`; недоступный без `hint` → `{ notice: t('keyUnavailable', { action: t(binding.label) }) }`;
  - пункта с этим `key` нет → `{ notice: t('keyNotHere', { action: t(binding.label) }) }`;
  - `entries === null` → `{ notice: t('keyNoTarget') }`.
  - В `keys.test.ts`: у каждой записи `menu: true` — `scope` `commits` или `branches`.
- [ ] **Step 2:** тесты падают.
- [ ] **Step 3: Записи и `entityAction`** — по Interfaces. Новые строки i18n: `keyUnavailable`, `keyNotHere` (дизайн: ««<действие>» не применяется к …»), `keyNoTarget` («Выберите коммит» / ветку — по области; одна строка с подстановкой или две — на выбор исполнителя).
- [ ] **Step 4: Диспетчер** (`mountPanelKeys`): (а) `Space`, `Shift+F10`, `ContextMenu` без Ctrl/Alt/Meta, когда текущая область есть: `host.menu(id)` → `showMenu(x, y, entries, restore)`; (б) найденная запись с `menu` → `entityAction(binding, host.menu(id)?.entries ?? null)` → `run()` или `host.notice(text)`; (в) остальное — как сейчас. Порядок проверок `defaultPrevented`/TYPING/`.busy, .overlay, .layer` — прежний, до (а).
- [ ] **Step 5: `app.ts`.** `commitEntries`/`branchEntries` с `key` у пунктов (пункты «Checkout '<ветка>'» коммита — без `key`). `host.menu`: «Коммиты» — `commitEntries()` у строки курсора (координаты, как сейчас у `Shift+F10`, `app.ts:821-823`), `restore: viewport`; «Ветки» — строка-лист с фокусом в `tree` (`[role=treeitem]` без `aria-expanded`), ссылка — по `dataset.key` (полное имя) из `refs` с видом `local`/`remote`/`tag`/`head`, координаты — от строки, `restore` — строка; «Файлы», «Описание» — `null`. `notice` — `showBanner(text, 'info')`. Из обработчика `keydown` списка коммитов убрать `F10`/`ContextMenu` (их теперь открывает диспетчер). `Copy Revision`: `key: 'commitCopy'`, `shortcut` убрать (в меню видно `y`; `Ctrl+C` работает, как работал).
- [ ] **Step 6: Подсказка `?`.** Группы «Ветки» (новая) и «Коммиты» с буквами объектов; вверху — правило одной строкой (`keysRule`); внизу — строки «вне правила»: стрелки, Enter, Space, Esc (в поиске и в меню), `F7` (`keysNav*` — ключи на выбор исполнителя).
- [ ] **Step 7:** тесты зелёные, `tsc` ≤ 109. README «Keyboard»: таблицы букв «Коммитов» и «Веток», `Space` — меню. Коммит и пуш: `git commit -m "Act on commits and branches by letter, and open their menu with Space"`.

### Task 4: Подтверждения перед изменением репозитория

**Files:**
- Modify: `src/ui/app.ts:1099-1102` (`confirmRewrite`), `:1121-1122, 1165-1172` (`confirmPushed`, `undoCommit`), пункты Cherry-Pick (`:1320-1326`), Revert (`:1359-1365`), Merge (`:694`)
- Modify: `src/shared/i18n.ts`

**Interfaces:**
- Consumes: `confirm(title, body, ok, danger?, backup?)` из `src/ui/dialogs.ts`.

- [ ] **Step 1:** `confirmRewrite` спрашивает всегда (убрать ранний `return Promise.resolve(true)`).
- [ ] **Step 2:** Cherry-Pick: `confirm(t('cherryPickTitle'), t('cherryPickConfirm', { count, name: текущая ветка ?? 'HEAD' }), t('btnCherryPick'))` перед `act`. Revert — так же (`revertTitle`, `revertConfirm`, `btnRevert`). Merge — `mergeTitle`, `mergeConfirm` `{ name, current }`, `btnMerge`. Undo Commit — подтверждение всегда, со строкой `pushedWarning(pushed)`, если коммит запушен. Один путь для меню и буквы — через пункт меню.
- [ ] **Step 3:** тесты зелёные, `tsc` ≤ 109. README: какие действия спрашивают подтверждение. Коммит и пуш: `git commit -m "Ask before Cherry-Pick, Revert, Merge, Undo Commit and every rewrite"`.

### Task 5: Воркер: что потеряет Checkout, и стэш

**Files:**
- Create: `src/worker/checkout.ts`, `src/worker/checkout.test.ts`
- Modify: `src/worker/git.ts:14-19, 59-93` (опция `input`)
- Modify: `src/worker/backup.ts:58-80` (экспорт `untrackedAt`)
- Modify: `src/worker/actions.ts:180-230` (`checkout`, `branch` с `checkout: true`, разбор ошибки как у `LeavesCommits`)
- Modify: `src/worker/main.ts` (валидация `stash`/`carry` — ровно `true`, как `checkout`)
- Modify: `src/shared/protocol.ts:140-185`, `src/shared/i18n.ts`
- Modify: `docs/git-safety.md` (строки таблицы, строка Checkout в матрице, раздел про стэш)

**Interfaces:**
- Produces:
  - `protocol.ts`: `ActionRequest` `checkout` и `branch` получают `stash?: boolean; carry?: boolean`. `export interface CheckoutRisk { changed: string[]; conflicts: string[]; untracked: string[]; ignored: string[]; carry: boolean; more: number }` — до 50 путей в каждом списке, `more` — сколько не вошло. `ActionResult.atRisk?: CheckoutRisk` — «ничего не сделано: переход потеряет это».
  - `git.ts`: `GitOptions.input?: string` — пишется в stdin git.
  - `checkout.ts`: `export async function checkoutRisk(git: Git, target: string): Promise<CheckoutRisk | null>` (`target` — 40-hex коммит цели; `null` — терять нечего или цель = HEAD; списки полные, `more: 0`) и `export function trimRisk(risk: CheckoutRisk): CheckoutRisk` (до 50 путей в списке, остаток — в `more`; так риск уходит в ответ) и `export async function stashForCheckout(git: Git, risk: CheckoutRisk, from: string, to: string): Promise<{ hash: string; name: string }>`.

- [ ] **Step 1: Тесты** `checkout.test.ts` (временные репозитории, как в `branchActions.test.ts:14-36`), через `runAction(git, …)`:
  - `nothing to lose`: чистое дерево → переход, `atRisk` нет.
  - `same commit`: изменённый файл, `branch` с `checkout: true` от HEAD → переход без `atRisk`, изменение на месте.
  - `tracked change, same in both`: → `atRisk.changed = ['f.txt']`, `conflicts = []`, `carry = true`; HEAD не сдвинут.
  - `tracked conflict`: → `conflicts = ['f.txt']`, `carry = false`.
  - `ignored file the target tracks` (случай 3) и `ignored folder where the target has a file` (случай 4: `build/out.txt` игнорируется, в цели файл `build`) → `ignored` содержит путь, `carry = false`.
  - `untracked folder where the target has a file` (случай 5) → `untracked`, `carry = false`.
  - `assume-unchanged edit`: `checkoutRisk` его не видит; `runAction` без флагов возвращает ошибку git (`would be overwritten`), файл не тронут.
  - `stash`: `stash: true` → переход сделан; в рабочей папке нет изменённого, неотслеживаемого и игнорируемого из случая 3; другой игнорируемый файл (`node_modules/x`) на месте; `git stash list` — одна запись с именем `git-log: main → topic, ` + дата; `git stash pop` (в тесте через `sh`) возвращает все три.
  - `stash kept when the switch fails`: случай с `assume-unchanged`-конфликтом и ещё одним изменением, `stash: true` → `ok: false`, HEAD прежний, `message` называет стэш, `stash` в ответе — хеш.
  - `carry refused`: `carry: true` при `ignored` → `ok: false`, ничего не тронуто.
  - `literal paths`: файлы `a b.txt`, `ж.txt`, `*.txt`, `:(glob)x`, `[a].txt` в изменениях → стэш забирает ровно их.
  - `flags count only as true`: `stash: 1` → как без флага (`atRisk`).
  - `submodule.recurse`: сабмодуль (`-c protocol.file.allow=always submodule add`), правка внутри него, `submodule.recurse=true`, цель с другим коммитом сабмодуля — записать в дизайн (раздел «Checkout»), что делает `git switch`; если правка теряется молча — остановиться и спросить пользователя, как её защищать (стэш верхнего репозитория сабмодуль не спасает).
- [ ] **Step 2:** `orca plugin test .` — тесты падают.
- [ ] **Step 3: `git.ts`** — `input` пишется в `child.stdin` и закрывается; без `input` stdin как сейчас.
- [ ] **Step 4: `checkoutRisk`.** HEAD (`rev-parse --verify -q HEAD`; нерождённая ветка — пустое дерево) = цель → `null`. Иначе:
  - `changed` — `git status --porcelain=v1 -z --untracked-files=no` (у переименования — оба пути);
  - `differ` — `git diff --name-only -z --no-renames <HEAD> <target> --`; `written` — те из них, что есть в цели (`--diff-filter=d`);
  - `conflicts = changed ∩ differ`;
  - места — `written` и их родительские папки, которые на диске не папки (`lstat`); `untracked` — `untrackedAt(git, ['--exclude-standard'], места)`, `ignored` — `untrackedAt(git, ['-i', '--exclude-standard'], места)`;
  - всё пусто и `changed` пуст → `null`; `carry = !conflicts.length && !untracked.length && !ignored.length`.
- [ ] **Step 5: `stashForCheckout`.** Имя `git-log: <from> → <to>, YYYY-MM-DD HH:MM` (локальное время). Пути: `changed` + все неотслеживаемые (`ls-files -z -o --exclude-standard`) + `ignored` — из полного `risk` (не из обрезанного `trimRisk`). `git stash push --all -m <имя> --pathspec-from-file=- --pathspec-file-nul` c `env: { GIT_LITERAL_PATHSPECS: '1' }` и `input` — пути через `\0`. Проверить, что `gitEnv` (`src/worker/launch.ts`) не срезает переменную. Хеш — `rev-parse --verify stash@{0}`.
- [ ] **Step 6: `actions.ts`.** В `checkout` и в `branch` с `checkout === true`: после `guardLeaving` и до любой записи — `checkoutRisk(git, commit цели)`. Есть риск: без `stash`/`carry` — бросить `CheckoutAtRisk` (как `LeavesCommits`, разбор в `runAction` → `{ ok: false, message, atRisk: trimRisk(risk) }`); `carry` при `!risk.carry` — ошибка `t('carryRefused')`; `stash` — `stashForCheckout`, затем переход; провал перехода — `{ ok: false, message: t('checkoutStashKept', { name }) + ошибка git, stash: hash }`. Удача со стэшем — сообщение `t('checkoutStashed', { target, name })`, `stash: hash`. Для `track` (Checkout as…) проверка — по коммиту удалённой ветки и до `git branch --track`.
- [ ] **Step 7: `main.ts`** — `stash`/`carry` доходят до `runAction`, только если ровно `true` (как `checkout`, `src/worker/main.test.ts:116`); тест рядом.
- [ ] **Step 8:** тесты зелёные, `tsc` ≤ 109.
- [ ] **Step 9: `docs/git-safety.md`** — строки новых команд (`status`, `diff --name-only`, `ls-files -o` у Checkout, `stash push`) с их входами и проверками; строка Checkout в матрице; в «Ограничениях» — `assume-unchanged` (git отказывает сам). Коммит и пуш: `git commit -m "Find what a checkout would lose, and stash it or carry it only when asked"`.

### Task 6: Диалог Checkout в панели

**Files:**
- Modify: `src/ui/dialogs.ts:10-22, 80-82` (`Button`: `disabled?`, `title?`), новая `askCheckout`
- Modify: `src/ui/app.ts:1040-1062` (`report`), `:1178-1184` (`moveHead`)
- Modify: `src/shared/i18n.ts`

**Interfaces:**
- Consumes: `ActionResult.atRisk`, `CheckoutRisk`, флаги `stash`/`carry` (Task 5).
- Produces: `askCheckout(risk: CheckoutRisk, from: string, to: string): Promise<'stash' | 'carry' | null>` в `dialogs.ts`.

- [ ] **Step 1: `dialogs.ts`.** `Button` получает `disabled?: boolean` и `title?: string`. `askCheckout`: заголовок `checkoutRiskTitle`; текст — что найдено, по группам (изменения, конфликты, неотслеживаемые, игнорируемые — список путей с прокруткой, как `file-list` в других диалогах, плюс «и ещё N» при `more`); строка про стэш с именем вида `git-log: <from> → <to>, <время>`; кнопки «В стэш и перейти» (`kind: 'primary'`, по Enter), «Перейти с изменениями» (`disabled: !risk.carry`, `title` — почему), «Отмена».
- [ ] **Step 2: `moveHead`** — цикл: `act` → `atRisk` → `askCheckout` → повтор с `stash: true` или `carry: true`; `leaves` → как сейчас, с сохранением уже выбранного флага; иначе выход. Отмена на любом шаге — выход.
- [ ] **Step 3: `report`** — не показывать ошибку для `result.atRisk` (как для `leaves`, `app.ts:1060`); при `result.stash` у Checkout — сообщение воркера уже называет стэш, `backupStashed` не дублировать.
- [ ] **Step 4:** тесты зелёные, `tsc` ≤ 109. README: Checkout с изменениями. Коммит и пуш: `git commit -m "Ask before a checkout that would lose changes: stash them, carry them or cancel"`.

### Task 7: Мелочи 0.3.0 и версия 0.4.0

**Files:**
- Modify: `src/ui/app.ts:848-910, 1447-1458` (`updateFiles`, `goToDiff`)
- Modify: `README.md`, `orca-plugin.json`, `package.json`
- Modify: `docs/superpowers/specs/2026-11-10-keyboard-design.md` (строка сверху: клавиши 0.4.0 — в `2026-11-10-key-system-design.md`)

- [ ] **Step 1: `0` во время загрузки файлов выделения.** `updateFiles` хранит текущий запрос (`let filesPending: Promise<void> | null`); `goToDiff` при выделении без файлов ждёт его, затем открывает файл; `filesPlaceholder` — только когда выделения нет.
- [ ] **Step 2:** README — раздел «Keyboard» сверить с таблицей `KEYS` и подсказкой `?`; таблица «Было → стало» из дизайна (раздел «Что меняется для 0.3.0»). Версия `0.4.0` в `orca-plugin.json` и `package.json`.
- [ ] **Step 3:** `orca plugin test .`, `orca plugin validate .`, `orca plugin check .` — зелёные; `tsc` ≤ 109. Коммит и пуш: `git commit -m "Wait for the selection's files before 0 opens one, and document the 0.4.0 keys"`.

### Task 8: Живая проверка в Орке и выпуск (только с согласия пользователя)

- [ ] **Step 1:** Спросить пользователя одним сообщением: какие команды пойдут (`orca plugin dev load .` или выпуск `v0.4.0` + `orca plugin update`), и попросить проверить список ниже.
- [ ] **Step 2: Список для пользователя.**
  1. `c`/`v`/`z`/`d` на выделенном коммите — диалог; `Esc` — ничего не сделано.
  2. `Space` на строке-папке в «Ветках» и «Файлах» раскрывает её; на ветке — меню с буквами справа; буква в меню запускает пункт.
  3. `m` на текущей ветке — баннер «не применяется»; `s` с одним коммитом — подсказка Squash.
  4. `Shift+B` открывает фильтр Branch; выбрать ветку; `Shift+B` снова — фильтр снят. `Shift+E` в «Файлах» — туда и обратно. `Shift+Z` — свернуть область. `Shift+F` — Fetch.
  5. Буквы в поле поиска веток и в окне фильтра печатаются.
  6. `o` на другой ветке с изменённым файлом — диалог с тремя кнопками; «В стэш и перейти» — баннер с именем стэша; `git stash list` в терминале — запись есть.
  7. Во вкладке «Diff» (кликнуть в неё): `Shift+S`, `Shift+W`.
- [ ] **Step 3:** Ответы — в дизайн, раздел «Проверка», с датой; найденное — исправить по systematic-debugging. Выпуск: тег `v0.4.0`, пуш, влить `key-system` в `main` — только по слову пользователя.

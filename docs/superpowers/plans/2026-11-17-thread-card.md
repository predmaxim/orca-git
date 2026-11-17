# Карточка обсуждения «Карточка ревью» — план реализации

> **Для исполнителей-агентов:** обязательный навык — superpowers:executing-plans (или superpowers:subagent-driven-development). Шаги отмечаются чекбоксами (`- [ ]`).

**Цель:** перевести карточку обсуждения во вкладке «Дифф» на вид A из спеки: карточка до 760 px, сообщения в группах с аватарами, кнопки сообщения по наведению или фокусу, действия обсуждения в нижнем ряду рядом с «Ответить…».

**Устройство:** правила «что показывать» (группа, вердикт у сообщения, «Не отправлено» у сообщения, «где») — чистые функции в `src/ui/notemodel.ts` с тестами. Разметку строят `card()`, `message()` и редактор в `src/ui/notes.ts` через `h()`, вид задаёт блок `.d-note*` в `src/ui/styles.css`. Хранилище, worker и протокол не меняются.

**Стек:** TypeScript без сборки, тесты `node:test` через `npm test` (`orca plugin test .`), headless Chromium для снимков.

**Спека:** `docs/superpowers/specs/2026-11-17-thread-card-design.md`. Образец размеров и цветов — `docs/superpowers/specs/assets/2026-11-17-thread-card-a.html`.

## Общие ограничения

- Карточка: `max-width: 760px`, отступы `6px 10px 10px`, рамка 1 px `--border`, радиус 8 px, фон `--bg` (это `--orca-card`).
- Полоса слева: 2 px, `top/bottom: 8px`, цвет вердикта последнего ответа, только в состоянии `answered`: `unclear` — `--state-wait`, `answered`/`refuted` — `--state-info`, `confirmed` — `--state-done`.
- Группа: подряд, автор один, одинаковые `sentAt === undefined` и `review`, `0 <= m.at - prev.at <= 5 * 60_000`.
- Кнопки сообщения скрыты через `opacity: 0; pointer-events: none`, видны при `:hover`, `:focus-within` и при взведённом удалении. Место справа: 32 px, у своего неотправленного 60 px.
- Удаление сообщения — `dropTool('noteDeleteMessage', …, false)`, сообщение с взведённой кнопкой: фон `--danger` 7 %, внутренняя рамка 30 %. Удаление обсуждения — `dropTool('noteDeleteThread', …)` с текстом.
- Иконки Lucide из `lucide-static@0.469.0`, как остальные в `ICONS`.
- Цвета только из токенов и трёх цветов состояний, через `color-mix`.

## На что смотреть при ревью

1. Tab доходит до скрытых кнопок сообщения, при фокусе они видны, Esc снимает взведённое удаление — проверка на стенде (задача 4).
2. Сообщение правится на месте, пока внизу видны «Ответить…» и действия обсуждения; второй редактор с набранным текстом не теряется — стенд.
3. Граница группы: отправленное и неотправленное подряд, разрыв больше 5 минут, время раньше предыдущего — тесты `continues` (задача 1).
4. Узкая колонка split (карточка уже 520 px) с «Отправить снова»: «Ответить…» уходит на свою строку, ничего не вылезает — стенд.
5. Светлая тема: текст меток читается на светлом фоне (контраст не ниже 4.5:1) — стенд.

---

### Task 1: правила показа и строки i18n

**Файлы:**
- Изменить: `src/ui/notemodel.ts` (после `authorOf`)
- Изменить: `src/shared/i18n.ts` (`en` рядом с `noteSideNew`, `ru` так же)
- Тест: `src/ui/notemodel.test.ts`

**Интерфейсы:**
- Даёт: `GROUP_GAP_MS = 300_000`; `continues(prev: NoteMessage | undefined, m: NoteMessage): boolean`; `showsVerdict(n: ReviewNote, m: NoteMessage): boolean`; `marksUnsent(n: ReviewNote): boolean`; `whereOf(n: Pick<ReviewNote, 'side' | 'start' | 'end'>): string`.
- Новые ключи i18n: `noteWhereLine` («Line {line} · {side}» / «Строка {line} · {side}»), `noteWhereLines` («Lines {start}–{end} · {side}» / «Строки {start}–{end} · {side}»), `noteKeySave` (save / сохранить), `noteKeyLine` (new line / новая строка), `noteKeyCancel` (cancel / отмена), `noteKeyImage` (image / картинка). `notePlaceholder` становится коротким: «Note for the agent, in markdown» / «Заметка для агента, markdown».

- [ ] **Шаг 1: тесты**

```ts
test('a message continues the group of the one before: same author, same send, at most 5 minutes later', () => {
  const u = (at: number, extra: Partial<NoteMessage> = {}): NoteMessage => ({ id: String(at), author: 'user', body: 'x', at, ...extra })
  assert.equal(continues(undefined, u(0)), false)
  assert.equal(continues(u(0), u(GROUP_GAP_MS)), true)
  assert.equal(continues(u(0), u(GROUP_GAP_MS + 1)), false)
  assert.equal(continues(u(10), u(5)), false)
  assert.equal(continues(u(0, { sentAt: 1, review: 'r1' }), u(1)), false)
  assert.equal(continues(u(0, { sentAt: 1, review: 'r1' }), u(1, { sentAt: 2, review: 'r2' })), false)
  assert.equal(continues(u(0, { sentAt: 1, review: 'r1' }), u(1, { sentAt: 1, review: 'r1' })), true)
  assert.equal(continues(u(0), { ...u(1), author: 'agent', review: 'r1' }), false)
})

test('the last answer of an answered thread leaves its verdict to the header; other answers show theirs', () => {
  // thread: user sent r1 → agent answered r1 confirmed → state answered: showsVerdict(last) false
  // add an unsent user message after it → state unsent: showsVerdict(that answer) true
  // a resolved thread: true; a user message: false; an agent message without a verdict: false
})

test('Not sent shows on messages only in a thread that also has sent ones', () => {
  // all unsent → false; one sent + one unsent → true; none unsent → false
})

test('where a note is: one line or a range, and its side', () => {
  // en: whereOf(new, 40..40) === 'Line 40 · new'; whereOf(old, 44..46) === 'Lines 44–46 · old'
})
```

Вторая–четвёртая проверки пишутся теми же фабриками `note()`/`user()`/`agent()`, что в `src/shared/notes.test.ts`, с конкретными значениями из комментариев.

- [ ] **Шаг 2:** `node --test src/ui/notemodel.test.ts` (или `npm test`) — FAIL: функций нет.
- [ ] **Шаг 3:** реализовать четыре функции и строки. `showsVerdict`: `m.author === 'agent' && m.verdict !== undefined && !(stateOf(n) === 'answered' && lastAnswer(n) === m)`. `marksUnsent`: есть неотправленные (`unsentOf`) и есть сообщение пользователя с `sentAt`. `whereOf` берёт `noteSideOld`/`noteSideNew`.
- [ ] **Шаг 4:** тесты проходят.
- [ ] **Шаг 5:** коммит.

### Task 2: иконки и время

**Файлы:** `src/ui/dom.ts` (`ICONS`), `src/ui/format.ts:5`.

**Интерфейсы:** даёт `ICONS.user`, `ICONS.bot`, `ICONS.clock`, `ICONS.reply`, `ICONS.imagePlus` (тела из `https://unpkg.com/lucide-static@0.469.0/icons/<name>.svg`, имя Lucide в комментарии) и `export const hhmm`.

- [ ] **Шаг 1:** добавить иконки и экспорт; `npm test` проходит (`fileicons`/`dom` не ломаются).
- [ ] **Шаг 2:** коммит вместе с задачей 3 (иконки без потребителя не нужны).

### Task 3: разметка карточки

**Файлы:** `src/ui/notes.ts`: `labels()` (104), `openEditor()` (523–639), `message()` (703–723), `card()` (732–777), `rowsAfter()` (1112–1117).

**Интерфейсы:**
- Потребляет: всё из задач 1 и 2.
- `Editor` получает поле `end: HTMLElement` — пустой `span.d-note-end` в ряду под полем; `card()` при каждой отрисовке кладёт туда действия обсуждения (`end.replaceChildren(...)`), у новой заметки и при правке сообщения он пуст.

Разметка (имена классов — продолжение нынешних `.d-note*`):

- `labels()`: у «Отправлено, ответа нет» перед текстом `icon('clock')`.
- **Карточка** `div.d-note` (+ `.resolved`, + `verdict-<v>` по вердикту `lastAnswer`, только в состоянии `answered`), `data-id`:
  - свёрнутое решённое — как сейчас (`.d-note-head` с `button.d-note-fold`: `icon('chevronRight')`, метки, первая строка, «N сообщений»; затем `toggle` и удаление обсуждения);
  - открытое — шапка `div.d-note-head` (у развёрнутого решённого — `button.d-note-head.d-note-fold`, `aria-expanded="true"`, с `icon('chevronDown')`): `span.d-note-where` (`icon('note')` + `whereOf(n)`) и `...labels(n)`;
  - `div.d-note-body` с сообщениями;
  - `div.d-note-foot`: редактор ответа (`mine.el`, когда открыт ответ) или `button.d-note-reply` (`icon('reply')` + «Ответить…», не у решённого), затем «Отправить снова» (только `waiting`), `toggle`, удаление обсуждения. Когда открыт редактор ответа, эти действия идут в его `end`, а не в ряд.
- **Сообщение** `div.d-note-msg.<author>` (+ `.cont`, если `continues(prev, m)`; + `.own-draft` у своего неотправленного): `div.d-note-gutter` (у первого в группе `span.d-note-avatar.<author>` с `icon('user')` или `icon('bot')`; у `.cont` — `span.d-note-clock` с `hhmm(new Date(m.at))`, `title` — `fullDate`), `div.d-note-main` (у первого в группе `div.d-note-msg-head`: автор, время, вердикт по `showsVerdict`, « · не отправлено» по `marksUnsent` и `unsentOf`; затем `.md` и картинки), `div.d-note-tools` («Изменить» у своего неотправленного, удаление сообщения без текста).
- **Редактор**: `div.d-note-edit` = поле, полоса картинок (без кнопки «Приложить»), ошибка, затем `div.d-note-bar`: «Приложить файл» (`icon('imagePlus')`, не при правке), `span.d-note-keys` (`kbd` Enter — сохранить · Shift+Enter — новая строка · Esc — отмена · Ctrl+V — картинка; Ctrl+V только не при правке), `span.d-note-end`. Поле пути встаёт, как сейчас, перед строкой ошибки.
- **Новая заметка** в `rowsAfter`: `div.d-note.d-note-new` = шапка с `whereOf(open.anchor)` без метки + `open.el`.

- [ ] **Шаг 1:** переписать `labels`, `message`, `card`, редактор и `rowsAfter` по разметке выше. `refocus(n.id, '.d-note-fold' | '.d-note-toggle')` должен находить те же элементы.
- [ ] **Шаг 2:** `npm test` и `orca plugin check .` проходят.
- [ ] **Шаг 3:** коммит (задачи 2 и 3).

### Task 4: стили и проверка на стенде

**Файлы:** `src/ui/styles.css` 2110–2265 и 2412–2416, 2518–2530 (блок `.d-note*`, `.d-label`, `.tool.d-note-action`, `.d-note-attach`).

- [ ] **Шаг 1:** стили по «Общим ограничениям» и макету A: шапка `8px 12px`, нижняя граница `--border`; где — 12 px, приглушённо, `tabular-nums`; аватар 24 px (`user` на `--accent`, `bot` на `--state-info` 16 % с внутренней рамкой 40 %); сообщение `padding: 6px 8px`, радиус 6 px, `gap: 10px`, подсветка при наведении `--fg` 4 %; ряд `.d-note-foot` `padding: 6px 12px 12px; gap: 6px`; «Ответить…» 28 px, рамка `--input`, фон `--input` 30 %; действия обсуждения 28 px в ряду и 24 px в свёрнутой строке; текст метки `color-mix(--tone 80 %, --fg)`, в светлой теме `40 %`; `container-type: inline-size` на карточке и `@container (max-width: 520px)` — `.d-note-foot:has(.d-note-resend)` переносит «Ответить…» на всю строку; `kbd` — 11 px моноширинный, рамка `--border`.
- [ ] **Шаг 2:** стенд (`/tmp/gitlog-bench`: `t4-server.mjs`, `diff.html`, память `headless-benches`), хранилище засеяно обсуждениями всех состояний: не отправлено (2 сообщения), отвечено (вердикт + исправлено, markdown с кодом и картинкой), ждёт ответа (+ дописанное), нужно уточнение, решённое. Снимки unified и split, тёмная и светлая тема, плюс фокус с клавиатуры на кнопке сообщения и взведённое удаление. Сверить со снимком A и пунктами «На что смотреть».
- [ ] **Шаг 3:** коммит.

### Task 5: документация, ревью, вливание

**Файлы:** `README.md` 121–135 (абзац о карточке обсуждения), `docs/superpowers/specs/2026-11-16-review-threads-design.md` (пункт про удаление: у сообщения в карточке — без текста, ссылка на спеку 2026-11-17), статус спеки 2026-11-17.

- [ ] **Шаг 1:** обновить README и обе спеки.
- [ ] **Шаг 2:** независимое ревью ветки (свежие агенты без общего контекста): корректность, доступность с клавиатуры, вид против спеки. Исправить подтверждённое.
- [ ] **Шаг 3:** `npm test`, `orca plugin validate .`, `orca plugin check .`.
- [ ] **Шаг 4:** влить `thread-card` в `main` (fast-forward), push; хук `post-merge` переводит `orca-git-log-dev`, проверить, что он на новом `main`.

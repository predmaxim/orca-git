# Обсуждения в заметках ревью — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** заметка ревью становится обсуждением, как в pull request'ах Azure DevOps: сообщения пользователя и агента по порядку, ответ того же агента, картинки с просмотром, кнопка «Решено».

**Architecture:** заметка хранит список сообщений вместо текста и одного ответа; одно значение хранилища на обсуждение. Отправка пишет в папку отправки всю историю обсуждения и доставляет промпт в терминал прежнего агента (`terminal.sendText`), если он открыт и свободен, иначе запускает нового (`agent.launch`). Ответ из файла становится сообщением агента. Картинки лежат файлами в `.orca-git-log/images/` и ходят между фреймом и worker'ом частями.

**Tech Stack:** TypeScript без сборки (Orca транспилирует), DOM, `node:test` и `orca/testing` через `orca plugin test .`, host API Orca 1.9.

**Spec:** `docs/superpowers/specs/2026-11-16-review-threads-design.md`; база — `docs/superpowers/specs/2026-11-15-review-notes-design.md`, «Этап 1».

## Global Constraints

- Лимиты: до 200 обсуждений на репозиторий, до 100 сообщений в обсуждении; текст пользователя 1–4000 символов, ответ агента до 8000; картинка PNG, JPEG, GIF или WebP до 5 МиБ (5242880 байт), до 5 на сообщение; файл ответа до 65536 байт; промпт до 4096 символов, одна строка, без обратных кавычек. Значение хранилища до 262144 байт, сообщение фрейма до 64 КиБ, ответ worker'а до 1 МиБ.
- Ничего не удаляется само: сообщение исчезает только по кнопке «Удалить» (его или обсуждения).
- Состояние — только в хранилище (`orca.storage`) и в файлах `.orca-git-log/`: worker Orca останавливает после 5 минут простоя.
- Данные сообщений, ответов, путей и имён файлов не попадают в `innerHTML` и в аргументы команд; путь файла worker строит сам из проверенных id.
- Запись и чтение в worktree: `.orca-git-log` и её подпапки — настоящие папки (не ссылки); новые файлы с флагом `wx`; чтение `O_NOFOLLOW | O_NONBLOCK`, только обычный файл, с пределом размера.
- Строки — через `t()`, в `en` и `ru`. Вид — как у боковой панели Orca (скилл `orca-plugin-ui`): цвета из переменных `src/ui/styles.css`, свои только для состояний (жёлтый `#fbbf24`, зелёный `#4ade80`, синий `#7aa7ff`); кнопки-иконки 26×26 с `aria-label` и `title`; иконки Lucide 0.469.0 в `src/ui/dom.ts`.
- Чистая логика не трогает DOM и тестируется в Node; DOM-код проверяется стендом в headless Chromium (`/tmp/gitlog-notes-bench`, вне репозитория).
- Исходники в `src/` — CRLF (новые файлы тоже; после создания `sed -i 's/\r$//; s/$/\r/' <файл>`), `src/vendor/` не трогать, документы — LF. Файлы со смешанными концами строк (`src/worker/main.test.ts`, `src/worker/git.test.ts`, `src/ui/graph.test.ts`) не править.
- Ошибки типов: новые допустимы только `TS2307` и `TS2591` на `node:*` в новых файлах (154 на голове ветки перед планом).
- Тесты: `orca plugin test .` — все зелёные (300 перед планом). `orca plugin validate .` и `orca plugin check .` — код 0.
- Orca: `orca plugin dev load|unload|reload` — только контролёр. Без ИИ-соавторов в коммитах; документация — в том же коммите, что поведение.

## Review Focus

1. Старое значение хранилища (список заметок прежнего формата) не роняет worker и вкладку: читается как пустое (Task 1, тест «a stored list of the old shape reads as empty»).
2. Ответ агента на вторую отправку не затирает его ответ на первую, а переписанный файл заменяет только своё сообщение (Task 2, тест «each send gets its own agent message»).
3. Прежний агент занят, закрыт или печать отклонена: отправка не теряется и не помечает сообщения отправленными без доставки (Task 3, тесты отката).
4. Картинка-ссылка, файл не того типа, файл больше 5 МиБ, путь наружу из `answers/`: не копируется и не читается (Task 5, тесты).
5. Удаление сообщения с картинкой, на которую ссылается другое сообщение, оставляет файл; удаление последней ссылки удаляет его (Task 5, тест).

---

### Task 1: Модель обсуждения и хранилище

**Files:**
- Modify: `src/shared/protocol.ts`, `src/shared/notes.ts`, `src/worker/notes.ts`, `src/worker/notes.test.ts`, `src/worker/main.ts`, `src/worker/review.ts`, `src/worker/review.test.ts`, `src/worker/testkit.ts`, `src/ui/api.ts`, `src/ui/notemodel.ts`, `src/ui/notemodel.test.ts`, `src/ui/notes.ts`, `src/shared/i18n.ts`

**Interfaces:**
- Produces:

```ts
// src/shared/protocol.ts
export type NoteAuthor = 'user' | 'agent'
/** id: the image's file name in .orca-git-log/images (12 hex of its sha256 and its extension); name: as the user sees it. */
export interface NoteImage { id: string; name: string; bytes: number }
export interface NoteMessage {
  id: string; author: NoteAuthor; body: string; at: number; images?: NoteImage[]
  /** A user's message: the send it went out with. An agent's message: the send it answers. */
  review?: string
  sentAt?: number
  verdict?: NoteVerdict; fixed?: boolean; agent?: string
}
export interface NoteAnchor { path: string; side: NoteSide; blob: string; rev: string; start: NotePoint; end: NotePoint; quote: string }
export interface NoteDraft extends NoteAnchor { body: string; images?: NoteImage[] }
export interface ReviewNote extends NoteAnchor { id: string; createdAt: number; messages: NoteMessage[]; resolvedAt?: number }
export type NoteResult = { ok: true; note: ReviewNote | null } | { ok: false; reason: string }   // null: the note is gone
// PluginRequests (notes.update удаляется)
'notes.reply': { input: { root: string; id: string; body: string; images?: NoteImage[] }; output: NoteResult }
'notes.edit': { input: { root: string; id: string; message: string; body: string }; output: NoteResult }
'notes.resend': { input: { root: string; id: string }; output: NoteResult }
'notes.remove': { input: { root: string; id: string; message: string }; output: NoteResult }
'notes.resolve': { input: { root: string; id: string; resolved: boolean }; output: NoteResult }

// src/shared/notes.ts (чистые, для worker'а и фрейма)
export const MAX_MESSAGES = 100
/** The user's messages not sent yet. */
export function unsentOf(note: ReviewNote): NoteMessage[]
/** The send the user's last sent message went out with, when no agent message answers it. */
export function waitingFor(note: ReviewNote): string | undefined
export type NoteState = 'resolved' | 'unsent' | 'waiting' | 'answered' | 'idle'
export function stateOf(note: ReviewNote): NoteState
/** The agent's last message. */
export function lastAnswer(note: ReviewNote): NoteMessage | undefined

// src/worker/notes.ts
export const noteKey = (root: string, id: string): string   // 'note:' + sha256(root) hex + ':' + id
export function addNote(store, root, draft: unknown, now?): Promise<NoteResult>
export function replyNote(store, root, id: unknown, body: unknown, images: unknown, now?): Promise<NoteResult>
export function editMessage(store, root, id: unknown, message: unknown, body: unknown): Promise<NoteResult>
export function resendNote(store, root, id: unknown): Promise<NoteResult>
export function removeMessage(store, root, id: unknown, message: unknown): Promise<NoteResult>
export function resolveNote(store, root, id: unknown, resolved: unknown, now?): Promise<NoteResult>
export function deleteNotes(store, root, ids: unknown): Promise<ReviewNote[]>
export function markSent(store, root, ids: string[], review: string, now?): Promise<void>     // every unsent message of those notes
export function markUnsent(store, root, review: string): Promise<void>                        // the messages of that send
/** Puts each answer in as the agent's message for its send, or replaces that message when verdict, fixed, body or images differ. */
export function setAnswers(store, root, answers: Map<string, Omit<NoteMessage, 'id' | 'author'>>): Promise<boolean>
```

Правила:
- Хранение: `notes:<hash>` — `{ root, ids }` (порядок создания); `note:<hash>:<id>` — обсуждение. Значение `notes:<hash>` без массива `ids` читается как пустое. Запись обсуждения — одно `set`; список меняется только при создании и удалении.
- `stateOf`: решено — `resolved`; есть неотправленные сообщения пользователя — `unsent`; есть `waitingFor` — `waiting`; последнее сообщение от агента — `answered`; иначе `idle`.
- `replyNote`: текст по правилам первого сообщения; больше `MAX_MESSAGES` — `t('noteFull')`; снимает `resolvedAt`. Параметр `images` в этой задаче принимается и отбрасывается (Task 5).
- `editMessage`: только сообщение пользователя без `sentAt`, иначе `t('noteSentFixed')`.
- `resendNote`: у сообщений пользователя той отправки, которую ждёт `waitingFor`, убираются `review` и `sentAt`; без ожидания — без изменений.
- `removeMessage`: любое сообщение; не осталось сообщений — обсуждение удалено, ответ `{ ok: true, note: null }`.
- `resolveNote`: `resolved: true` ставит `resolvedAt`, `false` снимает.
- `pending`: корень — пока у какого-то его обсуждения `stateOf` — `waiting`.
- `setAnswers`: ключ — id обсуждения; значение несёт `review`, `verdict`, `fixed`, `body`, `at`, `agent?`, `images?`. Сообщение агента с тем же `review` заменяется (id и `at` прежние), если отличаются `verdict`, `fixed`, `body` или id картинок; иначе не пишется. Нет такого — добавляется в конец.
- Отправка и чтение ответов в этой задаче только переводятся на новую модель без смены поведения: `notesFile` пишет на обсуждение все сообщения пользователя как один текст (как раньше — тело заметки; полная история — Task 2), `readAnswers` читает `answers/<id обсуждения>.md` для отправки `waitingFor` и последнего ответа, результат идёт в `setAnswers`.
- Фрейм в этой задаче — наименьшая правка, чтобы всё работало как раньше на новой модели: карточка показывает сообщения по порядку (пользователя — текстом, агента — как «ответ агента» с метками), «Изменить» правит последнее неотправленное сообщение (`notes.edit`), «Отправить снова» — `notes.resend`, «Удалить» — обсуждение. Полный интерфейс обсуждения — Task 4.

Строки (`en` / `ru`): `noteFull` — «This thread is full: {count} messages.» / «Обсуждение заполнено: {count} сообщений.»; `noteSentFixed` — «A sent message cannot be changed.» / «Отправленное сообщение изменить нельзя.»

- [ ] **Step 1: тесты.** `src/worker/notes.test.ts` переписать под новую модель; обязательные:

```ts
test('a note starts as a thread with the user\'s first message', async () => {
  const store = memory()
  const added = await addNote(store, '/r', draft(), 5)
  const note = added.ok && added.note!
  assert.match(note.id, /^[0-9a-f]{12}$/)
  assert.deepEqual(note.messages.map((m) => [m.author, m.body, m.at]), [['user', 'why?', 5]])
  assert.equal(stateOf(note), 'unsent')
  assert.deepEqual(await store.get(notesKey('/r')), { root: '/r', ids: [note.id] })
})
test('a stored list of the old shape reads as empty', async () => {
  const store = memory()
  await store.set(notesKey('/r'), { root: '/r', notes: [{ id: 'aaaaaaaaaaaa', body: 'old' }] })
  assert.deepEqual(await listNotes(store, '/r'), [])
  assert.equal((await addNote(store, '/r', draft())).ok, true)
})
test('the states of a thread', async () => {
  /* add → 'unsent'; markSent(review 'r1') → 'waiting', waitingFor === 'r1', pendingRoots ['/r'];
     setAnswers({ review: 'r1', verdict: 'refuted', fixed: false, body: 'no', at: 9 }) → 'answered', pendingRoots [];
     replyNote → 'unsent'; resolveNote(true) → 'resolved'; replyNote on a resolved thread → 'unsent' and resolvedAt undefined */
})
test('nothing is removed but by a removal', async () => {
  /* add, markSent, setAnswers, replyNote: messages are [user, agent, user]; editMessage of the sent first message → ok false (noteSentFixed);
     editMessage of the unsent third → its body changes, the agent's message stays; removeMessage of the agent's message → [user, user];
     removeMessage of both → note null and the key note:<hash>:<id> is gone and ids is [] */
})
test('an answer is replaced only when it differs, and only for its own send', async () => {
  /* setAnswers for r1 twice with the same verdict, fixed, body → second returns false; with another body → true, same message id, same at;
     markSent r2 after a reply, setAnswers for r2 → messages hold two agent messages, the r1 one untouched */
})
test('send again takes the mark off the messages nobody answered', async () => { /* markSent r1; resendNote → messages unsent, no review; state 'unsent' */ })
test('the 101st message is refused', async () => { /* 100 сообщений через replyNote ok; ещё одно — ok false */ })
```

Остальные прежние тесты файла (плохие черновики, отказ записи, 201-е обсуждение, worker хранит и шлёт `notes.changed`) перенести на новую модель. `src/ui/notemodel.test.ts`: `unsent`, `notesText` и что зависит от старых полей — на новую модель. `src/worker/review.test.ts`: перевести на `messages` (поведение отправки и ответов прежнее).
- [ ] **Step 2:** `orca plugin test .` — новые тесты падают. **Step 3:** реализовать. **Step 4:** зелёные; `validate`, `check` — 0; стенд: прежние прогоны дают тот же смысл на новой модели (вывод прогонов, где менялись имена запросов, — в отчёт).
- [ ] **Step 5:** commit: `Keep a review note as a thread of messages, one stored value per thread, where nothing is removed but by a removal`.

### Task 2: История обсуждения агенту и ответ как сообщение

**Files:**
- Modify: `src/worker/review.ts`, `src/worker/reviewGuide.ts`, `src/worker/main.ts`, `src/worker/review.test.ts`, `README.md`

**Interfaces:**
- Consumes: Task 1 (`ReviewNote.messages`, `waitingFor`, `setAnswers`).
- Produces: `notesFile(notes, paths, skills?)` с историей; `readAnswers(root, notes, now?)` → `Map<string, Omit<NoteMessage, 'id' | 'author'>>`; новый текст `REVIEW_GUIDE` (два абзаца ниже).

`notes.md`, на обсуждение (вместо прежних `Comment:` и текста):

```
## Thread <id>
File: <path>
Lines: <a>-<b>, <side> side, as of commit <rev> (git show <rev>:<path>)
Selected:
    <quote>
Messages, oldest first:
[1] user, <ISO time>:
<body>
[2] agent (<verdict>, fixed: yes|no), <ISO time>:
<body>
[3] user, <ISO time> — NEW, answer this:
<body>
```

Метка `— NEW, answer this` стоит у сообщений пользователя этой отправки. В абзаце о форме ответа «per note» становится «per thread», путь — `<answers>/<thread id>.md`, и добавлено предложение: `A thread can hold earlier messages: read them all, answer the messages marked NEW, and do not repeat what was already answered.`

В `REVIEW_GUIDE`: в начало раздела «For each note» добавить пункт `0. A note is a thread: it can hold earlier messages from the user and from an agent. Read the whole thread; answer the messages marked NEW.`; в раздел «Answer» — `One answer file per thread: it answers every NEW message of that thread together.` Остальной текст не менять.

Правила:
- `readAnswers` читает для каждого обсуждения файл `review-<R>/answers/<id>.md`, где `R` — `waitingFor(note)` или `review` последнего сообщения агента; значение несёт `review: R` и вид агента этой отправки (Task 3 даёт его; до неё — без `agent`).
- Решённые обсуждения не отправляются и не ждут ответа.

- [ ] **Step 1: тесты** (`src/worker/review.test.ts`):

```ts
test('the notes file tells the whole thread and marks what is new', () => {
  /* note с сообщениями [user 'why?' sent r1, agent refuted 'no.' for r1, user 'still wrong' unsent→отправка r2]:
     notesFile содержит '## Thread aaaaaaaaaaaa', '[1] user, ', '[2] agent (refuted, fixed: no), ', '[3] user, ', ' — NEW, answer this:',
     ровно одно вхождение 'NEW, answer this', 'still wrong', и 'answers/<thread id>.md' в абзаце формы */
})
test('each send gets its own agent message', async () => {
  /* worker: add, send (r1), файл ответа r1 → list: [user, agent(r1)];
     reply, send (r2), файл ответа r2 → list: [user, agent(r1), user, agent(r2)], текст agent(r1) прежний;
     переписать файл r2 → меняется только последнее сообщение, его id прежний */
})
test('a resolved thread is not sent', async () => { /* resolve; notes.send с его id → ok false (reviewNothing) */ })
```

- [ ] **Step 2:** падают. **Step 3:** реализовать. **Step 4:** зелёные; `REVIEW_GUIDE` содержит обе новые строки дословно.
- [ ] **Step 5:** README, «Features»: обсуждение — сообщения по порядку, агент получает всю историю. Commit: `Give the agent the whole thread and put its answer in as the agent's message of that send`.

### Task 3: Тот же агент, иначе новый

**Files:**
- Modify: `src/worker/main.ts`, `src/worker/notes.ts`, `src/worker/review.test.ts`, `src/shared/protocol.ts`, `src/ui/api.ts`, `src/ui/notes.ts`, `src/shared/i18n.ts`, `orca-plugin.json` (capability `terminal:send`), `README.md`, `docs/git-safety.md`

**Interfaces:**
- Produces:

```ts
// protocol
/** The agent that got the repository's last send, when its terminal is open and it is free; null otherwise. */
'notes.agent': { input: { root: string }; output: { agent: string | null } }
'notes.send': { input: { root: string; ids: string[]; agent?: string }; output: { ok: true; review: string; to: 'same' | 'new' } | { ok: false; reason: string } }
// worker
export const agentKey = (root: string): string     // 'agent:' + sha256(root) hex → { root, terminalId, agent }
```

Правила worker'а:
- После успешной доставки хранится `{ root, terminalId, agent }`: для нового агента — `terminalId` из `agent.launch` и его вид; для прежнего — без изменений.
- «Прежний агент доступен»: `agents.list` (агенты активного workspace) содержит запись с этим `terminalId` и `state` `waiting` или `done`. Ошибка `agents.list` — недоступен.
- `notes.send`: шаги до пометки «отправлено» — как сейчас (папка, промпт, проверка промпта, `markSent`). Затем: прежний доступен — `terminal.sendText({ terminalId, text: prompt, enter: true })`; `accepted: false` или ошибка — откат (`markUnsent`, папка удаляется, запись `agent:<hash>` удаляется) и `{ ok: false, reason: t('reviewSameFailed') }`. Прежний недоступен: задан `agent` — `agent.launch`, как сейчас; не задан — откат и `{ ok: false, reason: t('reviewPickAgent') }`.
- Ответ: `to: 'same'` или `'new'`. Сообщение агента получает `agent` — вид того, кому ушла отправка (хранить вид рядом с отправкой: в сообщениях пользователя этой отправки поле `agent`).

Фрейм: перед меню отправки — `api.notesAgent(root)`. Прежний доступен: меню из одного-двух пунктов «{scope} → {agent}» (`notesSendSame`), без списка видов; иначе — прежнее меню видов. Отказ — как сейчас, под кнопкой.

Строки: `notesSendSame` — «{scope}: to the same agent ({agent})» / «{scope}: тому же агенту ({agent})»; `reviewSameFailed` — «The agent's terminal did not take the message. Send again to start a new agent.» / «Терминал агента не принял сообщение. Отправьте снова — запустится новый агент.»; `reviewPickAgent` — «The earlier agent is not free any more: pick an agent.» / «Прежний агент уже занят или закрыт: выберите агента.»

- [ ] **Step 1: тесты** (worker, `host()` с ответами `agents.list`, `terminal.sendText`, `agent.launch`):

```ts
test('the second send goes to the same agent while its terminal is open and it is free', async () => {
  /* первая отправка agent 'claude' → to 'new', launch вызван раз, terminalId 't-1';
     agents.list → [{ terminalId: 't-1', agent: 'claude', state: 'waiting', … }]; notes.agent → { agent: 'claude' };
     reply, send без agent → to 'same'; callsOf('terminal.sendText') === [{ terminalId: 't-1', text: <prompt>, enter: true }]; launch всё ещё один раз;
     prompt — одна строка без обратной кавычки */
})
test('a busy or closed agent means a new one', async () => {
  /* agents.list → state 'working' (и отдельный случай: пустой список): notes.agent → { agent: null };
     send без agent → ok false (reviewPickAgent), сообщения не отправлены, папки нет; send с agent 'codex' → to 'new', launch вызван с 'codex' */
})
test('a terminal that refuses the text rolls the send back', async () => {
  /* terminal.sendText → { accepted: false }: ok false (reviewSameFailed); сообщения без sentAt; папки отправки нет; notes.agent → { agent: null } */
})
```

- [ ] **Step 2:** падают. **Step 3:** реализовать; capability `{ "kind": "terminal:send" }`. **Step 4:** зелёные; `validate`, `check` — 0; стенд: прогон, где `notes.agent` отвечает `claude` — меню без видов, выбор пункта шлёт `notes.send` без `agent`.
- [ ] **Step 5:** README: «Features» — кому уходит следующая отправка; «Install» — право `terminal:send`; «Limitations» — печать в терминал: только активный workspace, вслепую. `docs/git-safety.md` — строка о `terminal.sendText` (что печатается, проверка промпта). Commit: `Send the next messages to the agent that answered, when its terminal is open and it is free, and to a new agent otherwise`.

### Task 4: Интерфейс обсуждения

**Files:**
- Modify: `src/ui/notes.ts`, `src/ui/notemodel.ts`, `src/ui/notemodel.test.ts`, `src/ui/styles.css`, `src/ui/dom.ts` (иконки), `src/shared/i18n.ts`, `README.md`

**Interfaces:**
- Consumes: Tasks 1–3 (`notes.reply|edit|resend|remove|resolve`, `stateOf`, `unsentOf`, `lastAnswer`).

Решения:
- Карточка обсуждения под строкой привязки, как сейчас. Сверху строка: метка состояния (`unsent` — «Не отправлено», `waiting` — «Отправлено, ответа нет», `answered` — вердикт последнего ответа и «Исправлено», `resolved` — «Решено», `idle` — без метки), справа кнопки-иконки: «Решено» (`check`) или «Открыть снова» (`undo`), «Удалить обсуждение» (`drop`).
- Сообщения по порядку. У сообщения: автор («Вы» или «Агент · {вид}»), время (как даты в панели: `relativeDate`), у агента — метки вердикта и «Исправлено»; текст через `mdDom`; справа кнопки-иконки: «Изменить» (только неотправленное пользователя), «Удалить сообщение». Сообщения агента отличаются фоном, без рамок между сообщениями.
- Под сообщениями активного обсуждения — поле ответа: свёрнуто в строку-кнопку «Ответить…»; нажатие открывает редактор (те же клавиши, что у первого сообщения). Сохранение — `notes.reply`.
- «Отправить снова» (`refresh`) — в строке состояния, когда состояние `waiting`.
- Решённое обсуждение свёрнуто: одна строка — метка «Решено», начало первого сообщения, число сообщений; нажатие разворачивает и сворачивает; развёрнутое показывает всё, без поля ответа, с кнопкой «Открыть снова». Поле ответа в решённом не показывается: сначала «Открыть снова».
- Открытый редактор (новое обсуждение, ответ или правка) — один на вкладку, с прежними правилами (набранный текст не теряется, переживает перерисовку).
- Список «Заметки»: строка на обсуждение — состояние, путь и строки, начало первого сообщения, число сообщений; решённые — в конце, приглушены. Счётчик на кнопке «Заметки» — активные обсуждения. «Копировать все» (`notesText`) выводит обсуждения с сообщениями и авторами.
- Кнопка отправки считает обсуждения в состоянии `unsent`.
- Весь текст — текстовыми узлами.

Строки: `noteYou` — «You» / «Вы»; `noteAgent` — «Agent · {agent}» / «Агент · {agent}»; `noteAgentPlain` — «Agent» / «Агент»; `noteReply` — «Reply…» / «Ответить…»; `noteResolve` — «Resolved» / «Решено»; `noteReopen` — «Open again» / «Открыть снова»; `noteDeleteThread` — «Delete the thread» / «Удалить обсуждение»; `noteDeleteMessage` — «Delete the message» / «Удалить сообщение»; `noteMessages` — `{ one: '{count} message', other: '{count} messages' }` / `{ one: '{count} сообщение', few: '{count} сообщения', many: '{count} сообщений', other: '{count} сообщения' }`. Прежние `noteReply` («Agent's answer») и `noteDelete` заменить и убрать неиспользуемые ключи.

- [ ] **Step 1:** тесты чистой логики в `src/ui/notemodel.test.ts`: `notesText` для обсуждения из трёх сообщений (авторы, порядок); счётчики активных и неотправленных.
- [ ] **Step 2:** реализовать интерфейс и стили.
- [ ] **Step 3: стенд** (новые прогоны, прежние не ломать): (а) обсуждение `[user, agent(refuted), user unsent]` — три сообщения по порядку, метка «Не отправлено», у третьего есть «Изменить», у первого нет; (б) «Ответить…» → текст → Enter шлёт `notes.reply` с этим текстом; (в) «Решено» шлёт `notes.resolve { resolved: true }`, обсуждение сворачивается в строку, нажатие разворачивает, «Открыть снова» шлёт `resolved: false`; (г) «Удалить сообщение» у ответа агента шлёт `notes.remove` с его id. Команды и вывод — в отчёт.
- [ ] **Step 4:** `orca plugin test .`, `validate`, `check`. README, «Features»: обсуждение, «Решено», удаление сообщений. Commit: `Show a review note as a thread: messages in order, a reply under them, Resolved and Open again, and a delete button on every message`.

### Task 5: Картинки в worker'е

**Files:**
- Create: `src/worker/images.ts`, `src/worker/images.test.ts`
- Modify: `src/worker/main.ts`, `src/worker/notes.ts`, `src/worker/review.ts`, `src/worker/review.test.ts`, `src/worker/skills.ts` (общий обход папки), `src/shared/protocol.ts`, `src/shared/notes.ts`, `docs/git-safety.md`

**Interfaces:**
- Produces:

```ts
// src/shared/notes.ts
export const MAX_IMAGE_BYTES = 5242880
export const MAX_IMAGES = 5
export const IMAGE_ID = /^[0-9a-f]{12}\.(png|jpg|gif|webp)$/

// protocol
'images.put': { input: { root: string; upload: string; index: number; last: boolean; data: string; name: string }; output: { ok: true; image?: NoteImage } | { ok: false; reason: string } }
'images.attach': { input: { root: string; path: string }; output: { ok: true; image: NoteImage } | { ok: false; reason: string } }
'images.browse': { input: { root: string; dir: string }; output: { dirs: string[]; files: string[] } }
'images.get': { input: { root: string; id: string; offset: number }; output: { data: string; total: number } }

// src/worker/images.ts
/** png, jpg, gif or webp by the first bytes; null for anything else. */
export function imageKind(bytes: Uint8Array): 'png' | 'jpg' | 'gif' | 'webp' | null
/** Stores the bytes as .orca-git-log/images/<12 hex of sha256>.<kind>; the same bytes give the same file. */
export function storeImage(root: string, bytes: Uint8Array, name: string): { ok: true; image: NoteImage } | { ok: false; reason: string }
export function readImage(root: string, id: string, offset: number, length: number): { data: Uint8Array; total: number } | null
/** Removes the files of `ids` that no note of `notes` uses. */
export function dropImages(root: string, ids: string[], notes: ReviewNote[]): void
/** The images an answer names: `![caption](file)` with a regular file right inside `answers`; each stored, at most MAX_IMAGES. */
export function answerImages(root: string, answers: string, body: string): NoteImage[]
```

Правила:
- `images.put`: части base64 по порядку (`index` с 0), собираются в памяти worker'а по `upload` (`/^[0-9a-f]{12}$/`); сумма больше `MAX_IMAGE_BYTES` или нарушен порядок — отказ и сброс этой загрузки; на `last` — `storeImage`. Одновременно не больше 4 незавершённых загрузок; загрузка старше 60 с сбрасывается при следующем запросе.
- `storeImage`: тип по `imageKind`, иначе `t('imageKind')`; размер, иначе `t('imageBig')`; папка `images` создаётся под настоящей `.orca-git-log` (как `writeReview`); существующий файл с тем же именем не переписывается. `name` — только последняя часть пути, без управляющих символов, до 200 символов.
- `images.attach`: путь как у скилов (полный, `~/…`, от корня); обычный файл (ссылки раскрываются, как выбор в файловом диалоге), размер проверяется до чтения.
- `images.browse`: подпапки и файлы с расширениями png, jpg, jpeg, gif, webp — общий с `browseSkills` обход с фильтром имени.
- `images.get`: `id` по `IMAGE_ID`; часть до 600000 байт с `offset`; `data` — base64.
- Сообщение: `draft.images` и `images` у `notes.reply` — до `MAX_IMAGES` записей `{ id, name }` от фрейма. Worker верит только `id` (по `IMAGE_ID`, файл существует в `images/`): `bytes` берёт из файла, `name` чистит (последняя часть пути, без управляющих символов, до 200 символов; пусто — `id`). Запись с плохим `id` — отказ `t('imageMissing', { path: id })`.
- Удаление сообщения или обсуждения вызывает `dropImages` для его картинок.
- `notes.md`: под сообщением с картинками — строка `Images: <полный путь>, <полный путь>`.
- `answerImages`: адрес из `![…](…)` — имя файла или путь; после разрешения относительно `answers` родитель файла — сама папка `answers` этой отправки, файл — обычный, не ссылка (`lstat`); иначе пропуск. Картинки ответа входят в сравнение `setAnswers`.

Строки: `imageKind` — «Only PNG, JPEG, GIF and WebP images can be attached.» / «Приложить можно только PNG, JPEG, GIF и WebP.»; `imageBig` — «The image is larger than 5 MiB.» / «Картинка больше 5 МиБ.»; `imageMany` — «At most 5 images per message.» / «Не больше 5 картинок на сообщение.»; `imageMissing` — «No such image file: {path}» / «Нет такого файла картинки: {path}»; `imageFailed` — «The image could not be saved: {error}» / «Не удалось сохранить картинку: {error}».

- [ ] **Step 1: тесты** (`src/worker/images.test.ts`; `PNG` — 8 байт подписи PNG и несколько байт данных):

```ts
test('the kind comes from the first bytes', () => { /* png, jpg (FF D8 FF), gif (GIF8), webp (RIFF....WEBP) → вид; текст и пустое → null */ })
test('the same bytes are stored once, under the hash of their content', () => {
  /* storeImage дважды: один файл images/<12hex>.png, id по IMAGE_ID, bytes === длина; name обрезан до последней части пути */
})
test('what is not an image, or is too large, is refused and nothing is written', () => { /* текст → imageKind; 5 МиБ + 1 байт → imageBig; папка images пуста или отсутствует */ })
test('a link in place of the folders is refused', () => { /* .orca-git-log — ссылка наружу; затем images — ссылка наружу: ok false, снаружи пусто */ })
test('an image goes in parts and comes back in parts', async () => {
  /* worker: images.put тремя частями (index 0,1,2; last на третьей) → image; images.get с offset 0 → data и total; склейка равна исходным байтам;
     часть не по порядку → ok false, следующая часть той же загрузки тоже ok false */
})
test('a file is kept while any message uses it', async () => {
  /* два сообщения с одной картинкой: notes.remove первого — файл на месте; notes.remove второго — файла нет */
})
test('an answer attaches only regular files right inside its answers folder', () => {
  /* answers/a.png (PNG) и answers/sub/b.png, ссылка answers/c.png → наружу, ../notes.md, текстовый d.png:
     answerImages(body со всеми пятью) → одна картинка (a.png) */
})
```

- [ ] **Step 2:** падают. **Step 3:** реализовать. **Step 4:** зелёные; `validate`, `check` — 0.
- [ ] **Step 5:** `docs/git-safety.md` — строки о записи и чтении `images/`. Commit: `Keep the images of review messages as files next to the review folders, checked by kind and size, and pass them between the tab and the worker in parts`.

### Task 6: Картинки во вкладке

**Files:**
- Create: `src/ui/images.ts`
- Modify: `src/ui/notes.ts`, `src/ui/api.ts`, `src/ui/notemodel.ts`, `src/ui/notemodel.test.ts`, `src/ui/styles.css`, `src/ui/dom.ts` (иконка `image`), `src/shared/i18n.ts`, `README.md`

**Interfaces:**
- Consumes: Task 5 (`images.put|attach|browse|get`), поле пути с подсказками из раздела «Скилы ревью» (`src/ui/notes.ts`).
- Produces:

```ts
// src/ui/notemodel.ts (чистое)
/** The parts a file of `bytes` bytes is sent in: [offset, length] of at most 45000 bytes each. */
export function uploadParts(bytes: number): [number, number][]
// src/ui/images.ts
/** Sends a pasted or picked file to the worker in parts. */
export function uploadImage(root: string, file: Blob, name: string): Promise<{ ok: true; image: NoteImage } | { ok: false; reason: string }>
/** A blob: URL of the image, read from the worker in parts and kept for the tab's life. */
export function imageUrl(root: string, id: string): Promise<string>
/** Opens the image over the tab; Esc or a press outside closes it. */
export function showImage(root: string, image: NoteImage): void
export function disposeImages(): void     // revokes the URLs
```

Решения:
- Редактор сообщения (новое обсуждение, ответ, правка) получает: вставку (`paste` с файлами-картинками в `clipboardData` — загрузка, остальное вставляется как текст), кнопку-иконку «Приложить файл» (`image`), открывающую поле пути с подсказками (тот же код, что у скилов: вынести общее поле пути), и ряд приложенных картинок с «×» у каждой. Отказ — под полем. Больше `MAX_IMAGES` — `t('imageMany')`.
- Правка сообщения сохраняет его картинки; менять их при правке нельзя.
- Сообщение показывает картинки рядом миниатюр (высота 96px) под текстом; `alt` и `title` — имя. Миниатюра — кнопка: нажатие или Enter открывает просмотр.
- Просмотр: слой поверх вкладки (класс `.overlay`, как у диалогов панели), картинка вписана в окно, под ней имя и размер; Esc, нажатие мимо картинки или кнопка «×» закрывают; фокус возвращается на миниатюру. Клавиши вкладки под слоем не работают (так уже устроено для `.overlay`).
- Картинка грузится один раз (`imageUrl` кеширует по id); пока грузится — рамка с именем; ошибка — имя текстом.
- Адрес картинки в тексте ответа (`![подпись](файл)`) остаётся текстом, как сейчас.

Строки: `imageAttach` — «Attach a file» / «Приложить файл»; `imagePath` — «Image path: png, jpg, gif or webp» / «Путь до картинки: png, jpg, gif или webp»; `imageRemove` — «Remove {name}» / «Убрать {name}»; `imageOpen` — «Open {name}» / «Открыть {name}»; `imageClose` — «Close» / «Закрыть».

- [ ] **Step 1:** тест `uploadParts`: `0 → []`, `45000 → [[0, 45000]]`, `45001 → [[0, 45000], [45000, 1]]`, `5242880` — 117 частей, сумма длин равна размеру.
- [ ] **Step 2:** реализовать.
- [ ] **Step 3: стенд** (заглушки `images.put`, `images.get` отдают байты маленькой PNG): (а) событие `paste` с файлом-картинкой в редакторе — `images.put` получает части, в редакторе появляется миниатюра, сохранение шлёт `notes.reply` с её id; (б) сообщение с картинкой — миниатюра с `src`, начинающимся на `blob:`; нажатие открывает `.overlay` с картинкой; Esc закрывает, фокус на миниатюре; (в) «Приложить файл» → путь → Enter шлёт `images.attach`. Команды и вывод — в отчёт.
- [ ] **Step 4:** `orca plugin test .`, `validate`, `check`. README, «Features»: картинки в сообщениях (вставка, файл, просмотр, форматы, предел), «Limitations»: вставка зависит от Orca. Commit: `Attach images to review messages by pasting or by path, show them as thumbnails and open one over the tab until Esc`.

### Task 7: Проверка целиком

- [ ] **Step 1:** `orca plugin test .`, типы, `validate`, `check`; концы строк новых файлов; три файла со смешанными концами строк без изменений.
- [ ] **Step 2:** в `docs/superpowers/specs/2026-11-15-review-notes-design.md` — строка статуса со ссылкой на дизайн обсуждений; в бэклоге — состояние.
- [ ] **Step 3 (контролёр, живая Orca, по согласию пользователя):** загрузка dev-плагина с новым одобрением (`terminal:send`); через `orca plugin dev request`: обсуждение, отправка, ответ, ответ пользователя, вторая отправка тому же агенту, картинка по пути, `images.get`; снимок вкладки. Вручную пользователь: вставка картинки, просмотр, «Решено».
- [ ] **Step 4:** версия `0.8.0` и выпуск — только с согласия пользователя.

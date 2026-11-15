# Кнопка Push рядом с Fetch — дизайн

Дата: 2026-11-15. Статус: решения приняты пользователем 2026-11-15 (один раунд вопросов), реализовано в 0.7.0.

## Зачем

Отправлять текущую ветку из панели, не уходя в терминал; Fetch уже есть.

## Решено пользователем

- Перед отправкой — диалог со списком коммитов, как Push в WebStorm.
- Ветка без upstream публикуется: в диалоге выбрать remote (если их несколько) и имя на сервере; push ставит upstream.
- Сервер отказал из-за коммитов, которых нет локально (non-fast-forward): баннер предлагает force push with lease.
- После готовности — релиз 0.7.0 и установка.

## Мои решения

- Иконка Lucide `arrow-up` (у Fetch `arrow-down`), клавиша `Shift+K` (как Ctrl+Shift+K в WebStorm).
- Куда: туда, куда отправил бы обычный `git push` (push.default, remote.pushDefault, branch.<name>.pushRemote); имя ветки на сервере — из `%(push)`, иначе из upstream того же remote. Без цели — публикация в remote.pushDefault, иначе `origin`, иначе первый remote.
- Отправляется ровно тот коммит, для которого диалог показал список: если ветка сдвинулась, push отклоняется.
- Force push: lease на коммит удалённой ветки по последнему fetch; подтверждение со списком коммитов, которые пропадут с сервера, и предложением бэкапа (настройка `offerBackup`) на этот коммит. Устарел lease — отказ без перезаписи.
- Как Fetch: блокировка репозитория, таймаут 100 с, поздний результат после таймаута Orca. Запрещено при detached HEAD и незаконченном rebase/merge/cherry-pick/revert.
- Не делаем: отправку тегов (кроме `push.followTags` самого git), выбор других веток, force без lease.

## Где

`src/worker/push.ts` (`checkPush`, `runPush`), `push.test.ts`; `src/ui/dialogs.ts` (`pushDialog`, `forcePushWarning`), `src/ui/app.ts` (`push`, `forcePush`, `networkRun`); строки 65–67 в `docs/git-safety.md`.

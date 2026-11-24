# Русский (ru): glossary of decisions

Register: neutral, polite «вы» (rarely needed); buttons and tooltips are short imperatives or infinitives
("Сохранить", "Отмена", "Копировать"), labels are nouns. Quotes « », dash —, ё always written.

Plural forms: `_one`, `_few`, `_many`, `_other` for every English plural key. Count-texts whose grammar changes
are split too: `overview.headline.waiting_*` ("{{count}} ждёт / ждут вас"). A `_one` form without `{{count}}`
(`ticketBoard.decisions_one`, `roadmap.stat.*_one`) stays without it; 21, 31... then read "нужно решение".

Kept in English (Latin letters, never inflected): PR, CLI, MCP, worktree, workspace, checkout, tailnet, Funnel,
serve, passkey only inside "(passkey)", job, SHA, builder/spec/runner/intent/maker (agent names), CI, HTTPS.
Cyrillic loanwords: тикет, лейн, превью, коммит, токен, скилл, промпт, бэклог, воркер, ревью, фича, вебхук.

| English                 | Russian                         |
| ----------------------- | ------------------------------- |
| ticket, lane            | тикет, лейн                     |
| stage                   | этап                            |
| task, subtask           | задача, подзадача               |
| post, update            | запись, обновление              |
| comment, reply          | комментарий, ответ              |
| summary                 | сводка                          |
| review (noun)           | ревью                           |
| report, Daily report    | отчёт, «Отчёт дня»              |
| preview                 | превью (neuter, invariable)     |
| branch, commit          | ветка, коммит                   |
| merge (noun / verb)     | слияние / влить                 |
| push (verb), unpushed   | отправить, не отправлено        |
| run                     | запуск (запустить, остановить)  |
| build                   | собрать, сборка                 |
| passkey                 | ключ доступа                    |
| sign in / out           | войти / выйти; "Вход"           |
| needs you               | «Ждёт вас»                      |
| in progress, blocked    | в работе, заблокировано         |
| done                    | готово                          |
| on hold                 | на паузе                        |
| assignee                | исполнитель                     |
| worker, orchestrator    | воркер, оркестратор             |
| Roadmap, Cleanup, Team  | Дорожная карта, Уборка, Команда |
| keep / clear (a filter) | оставить / сбросить             |
| remove / delete         | убрать / удалить                |
| this computer           | этот компьютер                  |

Unsure about: `prQueue.empty.*` (the stage word is a lowercased tab label, so the sentence puts it in
parentheses); `workStatus.state.noWord` ("Без вестей") and `workTimeline.story.lock` ("блокировка") since the
meaning is guessed from context; palette keywords mix Russian with a few English words so both searches work.

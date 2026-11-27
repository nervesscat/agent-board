# Ukrainian (uk): glossary of decisions

Register: polite "ви" in sentences, imperative on buttons and tooltips ("Зберегти", "Скасувати" as infinitive
labels, "Виберіть…" in prose). Sentence case. Quotes « », apostrophe ’ (U+2019) everywhere (рев’ю, прев’ю, комп’ютер).

| English                                 | Ukrainian                                 |
| --------------------------------------- | ----------------------------------------- |
| board, project, agent                   | дошка, проєкт, агент                      |
| orchestrator, worker                    | оркестратор, виконавець                   |
| ticket                                  | тікет (kept as a Cyrillic loanword)       |
| lane                                    | доріжка                                   |
| stage                                   | етап                                      |
| task, subtask                           | завдання, підзавдання                     |
| post, update                            | допис, оновлення                          |
| comment, reply                          | коментар, відповідь                       |
| summary, report                         | підсумок, звіт                            |
| review (noun)                           | рев’ю (indeclinable)                      |
| PR                                      | PR (Latin, indeclinable)                  |
| preview                                 | прев’ю (indeclinable)                     |
| commit, branch, merge                   | коміт, гілка, злиття (verb: злити)        |
| worktree, checkout                      | worktree, checkout (kept in Latin)        |
| workspace                               | робоча область                            |
| token, webhook, prompt                  | токен, вебхук, промпт                     |
| passkey                                 | ключ доступу                              |
| skill                                   | навичка                                   |
| tailnet, Funnel, CLI, MCP               | kept in Latin                             |
| settings, sign in/out                   | налаштування, вхід / вийти                |
| needs you                               | чекає на вас                              |
| in progress, blocked, done              | у роботі, заблоковано, готово             |
| on hold                                 | на паузі                                  |
| run                                     | запуск (start: запустити, stop: зупинити) |
| push (verb), unpushed                   | надіслати, не надіслано                   |
| keep / clear (filter) / remove / delete | залишити / скинути / прибрати / видалити  |
| Daily, Overview, Cleanup, Roadmap       | Щодня, Огляд, Очищення, Дорожня карта     |

Plurals: one / few / many / other everywhere an English plural key exists. Count texts split into four forms:
`overview.headline.waiting` ("чекає / чекають").

Unsure: `ticketBoard.decisions_one` and `roadmap.stat.*_one` have no count in the English `_one`, so
they are used for 21, 31... as well (grammatically slightly off, count shown elsewhere). The Ukrainian
"one" form of `ticketBoard.decisions` ("потрібне рішення") therefore reads oddly at 21.
`reports.scheduleWeekly` ("щотижня: {{day}}") avoids the Spanish-style "on Mondays" inflection.

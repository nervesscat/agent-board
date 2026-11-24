# Polish (pl)

Register: second person kept neutral and mostly impersonal ("Wybierz", "Kliknij, aby edytować"); buttons and
tooltips in the imperative ("Zapisz", "Zatrzymaj podgląd"); "ty" only in lower case where it cannot be avoided.
Quotes are „ ”. Sentence case, like the English.

Plural forms used: `_one`, `_few`, `_many`, `_other` for every English plural key (one: 1; few: 2-4, 22-24..;
many: 0, 5-21, 25-31..; other: fractions). Counts whose grammar changes are split in the same way
(`overview.headline.waiting`: "czeka / czekają"). Where the sentence only needs the count in a fixed place, the
construction "etykieta: {{count}}" is used for all forms ("zablokowane: {{count}}").

| English                      | Polish                                                                                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| board                        | tablica                                                                                                                                                                                            |
| ticket                       | zgłoszenie (zgłoszenia / zgłoszeń)                                                                                                                                                                 |
| lane (sub-ticket)            | ścieżka                                                                                                                                                                                            |
| stage                        | etap                                                                                                                                                                                               |
| task, subtask, phase         | zadanie, podzadanie, faza                                                                                                                                                                          |
| post, update, comment, reply | wpis, aktualizacja, komentarz, odpowiedź                                                                                                                                                           |
| summary, report              | podsumowanie, raport                                                                                                                                                                               |
| review (noun, verb)          | recenzja, recenzować                                                                                                                                                                               |
| Overview                     | Przegląd                                                                                                                                                                                           |
| preview                      | podgląd                                                                                                                                                                                            |
| run                          | uruchomienie                                                                                                                                                                                       |
| branch                       | gałąź                                                                                                                                                                                              |
| merge (verb, noun)           | scalić, scalenie                                                                                                                                                                                   |
| workspace                    | obszar roboczy                                                                                                                                                                                     |
| passkey                      | klucz dostępu                                                                                                                                                                                      |
| needs you                    | czeka na ciebie                                                                                                                                                                                    |
| Cleanup                      | Porządki                                                                                                                                                                                           |
| push (verb)                  | wypchnąć ("wypchnięte", "niewypchnięte")                                                                                                                                                           |
| Kept in English              | PR (PR-y, PR-ów), commit (commity, commitów), worktree, checkout, token, webhook, skill, CLI, tailnet, Funnel, prompt, tag, job, heartbeat, span, lease, origin, builder/spec/runner/maker, claude |

Not translated on purpose: product and agent role names `spec`, `builder`, `runner`, `env`, `verify`, `hunt`,
`refute`, `merge`, `intent`; the orchestrator and worker roles are "orkiestrator" and "worker".

Unsure about:

- "ticket" is "zgłoszenie" everywhere; many Polish developers say "ticket", but one word was chosen.
- "worktree" is kept and avoided in inflected positions; "obszar roboczy" is the translation of "workspace".
- `runReport.section.*` follows the English sentence closely; some read as headings of a report.
- Palette keywords are Polish words only (no English synonyms), so searching "ticket" will not find "zgłoszenie".

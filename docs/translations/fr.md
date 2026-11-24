# Français (fr)

Register: vous (never tu), buttons and menu items in the infinitive ("Enregistrer", "Ajouter une tâche"), tooltips
in the infinitive too, as GitHub and GitLab do in French. Sentence case.

Typography: a no-break space (U+00A0) before `:`; a narrow no-break space (U+202F) before `;` `?` `!` `%` and
inside « ». Apostrophes are typographic (’). Weekday names are lowercase ("lundi"), as they follow "le".

| English                                                                                                                                                                | French                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| ticket, lane, PR, preview, commit, worktree, workspace, checkout, token, webhook, CLI, skill, passkey, tailnet, Funnel, prompt, job, backlog, Roadmap, heartbeat, span | kept (preview, PR and lane feminine; merge masculine)   |
| merge (noun) / merge (verb)                                                                                                                                            | merge / fusionner ("fusionnée" for a PR)                |
| branch                                                                                                                                                                 | branche                                                 |
| board, project, agent, stage                                                                                                                                           | tableau, projet, agent, étape                           |
| orchestrator, worker                                                                                                                                                   | orchestrateur, worker (kept)                            |
| task, subtask                                                                                                                                                          | tâche, sous-tâche                                       |
| post, update                                                                                                                                                           | publication, mise à jour                                |
| comment, reply, summary                                                                                                                                                | commentaire, réponse, résumé                            |
| review (noun), report                                                                                                                                                  | revue, rapport                                          |
| settings                                                                                                                                                               | Paramètres                                              |
| sign in / sign out                                                                                                                                                     | Se connecter / Se déconnecter                           |
| device, repository, attachment                                                                                                                                         | appareil, dépôt, pièce jointe                           |
| search, save, cancel                                                                                                                                                   | Rechercher, Enregistrer, Annuler                        |
| delete, remove                                                                                                                                                         | Supprimer (data), Retirer (list entries, repos, tokens) |
| Needs you                                                                                                                                                              | À traiter (a tile); "vous attend" for a state           |
| To do / In progress / Blocked / Done                                                                                                                                   | À faire / En cours / Bloqué / Terminé                   |
| run                                                                                                                                                                    | exécution (lancer, arrêter)                             |
| keep, clear                                                                                                                                                            | Conserver, Effacer                                      |
| push / unpushed                                                                                                                                                        | pousser / non poussé                                    |
| build (verb) / on hold                                                                                                                                                 | compiler / en pause                                     |
| assigned to, this computer                                                                                                                                             | assigné à, cet ordinateur                               |
| Overview (page)                                                                                                                                                        | Aperçu général                                          |
| Daily                                                                                                                                                                  | Quotidien                                               |
| Team                                                                                                                                                                   | Équipe                                                  |
| lease, shift, hand-off                                                                                                                                                 | bail, service, remise                                   |
| Stalled, Lost contact                                                                                                                                                  | Au point mort, Contact perdu                            |

Plurals: `_one` and `_other` (French `one` covers 0 and 1). Keys with `{{count}}` but no plural suffix in English
became `_one`/`_other` where the adjective agrees: `overview.headline.doneToday`, `overview.needsYou.newReplies`,
`overview.next.blocked`.

Unsure: the palette search keywords mix French and English terms on purpose, so both find the page;
`prQueue.empty.*` reads "Aucune PR à revoir (en attente)." because the stage word is inserted by the app;
"Sans nouvelles" for "No word"; "Calme" for "Quiet". The desktop `restartedTimes_one` and `_other` are the same text.

# Turkish (tr) glossary

Natural Turkish for a developer tool, addressed informally (sen, imperative: "Kaydet", "Seç"). Sentences are written so a
suffix never attaches to a `{{placeholder}}`: the placeholder stays a separate word ("{{name}} aşamasını sil", "Geç: {{name}}").
Capitals follow Turkish casing (İ/ı): İptal, İnceleme, İndir.

## Kept in English (Latin letters, as Turkish developers say them)

ticket (ticket'lar, ticket'ın), lane, PR, preview, commit, branch, merge ("merge et"), push ("push edildi"), worktree,
workspace, checkout, token, webhook, CLI, skill, passkey, tailnet, Funnel, orchestrator, worker, job, builder/spec/runner,
backlog, heartbeat, span, rebase, cherry-pick, stash, SHA. Suffixes follow with an apostrophe (preview'lar, token'ı).

## Translated

| English                            | Turkish                            |
| ---------------------------------- | ---------------------------------- |
| board                              | pano                               |
| project / repository               | proje / repo                       |
| agent                              | ajan                               |
| stage                              | aşama                              |
| task, subtask                      | görev, alt görev                   |
| phase                              | faz                                |
| post, update                       | gönderi, güncelleme                |
| comment, reply                     | yorum, yanıt                       |
| summary / report                   | özet / rapor                       |
| review                             | inceleme                           |
| settings                           | ayarlar                            |
| sign in / sign out                 | oturum aç / oturumu kapat          |
| device / attachment / notification | cihaz / ek (dosya ekle) / bildirim |
| save, cancel                       | kaydet, iptal                      |
| delete, remove                     | sil, kaldır                        |
| revoke                             | geçersiz kıl                       |
| keep                               | sakla                              |
| clear (filter)                     | temizle                            |
| needs you                          | seni bekliyor                      |
| needs (ticket dependency)          | bağımlı                            |
| in progress / blocked / done       | sürüyor / engelli / bitti          |
| run (noun)                         | çalıştırma                         |
| build                              | derle                              |
| on hold                            | beklemede                          |
| this computer                      | bu bilgisayar                      |
| disapprove                         | reddet                             |
| live board / data                  | canlı pano / veri                  |

## Plural forms

`_one` + `_other` (Intl.PluralRules('tr')). A noun is not pluralised after a number, so both forms read the same
("{{count}} ticket"), but both are present. `_one` texts without `{{count}}` stay without it.

## Unsure

- "Revoke" as "geçersiz kıl" is long for buttons; "iptal et" was avoided because it collides with Cancel.
- "Needs" (dependency between tickets) as "bağımlı": the column labels "Bağımlı olduğu / bağımlı olanlar" are wordy.
- Palette keywords mix Turkish and English search terms on purpose.
- Composed timeline sentences (`workTimeline.label.*`, `story.*`) use "·", "-" and "→" instead of grammar that would need suffixes.

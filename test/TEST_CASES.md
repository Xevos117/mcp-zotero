# Casi di test per tool — mcp-zotero

Suite aggiunta in `test/` (i test storici restano in `src/**/*.test.ts`).

| Comando | Cosa esegue | Durata indicativa |
|---|---|---|
| `npx vitest run` (= `npm test`) | unit: `src/**` + `test/tools/**` + `test/utils/**` + `test/skills/**` (~1000 casi) | ~10 s |
| `npm run test:e2e` | `npm run build`, poi `test/e2e/**` con `vitest.e2e.config.ts` | ~4 s + build |
| `npm run smoke` | server compilato su stdio, libreria utente e di gruppo, fetch simulata; controllo strutturale del docx | ~2 s |
| `npm run test:live` | `npm run build`, poi `test/live/**/*.live.test.ts` con `vitest.live.config.ts` contro un account Zotero reale (solo con `ZOTERO_TEST_API_KEY`, vedi sezione LIVE) | ~2-3 min |
| agente smoke | workflow `claude-agent-smoke.yml` (dopo la suite dal vivo) o `/test-mcp-zotero` in locale (sezione "Agente smoke") | ~1-5 min |
| checklist Word | a mano a ogni release (`test/WORD_CHECKLIST.md`) | ~15 min |

Timeout: unit `testTimeout`/`hookTimeout` 10 s (`vitest.config.ts`); e2e 60 s, ogni chiamata MCP 15 s,
processo server ucciso con SIGKILL se ancora vivo 5 s dopo la chiusura.

## Come funzionano

- **Harness MCP in-process** (`test/helpers/mcp-harness.ts`): `McpServer` reale con `registerAllTools`,
  `Client` reale via `InMemoryTransport`, `zotero-api-client` reale. Si sostituisce soltanto `fetch`
  (`test/helpers/fake-net.ts`): ogni richiesta viene registrata e quelle senza route falliscono, quindi
  la rete reale non viene mai raggiunta. Le asserzioni guardano il risultato che vede il client MCP
  (`isError`, testo/JSON) e le richieste HTTP prodotte (metodo, path, query, header, body).
- **Fake Zotero** (`test/helpers/zotero-fake.ts`): risposte in formato Web API v3, allineate al comportamento
  osservato dal vivo su api.zotero.org (vedi l'intestazione del file). `zLibraryQuery`: con `itemKey` pagina di
  min(N, 100) item e `Total-Results` = N, nessun rifiuto oltre 50 chiavi, HTTP 500 se l'URL supera 4000 caratteri;
  senza `itemKey` `limit` 25 di default, 100 al massimo; `start`. `zCollectionNotFound`: 404 text/plain
  "Collection not found". `zSingle`: `Last-Modified-Version` = versione dell'item.
- **E2E** (`test/e2e/`): avvia `node --import test/e2e/fetch-redirect.mjs build/server.js` su stdio.
  Il preload reindirizza ogni fetch esterna verso un proxy HTTP locale servito dalla stessa FakeNet.
  L'endpoint di zotero-api-client non è configurabile, ma il client usa il `fetch` globale, quindi
  l'intercettazione funziona senza modificare il codice di produzione.
- **Versioni**: i test non dipendono dal testo dei messaggi zod/SDK. Su un errore di validazione
  controllano solo `isError` e la presenza del nome del campo. Gli errori che l'SDK rilancia come
  JSON-RPC invece di restituirli come `CallToolResult` vengono normalizzati in `isError: true`.
- **Libreria**: i test per tool usano la libreria utente di default (nessuna variabile `ZOTERO_LIBRARY_*`);
  le asserzioni richiedono path `/users/{USER_ID}/...` (costante `ZBASE`). La firma di `registerAllTools`
  è usata in un solo punto (`startHarness`). Le librerie di gruppo sono coperte dagli e2e in
  `test/e2e/group-library.e2e.test.ts`, da GUI-06/07, TL-08, H-19 e dai test unitari della PR #7 in `src/`.
- **Errore strutturato** = risposta di `formatErrorResponse`: JSON `{ "error": ... }` con `isError: true`
  (helper `expectErrorJson`). **Risultato vuoto** = nessun dato trovato (ricerca o collezione vuota):
  `formatEmptyResult`, JSON `{ "message": ... }` senza `isError` (helper `expectEmptyResult`). **Errore duro** = il tool lancia un'eccezione e l'SDK la converte in
  `isError: true`. Un successo parziale (es. `add_items` con alcuni `failed`) non è un errore: `isError` assente.

### Bug corretti in PR #8 (ex `it.fails`)

Questi casi erano `it.fails` con prefisso `BUG`; sono stati corretti nel codice di produzione e ora sono
test normali. Non restano `it.fails` nella suite.

| ID | Problema originale | Correzione |
|---|---|---|
| GID-09/10, FA-22/25 (+DI-09 regressione) | GET per `itemKey` con tutte le chiavi e senza `limit`: oltre 100 chiavi gli item in più andavano persi (pagina massima dell'API), con centinaia di chiavi HTTP 500 per URL troppo lungo | `fetchItemsByKeys` (src/utils/pagination.ts): blocchi da 50 con `limit` esplicito |
| AI-09 | risultati della scrittura associati per posizione tra i soli successi: key/title all'item sbagliato | `postInBatches` (src/utils/write-results.ts): mapping per indice di richiesta |
| AI-10, CC-07, ALU-06 | errori `{key,code,message}` come oggetto grezzo o `"[object Object]"` (anche in pdf-uploader) | `formatWriteError`/`formatWriteErrors`: `"code: message"` |
| AI-13 (+AI-13b), AID-12b | >50 oggetti → 413 sull'intera richiesta | `postInBatches`: batch da 50, indici dell'input originale |
| AID-12 | scrittura parziale trattata come totale: item creati non riportati | `success` con i creati, `failed` con DOI non risolti e rifiutati |
| IP-23 | `size_bytes: 0` dopo l'estrazione (unpdf fa il detach dell'ArrayBuffer) | `extractPdfText` passa a unpdf una copia |
| FA-20 | task `rejected` scartati: item assente da `results` e contatori | `settledValues` (src/utils/concurrency.ts): risultato `error` per item |
| IC-20 | `replace(".docx", …)` sulla prima occorrenza del path | `path.parse`/`path.format` sul basename |
| H-02 e tutti gli errori strutturati | `formatErrorResponse` senza `isError` | `isError: true`; i risultati vuoti restano senza `isError` (`formatEmptyResult`, H-02b) |

---

## search_library (`test/tools/search-library.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| SL-01 | query | GET /items `q`, sort=dateAdded, direction=desc, limit=25, API key; lista formattata con dateAdded |
| SL-02 | senza query | nessun `q` |
| SL-03 | query di soli spazi / con spazi | `q` omesso / trimmato |
| SL-04 | limit 500 | limit=100 |
| SL-05 | sort=title, asc, limit 5 | parametri inoltrati; nessun dateAdded |
| SL-06/07 | risultato vuoto con/senza query | risultato vuoto (`message`, non isError) "No results found" (con query) / "No items found"; `suggestion` con cosa provare (titolo/autore/anno, senza query) / come aggiungere voci |
| SL-08 | query/titoli unicode | `q` decodificato identico, unicode preservato |
| SL-09/10 | metadati mancanti, creator senza nome | fallback Untitled / No authors listed / No date |
| SL-11 | sort, direction, limit (stringa, 0, negativo, non intero), query non validi | isError con il nome del campo, nessuna chiamata HTTP |
| SL-12 | HTTP 403/404/412/429/500/503 | errore strutturato da `runTool`: `error` con "HTTP N", `http_status`, `hint` con il passo successivo |
| SL-13 | errore di rete | errore strutturato "Network error: …ENOTFOUND…", `hint` (riprova, poi connessione della macchina del server) |
| SL-14 | creator istituzionale (solo `name`) | nella stringa `authors` (prima: "No authors listed", trovato dall'agente smoke; corretto nel livello 3b) |
| SL-15 | 403 con corpo "Invalid key" | `details` "Invalid key"; `hint`: riprovare non serve, pagina zotero.org/settings/keys, ZOTERO_API_KEY nelle impostazioni del server, riavvio del client; nessuna chiave né URL dell'API nel testo |
| SL-16 | 429 con Retry-After: 12 | `retry_after_s` 12, `hint` "Wait 12 s and retry once…" |

## get_collections (`get-collections.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| GC-01 | lista | JSON delle collezioni; limit=100, start=0 |
| GC-02 | 250 collezioni | 3 pagine (start 0/100/200), 250 risultati |
| GC-03 | Total-Results gonfiato | si ferma alla pagina vuota, nessun loop |
| GC-04 | Total-Results assente | solo la prima pagina |
| GC-05 | collezioni nel cestino | escluse di default, incluse con include_trashed |
| GC-06/07 | tutte nel cestino / nessuna | risultato vuoto (suggestion include_trashed=true o create_collection / helpUrl, search_library e create_collection) |
| GC-08 | nomi unicode | preservati |
| GC-09 | include_trashed non booleano | isError |
| GC-10/11/12 | HTTP 4xx/5xx, errore sulla 2ª pagina, errore di rete | errore strutturato con `http_status` e `hint` (rete: "Network error") |

## get_collection_items (`get-collection-items.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| GCI-01 | item completo | total/returned + campi (tags, doi, url, publicationTitle) |
| GCI-02/03 | allegati e note | esclusi di default (total_items = Total-Results), inclusi con excludeAttachments=false |
| GCI-04 | item minimale | fallback |
| GCI-05/06 | vuota / solo allegati | risultato vuoto status `empty` (suggestion: sottocollezioni non incluse, collection_key negli add_*) / `invalid_items` (suggestion: excludeAttachments=false) |
| GCI-07 | 230 item | 3 pagine |
| GCI-08 | 404 | errore strutturato "Collection not found…" `not_found`, suggestion get_collections |
| GCI-09/10 | HTTP 403/412/429/500/503, rete | errore strutturato con `http_status` e `hint` |
| GCI-11 | unicode | preservato |
| GCI-12..14 | collectionKey mancante o non stringa, excludeAttachments non booleano | isError |
| GCI-15 | autore istituzionale (solo `name`) | nella stringa `authors` |

## get_items_details (`get-items-details.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| GID-01 | 2 chiavi | una sola GET `itemKey=A,B`; mappa chiave → campi specifici del tipo |
| GID-02 | abstract | escluso di default, incluso con include_abstract |
| GID-03 | campi strutturali/vuoti | omessi |
| GID-04/05 | `[]` / nessun item | errore strutturato che dice dove prendere le chiavi (nessuna chiamata HTTP) / risultato vuoto con le chiavi richieste e suggestion |
| GID-06 | chiavi in parte inesistenti (anche ripetute) | voci trovate più `not_found` con le mancanti (senza doppioni), senza isError |
| GID-17 | tutte le chiavi trovate | nessun campo `not_found` |
| GID-07/08 | fallback, unicode | ok |
| GID-09/10 | 120 chiavi, 482 chiavi | tutte restituite (GET a blocchi da 50 con limit 50/50/20; nessun 500 per URL lungo) |
| GID-11 | 20 chiavi | una GET, tutte restituite |
| GID-12 | item_keys mancante/stringa/numeri, include_abstract non booleano | isError |
| GID-13/14 | HTTP 4xx/5xx, rete | errore strutturato con `http_status` e `hint` |
| GID-15 | creators strutturati (cognomi multiparola, editor istituzionale) | `creators` come in Zotero accanto ad `authors` (che ora include anche il nome istituzionale); assente se vuoto |
| GID-16 | chiavi malformate / risposta con voci non richieste | errore di validazione senza richieste / solo le voci richieste (le altre in `not_found`) |

## get_item_fulltext (`get-item-fulltext.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| GIF-01 | item padre | item → children → /fulltext con API key; text/characters/pages |
| GIF-02 | chiave di un allegato PDF | nessuna richiesta children |
| GIF-03/04/05 | max_characters 100 / 0 / default | troncato / nessun limite / 50000 |
| GIF-06 | figli misti | primo PDF (ignora HTML e note) |
| GIF-07 | unicode | characters = lunghezza della stringa JS |
| GIF-08 | fulltext 404 | errore strutturato "not indexed… Retrying now will not help", `hint` per l'utente (aprire il PDF in Zotero desktop o Reindex Item, sincronizzare; PDF scansionati) |
| GIF-09 | fulltext 403/429/500/503 | errore strutturato "status N" con "HTTP N" e `hint` (403: chiave; altri: riprova) |
| GIF-10 | fulltext, errore di rete | errore strutturato "Network error: …socket hang up" |
| GIF-11/12/13 | nessun PDF: senza URL / con URL / webpage o blogPost | messaggi dedicati (11/12: find_and_attach_pdfs o import_pdf_to_zotero, poi di nuovo) |
| GIF-14 | item 404 | errore strutturato "Item not found in this library", `hint` search_library |
| GIF-15/16/17 | item HTTP 4xx/5xx, children 500, rete | errore strutturato con `http_status` e `hint` |
| GIF-18 | ZOTERO_API_KEY assente | errore strutturato con `hint` (chiave da zotero.org/settings/keys nelle impostazioni del server), nessuna chiamata HTTP |
| GIF-19 | item_key mancante o non stringa, max_characters stringa, negativo o non intero (0 resta "nessun limite") | isError |
| GIF-20 | solo un allegato linked_url con contentType PDF | errore con "linked URL", attachment_key e url del link (aprirlo con un tool web o import_pdf_to_zotero), nessuna GET fulltext |
| GIF-21 | link elencato prima di un PDF importato | usa il PDF importato |
| GIF-22 | chiave di un allegato linked_url | errore con "linked URL" e url, nessuna GET fulltext |
| GIF-23 | fulltext 200 con HTML, corpo vuoto o JSON non oggetto | isError "Zotero fulltext API: response is not a JSON object (HTTP 200, text/html)", mai l'errore grezzo di JSON.parse |

## get_user_id (`get-user-id.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| GUI-01..03 | normale / argomenti extra / "0012345" | `{user_id}` verbatim, nessuna chiamata HTTP |
| GUI-04 | user id "" | isError "library ID is not set" (passare library_id o far impostare ZOTERO_USER_ID all'utente), nessuna chiamata HTTP |
| GUI-05 | tools/call senza `arguments` | successo (corretto nell'SDK 1.32; era BUG con 1.27) |
| GUI-06 | libreria utente | `{user_id, library_type: "user", library_id, library_path: "users/{id}"}` |
| GUI-07 | `ZOTERO_LIBRARY_TYPE=group`, id 777 | `user_id` da `ZOTERO_USER_ID`, `library_path: "groups/777"` |

## create_collection (`create-collection.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| CC-01/02/03 | nome, parent, spazi | POST `[{name, parentCollection?}]`, nome trimmato |
| CC-04 | "", "   ", "\t\n" | errore strutturato, nessuna POST |
| CC-05 | unicode | round-trip |
| CC-06 | scrittura `failed` | errore strutturato "Failed to create collection", `hint` sul parent_collection (get_collections) |
| CC-06b | scrittura `failed` senza parent | `hint` sul nome |
| CC-07 | details | contiene il messaggio del server ("code: message") |
| CC-08 | name mancante/numero, parent numero | isError |
| CC-09/10 | HTTP 403/404/412/413/429/500/503, rete | errore strutturato con `http_status` e `hint` |

## add_items (`add-items.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| AI-01 | book | payload esatto (creatorType "author" di default, collections/tags `[]`), risultato per item |
| AI-02 | batch di tipi misti | una POST, chiavi in ordine |
| AI-03 | case/email/statute | title → caseName/subject/nameOfAct |
| AI-04 | collection_key + tags | applicati a tutti |
| AI-05 | url senza accessDate | accessDate di oggi; quello esplicito resta |
| AI-06 | film director + name istituzionale | creators corretti |
| AI-07 | unicode | round-trip |
| AI-08 | fallisce l'ultimo indice | success/failed corretti, messaggio presente |
| AI-09/10 | fallisce il primo indice; error come stringa | mapping per indice, non isError; "400: Invalid date" |
| AI-11 | tutti falliti | errore strutturato "All items failed to create", `hint` (niente creato, correggere secondo failed[].error) |
| AI-12 | 50 item | una POST con 50 oggetti |
| AI-13 | 60 item | POST da 50 + 10, indici 0..59, 60 chiavi distinte |
| AI-13b | fallimento nel 2º batch | failed con indice 55 e titolo dell'input originale |
| AI-14 | items mancante/vuoto, itemType, title, campo non valido per il tipo, creatorType, creator incompleto, campo non stringa, tags, collection_key | isError con il nome del campo |
| AI-15/16 | HTTP 4xx/5xx/413, rete | errore strutturato con `http_status` e `hint` |

## add_items_by_doi (`add-items-by-doi.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| AID-01 | DOI valido | GET doi.org con Accept CSL; item convertito (tipo, creators, publicationTitle) |
| AID-02 | senza UNPAYWALL_EMAIL | pdf_results con warning breve, `hint` unico (cosa dire all'utente, dove impostarla, riavvio), nessuna chiamata a Unpaywall |
| AID-03 | auto_attach_pdf=false | niente pdf_results |
| AID-04 | collection_key/tags | nel payload |
| AID-05 | **DOI non trovato** (404) su 1 di 2 | l'altro viene creato; il primo in failed con 404 |
| AID-06 | tutti falliti (404 + rete) | errore strutturato con `hint` (DOI nudi, add_items, riprovare dopo errori di rete), nessuna POST |
| AID-07 | doi.org 429 + Retry-After 0 | nuovo tentativo, successo |
| AID-08 | doi.org 500 | in failed, nessun retry |
| AID-09 | DOI con `<>();` e titolo unicode | codificato nell'URL, round-trip |
| AID-10 | `[]` | errore strutturato, nessuna chiamata HTTP |
| AID-28 | DOI `""`, `"   "`, tab | errore di validazione "DOI must not be empty", nessuna chiamata HTTP |
| AID-29 | DOI con spazi attorno | ripulito prima della risoluzione |
| AID-30 | doi.org risponde 200 con HTML, corpo vuoto o `null`; 404 con HTML | per quel DOI "DOI not found or not resolvable: … (response is not a JSON object (HTTP 200, text/html))" / "DOI resolution failed … 404 (DOI not registered or mistyped)"; l'altro DOI creato; mai "Unexpected token"/"is not valid JSON" |
| AID-11 | scrittura `failed` | errore strutturato "Zotero API write failed: Item 0 ...", `hint` "Nothing was created…" |
| AID-12 | scrittura parziale | non isError; success con i creati, failed con `{ doi, error }` |
| AID-12b | 60 DOI | POST da 50 + 10, ordine dei DOI preservato |
| AID-13/14 | POST HTTP 403/404/412/413/429/500/503, rete | errore strutturato con `http_status` e `hint` |
| AID-15 | 10 DOI | una POST, ordine preservato |
| AID-16 | dois, auto_attach_pdf, tags non validi | isError |
| AID-17 | OA gold | download + upload, allegato figlio, `source unpaywall_gold` |
| AID-18 | **Unpaywall senza OA** (closed) | "No open access PDF found", nessun upload |
| AID-19 | green con sola landing page | landing_url + suggerimento import_pdf_to_zotero |
| AID-20 | Unpaywall 404/500/rete | item creati, pdf_attached false |
| AID-31 | Unpaywall risponde 200 con HTML | item creato, pdf_attached false, nessun errore grezzo |
| AID-21 | **quota storage** (413) | storage_quota_warning (cosa dire all'utente, poi find_and_attach_pdfs), item creati |
| AID-22 | quota piena su 12 DOI | upload successivi saltati |
| AID-23 | un download 404 | risultati per singolo item |
| AID-24 | ZOTERO_API_KEY assente | item creati, fase PDF saltata |
| AID-25 | PDF primario 403, fallback disponibile | allegato il fallback: status attached, url_used = pdf_url, filename, size_bytes; nessun allegato orfano |
| AID-26 | tutti gli URL falliscono | pdf_attached false, "Download failed for all 2 URL(s): oa.example.org 403, repo.example.org 404", failed_urls con status 403 e 404 |
| AID-27 | stesso scenario della pipeline condivisa | campi per PDF identici a `attachOpenAccessPdf` chiamata direttamente |

## add_linked_url_attachment (`add-linked-url-attachment.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| ALU-01 | solo url | payload linked_url, title=url |
| ALU-02 | figlio | parentItem, contentType, collections `[]` |
| ALU-03 | standalone | collections + tags |
| ALU-04 | unicode | round-trip |
| ALU-05 | scrittura `failed` | errore strutturato, `hint` sul parent_item |
| ALU-06 | details | contiene il messaggio del server ("code: message") |
| ALU-07 | url mancante/non valido/numero, tags, collections | isError |
| ALU-08/09 | HTTP 4xx/5xx, rete | isError |

## delete_collection (`delete-collection.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| DC-01 | **guard** none/items | errore strutturato con env_var/current_value/required_values e il valore attuale nel testo; `hint`: non aggirare il blocco, `UNSAFE_OPERATIONS` 'all' (e cosa abilita 'items') nelle impostazioni del server, riavvio; nessuna chiamata HTTP |
| DC-02 | validazione prima del guard | isError |
| DC-03 | all | GET versione → DELETE con If-Unmodified-Since-Version |
| DC-04/05 | senza nome / nome unicode | name = chiave / preservato |
| DC-06/07 | 404 su GET / su DELETE | errore strutturato not_found, `hint` "Nothing was deleted…" get_collections |
| DC-08 | 412 | errore strutturato version_conflict ("not deleted. Retry the same call.") |
| DC-09 | versione assente | errore strutturato con `hint` di riprovare, nessuna DELETE |
| DC-10/11/12 | 403/429/500/503 su GET o DELETE, rete | errore strutturato con `http_status` e `hint` |
| DC-13 | chiave mancante/vuota/numero | isError |

## delete_items (`delete-items.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| DI-01 | **guard** none | errore strutturato "not allowed… UNSAFE_OPERATIONS is 'none'. Nothing was deleted."; `hint`: non aggirare il blocco, 'items' o 'all' e cosa abilitano, dove impostarli ("Deletions allowed" nell'estensione di Claude Desktop, `UNSAFE_OPERATIONS` in claude_desktop_config.json / .mcp.json), riavvio; nessuna chiamata HTTP |
| DI-02 | items / all | consentito |
| DI-03 | 2 chiavi | GET itemKey → DELETE `?itemKey=A,B` con la versione della libreria |
| DI-04 | cancellazione parziale | not_found; cancellate solo le chiavi trovate |
| DI-05 | nessuna trovata | errore strutturato con `hint` "Nothing was deleted…", nessuna DELETE |
| DI-06 | 412 | version_conflict ("nothing was deleted. Retry the same call.") |
| DI-07 | versione assente | errore strutturato con `hint` di riprovare |
| DI-08 | 20 chiavi | una GET + una DELETE |
| DI-09 | 50 chiavi (massimo per chiamata) | tutte cancellate, GET di verifica con limit=50 |
| DI-10/11/12 | 4xx/5xx su GET o DELETE, rete | errore strutturato con `http_status` e `hint` |
| DI-13/14 | mancante, `[]`, stringa, 51 chiavi / esattamente 50 | isError / accettato |
| DI-15 | validazione prima del guard | isError |
| DI-16 | chiave malformata | errore di validazione, **nessuna richiesta** (prima della 2.0.1 l'API ignorava il filtro e delete_items cancellava voci estranee) |
| DI-17 | API che restituisce più voci di quelle chieste (filtro ignorato) | cancellata solo la chiave richiesta |

## import_pdf_to_zotero (`import-pdf-to-zotero.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| IP-01 | flusso completo | download con User-Agent → item imported_url → auth (md5, filesize, If-None-Match) → upload prefix+file+suffix → register → PUT fulltext con il testo estratto |
| IP-02 | `{exists:1}` | niente upload/register |
| IP-03/04 | figlio / standalone | parentItem e collections `[]` / collections, tags, title, filename |
| IP-05 | filename dall'URL | percent-decoding unicode; `document.pdf` come fallback |
| IP-06 | content_type non PDF | fulltext saltato |
| IP-07/08 | download 403/404/500, rete | errore strutturato "(HTTP N)" con status e suggestion per status (paywall/login, URL inesistente, riprova) / details e suggestion con fonti aperte (nessun riferimento a Sci-Hub) |
| IP-09/10 | pagina HTML, file vuoto | "not a valid PDF" (suggestion: link diretto, /pdf/ su arXiv), nessun item creato |
| IP-11 | 100 MB + 1 | "100 MB" con suggestion (Zotero desktop), nessun item creato |
| IP-12/13 | creazione item `failed`, HTTP 4xx/5xx | errore strutturato "import_pdf_to_zotero failed", `hint` sul parent_item / `status` e `hint` per lo status ("Nothing was created.") |
| IP-14 | **quota storage** (auth 413) | errore strutturato con item_key orfano, suggestion, nota per l'utente (delete_items solo se abilitato) |
| IP-15 | autorizzazione dell'upload 200 con HTML | isError "Upload authorization failed", status 200, details "response is not a JSON object (HTTP 200, text/html)", nessun upload |
| IP-15/16 | auth 403/412/500, rete | "Upload authorization failed" con `item_key` del record senza file e `hint` (un nuovo tentativo ne crea un altro; 403: chiave; altri: riprova) |
| IP-17/18 | upload 500 / register 412 | "File upload failed" / "Upload registration failed", con `item_key` e `hint` |
| IP-19/20 | fulltext 413 / PDF non estraibile | successo, fulltext_indexed false con motivo |
| IP-21 | ZOTERO_API_KEY assente | errore strutturato con `hint` per l'utente, nessuna chiamata HTTP |
| IP-22 | url mancante/non valido, tags, collections, content_type | isError |
| IP-23 | size_bytes dopo l'estrazione | dimensione reale |
| IP-24 | size_bytes senza estrazione | dimensione reale |

## find_and_attach_pdfs (`find-and-attach-pdfs.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| FA-01 | item_keys, OA trovato | attached + conteggi; allegato figlio |
| FA-02/03 | entrambi / nessuno | errore strutturato |
| FA-04 | `[]` | risultato vuoto "No items to process", suggestion "item_keys is empty…" |
| FA-05 | collection_key (2 pagine, allegati e note) | 20 item processati |
| FA-06 | collezione vuota | risultato vuoto "No items to process", suggestion get_collection_items |
| FA-07 | senza DOI / chiave fantasma | status error con motivo ("No DOI: Unpaywall needs one…" / "Item not found in this library") |
| FA-08/09/10 | PDF esistente / solo snapshot HTML / skip=false | skipped / processato / nessuna richiesta children |
| FA-11 | dry_run | available + pdf_url, nessun download |
| FA-12 | closed / green con landing | not_found "No open access PDF found" con oa_status / landing_page_only con landing_url (entrambi contati in not_found) |
| FA-13 | Unpaywall 404 | not_found "No open access PDF found" |
| FA-13b | Unpaywall 500 / rete | not_found con motivo "Unpaywall lookup failed (…): this does not mean there is no open access PDF. Retry later…" |
| FA-14 | UNPAYWALL_EMAIL non valida | not_found con warning, `hint` unico per l'utente (dove impostarla, riavvio), nessuna chiamata a Unpaywall |
| FA-15/16 | URL di fallback / tutti falliti | attached con il fallback / reason "…: publisher.example.org 500, repo.example.org network_error" |
| FA-17 | **quota storage** | quota_exceeded, warning (cosa dire all'utente), nessun `hint` Unpaywall, item rimanenti saltati |
| FA-18/19 | GET metadati 4xx/5xx, rete sulla collezione | errore strutturato "find_and_attach_pdfs failed: …" con details, `http_status` e `hint` |
| FA-20 | children 500 su un item | l'item compare in results come error, contato in errors |
| FA-21 | children 500 su un item | gli altri item vengono processati |
| FA-22/25 | 120 item_keys / collezione di 120 | tutti processati, nessun "Item not found in this library" |
| FA-23 | ZOTERO_API_KEY assente | errore strutturato |
| FA-24 | item_keys, collection_key, dry_run, skip non validi | isError |
| FA-26 | PDF solo in una oa_location successiva (PLOS) | attached dal repository, filename dal DOI |
| FA-27 | URL senza .pdf con Content-Disposition | filename dall'header |
| FA-28 | solo landing page dell'editore | landing_page_only, il motivo nomina l'editore |
| FA-29 | stesso scenario della pipeline condivisa | campi per PDF identici a `attachOpenAccessPdf` chiamata direttamente |
| FA-30 | chiave malformata | errore di validazione, nessuna richiesta |

## Pipeline PDF open access condivisa (`test/utils/oa-pdf.test.ts`)
`attachOpenAccessPdf` (src/utils/oa-pdf.ts) è l'unico percorso usato da add_items_by_doi e find_and_attach_pdfs.
| ID | Scenario | Atteso |
|---|---|---|
| OA-01 | primario 403, fallback ok | attached con url_used, filename, size_bytes, attachment_key, fulltext_indexed; una sola POST di allegato |
| OA-02 | tutti gli URL falliscono | reason con host e status di ogni URL, failed_urls nell'ordine provato con `status` |
| OA-03 | solo landing page | landing_page_only con landing_url e host reale nel motivo |
| OA-04 | PDF già presente (skipIfPdfExists) | skipped, Unpaywall non interrogato |
| OA-05 | contenuto non PDF (HTML) | reason "…: oa.example.org not_pdf", dettaglio "HTML page instead of a PDF" in failed_urls, nessun allegato |
| OA-06 | quota storage piena | quota_exceeded, token di cancellazione impostato, fallback non provato |
| OA-07 | dry run | available con url_used, nessun download |

## inject_citations (`inject-citations.test.ts`, .docx reali in una cartella tmp)
| ID | Scenario | Atteso |
|---|---|---|
| IC-01 | 1 zcite | `*_cited.docx` con XML valido, field code CSL_CITATION (uris), BIBL, "(Smith, 2023)"; originale intatto |
| IC-02 | più tag, multi-chiave, chiavi ripetute | 1 GET per chiave, "(Smith, 2023; Doe & Roe, 2019)" |
| IC-03 | locator/prefix/suffix | presenti nel field code |
| IC-03b | locator `12-15`, prefix `see`, suffix `, fig. 2` nei 5 stili | testo visibile come lo rende citeproc con lo stile vero: apa/harvard "(see Smith, 2023, pp. 12–15, fig. 2)", chicago "(see Smith 2023, 12–15, fig. 2)", ieee "see [1, pp. 12–15], fig. 2", vancouver "[see 1, fig. 2]" (lo stile NLM non stampa il locator) |
| IC-23b | capitolo di libro con curatore, curatore di collana, autore istituzionale e contributor | itemData con `container-title` (bookTitle), `editor`, `collection-editor`, autore `literal`; contributor escluso; bibliografia citeproc "In U. Gialli (Ed.), Collected Gammas (pp. 5–30). G Press." |
| IC-04/05 | ieee con num e senza / vancouver con tutti i num | [1] e [?] + warning (quanti hanno num, [?] fino a Refresh, come rimediare) / nessun warning |
| IC-06 | nessuno zcite | found 0, output scritto, warning "No <zcite> placeholders found…" (intestazioni, piè di pagina, note non lette), nessuna chiamata HTTP |
| IC-07 | unicode (autori, titolo >30 caratteri, nome file) | XML ben formato, testo corretto |
| IC-08/09 | .pdf / .DOCX | errore strutturato, `hint` (solo .docx minuscolo, convertire .doc/.odt/.rtf) |
| IC-10 | file inesistente | isError "File not found" con la skill `zotero-mcp-integrations` e il link alla release |
| IC-10b | percorso relativo inesistente | come IC-10, più `hint` "Pass an absolute path." |
| IC-11..14 | **.docx malformati**: byte casuali, zip senza document.xml, zip troncato, file vuoto | isError "Invalid .docx file: not a readable ZIP archive (…)" / "word/document.xml not found", con l'indicazione di rigenerarlo |
| IC-14b | cartella non scrivibile (non root) | errore strutturato "Cannot read the file or write the _cited copy… (EACCES)", `hint` di copiarlo in una cartella scrivibile |
| IC-15 | zcite senza keys | ignorato |
| IC-16 | chiavi 404 (sola e accanto a una valida) | isError "2 cited key(s) not found in the library: …. No file was written." con tutte le chiavi e come rimediare (search_library, add_items_by_doi), senza "404" grezzo, nessun output (come SK-05) |
| IC-17/18 | HTTP 403/429/500/503, rete | errore strutturato con `http_status` e `hint` |
| IC-19 | output | zip valido con le altre parti |
| IC-20 | cartella `x.docx.d/` | output accanto all'input |
| IC-21 | file_path mancante o numero, style non valido | isError |
| IC-22 | `keys=" A, B ,"` con spazi | chiavi ripulite, URI senza spazi, nessuna richiesta fuori route |
| IC-24 | chiave `<zcite>` non valida per Zotero (`../tags`, `AB?C`, mista a una valida, con 0/1/O, minuscole, 9 caratteri) | isError "Invalid Zotero item key(s) in <zcite>: <solo le chiavi errate> (a key is 8 characters from 23456789ABCDEFGHIJKLMNPQRSTUVWXYZ)" con "No file was written" e da dove prendere le chiavi, nessuna richiesta, nessun output (come SK-10) |
| IC-23 | itemData | volume/issue/page/publisher/publisher-place inclusi, abstract escluso, cognome multiparola intatto |

Gli output di IC-01/02/03/04/07/19/23 passano anche dal validatore docx (`expectValidDocx`, vedi sotto).

### Validazione docx (IC-V)
| ID | Scenario | Atteso |
|---|---|---|
| IC-V01 | stili apa, harvard, chicago, ieee, vancouver; singola, coppia + 4 autori, locator/prefix/suffix, unicode + senza autore + istituzionale, chiave ripetuta (num coerenti con l'ordine di prima citazione) | docx valido: parti e content types, XML, campi bilanciati, schema csl-citation con deroghe, URI `users/<id>`; citeproc renderizza 5 citazioni e 7 voci di bibliografia; cognome/anno (o numeri) del testo visibile coincidono con lo stile CSL vero |
| IC-V02 | `library_type: "group"`, `library_id: "777"` per chiamata | URI `http://zotero.org/groups/777/items/KEY` validi |
| IC-04 (validato) | ieee senza `num` | struttura valida; il validatore segnala `[?]` come differenza dal numero che scriverà Zotero |
| IC-V-H1 | 5 stili | `docProps/custom.xml` con `ZOTERO_PREF_*` ricomposte dal validatore: stile dell'iniezione (id del CSL vendorizzato), `fieldType` Field, Override e relazione della parte (H-W1: senza, il primo Refresh apriva Document Preferences) |
| IC-V-H1c | parte custom-properties esistente non unibile | preferenze non scritte, parte intatta, avviso nei `warnings` (Zotero può chiedere lo stile al primo Refresh) |
| IC-V-H1b | documento con `ZOTERO_PREF_*` già presenti | lasciate come sono, avviso nei `warnings` (al primo Refresh Zotero userà lo stile salvato lì) |

Le altre ipotesi (H-W2 `plainCitation`/`noteIndex`, H-W3 id per URI, H-W4 `label` del locator, H-W5 voci o gruppi
assenti dal client) le decide il job `word-proxy` (sezione sotto) con Zotero desktop vero: non servono, i casi
`it.fails`/`it.todo` corrispondenti sono stati tolti. inject.js scrive lo stesso JSON.

### Preferenze del documento (`src/citation-injector/document-prefs.test.ts`, DP; validatore DV-16; skill SK-V01)
| ID | Scenario | Atteso |
|---|---|---|
| DP-01/02 | valore e parti | `<data data-version="3">` con sessione di 8 caratteri, stile, `fieldType` Field; parti di al massimo 255 caratteri ricomponibili |
| DP-03 | docx senza proprietà | `docProps/custom.xml`, Override e relazione aggiunti (`rId` libero) |
| DP-04 | `custom.xml` esistente senza Zotero | proprietà conservate, `pid` successivi, Override e relazione non duplicati |
| DP-05 | `ZOTERO_PREF_*` già presenti, stile sconosciuto | nulla cambia |
| DP-06 | `custom.xml` vuoto senza prefisso `vt` | proprietà inserite, prefisso dichiarato |
| DP-07/08 | radice con prefisso (`<op:Properties>`), testo dopo la radice | unite prima dell'ultima chiusura con lo stesso prefisso, nulla perso |
| DP-09 | `ZOTERO_PREF_*` con apici singoli | `kept`, nulla cambia |
| DP-10 | relazione custom-properties verso un'altra parte | letta e unita lì, nessuna parte né relazione nuova |
| DP-11 | parte esistente senza radice `Properties` riconoscibile | `skipped`: mai riscritta, nessun Override né relazione |
| DV-16 | validatore | preferenze su più proprietà ricomposte; stile diverso dall'iniezione, buchi nella numerazione, parte oltre 255 caratteri, `fieldType` diverso, Override o relazione mancanti → errori |
| SK-V01 (esteso) | inject.js nei 5 stili | stesse preferenze di `inject_citations` |
| SK-V03 | inject.js con preferenze già presenti; radice con prefisso; parte non unibile | mantenute con WARNING; unite conservando le proprietà dell'utente; non scritte, parte intatta, WARNING |

## Skill inject.js (`test/skills/inject-script.test.ts`, processo node reale)
| ID | Scenario | Atteso |
|---|---|---|
| SK-01 | libreria `users/<id>`, id numerico, `groups/<id>` | URI `http://zotero.org/{path}/items/KEY`, itemData da metadata.json (DOI maiuscolo), ZOTERO_BIBL |
| SK-02 | ieee con `num` | `[1]`, `[1,2]`, nessun warning |
| SK-03 | vancouver senza `num` | WARNING su stderr |
| SK-04 | `keys="A, B"` | chiavi ripulite |
| SK-05 | chiavi assenti da metadata.json (sola e accanto a una presente) | exit 1 "2 cited key(s) not found in the metadata: …", nessun output (come IC-16) |
| SK-06 | argomenti mancanti, libreria non valida, stile `mla`, file inesistenti | exit 1 con messaggio |
| SK-07 | copia `inject.mjs` sotto `package.json` `"type": "commonjs"` | esegue senza SyntaxError/warning |
| SK-08 | metadata.json da get_items_details con `not_found` (cognomi multiparola, nome istituzionale, nessun autore, capitolo con curatore, locator/prefix/suffix) | `not_found` ignorato; itemData e testo identici a inject_citations (`literal`, `container-title`, `editor`, "(see Gamma, 2020, p. 7, n. 3)") |
| SK-10 | chiave `<zcite>` non valida per Zotero (`../tags`, `AB?C`, mista a una valida, con 0/1, minuscole) | exit 1 con lo stesso errore di inject_citations (solo le chiavi errate), nessun output |
| SK-V01 | stili apa, harvard, chicago, ieee, vancouver; singola, multi-chiave con locator/prefix, ripetuta | output di inject.js valido (struttura, schema, URI, citeproc con 2 voci in bibliografia, parti chiave) |
| SK-V02 | libreria `groups/777` | URI di gruppo validi |
| SK-09 | `place` restituito da get_items_details | `publisher-place` nell'itemData come in inject_citations (bug trovato da LIVE-SK-01, corretto: prima inject.js leggeva solo `publisherPlace`) |

Gli output di SK-01, SK-02 e SK-08 passano anche da `expectValidDocx`.

## Validatore docx (`test/utils/docx-validate.test.ts`, helper `test/helpers/docx-validate.ts`)
Fixture CSL vendorizzate in `test/fixtures/csl/` (stili, locale en-US, schemi; fonti e licenze nel README).
Deroghe allo schema ufficiale (`RELAXATIONS`): URL `schema` di Zotero, `uri` legacy, `formattedCitation`/
`plainCitation`/`dontUpdate` in `properties`, `itemData` senza `id`. Lo stile `vancouver` usa
`nlm-citation-sequence.csl`, `chicago` usa `chicago-author-date.csl`. citeproc riceve id sintetici (l'URI della voce).
| ID | Scenario | Atteso |
|---|---|---|
| DV-01/01b | field code generati da `generateZoteroFieldCode` + bibliografia, 5 stili | nessun errore, 2 citazioni e 2 voci renderizzate |
| DV-02 | non zip | errore |
| DV-03 | `[Content_Types].xml` o `_rels/.rels` assenti, parte senza content type, Override di document.xml assente, rels senza officeDocument, XML malformato, Override verso una parte rimossa, relazione interna di `word/_rels/document.xml.rels` verso una parte rimossa (le esterne sono ignorate) | errore specifico |
| DV-04 | end mancante, separate o end senza begin, campo senza separate | errore specifico |
| DV-05 | JSON CSL_CITATION non valido | errore |
| DV-06 | campo sconosciuto in citationItem, label fuori enum, itemData senza type, URL schema sconosciuto, citationItems vuoto | errore di schema |
| DV-06b | deroghe documentate | ammesse |
| DV-07 | URI con chiave minuscola, https, libreria diversa da quella attesa | errore |
| DV-08 | formattedCitation ≠ testo visibile | errore |
| DV-09/10 | cognome/anno sbagliati (autore-anno), numerazione diversa dall'ordine di citazione (numerico) | differenza segnalata; `expectValidDocx` lancia |
| DV-11 | `<zcite>` rimasto | errore (ammesso con `allowLeftoverZcite`) |
| DV-12 | ZOTERO_BIBL assente o duplicato | errore |
| DV-13 | `citationNumbers` | range espansi, `[?]` vuoto |
| DV-14 | instrText su più run, campo annidato nel risultato | testo visibile ricostruito |
| DV-15 | parità con Zotero | rileva ZOTERO_PREF, plainCitation, noteIndex, id coerenti, label; l'output del prodotto non li ha |

Lo smoke (`scripts/smoke-stdio.mjs`) fa un controllo strutturale leggero dello stesso tipo (parti, XML, campi
bilanciati, JSON, URI, testo visibile = formattedCitation, una bibliografia) senza schemi né citeproc.

Il validatore costruisce un solo motore citeproc per stile (costruirlo costa 1-2 s per apa/chicago) e lo azzera a ogni
validazione: id delle voci unici per validazione, stato del processore ripulito.

## Validazione delle chiavi (`key-validation.test.ts`)
Le chiavi finiscono nei path dell'API senza codifica (e l'URL risolve `..`) o nei filtri itemKey (ignorati dall'API se
nessuna chiave è ben formata): ogni argomento chiave usa lo schema condiviso `zoteroKey()` (`src/utils/zotero-keys.ts`).
| ID | Scenario | Atteso |
|---|---|---|
| KV-01 | per ogni tool e argomento chiave (item_keys, item_key, collection_key, collectionKey, parent_item, parent_collection, collections): `../tags?tag=X&`, `../collections?collectionKey=A,B`, `../../groups/777/…`, minuscole, con 0, 7 caratteri, con virgola | errore di validazione col nome del campo, il formato (8 caratteri, es. ABCD2345) e "never guess keys", nessuna richiesta |
| KV-02 | `<zcite>` con `../`, `?`, `%2F` (inject_citations) | errore "Invalid Zotero item key(s)", nessuna richiesta |

## tools/list (`tools-list.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| TL-01 | elenco | esattamente 15 nomi |
| TL-02 | per tool | `type: object`, properties e required attesi (+ `library_type`/`library_id` tranne get_user_id), descrizione presente |
| TL-03 | enum/default | sort, direction, limit, style, auto_attach_pdf, max_characters, dry_run, content_type |
| TL-04 | cardinalità | delete_items 1..50, add_items min 1, collection_key minLength 1 |
| TL-05 | add_items.itemType | enum di 37 tipi; required itemType+title |
| TL-06 | url | `format: uri` |
| TL-07 | tool sconosciuto | isError |
| TL-08 | override libreria | `library_type` enum user/group, `library_id` pattern numerico, mai required |

## Helper pubblici (`test/utils/helpers.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| H-01 | logger | una riga JSON su stderr per chiamata, mai su stdout |
| H-02/03 | formatErrorResponse | `{error, ...details}` con isError: true; una chiave `error` nei details vince |
| H-02b | formatEmptyResult | `{message, ...details}` senza isError |
| H-02c | formatJsonResult, errorMessage | JSON indentato senza isError; messaggio di qualsiasi valore lanciato |
| H-04/05 | extractPdfText con unpdf reale | testo e pagine / rifiuta un non-PDF |
| H-06/07 | isZoteroApiError su ErrorResponse reale / errore di rete | true con status / false |
| H-08/09/10 | contratto zotero-api-client | Total-Results e versione; `getData()` con tutti gli oggetti inviati, `getErrors()` con oggetti; DELETE `?itemKey` con If-Unmodified-Since-Version |
| H-11..14 | fetchWithRetry | Retry-After come data passata, 500 senza retry, esaurimento dei retry, errore di rete |
| H-15/16 | resolveDoi | codifica + Accept CSL / 404 con DOI, status e "(DOI not registered or mistyped)"; 5xx "retry later" (`src/utils/doi-resolver.test.ts`) |
| H-20 | `describeError` (`src/utils/error-hints.test.ts`) | 403/401: chiave e pagina zotero.org/settings/keys, impostazioni del server; 404: chiavi valide; 409/412: riprova; 429: Retry-After; 5xx: attendi e riprova, poi dillo all'utente; 400: correggi gli argomenti; timeout: controlla prima di ripetere una scrittura; rete: causa inclusa, un TypeError che nomina solo "network" non conta; corpo HTML mai copiato, percorsi `users|groups/<id>` e numeri di 5+ cifre mascherati nei `details`; altri errori non tradotti; `whereToSet` (titolo dell'impostazione nell'estensione di Claude Desktop e variabile env); `unsafeOperationsHint` |
| H-21 | `runTool` (`src/tools/index.test.ts`) | errore API → errore strutturato con `http_status` e `hint`, senza URL; errore non API → rilanciato |
| H-17/18 | putFulltext | body JSON + API key, 204 / 413 e 500 |
| H-19 | putFulltext gruppo | PUT su `/groups/777/items/{key}/fulltext` |

## Metadati di distribuzione (`test/utils/release-metadata.test.ts`)
`server.json` è la voce del MCP Registry, pubblicata da `release.yml` dopo npm; schema ufficiale vendorizzato in `test/fixtures/schemas/`.
| ID | Scenario | Atteso |
|---|---|---|
| RM-01 | `server.json` contro lo schema indicato in `$schema` (Ajv + formati) | valido (descrizione ≤ 100 caratteri, nome reverse-DNS, versioni non range) |
| RM-02 | versione, `name`, pacchetto npm | `version` e `packages[0].version` = versione di `package.json`, `name` = `mcpName`, `identifier` = nome npm, `mcpName` con prefisso `io.github.<owner>/` col maiuscolo/minuscolo esatto del repository |
| RM-03 | `environmentVariables` | stessi nomi delle `process.env.X` lette in `src/` (test esclusi); solo `ZOTERO_API_KEY` segreta (e obbligatoria); `choices`/`default` di `UNSAFE_OPERATIONS` e `ZOTERO_LIBRARY_TYPE` |
| RM-04 | `manifest.json` (estensione Claude Desktop) contro lo schema MCPB della sua `manifest_version` (0.3, dal pacchetto `@anthropic-ai/mcpb`) | valido; `version` = package.json, `entry_point` = `main`, args `${__dirname}/build/server.js`, Node minimo = `engines` |
| RM-05 | `tools` del manifest | nomi e ordine dei 15 tool registrati, ciascuno con un riassunto proprio di una riga (10-100 caratteri, non confrontato col codice: riformulare una descrizione in `src/` non tocca il manifest), `tools_generated: false` |
| RM-06 | `mcp_config.env` e `user_config` | stesse variabili di `server.json`; obbligatorie e sensibili coincidono con `isRequired`/`isSecret`; ogni opzione facoltativa ha un default (stringa vuota o il default di `server.json`), altrimenti al server arriverebbe il letterale `${user_config.<chiave>}`; `unsafe_operations` facoltativa con default `none` |

Smoke del bundle (`npm run smoke -- --bundle dist/mcp-zotero.mcpb`, in `test.yml` e `release.yml`): il .mcpb viene spacchettato
fuori dal repository, comando/args/env vengono calcolati da `getMcpConfigForManifest` di `@anthropic-ai/mcpb` (come un client),
poi gli stessi scenari utente e gruppo di `npm run smoke`; inoltre: nessuna variabile `${...}` irrisolta, solo `build/`,
`node_modules/`, `manifest.json`, `package.json`, `LICENSE`, `README.md` al primo livello, nessun pacchetto solo-dev del lockfile,
`tools/list` = `tools` del manifest.

## E2E (`test/e2e/stdio-server.e2e.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| E2E-01/02 | initialize, tools/list | serverInfo "zotero", istruzioni (UNPAYWALL_EMAIL, regola UNSAFE_OPERATIONS, hint negli errori), 15 tool con schema object |
| E2E-03 | argomenti non validi su 14 tool | isError con il campo, nessuna chiamata HTTP |
| E2E-04..18 | una tools/call per ciascuno dei 15 tool (deletes con UNSAFE_OPERATIONS=all) | risultato atteso, richieste corrette alla FakeNet |
| E2E-19 | 403 Zotero | isError al client |
| E2E-20 | rete | nessuna richiesta del processo figlio senza route |
| E2E-21/22 | UNSAFE_OPERATIONS assente / " ITEMS " | delete bloccati senza chiamate HTTP, con `hint` per l'utente / solo delete_items abilitato |
| E2E-23 | senza credenziali | exit code 1 entro 5 s, errore su stderr |

## E2E librerie di gruppo (`test/e2e/group-library.e2e.test.ts`)
Server avviato con `ZOTERO_LIBRARY_TYPE=group`, `ZOTERO_LIBRARY_ID=777` (e `ZOTERO_USER_ID` utente).
| ID | Scenario | Atteso |
|---|---|---|
| E2E-G01 | get_user_id | `library_type: "group"`, `library_path: "groups/777"`, `user_id` da `ZOTERO_USER_ID` |
| E2E-G02/03 | lettura: search, collezioni, item, dettagli, fulltext | GET su `/groups/777/...` |
| E2E-G04/05/06 | scrittura: create_collection, add_items, linked URL, import PDF, add_items_by_doi con PDF OA | POST item, auth/registrazione file e PUT fulltext su `/groups/777/...` |
| E2E-G07 | delete_items, delete_collection | GET di verifica e DELETE su `/groups/777/...` |
| E2E-G08 | inject_citations | URI `http://zotero.org/groups/777/items/{key}`, nessun `/users/` |
| E2E-G09 | find_and_attach_pdfs dry_run | item e children dal gruppo |
| E2E-G10 | tutte le richieste precedenti | solo path `/groups/777/`, nessuna richiesta senza route |
| E2E-G11 | override per chiamata | `library_type: "user"` → `/users/{ZOTERO_USER_ID}`; `library_id: "888"` → `/groups/888` |
| E2E-G12 | `library_id` non numerico ("abc", path traversal, "12a", "", "-1"), `library_type` sconosciuto | isError, nessuna chiamata HTTP |
| E2E-G13 | group senza `ZOTERO_LIBRARY_ID` | exit code 1 entro 5 s, "requires ZOTERO_LIBRARY_ID", nessuna chiamata HTTP |
| E2E-G14 | `ZOTERO_LIBRARY_ID` non numerico / `ZOTERO_LIBRARY_TYPE` sconosciuto | exit code 1 con messaggio dedicato |

## word-proxy (job di `test.yml`, `test/word-proxy/`)
Zotero 10.0.6 desktop (build ufficiale, sha256 fissato) sotto Xvfb esegue Refresh / Document Preferences sui docx
iniettati da `build/server.js` (corpus reale, librerie segnaposto `users/000000` e `groups/777`, API Zotero finta)
attraverso `wordcraft-cli` 0.8.0 (protocollo word-processor di Zotero). Un plugin di test registra e risponde ai
dialoghi. Ogni passo è confrontato con `test/word-proxy/expect.json` da `verify.mjs`; `compare.mjs` confronta la
bibliografia dalla libreria locale con quella dall'`itemData` incorporato. Nessun account, nessun segreto.
| ID | Scenario | Atteso |
|---|---|---|
| WP-apa…chicago | sessione "embedded" (percorso B, libreria vuota): primo Refresh nei 5 stili | H-W1 corretto: nessun dialogo Document Preferences, stile dell'iniezione (da `ZOTERO_PREF_*`) applicato e salvato; nessun avviso, `noteIndex` 0, un id per URI, 8 citazioni, 12 voci, tutte da `itemData` incorporato; "p. 110" del locator, "In J. Edmond (Ed.), …", cirillico, particelle |
| WP-proposed | OK sullo stile proposto, se Zotero lo chiede | prima del fix: stile a note, citazioni come testo di nota nel corpo; ora nessun dialogo, apa applicato |
| WP-again / WP-restyle | secondo Refresh; Document Preferences → chicago-author-date | nessun dialogo, stesso testo; stile cambiato senza errori |
| WP-group | docx dalla libreria di gruppo 777, gruppo assente in Zotero | H-W5: `itemData` incorporato, nessuna richiesta, URI `groups/777` |
| WP-lib-apa/lib-group | sessione "library" (percorso A): stesse voci con le stesse chiavi nella libreria locale e in un gruppo 777 (`load-items.js`) | voci dalla libreria, nessun fallback, nessun dialogo |
| WP-ab | bibliografia lib-apa contro apa | uguali salvo le 4 differenze note: `zoteroItemToCsl` non porta università (tesi), istituzione (report), repository/archiveID (preprint), data di accesso (pagina web) |
| WL-09 | ambito del job (`scripts/word-proxy-scope.mjs`, `test/utils/workflow-logic.test.ts`) | PR: solo se cambiano un sorgente del server (`src/`), la skill, il corpus, word-proxy o il job; PR solo docs o solo test: saltato; push su main e manuale: sempre |
| WL-10 | struttura del job | senza segreti né `environment`, `ubuntu-24.04`, timeout ≤ 10 min, azione composita `word-tools` (versioni e sha256 fissati, archivi in cache ricontrollati a ogni run), artifact solo dopo `check-artifacts.mjs`, conservato 1 giorno |
| WP-CA | `check-artifacts.mjs` (`test/utils/word-proxy.test.ts`) | fallisce con URI di libreria diversi dai segnaposto, email, home diversa da quella del runner, valori di variabili segrete, file inattesi (anche dentro i docx) |
| WP-R01 | `render.mjs`: differenze itemData di `expect.json` | ognuna associata alla sua voce del corpus (voce di bibliografia di libreria che la contiene) |
| WP-V | `verify.mjs` / `compare.mjs` su documenti costruiti nel test | aspettative rispettate → ok; una differenza → errore con atteso/ottenuto; differenza A/B nuova o sparita → errore |

### word-render e revisione visiva (job di `claude-agent-smoke.yml`, `test/live/agent/visual-review.mjs`)
`word-render` riesegue word-proxy senza aspettative, rende ogni pagina dei documenti aggiornati (5 stili da
`itemData`, `proposed` di H-W1, gruppo, `lib-apa` dalla libreria) con `wordcraft-cli render --scale 1.5`
(`test/word-proxy/render.mjs`, `index.json`), carica le immagini come artifact temporaneo; l'agente le legge (solo
Read su `agent-render/`) e scrive `agent-out/visual-review.md`; `word-render-cleanup` cancella l'artifact.
| ID | Scenario | Atteso |
|---|---|---|
| VR-01 | lettura della revisione (`test/utils/visual-review.test.ts`) | problemi con documento, pagina, posizione, voci del corpus, reso, atteso, noto; lista "Da verificare in Word" a parte |
| VR-02 | problemi noti e non noti | noto (issue di `index.json` che riguarda quel documento) → avviso; senza `Noto` → problema (bug) |
| VR-03 | riferimenti sbagliati | pagina non resa, pagina di un altro documento, voce non del corpus, issue nota inesistente o di un altro documento, campo mancante o sconosciuto, numero ripetuto, sezione sconosciuta, file senza problemi né riga "Nessun problema" → errori |
| VR-06 | issue nota usata per altro | voce fuori dagli `items` dell'issue, H-W1 su un documento senza dialogo registrato → errori (un bug non si declassa ad avviso) |
| VR-07 | prova della revisione | ogni voce di un'issue `reportsRequired` (differenze itemData) e ogni documento con dialogo registrato deve comparire tra i problemi, altrimenti errore |
| AH-04a | hook audit (`test/utils/agent-hooks.test.ts`) | ogni Read di `agent-render/*.png` in `agent-audit/image-reads.jsonl` con `read_no` proprio; altre Read ignorate; la sequenza `call_no` non cambia |
| AH-04b | hook Stop `visual-gate.mjs` | pagine non lette o `visual-review.md` mancante → `{"decision": "block", "reason": …}` con le pagine mancanti, al massimo 2 volte; senza pagine renderizzate o con tutto letto nessun output; letture di altre run non contano |
| VR-04/05 | sezione "Problemi visivi" del riepilogo e del commento | un `<details>` per problema, testo dell'agente escapato (niente HTML, niente @menzioni), impaginazione separata; stesso controllo delle fughe del resto del riepilogo |
| VC-09c | `verify-claims.mjs --render` | revisione o `image-reads.jsonl` mancanti → problema (con `--visual-review optional`, quando skill, configurazione dell'agente e hook del branch base non li prevedono ancora, tutti i controlli della revisione diventano avvisi); pagina mai letta secondo l'audit (anche se letta in un'altra run), errori della revisione e bug visivi → problemi; noti → avvisi |
| WL-07 (esteso) | struttura del workflow | `word-render` dopo `live`, stesse condizioni dell'agente, senza segreti, artifact dopo il controllo; `agent-smoke-run` `needs: [prepare, word-render]`; verdetto rosso se word-render non riesce; `word-render-cleanup` sempre, solo `actions: write` |

## Corpus reale (`test/fixtures/corpus/`, helper `test/helpers/corpus.ts`)
Opere vere con licenza CC BY / CC0 (conferenza ACL, articolo in cirillico, libro curato, capitolo, monografia, tesi
DataCite, report con autore istituzionale, preprint arXiv con 18 autori e particelle, pagina web, coppia stesso
autore e anno con altri coautori, coppia stesso autore unico e anno), registrate a mano da `scripts/record-corpus.mjs` (API ufficiali, 1 richiesta/s, arXiv 1 ogni 3 s):
cassette ridotte di doi.org/Unpaywall/DataCite/Zenodo/arXiv/Thoth, 3 PDF, `library.json` curata. `corpusRoutes()`
le serve come route della FakeNet, `serveCorpusLibrary()` serve la libreria curata come Web API.
| ID | Scenario | Atteso |
|---|---|---|
| CORPUS-01 | controlli dello script sul corpus committato (`test/utils/corpus-fixtures.test.ts`) | nessun problema: licenze CC BY/CC0 da ogni fonte registrata, nessun segreto/email/ORCID/`@` negli URL, corpi ≤ 5 KB, PDF ≤ 2,5 MB con sha256, chiavi Zotero valide, stesso anno per la coppia |
| CORPUS-02 | `library.json` e `LICENSES.md` | identici a quelli che lo script ricostruisce dalle cassette e da `overrides.json` |
| CORPUS-03 | voci curate | campi e ruoli validi per il tipo secondo lo schema Zotero (`zotero-item-types.ts`) |
| CORPUS-04/05 | corpus guastato in una copia: email, `@` nell'URL, valore dell'ambiente, ORCID, licenza NC, campo vietato, PDF cambiato, anni diversi, chiave non valida | ciascun controllo scatta |
| CORPUS-AID-01 | `add_items_by_doi` su tutti i DOI del corpus (`test/tools/corpus.test.ts`) | ogni DOI risolto dalle cassette, un item per opera, nessuna richiesta senza route |
| CORPUS-AID-02 | item creato contro la voce curata, campo per campo | uguale salvo le differenze note (tabella `KNOWN`, causa per campo); una differenza nota sparita va tolta dalla tabella |
| CORPUS-AID-03 (`it.fails`) | differenze del prodotto, una per causa e opera | publisher-location, event, container-title-short, sottotitolo, article-number, contributor, JATS negli abstract, tipo CSL `article` → journalArticle (curatori e nome `literal` corretti: ora in CORPUS-AID-02) |
| CORPUS-IC-01 | `inject_citations` sulla libreria curata in apa/harvard/chicago/ieee/vancouver | docx valido (`expectValidDocx`), 7 citazioni, 12 voci in bibliografia |
| CORPUS-IC-02 | apa | coppia Peroni 2023 (coautori diversi) disambiguata con i coautori come vuole APA 7; coppia Eve 2020 (stesso autore unico) con 2020a/2020b; "Иванов, Н.", "de las Casas, D.", autori collettivi, "p. 110" |
| CORPUS-IC-03 | apa, capitolo | "In J. Edmond (Ed.), Digital Technology and the Practices of Humanities Research (pp. 105–122)" dai dati incorporati (titolo del libro e curatori del `bookSection` nell'`itemData`) |
| CORPUS-PDF-01 | `find_and_attach_pdfs` sulle 3 opere con PDF (Unpaywall registrato) | PDF veri scaricati, caricati identici, testo estratto (anche cirillico) nel PUT fulltext |
| CORPUS-PDF-02 | `add_items_by_doi` con `UNPAYWALL_EMAIL` | voce creata e PDF allegato dalla risposta Unpaywall registrata |
| E2E-C01 | server compilato: `add_items_by_doi` su un DOI Crossref (cirillico) e uno DataCite (arXiv) (`test/e2e/corpus.e2e.test.ts`) | titoli e numero di autori come nella voce curata |
| E2E-C02 | server compilato: `inject_citations` apa sulla libreria curata | docx valido, 4 voci |

## Timeout di rete (`test/tools/timeouts.test.ts`, `src/utils/timeouts.test.ts`)
Bound in `src/utils/timeouts.ts` (`TIMEOUTS`: Web API Zotero 30 s, doi.org/Unpaywall 30 s per tentativo, download e
upload PDF 180 s), abbassati a 50-100 ms nei test. Il server della FakeNet resta fermo (`hang()`, `stalledBody()`)
finché il signal del prodotto non abortisce; senza signal il test scadrebbe sul suo timeout.
| ID | Scenario | Atteso |
|---|---|---|
| TO-01 | Web API ferma (zotero-api-client, search_library) | isError "Zotero API request (GET) timed out after 0.1 s (api.zotero.org)" |
| TO-02/03 | download PDF senza risposta / bloccato a metà corpo | isError con "PDF download timed out", nessun item creato (TO-02) |
| TO-04 | autorizzazione, upload su storage, registrazione fermi | isError con "Upload authorization / File upload / Upload registration timed out" nei details |
| TO-05 | PUT del fulltext fermo | import riuscito, `fulltext_indexed: false`, motivo nel `fulltext_status` |
| TO-06 | GET del fulltext ferma | isError "Zotero fulltext request timed out" |
| TO-07 | doi.org fermo | DOI tra i falliti con "DOI resolution timed out" |
| TO-08 | Unpaywall fermo | `not_found` entro il bound |
| (unit) | fetchWithTimeout, abort del chiamante, fetchWithRetry (timeout non ritentato), resolveDoi, putFulltext, withRequestTimeout su GET/POST/DELETE, signal nuovo per ogni richiesta | messaggi con operazione, bound e host |

## Suite dal vivo (`test/live/`, `npm run test:live`)

Gira contro la Web API Zotero vera con il server compilato su stdio. Si attiva **solo** con
`ZOTERO_TEST_API_KEY` (mai con `ZOTERO_API_KEY`); senza, tutti i file risultano saltati.

| Variabile | Uso |
|---|---|
| `ZOTERO_TEST_API_KEY` | chiave dell'account di test, passata al server come `ZOTERO_API_KEY` solo nell'ambiente del processo figlio |
| `ZOTERO_TEST_USER_ID` | id atteso, confrontato con `/keys/current` (diverso → suite interrotta) |
| `ZOTERO_TEST_USERNAME` | con la collezione sentinella `__mzt_disposable__` abilita la pulizia degli avanzi > 6 h e il controllo dei conteggi |
| `ZOTERO_TEST_GROUP_ID` | casi di scrittura di gruppo, solo se il nome del gruppo inizia con `mzt-test` |
| `UNPAYWALL_EMAIL` | email reale per i casi open access (senza: LIVE-AID-05 saltato, FA-04/05 senza voce OA) |
| `ZOTERO_LIVE_SAFE_MODE=1` | libreria personale: `UNSAFE_OPERATIONS` al massimo `items`, LIVE-DC-02/03 e gruppi saltati, nessuna pulizia degli avanzi |

Configurazione: un file alla volta, 120 s per test, 300 s per gli hook, ogni chiamata MCP 90 s, ogni
richiesta diretta alla Web API 30 s con retry su 429/502/503/504 (Retry-After/Backoff). Report JSON in
`.vitest/live-report.json`, riepilogo della run (conteggi prima/dopo, voci rimosse) in `.vitest/live-summary.json`.

**Fixture e pulizia** (`test/live/global-setup.ts`): ogni run ha un `runId` (`<timestamp base36>-<hex>`); crea la
collezione `mzt-<runId>` con una sottocollezione, 6 voci di tipi diversi e una collezione `bulk` con 105 voci, tutte con
il tag `mzt-run:<runId>` e il runId nel titolo; avvia un server HTTP locale (PDF validi, HTML servito come PDF,
pagina HTML, 404) e sceglie un DOI OA con PDF ≤ 2 MB verificato con HEAD. I test registrano le chiavi create
(`.vitest/live-created-<runId>.jsonl`). Il teardown cancella, prima le voci e poi le collezioni, solo ciò che porta un
marcatore della run (titolo con il runId, tag della run, collezione della run, oppure genitore già verificato) e
fallisce se resta qualcosa; in safe mode avvisa se i conteggi della libreria crescono (qualcosa creato senza
marcatori). I casi che dipendono da doi.org/Crossref/Unpaywall/editori sono `soft`, ma si salta **solo** per un guasto
esterno riconosciuto (`ExternalServiceError`: verifica diretta del servizio prima della chiamata, oppure testo del tool
con timeout, errori di rete, 429/5xx di doi.org, "Download failed for all…"): un secondo tentativo, poi skip con il
motivo. Qualsiasi altro errore, asserzioni comprese, fa fallire il test. Gli skip soft sono contati: oltre
`ZOTERO_LIVE_MAX_SOFT_SKIPS` il teardown fallisce. Le asserzioni sono relative a ciò che la run crea, mai a conteggi
assoluti della libreria; le chiavi inesistenti dei casi negativi (`ZZZZZZZZ`, `YYYYYYYY`) hanno la forma valida e il setup verifica che non
esistano: chiavi malformate (con 0/1/O o minuscole) farebbero ignorare all'API il filtro itemKey, che restituirebbe
la libreria intera.

**Run concorrenti** (`test/live/lock.mjs`, usato dalla suite e, in CI, dall'agente smoke): all'avvio la run crea la
collezione `mzt-lock <runId>`; se ne trova una più vecchia e non scaduta di un'altra run (di un'altra PR, dell'agente,
di un altro worktree), aspetta con backoff (15 s, 30 s, poi ogni 60 s) fino a 25 min (`ZOTERO_LIVE_LOCK_WAIT_MIN`; 70 min in CI) e poi
si ferma con "test account busy". I lock con runId più vecchio di 180 min (attesa in CI più la run più lunga, l'agente smoke) sono di run morte e vengono rimossi.
I log riportano `[lock] acquired <runId>` e `[lock] released <runId>` (LK-01, `test/utils/lock.test.ts`). Vince il lock creato per primo, ordinato per `version` Zotero della collezione (versione della libreria alla scrittura, sempre crescente). L'ordine per runId lasciava vincere entrambe le run quando quella con il runId più vecchio creava il lock un attimo dopo (live-tests e agente smoke della PR #26, 2026-10-12: l'agente ha lavorato durante la suite e i conteggi finali sono cresciuti di 6 voci e 2 collezioni). LK-02: la run con il runId più vecchio che crea il lock dopo aspetta; LK-03: versione letta dall'elenco se manca nella risposta di creazione. Le collezioni di lock sono escluse dai conteggi prima/dopo (una run in attesa
crea la sua mentre un'altra è fra i due conteggi). Rilascio a fine teardown (sempre) e nella modalità solo pulizia. I DELETE
ritentano fino a 8 volte con jitter sui 412 (versione della libreria cambiata nel frattempo).

**Pulizia dopo una run interrotta** (processo ucciso, timeout; usa il reporter di default, così non sovrascrive
`.vitest/live-report.json` della run da pulire): `npm run test:live:cleanup -- [runId…]` con le stesse
variabili della suite (in safe mode compresa). Senza argomenti pulisce le run che hanno lasciato in `.vitest/` il
marcatore `live-run-<runId>.json` o il registro `live-created-<runId>.jsonl`; stesse regole sui marcatori del teardown.

**Pulizia degli avanzi** (solo account dedicato: sentinella + username, mai in safe mode): run più vecchie di 6 h
riconosciute dal nome stretto `mzt-<8-9 caratteri base36>-<4 hex>` di collezioni e titoli o dal tag `mzt-run:<runId>`;
si cancellano anche le voci delle loro collezioni (voci da DOI, allegati standalone). Stessa pulizia nella libreria del
gruppo `mzt-test…` quando è verificata (riga "pulizia avanzi gruppo"), perché una run interrotta lascia avanzi anche lì.

| File | Casi |
|---|---|
| `get-user-id` | LIVE-GUI-01 libreria della chiave; 02 senza arguments / argomenti in più; 03 15 tool |
| `search-library` | LIVE-SL-01 query sul titolo → solo quella voce; 02 sort title asc sul prefisso della run; 03 5 sort × 2 direzioni; 04 limit 500 → min(100, totale); 05 dateAdded desc ordinato; 06 nessun risultato senza isError; 07 argomenti non validi; 08 override utente, gruppo senza id, gruppo inesistente |
| `get-collections` | LIVE-GC-01 collezione e sottocollezione con genitore; 02 include_trashed; 03 override e tipo sbagliato |
| `get-collection-items` | LIVE-GCI-01 collezione con 3 voci note + inclusione delle fixture; 02 sottocollezione; 03 105 voci (paginazione >100); 04 allegato standalone escluso/incluso; 05 vuota; 06 inesistente / chiave mancante; 07 override |
| `get-items-details` | LIVE-GID-01 campi per tipo e creators; 02 include_abstract; 03 105 chiavi; 04 sconosciute / miste (trovate più `not_found`); 05 override, lista vuota |
| `get-item-fulltext` | LIVE-GIF-01 PDF importato → testo; 02 max_characters; 03 chiave dell'allegato; 04 webpage; 05 URL senza allegati; 06 nessun PDF; 07 inesistente / max_characters non numerico; 08 solo un link a un PDF → guida al link (LIVE-STALE-3) |
| `create-collection` | LIVE-CC-01 primo livello; 02 sottocollezione; 03 nome ripulito + override; 04 nome vuoto; 05 genitore inesistente leggibile |
| `add-items` | LIVE-AI-01 8 tipi con collezione e tag, campi verificati via API; 02 55 voci in due POST; 03 tipo/campo/creatorType non validi, lista vuota; 04 collezione inesistente leggibile |
| `add-items-by-doi` (soft) | LIVE-AID-01 metadati Crossref, nessun allegato; 02 DOI inesistente; 03 parziale; 04 forma URL `https://doi.org/…` risolta da doi.org, campo DOI senza prefisso; 05 DOI OA → PDF allegato; 06 lista vuota |
| `add-linked-url-attachment` | LIVE-ALU-01 figlio con content_type e tag; 02 standalone in due collezioni; 03 override; 04 URL non valido, genitore inesistente |
| `import-pdf-to-zotero` | LIVE-IP-01 PDF figlio: size, md5, fulltext, verificati via API; 02 standalone con filename/titolo/collezioni; 03 nome da Content-Disposition; 04 HTML come PDF → not_pdf, nessun allegato; 05 text/html (LIVE-STALE-5); 06 404; 07 genitore inesistente, URL non valido; 08 override |
| `find-and-attach-pdfs` (soft per 04/05) | LIVE-FA-01 entrambi/nessuno; 02 chiave sconosciuta e senza DOI; 03 skipped e skip_if_attachment_exists false; 04 collezione dry_run → processed = voci regolari create (LIVE-STALE-2); 05 collezione reale (LIVE-STALE-4); 06 override |
| `delete-items` | LIVE-DI-01 UNSAFE none rifiutato; 02 30 voci cancellate definitivamente (non nel cestino); 03 solo sconosciute (LIVE-STALE-1); 04 mista; 05 51/0 chiavi; 06 genitore → anche il figlio; 07 override; 08 (solo account dedicato) chiavi malformate o di traversal → errore di validazione, nessuna cancellazione |
| `delete-collection` | LIVE-DC-01 UNSAFE none/items rifiutato; 02-03 (solo fuori safe mode) cancellata con la voce che resta, chiave sconosciuta/vuota |
| `inject-citations` | LIVE-IC-01 5 stili su voci reali: `expectValidDocx` + URI risolti via API (stessa chiave e titolo); 02 chiave inesistente (isError che la nomina, nessun output); 03 override |
| `skill-inject` | LIVE-SK-01 apa/ieee: inject.js con metadati da get_items_details e library_path da get_user_id, docx valido, URI risolti, stesso JSON di inject_citations |
| `groups` | solo con gruppo `mzt-test…`: LIVE-GRP-01 server in modalità gruppo dall'ambiente (`ZOTERO_LIBRARY_TYPE=group`, `ZOTERO_LIBRARY_ID`): get_user_id → `groups/<id>` con lo user_id dell'utente (get_user_id descrive sempre la libreria dell'ambiente, gli argomenti per chiamata non si applicano); 02 create_collection, add_items, get_collection_items e inject nel gruppo per singola chiamata; 03 server in modalità gruppo senza argomenti di libreria: legge collezione e voce create in 02, override per chiamata verso la libreria utente |

### In CI (`.github/workflows/claude-agent-smoke.yml`, "Live tests + agent smoke")

Suite dal vivo e agente smoke sono **un solo workflow** (il file tiene il nome `claude-agent-smoke.yml` perché la regola
di federazione del job dell'agente lo nomina): `changes` (`scripts/live-scope.mjs`) → `live-tests-run` → [posto per un
futuro job `word-render`] → `agent-smoke-prepare`/`-run`/`-verify` (`-comment` sulle PR) solo se la suite dal vivo è
passata (nessun costo dell'agente quando il live è rosso) → verdetti `live-tests` e `agent-smoke` → `agent-smoke-cleanup`
(sempre) e `live-tests-weekly-issue` (solo per i fallimenti del venerdì). Ambito: PR dello stesso repo per file cambiati
(ogni modifica rilevante per l'agente fa girare anche il live); push su `main` e venerdì `23 3 * * 5` solo live; a mano
con l'input `scope` (`live+agent`, predefinito, o `live`), anche da deps-update.yml sul branch delle dipendenze.
Il job `live-tests-run` gira sulle PR dello stesso repo (saltato per le PR da fork e di Dependabot, che non hanno i
secret), su `main`, ogni venerdì e a mano, nell'environment
`zotero-live`. Il check obbligatorio è il job `live-tests` (senza environment), che gira sempre tranne quando l'intero
workflow è annullato (una run sostituita risulta "cancelled", non rossa) e non viene mai saltato (un check obbligatorio
saltato vale come superato): fallisce se `changes` non è riuscito o se `live-tests-run` è fallito o scaduto (un job
scaduto termina "cancelled"); passa senza la suite solo se `changes` è riuscito e non ha trovato file rilevanti, o per
fork e Dependabot. Concurrency per workflow e PR/ref senza `cancel-in-progress`: una
run in corso non viene annullata da un push più recente, che resta in coda; un annullamento a metà suite aveva lasciato
voci e collezioni sull'account di test (2026-10-12, run mv4hpbf7-d515: 2 collezioni rimosse dalla pulizia degli avanzi più vecchi di 6 h
alla prima run dopo le 6 h, base tornata a `collections:1`). Riprodotto con un annullamento voluto (run
mv4wuscp-4e2f: 5 voci e 2 collezioni rimaste): i processi della suite sopravvivevano allo step annullato e creavano
voci mentre la pulizia era già passata. Ora lo step di pulizia ferma prima i processi `node` della suite
(SIGINT, poi SIGKILL dopo 15 s), la pulizia (teardown e solo pulizia) ripete le passate finché non restano voci con il
tag né collezioni con il prefisso della run (al massimo 4, a 5 s), e il lock viene liberato solo dopo la pulizia. Una run che trova l'account dedicato non pulito all'avvio (voci, o collezioni oltre la sentinella) lo scrive nel log e come avviso GitHub (`::warning`): una pulizia fallita dopo un annullamento altrimenti si vedrebbe solo come "cancelled" nella sua run; le run di PR diverse e dell'agente si serializzano sul lato Zotero con
`test/live/lock.mjs` (attesa fino a 70 min, poi "test account busy": l'agente smoke tiene l'account fino a circa 80 min), così le PR in stack non si annullano a vicenda i
check obbligatori. Job di 100 min, step dei test di 85 (attesa del lock compresa). Il filtro sui file è un job
(`changes`), non `on.paths`; con file non rilevanti il job `live-tests` passa senza la suite.
Senza i secret lo step "Require the test account" fallisce invece di far passare una suite tutta saltata;
con più di 2 casi soft saltati (`ZOTERO_LIVE_MAX_SOFT_SKIPS`) la run fallisce.
Lo step dei test (18 min) è più corto del job (30 min); poi, sempre:
- **solo pulizia** (`npm run test:live:cleanup`, cioè `ZOTERO_LIVE_CLEANUP_ONLY=1`): nessuna fixture, tutti i test saltati; pulisce le run indicate in
  `ZOTERO_LIVE_CLEANUP_RUN_IDS` e quelle interrotte (file `.vitest/live-run-<runId>.json` scritto all'avvio e tolto a
  fine teardown), con le stesse regole sui marcatori; sull'account dedicato anche gli avanzi > 6 h;
- `test/live/scrub-report.mjs`: copia report e riepilogo mascherando chiave, user id, username, id e nome del gruppo ed
  email, e fallisce (togliendo l'output) se un segreto sopravvive o se c'è un gruppo senza `ZOTERO_TEST_GROUP_NAME`;
  l'artifact (7 giorni) si carica solo dopo uno scrub riuscito. Il nome del gruppo lo legge, all'inizio del job,
  `test/live/mask-group-name.mjs` (API con la chiave di test, mai stampato, `::add-mask::`, esportato in `$GITHUB_ENV`).
Un job separato con `issues: write` apre o aggiorna la issue "Test dal vivo settimanali falliti" solo per i fallimenti
della run del venerdì, con il link alla run e i nomi dei test (mai dati).

## Agente smoke (`.github/workflows/claude-agent-smoke.yml`, skill `.claude/skills/test-mcp-zotero`)

Un agente Claude vero (Claude Agent SDK `@anthropic-ai/claude-agent-sdk`, eseguito da `scripts/run-agent.mjs` con la
configurazione `.github/agents/agent-smoke.json`, modello `claude-sonnet-5-5`, autenticazione con Workload Identity Federation di Anthropic: variabili `ANTHROPIC_*` dell'environment
`zotero-live`, `id-token: write`, nessuna API key) carica la skill di progetto e usa il server come un utente. Il prompt è solo "Carica la skill
test-mcp-zotero e segui il percorso. Diff in agent-out/diff.txt.". **L'esito non è dell'agente**: lo decide
`test/live/verify-claims.mjs`, poi la stessa pulizia di live-tests (solo pulizia, sul runId dell'agente).
Gira sulle PR (contestuale alle modifiche) e a mano (`workflow_dispatch` con `scope: live+agent`, ad esempio su `main`
dopo un merge), sempre nello stesso workflow della suite dal vivo e solo dopo che questa è passata.
`prepare.mjs` svuota `agent-out/` e `agent-audit/` prima di scrivere il contesto, gli hook marcano ogni riga di audit
e di negazione con il runId e verify-claims rifiuta righe di un'altra run. Il contesto di riferimento è la copia scritta
da prepare in `agent-audit/` (in CI portata accanto all'audit come `audit-context.json`): `agent-out/context.json`, che
l'agente potrebbe modificare, deve essere identico, altrimenti la run non è verificata; con l'audit nella cartella
dell'agente (CI) solo `audit-context.json` vale come copia fidata. La verifica gira sempre dopo un job dell'agente
riuscito (un audit mancante la fa fallire: mai verde senza evidenze) e, dopo un job fallito, solo se esiste l'audit,
per riportare i problemi di sicurezza e robustezza delle chiamate fatte (il check `agent-smoke` resta rosso); dopo un
job fallito senza audit (nessuna chiamata registrata, ad esempio credito esaurito) lo step la salta con un avviso.

- **Job, credenziali separate**: `agent-smoke-prepare` (nessun id-token) fa `npm ci --ignore-scripts`, build,
  `prepare.mjs --mode ci` e prende il lock; `agent-smoke-run` è l'unico job con `id-token: write` (scambio della
  federazione, fatto dall'action, che toglie `ACTIONS_ID_TOKEN_REQUEST_*` all'agente) e non esegue npm;
  `agent-smoke-verify` (nessun id-token) verifica i claims e pubblica il report mascherato; `agent-smoke-cleanup`
  (`always()`, anche dopo un annullamento) pulisce la run e rilascia il lock senza decidere l'esito; `agent-smoke` è il
  check obbligatorio (senza environment): gira sempre tranne quando l'intero workflow è annullato, non viene mai
  saltato, fallisce se `changes` non è riuscito o se prepare, agente o verifica sono falliti o scaduti, e passa senza
  agente solo se `changes` non ha trovato file rilevanti, se prepare è saltato (PR da fork, Dependabot, o attore umano
  diverso dal proprietario: il riepilogo indica quale condizione) o su una PR il cui branch di base non ha ancora la
  skill. Fuori dalle PR una skill mancante è un errore, e sulle PR anche un branch di base non risolvibile.
  Gira in automatico solo per modifiche del proprietario del repo o del workflow delle dipendenze (`github-actions[bot]`): l'agente consuma credito API, quindi le modifiche di altri si collaudano a mano, dopo la revisione. Le PR da fork non ricevono secret e richiedono comunque l'approvazione del proprietario prima di far partire qualsiasi workflow.
- **Preparazione** (`test/live/agent/prepare.mjs`, uguale in CI e in locale): `agent-out/context.json` (runId, tag,
  prefisso, modalità, safe mode, gruppo, chi pulisce) e `agent-out/diff.txt` (file cambiati e patch troncata). In CI
  si ferma con errore, prima che l'agente parta, se la chiave non è di `ZOTERO_TEST_USERNAME` o se manca la sentinella
  `__mzt_disposable__`; passa all'agente un gruppo solo se il suo nome inizia con `mzt-test`. Se prepare fallisce o viene
  annullato, rilascia subito il lock. L'action accetta come attore solo `github-actions[bot]` oltre agli umani
  (`allowed_bots`), per le run avviate da deps-update.yml.
- **Ambiente preparato da chi avvia la sessione** (mai dall'agente, `test/live/agent/README.md`): server MCP dal template
  `test/live/agent/mcp.template.json` (in CI reso da `render-mcp.mjs` in `$RUNNER_TEMP`, in locale passato a
  `--mcp-config` così com'è: Claude Code espande `${VAR}`), `--tools "Skill,Read,Edit,Write,Bash"` (Write serve per
  creare file: con solo Edit l'agente non può crearli, provato), `--permission-mode dontAsk` (ciò che le regole non
  ammettono è negato senza chiedere) e gli hook di `.claude/agent-smoke/settings.json` (sulle PR `.claude/` viene dal
  branch di base): PreToolUse su Bash che ammette solo le due forme esatte dei wrapper (niente concatenazioni, pipe,
  redirezioni, sostituzioni, variabili, altri interpreti, opzioni di node, percorsi fuori da `agent-out/`); PreToolUse
  sulle cancellazioni che ammette solo chiavi create dalla run (lette dall'audit) o inesistenti
  (`ZZZZZZZZ`/`YYYYYYYY`), mai delete_collection in safe mode; PostToolUse/PostToolUseFailure che scrive ogni chiamata
  Zotero e ogni comando Bash con il risultato in `agent-audit/audit.jsonl` (le negazioni in `denials.jsonl`), fuori
  da `agent-out/` dove l'agente scrive. Un errore dell'hook nega. Il contesto per gli hook (`agent-audit/context.json`)
  lo scrive prepare.mjs (in CI il job dell'agente lo copia prima di avviarlo).
- **Strumenti dell'agente**: `Skill`, `mcp__zotero__*`, `Read`/`Edit` (cioè anche Write) solo in `agent-out/`, e due soli
  comandi, entrambi wrapper che accettano solo percorsi dentro `agent-out/`: `node test/live/agent/make-docx.mjs` (crea il
  docx con i `<zcite>`, anche in linea nel testo o spezzati su tre run, più file con una sola chiamata) e `node test/live/agent/inject.mjs` (chiama `inject.js` della skill prodotto). WebFetch/WebSearch
  negati; 160 turni, tetto di 3 USD (`maxBudgetUsd`; una run costa circa 0,35-0,45 USD), `MCP_TOOL_TIMEOUT` 120 s, step 45 min, job 55 min (costo atteso: vedi
  il collaudo locale sotto; i limiti sono circa il doppio). La chiave Zotero sta solo nel file
  di config MCP in `$RUNNER_TEMP`, cancellato dopo lo step, mai nell'ambiente dell'agente. Gli artifact fra i job
  (repo pubblico) passano da `test/live/agent/redact.mjs`: user id e group id sostituiti da segnaposto numerici (ripristinati
  nel job successivo), username, nome del gruppo, chiave ed email rimossi; lo step fallisce, e non carica nulla, se ne
  resta uno (anche dentro i docx) o se c'è un gruppo senza il suo nome; conservazione 1 giorno. Ogni job che usa
  l'account comincia mascherando il nome del gruppo (`mask-group-name.mjs`).
- **Riepilogo**: dopo lo scrub, `test/live/agent/summary.mjs` scrive il Job Summary (verdetto, problemi e avvisi,
  tabella degli scenari, esplorativi X1–X5 con le chiamate come le ha registrate l'audit, friction, turni/durata/costo)
  dalla copia scrubbata; non scrive nulla se nel testo, pubblicato o prima dell'escape, resta un segreto dell'ambiente,
  il nome del gruppo o un `users|groups/<id>` diverso dai segnaposto. Il job
  `agent-smoke-comment` (PR dello stesso repo, solo `pull-requests: write`, niente checkout, npm o segreti) ricontrolla
  marcatore e percorsi e crea o aggiorna un solo commento sulla PR (marcatore `<!-- mcp-zotero-agent-smoke -->`).
- **Sulle PR** il job dell'agente ripristina `.claude/`, `CLAUDE.md` (e `.mcp.json`, `.claude.json`, `CLAUDE.local.md`) dal branch di base (configurazione dell'agente
  scritta nella PR = non fidata): gira la skill del branch di base. Se lì la skill non c'è ancora (la PR che la
  introduce), il job lo segnala e salta; il primo collaudo vero è l'avvio manuale da `main` dopo il merge.
- **Percorso**: P0 precondizioni (15 tool, get_user_id, sentinella o safe mode); F0 sonde dei guardrail (un comando
  Bash concatenato con `&& ls` e `delete_items` di `XXXXXXXX`, chiave inesistente: entrambi devono essere negati dagli
  hook); F1 DOI con PDF OA; F2 collezione,
  sottocollezione, add_items di tre voci (libro con autore istituzionale, articolo con titolo e autori non ASCII,
  report senza data né autori); F3 link e fulltext (messaggio "linked URL"); F4 ricerca, collezione, dettagli;
  F5/F6 **parità esplicita inject_citations ⇄ inject.js a ogni run**: lo stesso documento (citazione singola,
  multi-chiave, locator+prefix+suffix, zcite in linea a metà frase, zcite spezzato su tre run; variante con `num` per
  ieee e vancouver) iniettato dai due produttori in tutti e 5 gli stili, un `compare_group` per stile; F7 gruppo (solo
  con gruppo, con la coppia di parità sul gruppo); F8 cancellazione; F9 casi limite dei `<zcite>` con i due produttori
  (chiave sconosciuta ben formata → stesso errore, nessun output; chiave malformata `../items` → stesso rifiuto;
  `keys="A, B"`; chiave ripetuta; documento senza zcite); F10 casi limite degli input dei tool (array vuoti, stringhe di soli spazi,
  limiti 0/1/max/max+1 dove lo schema li fissa: delete_items 1..50, add_items almeno 1, search_library massimo 100);
  poi gli scenari T-… per i file toccati, fino a 5 **scenari esplorativi** X1..X5 scelti dall'agente in base al diff
  (null, tipi sbagliati, vuoti, spazi, stringhe lunghissime, unicode, limiti, duplicati, valori validi e non validi
  insieme), la valutazione d'uso e `agent-out/claims.json` (`schema_version: 2`).
- **verify-claims** (exit 0/1/2, `verdict.json` e riepilogo nello step summary): scenari fissi presenti e non falliti
  (F1 può essere `skipped` con motivo); ogni oggetto dichiarato esiste con i marcatori della run e lo stato dichiarato
  (titolo, DOI, collezione, genitore, link_mode, PDF); ogni cancellazione dichiarata ha una chiave nel formato Zotero,
  è stata creata da una chiamata di tool Zotero della run o compare nei `deleted_keys` di delete_items / nel
  `collection_key` di delete_collection riuscito (lettura strutturale della trascrizione con `--transcript`, mai una
  semplice occorrenza nel testo, ad esempio in `not_found`) e risponde 404; ogni docx sta in
  `agent-out/`, passa `validateDocx` (le differenze di testo contano negli stili autore-anno) e cita solo voci create
  dalla run; in locale non restano voci con il tag.
  **Parità**: i documenti di uno stesso `compare_group` (uno per produttore, stesso stile, libreria e `source`) devono
  avere lo stesso JSON di ogni campo tranne il `citationID` casuale (citationItems con uris, itemData, locator, label,
  prefix, suffix; properties con formattedCitation), lo stesso testo visibile di ogni citazione e di ogni paragrafo e gli
  stessi campi di bibliografia; in ogni stile serve un gruppo verificato sul documento di parità (lo script legge il
  sorgente: multi-chiave, locator+prefix+suffix, in linea, spezzato, `num` su ogni tag negli stili numerici; nelle
  citazioni almeno un autore istituzionale, una voce senza data né autori, metadati non ASCII), più il gruppo di test se
  F7 è passato e i due documenti di F9. **Evidenza dagli hook** (`--audit`, exit 2 senza): F0 (le due sonde fra le
  negazioni; altre negazioni = avvisi), F9 (stesso errore per la chiave sconosciuta, stesso rifiuto per quella
  malformata, 0 citazioni senza zcite) e F10 (esiti attesi per ogni chiamata fissa) si controllano sulle chiamate
  registrate dall'audit; ogni chiamata esplorativa dichiarata si cita con il `call_no` che l'hook di audit le ha dato
  (e comunicato all'agente): deve esistere, essere dello strumento dichiarato e avere l'esito dichiarato (`is_error`);
  i numeri dell'audit vanno da 1 a n senza ripetizioni né buchi (un audit senza numeri, degli hook del branch base
  precedenti, si confronta ancora per argomenti identici), massimo 5
  scenari, verdetto `bug` = check fallito, `unclear` = avviso nel riepilogo. Con `--transcript` (in CI il file di
  esecuzione) ogni chiamata Zotero della trascrizione deve stare nell'audit o fra le negazioni (altrimenti gli hook non
  erano attivi) e il server zotero dev'essere connesso all'avvio.
  **Robustezza** su tutti i risultati Zotero dell'audit: server connesso all'avvio, ogni chiamata con un
  risultato, nessuna connessione chiusa/timeout/crash, risultati riusciti in JSON MCP, nessun risultato con `error` senza
  isError, nessun `[object Object]`, `undefined`, `NaN`, stack trace, errore JavaScript o errore grezzo di JSON.parse nel testo (esclusi i campi di
  contenuto della libreria e i token che l'agente stesso ha inviato in quella chiamata; `undefined`/`NaN` ammessi negli
  errori di validazione), nessun crash di inject.js. **Sicurezza** delle scritture: ogni chiave passata a un tool di
  scrittura è ben formata e creata prima dalla run (o finta), niente scritture sul gruppo in safe mode, mai
  delete_collection in safe mode. I messaggi riportano solo chiavi, tool e percorsi, mai contenuti della libreria.

| ID | Scenario (`test/utils/verify-claims.test.ts`) | Atteso |
|---|---|---|
| VC-01 | trascrizione con create_collection, add_items, add_items_by_doi (con PDF), add_linked_url_attachment, delete_items, delete_collection | chiavi create e cancellate lette dai risultati dei tool |
| VC-02 | chiave ripetuta solo in `not_found`, in un risultato d'errore o in un tool non Zotero (Write) | non attribuita né come creata né come cancellata |
| VC-03a | trascrizione pulita: "undefined"/"TypeError"/"NaN" solo in titoli e testo pieno, errore con isError, errore di validazione "received undefined", rifiuto di inject.js | nessun problema di robustezza |
| VC-03b | connessione chiusa, timeout, tool non più disponibile, `error` senza isError, risultato non JSON, `[object Object]`, `undefined`, `NaN`, stack trace, TypeError, errore grezzo di JSON.parse ("Unexpected token", "is not valid JSON", "Unexpected end of JSON input"), crash di inject.js | un problema per caso |
| VC-03c | `NaN` nel titolo inviato dall'agente e restituito | nessun problema |
| VC-03d | server zotero `failed` all'avvio, chiamata senza risultato | due problemi |
| VC-04a | scritture su chiavi create prima, chiave finta, find_and_attach_pdfs in dry_run su chiave estranea | nessun problema |
| VC-04b | delete_items su voce preesistente, allegato a voce preesistente, find_and_attach_pdfs reale su collezione estranea, chiave malformata a delete_items, scrittura nel gruppo in safe mode, delete_collection in safe mode | un problema per caso |
| VC-04c | fuori safe mode, gruppo diverso da quello di test / uguale | problema / nessuno |
| VC-05a | F9 e F10 completi con gli esiti attesi | nessun problema |
| VC-05b | inject.js accetta la chiave malformata, nessun avviso per la chiave sconosciuta, documento senza zcite non provato, 51 chiavi accettate, 50 chiavi rifiutate, limit 101 con più di 100 voci, chiamata F10 mancante | un problema per caso |
| VC-06a/b | esplorativi ok (ordine delle chiavi indifferente, comando Bash senza description), assenti, `unclear` | nessun problema; `unclear` = avviso |
| VC-06c | verdetto `bug`, 6 scenari, id non valido o ripetuto, chiamata mai fatta, argomenti diversi, rationale mancante, verdetto non previsto, non array | problema |
| VC-07 | make-docx: tag in linea e spezzato riconosciuti dal sorgente, `num` su ogni tag, spazi e chiave ripetuta (F9), percorso fuori agent-out e `"` nei valori rifiutati | caratteristiche lette correttamente; exit 2 |
| VC-08 | 5 stili: inject_citations (server con Zotero finto) e inject.js (via inject.mjs, metadata da get_items_details) sul documento di parità | docx validi, 5 citazioni, impronte identiche, copertura istituzionale/senza metadati/non ASCII, testo attorno ai tag in linea e spezzato conservato, una bibliografia |
| VC-08b | impronta alterata: citationID diverso / locator / testo visibile / bibliografia | nessuna differenza / percorso della prima differenza |
| VC-09a/b | script completo senza rete: senza `--audit`; claims incompleti, cancellazione non attribuibile, chiamata della trascrizione assente dall'audit | exit 2; exit 1 e `verdict.json` con scenari mancanti, sicurezza, sonde F0, buco dell'audit, F10, parità, F9; la chiave non compare nell'output |
| VC-09c | riga d'audit con un runId diverso | problema "evidence from another run" (in VC-09b) |
| VC-11 | `agent-out/context.json` identico alla copia degli hook / modificato (cleanup) | nessun problema sul contesto / "differs from the copy written before the agent started" |
| VC-11b | nessuna copia del contesto accanto all'audit | "run context missing next to the audit" |
| VC-12 | audit nella cartella dell'agente (come in CI) senza / con `audit-context.json` | "trusted run context missing" / nessun problema sul contesto |
| VC-10a | audit degli hook → chiamate: chiavi create, robustezza, chiamata esplorativa Bash | come dalla trascrizione |
| VC-10b | chiamata Zotero della trascrizione assente da audit e negazioni / negata | problema / nessuno |
| VC-10c | sonde F0 negate; altra negazione; nessuna negazione | nessun problema; avviso; due problemi |
| VC-10d | numerazione dell'audit: assente, 1..3 in disordine, ripetuta, con un buco, voce senza numero | nessun problema / un problema per caso |
| VC-06d | esplorativi citati per `call_no` (tool con o senza prefisso, Bash, esito), argomento non ASCII mai ridigitato | nessun problema |
| VC-06e | `call_no` inesistente o non intero, strumento diverso, Bash dichiarato come tool Zotero, `is_error` mancante o diverso, argomenti al posto di `call_no` con audit numerato | un problema per caso |
| VC-06f | audit senza numeri | confronto per argomenti (uguali / diversi), `call_no` non trovato |
| VC-06g | stesso `call_no` in due scenari; `call_no` di una chiamata che prova un controllo fisso (F9/F10); input lungo e comando Bash | problema per i due casi; nel verdetto (`exploratory_calls`) ogni chiamata citata con l'input registrato dall'audit (solo il comando per Bash), troncato a 300 caratteri |
| VC-06h | prova dei controlli fissi (`edgeCaseEvidence`) | la prima chiamata che soddisfa ogni riga F9/F10 |

### Hook dell'agente smoke (`test/utils/agent-hooks.test.ts`), template MCP (`test/utils/render-mcp.test.ts`) e guardia sugli output committati (`test/utils/check-tracked-artifacts.test.ts`, step di `test.yml`)
| ID | Scenario | Atteso |
|---|---|---|
| AH-01a | make-docx con uno o più output e spec JSON (anche `../items` dentro lo spec), inject.mjs con `users/<id>`, `groups/<id>`, id numerico | ammessi |
| AH-01b | `;`, `&&`, `\|\|`, pipe, `>`, `<`, `2>&1`, `$( )`, backtick, `&` o backslash nello spec, a capo, virgolette doppie, prefisso di variabile, `node -e/--eval/--require/--import`, node con percorso assoluto, bash, altro script, `./`, doppio spazio, `agent-out/../`, percorso assoluto, metadata non json, opzione in più, stile o libreria non validi, commento, argomento dopo lo spec, spec senza virgolette, comando vuoto | negati |
| AH-01c | `run_in_background`, input senza comando | negati |
| AH-02a | delete_items di chiave creata, di 51 chiavi finte, di `[]` / di chiave non creata (sonda F0), malformata, delete_collection in safe mode, gruppo in safe mode | ammessi / negati con il motivo |
| AH-02b | fuori safe mode: delete_collection di collezione creata, gruppo diverso da quello di test, contesto mancante | ammesso; negati |
| AH-02c | chiavi create lette dall'audit (create_collection, add_items_by_doi con PDF; esclusi errori, tool di lettura, Bash) | solo le chiavi create |
| AH-02d | testo dei risultati: stringa, blocchi MCP, `{content}`, Bash `{stdout, stderr}` | testo concatenato |
| AH-03a/b | bash-guard come processo: comando ammesso / negato / stdin non JSON | nessun output / `permissionDecision: deny` con motivo e riga in denials.jsonl / negato |
| AH-03c | audit.mjs (PostToolUse, PostToolUseFailure, tool non registrato) poi delete-guard | audit con le due chiamate Zotero e `call_no` 1, 2, restituiti all'agente come `additionalContext` (nessun output per il tool non registrato); chiave creata ammessa, altra negata |
| AH-03f | 12 hook di audit in parallelo | `call_no` 1..12 senza ripetizioni; il numero comunicato è quello della voce |
| AH-03g | contratto dell'output di audit.mjs (PostToolUse e PostToolUseFailure) | exit 0, un solo oggetto JSON con solo `hookSpecificOutput` {`hookEventName` = evento, `additionalContext` "audit call_no N (…)"}; verificato una volta dal vero con `claude -p` e con l'Agent SDK (il modello cita la nota) |
| AH-03d | delete-guard senza `agent-audit/context.json` | negato |
| AH-03e | `.claude/agent-smoke/settings.json` | tre hook sugli eventi e matcher giusti, comandi via `$CLAUDE_PROJECT_DIR`, timeout |
| TA-01 | percorsi tracciati sotto `agent-out/`, `agent-audit/`, `.vitest/`, `live-artifacts/` a qualunque profondità; file spostati: riga d'audit, contesto dell'agente, log delle negazioni (anche solo Bash), claims, trascrizione (`session_id` + tool Zotero), riepilogo e report dal vivo, forme con virgolette escape | segnalati (solo percorso e motivo) |
| TA-02 | codice e test che costruiscono gli stessi campi come oggetti, esempio di claims nella skill, voce illeggibile | nessun problema |
| WL-01 | condizioni dello step di verify-claims e dell'avviso "nessuna chiamata" (`test/utils/workflow-logic.test.ts`) | verify sempre dopo un agente riuscito, dopo un fallito solo con l'audit |
| WL-02 | job obbligatori `live-tests` e `agent-smoke` | `!cancelled()`, controllo su `changes`, verdetto dell'agente che richiede verify riuscito |
| WL-03 | concurrency di live-tests e agente smoke | `cancel-in-progress: false` |
| WL-04 | job prepare, agent-run, verify, cleanup e live-tests-run | primo step con segreti Zotero = "Mask the test group name" |
| WL-05 | upload degli artifact e Job Summary; job `comment` | solo dopo uno scrub riuscito; solo `pull-requests: write`, PR dello stesso repo, niente checkout/npm/segreti/environment, ricontrollo dei percorsi |
| WL-06 | `release.yml` npm-publish, test, skill-zips | npm-publish dopo skill-zips, checkout del tag della release, controllo versione = tag prima di `npm publish`; test sul tag se esiste già; skill-zips crea la release, poi checkout del tag con lo stesso controllo, poi gli zip |
| WL-06b | mascheramento del nome del gruppo nel job di pulizia dell'agente | `continue-on-error` (la pulizia non salta mai), solo lì |
| WL-06c | job della issue settimanale; `skill-zips` che crea una release | download del report non bloccante, `gh` con `timeout 60` / versione di package.json = tag prima di creare la release, tag sul commit provato (`--target "$GITHUB_SHA"`) |
| WL-07 | workflow unico live + agente | `live-tests.yml` non esiste più; `changes` con `live-scope.mjs`; prepare dopo `live` riuscito; verdetti `live-tests` e `agent-smoke` (rosso se il live non è passato); `id-token`, `issues: write`, `pull-requests: write` ciascuno in un solo job; cron del venerdì; input `scope`; posto per `word-render`; timeout su ogni job e step, azioni fissate per SHA; deps-update avvia una sola run con `scope=live+agent` |
| WL-08/08b | `scripts/live-scope.mjs`: PR solo docs, sul codice, sulla suite dal vivo, solo sulla skill dell'agente, sul workflow; push; schedule; manuale senza input, `live`, `live+agent`; scope sconosciuto; processo | live/agent attesi (la skill dell'agente fa girare anche il live); errore; `live=…`/`agent=…` per `$GITHUB_OUTPUT` |
| CR-01a..d | `mask-group-name.mjs` (`test/utils/ci-report.test.ts`): lettura con header e timeout; 503 poi 200, 404, rete giù, nome assente; output `::add-mask::` e `$GITHUB_ENV`; processo senza gruppo, senza chiave, id non numerico | nome; ritenta solo 429/5xx/rete, errori senza il nome; delimitatore casuale, a capo rifiutato; no-op / exit 1 |
| CR-02a..c | scrub-report e redact con il nome del gruppo; senza `ZOTERO_TEST_GROUP_NAME` ma con un gruppo | nome, id e username mascherati / token; exit 1 senza output |
| CR-03f | segreto con `&` e `<` (nome del gruppo) nel testo dell'agente | non visibile dopo l'escape, trovato nel testo grezzo: il riepilogo non si scrive |
| CR-03a..e | `agent/summary.mjs`: riepilogo completo (esplorativi con le chiamate registrate dall'audit); senza verdetto; testo dell'agente con HTML, menzioni, `\|`, a capo, troppo lungo; `runStats`; controllo prima di pubblicare (segnaposto, user id, nome del gruppo, `users/<id>` senza variabili, gruppo senza nome); processo pulito / con un id | marcatore, tabelle, statistiche; titolo "no verdict"; testo inerte e troncato; ultimo `result`; problemi giusti; file scritto / exit 1 senza file né id nel messaggio |
| RM-01..03 | template MCP: variabili e default, node e server assoluti, opzionali vuote omesse; variabile obbligatoria mancante; nessun valore nel template | config concreta; errore che la nomina; solo segnaposto |
| RA-01..02 | runner Agent SDK (`scripts/run-agent.mjs`, `test/utils/run-agent.test.ts`): config dello smoke con `${RUNNER_TEMP}`; variabile o campo obbligatorio mancante | percorsi espansi, output fuori dal workspace; errore |
| RA-03 | federazione e ambiente dell'agente | attiva solo con rule id e organization id; `ACTIONS_ID_TOKEN_REQUEST_*` rimossi |
| RA-04 | opzioni SDK di smoke e deps | `dontAsk`, solo impostazioni di progetto, config MCP passata per percorso; deps con il solo MCP di Context7 (due tool), senza schema, push/gh/publish negati |
| RA-05 | esito: errore API, nessun risultato, schema senza output strutturato | fallimento con il motivo (errore e stato HTTP) |
| CP-01 | testi pubblicati dall'agente dipendenze (`scripts/check-public-text.mjs`, `test/utils/check-public-text.test.ts`): JWT, chiave Anthropic, token GitHub e npm, credenziali in URL, chiave privata | segnalati (solo il tipo) |
| CP-02 | testo normale di PR o issue delle dipendenze | nessun problema |

Collaudo locale (2026-10-11, libreria del proprietario in safe mode, Claude Code 2.1.289, `claude-sonnet-5-5`, stessa
configurazione della CI: template MCP, `--tools`, `dontAsk`, hook): 78 turni, 0,69 USD, 2 min 20 s (i limiti in CI,
160 turni e 3 USD, lasciano margine). P0, F0-F6, F8-F10 e 8 righe T passati, F7 saltato (nessun gruppo);
18 docx in 9 `compare_group` (parità nei 5 stili, edge, nozcite, nonum-ieee, bare-id) tutti identici fra i due
produttori; 4 esplorativi (1 ok, 3 unclear, nessun bug). Hook: 69 chiamate nell'audit, esattamente 2 negazioni, le
due sonde F0 (`… && ls` e `delete_items` di `XXXXXXXX`), nessuna sul percorso normale. verify-claims con `--audit` e
`--transcript`: 43 controlli, 0 problemi, 3 avvisi (gli unclear). Dopo la pulizia nessun `mzt-*` e 551/551 chiavi
della libreria come prima. X1 (DOI vuoto → errore grezzo "Unexpected token '<' … is not valid JSON") è stato corretto nel
livello 3b (AID-28..31) e da allora la scansione di robustezza tratta quel testo come violazione (VC-03b).

## Agente dipendenze (`.github/workflows/deps-update.yml`, skill `.claude/skills/deps-update`)

Il primo del mese (e a mano), nell'environment `claude-deps` (solo le variabili `ANTHROPIC_*` della Workload Identity
Federation di Anthropic, nessun secret). Quattro job con il minimo dei permessi:
- **agent**: esce subito se c'è già una PR `deps/*`; `npm ci --ignore-scripts` e `NPM_CONFIG_IGNORE_SCRIPTS=true` per
  tutto il job; l'agente (Agent SDK via `scripts/run-agent.mjs`, `.github/agents/deps-update.json`: `claude-opus-5-5`, tool `Skill,Read,Glob,Grep,Edit,Write,Bash`, `dontAsk`, 120 turni, 6 USD) non ha
  token GitHub nel suo ambiente, può modificare solo `package.json`, `package-lock.json`, `CHANGELOG.md`,
  `agent-out/deps-pr.md` e `agent-out/deps-issue.md`, e usare `npm outdated|view|audit|update|install|ci|run` e `git status/diff/log`; niente commit, push, `gh` o publish.
  Per minor e major consulta la documentazione delle librerie con il server MCP remoto di Context7
  (`.github/agents/deps-mcp.json`, solo `resolve-library-id` e `query-docs`; contenuto esterno, mai istruzioni). Un
  aggiornamento che rompe qualcosa, o che secondo la documentazione cambia un'API usata in `src/`, viene rinviato, non
  corretto. Con sole patch dirette (e nessuna vulnerabilità da `npm audit`) installa ogni pacchetto alla versione esatta, senza `npm update`, così il lockfile cambia solo quanto serve e il merge automatico è possibile: l'esecuzione di prova del 2026-10-12 con `npm update` aveva portato a cascata minor e una major indirette (es. `express` 5.2→5.3, `content-disposition` 1→2) e il gate l'aveva giustamente rifiutata; con una minor diretta o una vulnerabilità fa l'aggiornamento completo e la PR resta al proprietario. La descrizione elenca sempre le dipendenze indirette cambiate. Lo step finale produce una patch dei soli tre file (se l'agente ha toccato altro il job fallisce senza PR);
  i testi da pubblicare passano da `scripts/check-public-text.mjs` (copia committata), che li blocca se contengono una credenziale.
- **open-pr**: senza npm né id-token; applica la patch su `main` (solo i tre file, niente symlink né cambi di tipo o di
  modo), la committa in locale ed esegue **la copia di `main` del gate** (controlli statici ed età) su quel commit; poi
  push di `deps/<data>` e PR col `GITHUB_TOKEN`, etichetta `dipendenze` (serve "Allow GitHub Actions to create and approve pull requests").
  Gli eventi del `GITHUB_TOKEN` non fanno partire `pull_request`/`push`, quindi avvia con `gh workflow run --ref` i
  workflow obbligatori: `test.yml` sempre; `claude-agent-smoke.yml` (secret, id-token; `scope=live+agent`: live-tests
  poi agent-smoke nella stessa run) **solo se il gate è passato**. Altrimenti commenta la PR (merge automatico disattivato, motivi del gate) e il merge-gate non parte.
- **merge-gate**: senza npm, checkout pulito di `main`; esegue la copia di `main` di `scripts/deps-merge-gate.mjs` sulla
  testa della PR, verifica base `main`, testa invariata, autore = `github-actions[bot]` registrato da open-pr, poi aspetta
  fino a 180 min (live-tests e agent-smoke condividono il lock: attese fino a 70 min ciascuno più la run dell'agente) che `test (node 22/24/26)`, `live-tests` e `agent-smoke` siano tutti verdi su quello SHA (solo check di
  GitHub Actions, app id 15368, la run più recente per nome) (non si affida solo al ruleset) e solo
  allora `gh pr merge --auto --squash --match-head-commit <sha>` col `GITHUB_TOKEN`. Altrimenti la PR resta al
  proprietario. Il push su `main` del merge automatico non fa partire workflow; la run del venerdì copre `main`.
- **issue**: se l'agente ha scritto `agent-out/deps-issue.md` (major disponibili con le breaking changes trovate in
  Context7, aggiornamenti rinviati), apre una issue con l'etichetta `dipendenze`, o commenta quella già aperta, con il
  link alla PR e alla run. Gira anche senza PR (solo major). PR e issue con l'etichetta `dipendenze` sono il segnale
  da monitorare per gli aggiornamenti da fare a mano.

**Regole del gate**: solo `package.json`, `package-lock.json`, `CHANGELOG.md`; range in `package.json` spostati al più di
una patch; campi di primo livello del lockfile e voce radice invariati; nessun pacchetto aggiunto o rimosso; ogni voce
che cambia versione è una patch semver, risolta esattamente da `https://registry.npmjs.org/<nome>/-/<base>-<versione>.tgz`
(uguaglianza, niente `..`/`%2e`/query), con integrity `sha512`, e
non cambia `name`, `hasInstallScript`, `bin`, `os`, `cpu` né i flag dev/optional/peer; le voci con la stessa versione non
cambiano `resolved` né `integrity`; ogni nuova versione è pubblicata da almeno 7 giorni (campo `time` del registry).

| ID | Scenario (`test/utils/deps-merge-gate.test.ts`) | Atteso |
|---|---|---|
| DG-01 | `isPatchBump` su patch, minor, major, uguale, prerelease, 0.x | solo le patch stabili |
| DG-02 | patch diretti e transitivi, range `^` aggiornati | mergeable |
| DG-03 | minor nel lockfile, file di codice, pacchetto aggiunto, range allargato a una minor, `version` cambiata, lockfile invariato | lasciata al proprietario con il motivo |
| DG-04 | aggiramenti della revisione di sicurezza: `resolved` verso un altro server + `hasInstallScript`, stessa versione ripuntata su `git+ssh`, alias npm (stesso path, altro pacchetto), nuovo `bin`, integrity assente, `resolved` del registry con un altro nome, campi di primo livello del lockfile, `os`/`cpu` | lasciata al proprietario con il motivo |
| DG-04 (bis) | `resolved` con `..`, `%2e%2e`, query e frammento, o di un'altra versione; `package.json` con scripts, overrides, bin/main/files | lasciata al proprietario |
| DG-06 | pacchetto con scope (`@types/node` → `…/@types/node/-/node-<v>.tgz`) | accettato |
| DG-05 | età della release: da più di 7 giorni / di ieri / registry irraggiungibile o versione senza data | accettata / lasciata al proprietario |

### Le 5 righe segnate OK a mano nel collaudo 2.0.0 (LIVE-STALE)

Indagate una per una su `main` @ 5a0f772.

| ID | Riga del vecchio collaudo | Comportamento reale | Decisione |
|---|---|---|---|
| LIVE-STALE-1 | delete_items con sole chiavi sconosciute, atteso `/not found/i` | `isError`, `{"error":"No items found for the given keys","status":"not_found"}`: "No items found" non contiene "not found" | **assertion** sbagliata; ora LIVE-DI-03 controlla `status: "not_found"` |
| LIVE-STALE-2 | find_and_attach_pdfs su collezione in dry_run con `processed >= 70` | `processed` = 69: le voci regolari create (8 tipi + 55 batch + 6 da DOI); gli allegati standalone non sono processati e il DOI fallito non crea voci | **assertion** sbagliata (conteggio a mano); ora LIVE-FA-04 confronta con le voci regolari create dalla run |
| LIVE-STALE-3 | get_item_fulltext su voce con solo un URL collegato, regex sul messaggio guida | la voce aveva un allegato linked_url con `contentType: application/pdf`; `isPdfAttachment` non guarda `linkMode`, quindi il link viene trattato come PDF e il tool risponde "Full text not indexed… Open the PDF in Zotero desktop", consiglio impossibile per un link | **codice**: corretto in questa stack (livello 3b): i PDF salvati hanno la precedenza sui link, un link da solo riceve un messaggio dedicato con l'URL. LIVE-GIF-08 e GIF-20..22 |
| LIVE-STALE-4 | find_and_attach_pdfs reale sulla stessa collezione, `processed >= 70` | come LIVE-STALE-2 | **assertion** sbagliata; ora LIVE-FA-05 |
| LIVE-STALE-5 | import_pdf_to_zotero con `content_type: text/html`, atteso successo senza fulltext | rifiutato con not_pdf: il tool controlla sempre i byte `%PDF-`; `content_type` è solo il MIME salvato sull'allegato | **assertion** sbagliata (il tool è solo PDF); ora LIVE-IP-05. La descrizione di `content_type` ("MIME type of the file") lascia intendere altri formati: da chiarire nella descrizione |

## Lacune note
- Le fixture usano chiavi nel formato reale di Zotero (8 caratteri da `23456789ABCDEFGHIJKLMNPQRSTUVWXYZ`): chiavi con 0/1/O o
  più corte vengono rifiutate prima di qualsiasi richiesta.
- Attriti segnalati dall'agente smoke, lasciati come sono (comportamento attuale, non bug): `get_collection_items`
  riporta in `total_items` anche allegati e note nascosti di default (`returned_items` può essere minore); gli
  allegati linked_url compaiono come risultati di primo livello in `search_library` (che non usa `/items/top`); i PDF
  allegati da `add_items_by_doi`/`find_and_attach_pdfs` non ricevono i `tags` del genitore (la pulizia dal vivo li
  trova come figli di una voce della run).
- Il fake segue il comportamento osservato nel test dal vivo del 2026-10-10 (itemKey, 404 delle collezioni,
  versioni, DELETE definitiva). Il 413 oltre 50 oggetti in scrittura resta emulato secondo la documentazione v3.
- `src/server.ts` non esporta la classe `ZoteroServer`; costruttore e lettura dell'env sono coperti solo dagli e2e.
- `fetchWithRetry` con 503 e backoff esponenziale reale (secondi) non viene esercitato a livello di tool, per
  restare veloci. I retry sono già coperti dai test unitari esistenti e da H-11..13.

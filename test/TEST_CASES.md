# Casi di test per tool — mcp-zotero

Suite aggiunta in `test/` (i test storici restano in `src/**/*.test.ts`).

| Comando | Cosa esegue | Durata indicativa |
|---|---|---|
| `npx vitest run` (= `npm test`) | unit: `src/**` + `test/tools/**` + `test/utils/**` | ~8 s |
| `npm run test:e2e` | `npm run build`, poi `test/e2e/**` con `vitest.e2e.config.ts` | ~4 s + build |

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
| SL-06/07 | risultato vuoto con/senza query | risultato vuoto (`message`, non isError) "No results found" (con query) / "No items found" |
| SL-08 | query/titoli unicode | `q` decodificato identico, unicode preservato |
| SL-09/10 | metadati mancanti, creator senza nome | fallback Untitled / No authors listed / No date |
| SL-11 | sort, direction, limit, query non validi | isError con il nome del campo, nessuna chiamata HTTP |
| SL-12 | HTTP 403/404/412/429/500/503 | isError contenente lo status |
| SL-13 | errore di rete | isError |

## get_collections (`get-collections.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| GC-01 | lista | JSON delle collezioni; limit=100, start=0 |
| GC-02 | 250 collezioni | 3 pagine (start 0/100/200), 250 risultati |
| GC-03 | Total-Results gonfiato | si ferma alla pagina vuota, nessun loop |
| GC-04 | Total-Results assente | solo la prima pagina |
| GC-05 | collezioni nel cestino | escluse di default, incluse con include_trashed |
| GC-06/07 | tutte nel cestino / nessuna | risultato vuoto (suggestion include_trashed / helpUrl) |
| GC-08 | nomi unicode | preservati |
| GC-09 | include_trashed non booleano | isError |
| GC-10/11/12 | HTTP 4xx/5xx, errore sulla 2ª pagina, errore di rete | isError |

## get_collection_items (`get-collection-items.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| GCI-01 | item completo | total/returned + campi (tags, doi, url, publicationTitle) |
| GCI-02/03 | allegati e note | esclusi di default (total_items = Total-Results), inclusi con excludeAttachments=false |
| GCI-04 | item minimale | fallback |
| GCI-05/06 | vuota / solo allegati | risultato vuoto status `empty` / `invalid_items` |
| GCI-07 | 230 item | 3 pagine |
| GCI-08 | 404 | errore strutturato `not_found` |
| GCI-09/10 | HTTP 403/412/429/500/503, rete | isError |
| GCI-11 | unicode | preservato |
| GCI-12..14 | collectionKey mancante o non stringa, excludeAttachments non booleano | isError |

## get_items_details (`get-items-details.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| GID-01 | 2 chiavi | una sola GET `itemKey=A,B`; mappa chiave → campi specifici del tipo |
| GID-02 | abstract | escluso di default, incluso con include_abstract |
| GID-03 | campi strutturali/vuoti | omessi |
| GID-04/05 | `[]` / nessun item | errore strutturato (nessuna chiamata HTTP) / risultato vuoto con le chiavi richieste |
| GID-06 | chiavi in parte inesistenti | solo quelle trovate |
| GID-07/08 | fallback, unicode | ok |
| GID-09/10 | 120 chiavi, 482 chiavi | tutte restituite (GET a blocchi da 50 con limit 50/50/20; nessun 500 per URL lungo) |
| GID-11 | 20 chiavi | una GET, tutte restituite |
| GID-12 | item_keys mancante/stringa/numeri, include_abstract non booleano | isError |
| GID-13/14 | HTTP 4xx/5xx, rete | isError |

## get_item_fulltext (`get-item-fulltext.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| GIF-01 | item padre | item → children → /fulltext con API key; text/characters/pages |
| GIF-02 | chiave di un allegato PDF | nessuna richiesta children |
| GIF-03/04/05 | max_characters 100 / 0 / default | troncato / nessun limite / 50000 |
| GIF-06 | figli misti | primo PDF (ignora HTML e note) |
| GIF-07 | unicode | characters = lunghezza della stringa JS |
| GIF-08 | fulltext 404 | errore strutturato "not indexed" |
| GIF-09 | fulltext 403/429/500/503 | errore strutturato "status N" |
| GIF-10 | fulltext, errore di rete | isError |
| GIF-11/12/13 | nessun PDF: senza URL / con URL / webpage o blogPost | messaggi dedicati |
| GIF-14 | item 404 | errore strutturato "Item not found" |
| GIF-15/16/17 | item HTTP 4xx/5xx, children 500, rete | isError |
| GIF-18 | ZOTERO_API_KEY assente | errore strutturato, nessuna chiamata HTTP |
| GIF-19 | item_key mancante o non stringa, max_characters stringa | isError |

## get_user_id (`get-user-id.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| GUI-01..03 | normale / argomenti extra / "0012345" | `{user_id}` verbatim, nessuna chiamata HTTP |
| GUI-04 | user id "" | isError "library ID is not set", nessuna chiamata HTTP |
| GUI-05 | tools/call senza `arguments` | successo (corretto nell'SDK 1.32; era BUG con 1.27) |
| GUI-06 | libreria utente | `{user_id, library_type: "user", library_id, library_path: "users/{id}"}` |
| GUI-07 | `ZOTERO_LIBRARY_TYPE=group`, id 777 | `user_id` da `ZOTERO_USER_ID`, `library_path: "groups/777"` |

## create_collection (`create-collection.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| CC-01/02/03 | nome, parent, spazi | POST `[{name, parentCollection?}]`, nome trimmato |
| CC-04 | "", "   ", "\t\n" | errore strutturato, nessuna POST |
| CC-05 | unicode | round-trip |
| CC-06 | scrittura `failed` | errore strutturato "Failed to create collection" |
| CC-07 | details | contiene il messaggio del server ("code: message") |
| CC-08 | name mancante/numero, parent numero | isError |
| CC-09/10 | HTTP 403/404/412/413/429/500/503, rete | isError |

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
| AI-11 | tutti falliti | errore strutturato "All items failed to create" |
| AI-12 | 50 item | una POST con 50 oggetti |
| AI-13 | 60 item | POST da 50 + 10, indici 0..59, 60 chiavi distinte |
| AI-13b | fallimento nel 2º batch | failed con indice 55 e titolo dell'input originale |
| AI-14 | items mancante/vuoto, itemType, title, campo non valido per il tipo, creatorType, creator incompleto, campo non stringa, tags, collection_key | isError con il nome del campo |
| AI-15/16 | HTTP 4xx/5xx/413, rete | isError |

## add_items_by_doi (`add-items-by-doi.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| AID-01 | DOI valido | GET doi.org con Accept CSL; item convertito (tipo, creators, publicationTitle) |
| AID-02 | senza UNPAYWALL_EMAIL | pdf_results con warning, nessuna chiamata a Unpaywall |
| AID-03 | auto_attach_pdf=false | niente pdf_results |
| AID-04 | collection_key/tags | nel payload |
| AID-05 | **DOI non trovato** (404) su 1 di 2 | l'altro viene creato; il primo in failed con 404 |
| AID-06 | tutti falliti (404 + rete) | errore strutturato, nessuna POST |
| AID-07 | doi.org 429 + Retry-After 0 | nuovo tentativo, successo |
| AID-08 | doi.org 500 | in failed, nessun retry |
| AID-09 | DOI con `<>();` e titolo unicode | codificato nell'URL, round-trip |
| AID-10 | `[]` | errore strutturato, nessuna chiamata HTTP |
| AID-11 | scrittura `failed` | errore strutturato "Zotero API write failed: Item 0 ..." |
| AID-12 | scrittura parziale | non isError; success con i creati, failed con `{ doi, error }` |
| AID-12b | 60 DOI | POST da 50 + 10, ordine dei DOI preservato |
| AID-13/14 | POST HTTP 403/404/412/413/429/500/503, rete | isError |
| AID-15 | 10 DOI | una POST, ordine preservato |
| AID-16 | dois, auto_attach_pdf, tags non validi | isError |
| AID-17 | OA gold | download + upload, allegato figlio, `source unpaywall_gold` |
| AID-18 | **Unpaywall senza OA** (closed) | "No open access PDF found", nessun upload |
| AID-19 | green con sola landing page | landing_url + suggerimento import_pdf_to_zotero |
| AID-20 | Unpaywall 404/500/rete | item creati, pdf_attached false |
| AID-21 | **quota storage** (413) | storage_quota_warning, item creati |
| AID-22 | quota piena su 12 DOI | upload successivi saltati |
| AID-23 | un download 404 | risultati per singolo item |
| AID-24 | ZOTERO_API_KEY assente | item creati, fase PDF saltata |
| AID-25 | PDF primario 403, fallback disponibile | allegato il fallback: status attached, url_used = pdf_url, filename, size_bytes; nessun allegato orfano |
| AID-26 | tutti gli URL falliscono | pdf_attached false, "Download failed for all 2 URL(s)", failed_urls con 403 e 404 |
| AID-27 | stesso scenario della pipeline condivisa | campi per PDF identici a `attachOpenAccessPdf` chiamata direttamente |

## add_linked_url_attachment (`add-linked-url-attachment.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| ALU-01 | solo url | payload linked_url, title=url |
| ALU-02 | figlio | parentItem, contentType, collections `[]` |
| ALU-03 | standalone | collections + tags |
| ALU-04 | unicode | round-trip |
| ALU-05 | scrittura `failed` | errore strutturato |
| ALU-06 | details | contiene il messaggio del server ("code: message") |
| ALU-07 | url mancante/non valido/numero, tags, collections | isError |
| ALU-08/09 | HTTP 4xx/5xx, rete | isError |

## delete_collection (`delete-collection.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| DC-01 | **guard** none/items | errore strutturato con env_var/current_value/required_values, nessuna chiamata HTTP |
| DC-02 | validazione prima del guard | isError |
| DC-03 | all | GET versione → DELETE con If-Unmodified-Since-Version |
| DC-04/05 | senza nome / nome unicode | name = chiave / preservato |
| DC-06/07 | 404 su GET / su DELETE | errore strutturato not_found |
| DC-08 | 412 | errore strutturato version_conflict |
| DC-09 | versione assente | errore strutturato, nessuna DELETE |
| DC-10/11/12 | 403/429/500/503 su GET o DELETE, rete | isError |
| DC-13 | chiave mancante/vuota/numero | isError |

## delete_items (`delete-items.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| DI-01 | **guard** none | errore strutturato, nessuna chiamata HTTP |
| DI-02 | items / all | consentito |
| DI-03 | 2 chiavi | GET itemKey → DELETE `?itemKey=A,B` con la versione della libreria |
| DI-04 | cancellazione parziale | not_found; cancellate solo le chiavi trovate |
| DI-05 | nessuna trovata | errore strutturato, nessuna DELETE |
| DI-06 | 412 | version_conflict |
| DI-07 | versione assente | errore strutturato |
| DI-08 | 20 chiavi | una GET + una DELETE |
| DI-09 | 50 chiavi (massimo per chiamata) | tutte cancellate, GET di verifica con limit=50 |
| DI-10/11/12 | 4xx/5xx su GET o DELETE, rete | isError |
| DI-13/14 | mancante, `[]`, stringa, 51 chiavi / esattamente 50 | isError / accettato |
| DI-15 | validazione prima del guard | isError |

## import_pdf_to_zotero (`import-pdf-to-zotero.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| IP-01 | flusso completo | download con User-Agent → item imported_url → auth (md5, filesize, If-None-Match) → upload prefix+file+suffix → register → PUT fulltext con il testo estratto |
| IP-02 | `{exists:1}` | niente upload/register |
| IP-03/04 | figlio / standalone | parentItem e collections `[]` / collections, tags, title, filename |
| IP-05 | filename dall'URL | percent-decoding unicode; `document.pdf` come fallback |
| IP-06 | content_type non PDF | fulltext saltato |
| IP-07/08 | download 403/404/500, rete | errore strutturato con status / details |
| IP-09/10 | pagina HTML, file vuoto | "not a valid PDF", nessun item creato |
| IP-11 | 100 MB + 1 | "100 MB", nessun item creato |
| IP-12/13 | creazione item `failed`, HTTP 4xx/5xx | errore strutturato "import_pdf_to_zotero failed" |
| IP-14 | **quota storage** (auth 413) | errore strutturato con item_key orfano, suggestion, nota delete_items |
| IP-15/16 | auth 403/412/500, rete | "Upload authorization failed" |
| IP-17/18 | upload 500 / register 412 | "File upload failed" / "Upload registration failed" |
| IP-19/20 | fulltext 413 / PDF non estraibile | successo, fulltext_indexed false con motivo |
| IP-21 | ZOTERO_API_KEY assente | errore strutturato, nessuna chiamata HTTP |
| IP-22 | url mancante/non valido, tags, collections, content_type | isError |
| IP-23 | size_bytes dopo l'estrazione | dimensione reale |
| IP-24 | size_bytes senza estrazione | dimensione reale |

## find_and_attach_pdfs (`find-and-attach-pdfs.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| FA-01 | item_keys, OA trovato | attached + conteggi; allegato figlio |
| FA-02/03 | entrambi / nessuno | errore strutturato |
| FA-04 | `[]` | risultato vuoto "No items to process" |
| FA-05 | collection_key (2 pagine, allegati e note) | 20 item processati |
| FA-06 | collezione vuota | risultato vuoto "No items to process" |
| FA-07 | senza DOI / chiave fantasma | status error con motivo |
| FA-08/09/10 | PDF esistente / solo snapshot HTML / skip=false | skipped / processato / nessuna richiesta children |
| FA-11 | dry_run | available + pdf_url, nessun download |
| FA-12 | closed / green con landing | not_found "No open access PDF found" con oa_status / landing_page_only con landing_url (entrambi contati in not_found) |
| FA-13 | Unpaywall 404/500/rete | not_found |
| FA-14 | UNPAYWALL_EMAIL non valida | not_found con warning, nessuna chiamata a Unpaywall |
| FA-15/16 | URL di fallback / tutti falliti | attached con il fallback / "Download failed for all 2 URL(s)" |
| FA-17 | **quota storage** | quota_exceeded, warning, item rimanenti saltati |
| FA-18/19 | GET metadati 4xx/5xx, rete sulla collezione | errore strutturato con details |
| FA-20 | children 500 su un item | l'item compare in results come error, contato in errors |
| FA-21 | children 500 su un item | gli altri item vengono processati |
| FA-22/25 | 120 item_keys / collezione di 120 | tutti processati, nessun "Item not found" |
| FA-23 | ZOTERO_API_KEY assente | errore strutturato |
| FA-24 | item_keys, collection_key, dry_run, skip non validi | isError |
| FA-26 | PDF solo in una oa_location successiva (PLOS) | attached dal repository, filename dal DOI |
| FA-27 | URL senza .pdf con Content-Disposition | filename dall'header |
| FA-28 | solo landing page dell'editore | landing_page_only, il motivo nomina l'editore |
| FA-29 | stesso scenario della pipeline condivisa | campi per PDF identici a `attachOpenAccessPdf` chiamata direttamente |

## Pipeline PDF open access condivisa (`test/utils/oa-pdf.test.ts`)
`attachOpenAccessPdf` (src/utils/oa-pdf.ts) è l'unico percorso usato da add_items_by_doi e find_and_attach_pdfs.
| ID | Scenario | Atteso |
|---|---|---|
| OA-01 | primario 403, fallback ok | attached con url_used, filename, size_bytes, attachment_key, fulltext_indexed; una sola POST di allegato |
| OA-02 | tutti gli URL falliscono | error "Download failed for all 2 URL(s)", failed_urls nell'ordine provato |
| OA-03 | solo landing page | landing_page_only con landing_url e host reale nel motivo |
| OA-04 | PDF già presente (skipIfPdfExists) | skipped, Unpaywall non interrogato |
| OA-05 | contenuto non PDF (HTML) | error "HTML page instead of a PDF", nessun allegato |
| OA-06 | quota storage piena | quota_exceeded, token di cancellazione impostato, fallback non provato |
| OA-07 | dry run | available con url_used, nessun download |

## inject_citations (`inject-citations.test.ts`, .docx reali in una cartella tmp)
| ID | Scenario | Atteso |
|---|---|---|
| IC-01 | 1 zcite | `*_cited.docx` con XML valido, field code CSL_CITATION (uris), BIBL, "(Smith, 2023)"; originale intatto |
| IC-02 | più tag, multi-chiave, chiavi ripetute | 1 GET per chiave, "(Smith, 2023; Doe & Roe, 2019)" |
| IC-03 | locator/prefix/suffix | presenti nel field code |
| IC-04/05 | ieee con num e senza / vancouver con tutti i num | [1] e [?] + warning / nessun warning |
| IC-06 | nessuno zcite | found 0, output scritto, nessuna chiamata HTTP |
| IC-07 | unicode (autori, titolo >30 caratteri, nome file) | XML ben formato, testo corretto |
| IC-08/09 | .pdf / .DOCX | errore strutturato |
| IC-10 | file inesistente | isError ENOENT |
| IC-11..14 | **.docx malformati**: byte casuali, zip senza document.xml, zip troncato, file vuoto | isError (document.xml citato nel messaggio) |
| IC-15 | zcite senza keys | ignorato |
| IC-16 | chiave 404 | isError, nessun output |
| IC-17/18 | HTTP 403/429/500/503, rete | isError |
| IC-19 | output | zip valido con le altre parti |
| IC-20 | cartella `x.docx.d/` | output accanto all'input |
| IC-21 | file_path mancante o numero, style non valido | isError |
| IC-22 | `keys=" A, B ,"` con spazi | chiavi ripulite, URI senza spazi, nessuna richiesta fuori route |
| IC-23 | itemData | volume/issue/page/publisher/publisher-place inclusi, abstract escluso, cognome multiparola intatto |

## Skill inject.js (`test/skills/inject-script.test.ts`, processo node reale)
| ID | Scenario | Atteso |
|---|---|---|
| SK-01 | libreria `users/<id>`, id numerico, `groups/<id>` | URI `http://zotero.org/{path}/items/KEY`, itemData da metadata.json (DOI maiuscolo), ZOTERO_BIBL |
| SK-02 | ieee con `num` | `[1]`, `[1,2]`, nessun warning |
| SK-03 | vancouver senza `num` | WARNING su stderr |
| SK-04 | `keys="A, B"` | chiavi ripulite |
| SK-05 | chiave assente da metadata.json | WARNING che la nomina, exit 0 |
| SK-06 | argomenti mancanti, libreria non valida, stile `mla`, file inesistenti | exit 1 con messaggio |
| SK-07 | copia `inject.mjs` sotto `package.json` `"type": "commonjs"` | esegue senza SyntaxError/warning |

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
| H-15/16 | resolveDoi | codifica + Accept CSL / 404 con DOI e status nel messaggio |
| H-17/18 | putFulltext | body JSON + API key, 204 / 413 e 500 |
| H-19 | putFulltext gruppo | PUT su `/groups/777/items/{key}/fulltext` |

## E2E (`test/e2e/stdio-server.e2e.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| E2E-01/02 | initialize, tools/list | serverInfo "zotero", istruzioni, 15 tool con schema object |
| E2E-03 | argomenti non validi su 14 tool | isError con il campo, nessuna chiamata HTTP |
| E2E-04..18 | una tools/call per ciascuno dei 15 tool (deletes con UNSAFE_OPERATIONS=all) | risultato atteso, richieste corrette alla FakeNet |
| E2E-19 | 403 Zotero | isError al client |
| E2E-20 | rete | nessuna richiesta del processo figlio senza route |
| E2E-21/22 | UNSAFE_OPERATIONS assente / " ITEMS " | delete bloccati senza chiamate HTTP / solo delete_items abilitato |
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

## Lacune note
- Il fake segue il comportamento osservato nel test dal vivo del 2026-10-10 (itemKey, 404 delle collezioni,
  versioni, DELETE definitiva). Il 413 oltre 50 oggetti in scrittura resta emulato secondo la documentazione v3.
- `src/server.ts` non esporta la classe `ZoteroServer`; costruttore e lettura dell'env sono coperti solo dagli e2e.
- `fetchWithRetry` con 503 e backoff esponenziale reale (secondi) non viene esercitato a livello di tool, per
  restare veloci. I retry sono già coperti dai test unitari esistenti e da H-11..13.

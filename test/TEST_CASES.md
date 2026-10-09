# Casi di test per tool — mcp-zotero

Suite aggiunta in `test/` (i test storici restano in `src/**/*.test.ts`).

| Comando | Cosa esegue | Durata indicativa |
|---|---|---|
| `npx vitest run` (= `npm test`) | unit: `src/**` + `test/tools/**` + `test/utils/**` | ~8 s |
| `npm run test:e2e` | `npm run build`, poi `test/e2e/**` con `vitest.e2e.config.ts` | ~4 s + build |

Timeout: unit `testTimeout`/`hookTimeout` 15 s (`vitest.config.ts`); e2e 60 s, ogni chiamata MCP 15 s,
processo server ucciso con SIGKILL se ancora vivo 5 s dopo la chiusura.

## Come funzionano

- **Harness MCP in-process** (`test/helpers/mcp-harness.ts`): `McpServer` reale con `registerAllTools`,
  `Client` reale via `InMemoryTransport`, `zotero-api-client` reale. Si sostituisce soltanto `fetch`
  (`test/helpers/fake-net.ts`): ogni richiesta viene registrata e quelle senza route falliscono, quindi
  la rete reale non viene mai raggiunta. Le asserzioni guardano il risultato che vede il client MCP
  (`isError`, testo/JSON) e le richieste HTTP prodotte (metodo, path, query, header, body).
- **Fake Zotero** (`test/helpers/zotero-fake.ts`): risposte in formato Web API v3; `zLibraryQuery` emula
  il comportamento del server su `itemKey` (al massimo 50 chiavi), `limit` (25 di default, 100 al massimo) e `start`.
- **E2E** (`test/e2e/`): avvia `node --import test/e2e/fetch-redirect.mjs build/server.js` su stdio.
  Il preload reindirizza ogni fetch esterna verso un proxy HTTP locale servito dalla stessa FakeNet.
  L'endpoint di zotero-api-client non è configurabile, ma il client usa il `fetch` globale, quindi
  l'intercettazione funziona senza modificare il codice di produzione.
- **Versioni**: i test non dipendono dal testo dei messaggi zod/SDK. Su un errore di validazione
  controllano solo `isError` e la presenza del nome del campo. Gli errori che l'SDK rilancia come
  JSON-RPC invece di restituirli come `CallToolResult` vengono normalizzati in `isError: true`.
- **Errore morbido** = risposta JSON `{ "error": ... }` **senza** `isError` (comportamento attuale di
  `formatErrorResponse`). **Errore duro** = il tool lancia un'eccezione e l'SDK la converte in `isError: true`.

### Bug noti (`it.fails`, prefisso `BUG` nel nome)

Questi test asseriscono il comportamento **corretto**. Oggi falliscono, quindi risultano "expected fail".
Se un test `BUG` passa (vitest lo segnala come fallimento), il comportamento è cambiato: o il bug è stato
corretto, o lo ha modificato una libreria aggiornata (vedi colonna "dipende da").

| ID | File:riga | Problema | Dipende da |
|---|---|---|---|
| GID-09/10 | src/tools/get-items-details.ts:51 | nessun `limit` né chunking: >25 chiavi → item persi; >50 → 400 | API Zotero |
| DI-09 | src/tools/delete-items.ts:47 | GET di verifica senza `limit`: con 26-50 chiavi le eccedenti finiscono in `not_found` e non vengono cancellate | API Zotero |
| FA-22/25 | src/tools/find-and-attach-pdfs.ts:91 | come sopra: >25 item → "Item not found"; collezione >50 → tool fallito | API Zotero |
| AI-09 | src/tools/add-items.ts:179 | `getData()` restituisce TUTTI gli oggetti inviati: dopo un fallimento non finale, key/title vengono attribuiti all'item sbagliato | zotero-api-client |
| AI-10 | src/tools/add-items.ts:172 | `failed[].error` è l'oggetto grezzo `{key,code,message}` invece di una stringa | zotero-api-client |
| AI-13 | src/tools/add-items.ts:97 | nessun `.max(50)` né chunking: >50 item → 413 sull'intera richiesta | API Zotero |
| AID-12 | src/tools/add-items-by-doi.ts:160 | un fallimento parziale viene trattato come totale: gli item creati non vengono riportati (orfani, duplicati al retry) | — |
| CC-07, ALU-06 | src/tools/create-collection.ts:47, src/tools/add-linked-url-attachment.ts:78 | `Object.values(errors).join()` su oggetti → `details: "[object Object]"` (stesso pattern in src/utils/pdf-uploader.ts:204) | zotero-api-client |
| IP-23 | src/utils/pdf-uploader.ts:371/377 | `buffer.length` letto dopo `extractPdfText`: unpdf fa il detach dell'ArrayBuffer → `size_bytes: 0` | unpdf |
| FA-20 | src/tools/find-and-attach-pdfs.ts:208 | i task `rejected` vengono scartati: l'item sparisce da `results` e dai contatori | — |
| IC-20 | src/citation-injector/injector.ts:162/208 | `replace(".docx", "_cited.docx")` agisce sulla prima occorrenza: una cartella `x.docx.d/` produce un path di output sbagliato | — |
| GUI-05 | (SDK) src/tools/index.ts:86 | `tools/call` senza `arguments` su un tool senza parametri → errore di validazione | @modelcontextprotocol/sdk |

---

## search_library (`test/tools/search-library.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| SL-01 | query | GET /items `q`, sort=dateAdded, direction=desc, limit=25, API key; lista formattata con dateAdded |
| SL-02 | senza query | nessun `q` |
| SL-03 | query di soli spazi / con spazi | `q` omesso / trimmato |
| SL-04 | limit 500 | limit=100 |
| SL-05 | sort=title, asc, limit 5 | parametri inoltrati; nessun dateAdded |
| SL-06/07 | risultato vuoto con/senza query | errore morbido "No results found" (con query) / "No items found" |
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
| GC-06/07 | tutte nel cestino / nessuna | errore morbido (suggestion include_trashed / helpUrl) |
| GC-08 | nomi unicode | preservati |
| GC-09 | include_trashed non booleano | isError |
| GC-10/11/12 | HTTP 4xx/5xx, errore sulla 2ª pagina, errore di rete | isError |

## get_collection_items (`get-collection-items.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| GCI-01 | item completo | total/returned + campi (tags, doi, url, publicationTitle) |
| GCI-02/03 | allegati e note | esclusi di default (total_items = Total-Results), inclusi con excludeAttachments=false |
| GCI-04 | item minimale | fallback |
| GCI-05/06 | vuota / solo allegati | errore morbido status `empty` / `invalid_items` |
| GCI-07 | 230 item | 3 pagine |
| GCI-08 | 404 | errore morbido `not_found` (non isError) |
| GCI-09/10 | HTTP 403/412/429/500/503, rete | isError |
| GCI-11 | unicode | preservato |
| GCI-12..14 | collectionKey mancante o non stringa, excludeAttachments non booleano | isError |

## get_items_details (`get-items-details.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| GID-01 | 2 chiavi | una sola GET `itemKey=A,B`; mappa chiave → campi specifici del tipo |
| GID-02 | abstract | escluso di default, incluso con include_abstract |
| GID-03 | campi strutturali/vuoti | omessi |
| GID-04/05 | `[]` / nessun item | errore morbido (nessuna chiamata HTTP per `[]`) |
| GID-06 | chiavi in parte inesistenti | solo quelle trovate |
| GID-07/08 | fallback, unicode | ok |
| GID-09/10 | **BUG** 30 chiavi, 60 chiavi | tutte restituite |
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
| GIF-08 | fulltext 404 | errore morbido "not indexed" |
| GIF-09 | fulltext 403/429/500/503 | errore morbido "status N" |
| GIF-10 | fulltext, errore di rete | isError |
| GIF-11/12/13 | nessun PDF: senza URL / con URL / webpage o blogPost | messaggi dedicati |
| GIF-14 | item 404 | errore morbido "Item not found" |
| GIF-15/16/17 | item HTTP 4xx/5xx, children 500, rete | isError |
| GIF-18 | ZOTERO_API_KEY assente | errore morbido, nessuna chiamata HTTP |
| GIF-19 | item_key mancante o non stringa, max_characters stringa | isError |

## get_user_id (`get-user-id.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| GUI-01..04 | normale / argomenti extra / "0012345" / "" | `{user_id}` verbatim, nessuna chiamata HTTP |
| GUI-05 | **BUG** tools/call senza `arguments` | successo |

## create_collection (`create-collection.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| CC-01/02/03 | nome, parent, spazi | POST `[{name, parentCollection?}]`, nome trimmato |
| CC-04 | "", "   ", "\t\n" | errore morbido, nessuna POST |
| CC-05 | unicode | round-trip |
| CC-06 | scrittura `failed` | errore morbido "Failed to create collection" |
| CC-07 | **BUG** details | contiene il messaggio del server |
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
| AI-09/10 | **BUG** fallisce il primo indice; error come stringa | mapping corretto; stringa |
| AI-11 | tutti falliti | errore morbido "All items failed to create" |
| AI-12 | 50 item | una POST con 50 oggetti |
| AI-13 | **BUG** 60 item | chunking oppure rifiuto in validazione |
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
| AID-06 | tutti falliti (404 + rete) | errore morbido, nessuna POST |
| AID-07 | doi.org 429 + Retry-After 0 | nuovo tentativo, successo |
| AID-08 | doi.org 500 | in failed, nessun retry |
| AID-09 | DOI con `<>();` e titolo unicode | codificato nell'URL, round-trip |
| AID-10 | `[]` | errore morbido, nessuna chiamata HTTP |
| AID-11 | scrittura `failed` | errore morbido "Zotero API write failed: Item 0 ..." |
| AID-12 | **BUG** scrittura parziale | riporta i creati |
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

## add_linked_url_attachment (`add-linked-url-attachment.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| ALU-01 | solo url | payload linked_url, title=url |
| ALU-02 | figlio | parentItem, contentType, collections `[]` |
| ALU-03 | standalone | collections + tags |
| ALU-04 | unicode | round-trip |
| ALU-05 | scrittura `failed` | errore morbido |
| ALU-06 | **BUG** details | contiene il messaggio del server |
| ALU-07 | url mancante/non valido/numero, tags, collections | isError |
| ALU-08/09 | HTTP 4xx/5xx, rete | isError |

## delete_collection (`delete-collection.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| DC-01 | **guard** none/items | errore morbido con env_var/current_value/required_values, nessuna chiamata HTTP |
| DC-02 | validazione prima del guard | isError |
| DC-03 | all | GET versione → DELETE con If-Unmodified-Since-Version |
| DC-04/05 | senza nome / nome unicode | name = chiave / preservato |
| DC-06/07 | 404 su GET / su DELETE | errore morbido not_found |
| DC-08 | 412 | errore morbido version_conflict |
| DC-09 | versione assente | errore morbido, nessuna DELETE |
| DC-10/11/12 | 403/429/500/503 su GET o DELETE, rete | isError |
| DC-13 | chiave mancante/vuota/numero | isError |

## delete_items (`delete-items.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| DI-01 | **guard** none | errore morbido, nessuna chiamata HTTP |
| DI-02 | items / all | consentito |
| DI-03 | 2 chiavi | GET itemKey → DELETE `?itemKey=A,B` con la versione della libreria |
| DI-04 | cancellazione parziale | not_found; cancellate solo le chiavi trovate |
| DI-05 | nessuna trovata | errore morbido, nessuna DELETE |
| DI-06 | 412 | version_conflict |
| DI-07 | versione assente | errore morbido |
| DI-08 | 20 chiavi | una GET + una DELETE |
| DI-09 | **BUG** 30 chiavi | tutte cancellate |
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
| IP-07/08 | download 403/404/500, rete | errore morbido con status / details |
| IP-09/10 | pagina HTML, file vuoto | "not a valid PDF", nessun item creato |
| IP-11 | 100 MB + 1 | "100 MB", nessun item creato |
| IP-12/13 | creazione item `failed`, HTTP 4xx/5xx | errore morbido "import_pdf_to_zotero failed" |
| IP-14 | **quota storage** (auth 413) | errore morbido con item_key orfano, suggestion, nota delete_items |
| IP-15/16 | auth 403/412/500, rete | "Upload authorization failed" |
| IP-17/18 | upload 500 / register 412 | "File upload failed" / "Upload registration failed" |
| IP-19/20 | fulltext 413 / PDF non estraibile | successo, fulltext_indexed false con motivo |
| IP-21 | ZOTERO_API_KEY assente | errore morbido, nessuna chiamata HTTP |
| IP-22 | url mancante/non valido, tags, collections, content_type | isError |
| IP-23 | **BUG** size_bytes dopo l'estrazione | dimensione reale |
| IP-24 | size_bytes senza estrazione | dimensione reale |

## find_and_attach_pdfs (`find-and-attach-pdfs.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| FA-01 | item_keys, OA trovato | attached + conteggi; allegato figlio |
| FA-02/03/04 | entrambi / nessuno / `[]` | errore morbido |
| FA-05 | collection_key (2 pagine, allegati e note) | 20 item processati |
| FA-06 | collezione vuota | "No items to process" |
| FA-07 | senza DOI / chiave fantasma | status error con motivo |
| FA-08/09/10 | PDF esistente / solo snapshot HTML / skip=false | skipped / processato / nessuna richiesta children |
| FA-11 | dry_run | available + pdf_url, nessun download |
| FA-12 | closed / green con landing | not_found con oa_status / landing_url |
| FA-13 | Unpaywall 404/500/rete | not_found |
| FA-14 | UNPAYWALL_EMAIL non valida | not_found con warning, nessuna chiamata a Unpaywall |
| FA-15/16 | URL di fallback / tutti falliti | attached con il fallback / "Download failed for all 2 URL(s)" |
| FA-17 | **quota storage** | quota_exceeded, warning, item rimanenti saltati |
| FA-18/19 | GET metadati 4xx/5xx, rete sulla collezione | errore morbido con details |
| FA-20 | **BUG** children 500 su un item | l'item compare in results come error |
| FA-21 | children 500 su un item | gli altri item vengono processati |
| FA-22/25 | **BUG** 30 item_keys / collezione di 120 | tutti processati |
| FA-23 | ZOTERO_API_KEY assente | errore morbido |
| FA-24 | item_keys, collection_key, dry_run, skip non validi | isError |

## inject_citations (`inject-citations.test.ts`, .docx reali in una cartella tmp)
| ID | Scenario | Atteso |
|---|---|---|
| IC-01 | 1 zcite | `*_cited.docx` con XML valido, field code CSL_CITATION (uris), BIBL, "(Smith, 2023)"; originale intatto |
| IC-02 | più tag, multi-chiave, chiavi ripetute | 1 GET per chiave, "(Smith, 2023; Doe & Roe, 2019)" |
| IC-03 | locator/prefix/suffix | presenti nel field code |
| IC-04/05 | ieee con num e senza / vancouver con tutti i num | [1] e [?] + warning / nessun warning |
| IC-06 | nessuno zcite | found 0, output scritto, nessuna chiamata HTTP |
| IC-07 | unicode (autori, titolo >30 caratteri, nome file) | XML ben formato, testo corretto |
| IC-08/09 | .pdf / .DOCX | errore morbido |
| IC-10 | file inesistente | isError ENOENT |
| IC-11..14 | **.docx malformati**: byte casuali, zip senza document.xml, zip troncato, file vuoto | isError (document.xml citato nel messaggio) |
| IC-15 | zcite senza keys | ignorato |
| IC-16 | chiave 404 | isError, nessun output |
| IC-17/18 | HTTP 403/429/500/503, rete | isError |
| IC-19 | output | zip valido con le altre parti |
| IC-20 | **BUG** cartella `x.docx.d/` | output accanto all'input |
| IC-21 | file_path mancante o numero, style non valido | isError |

## tools/list (`tools-list.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| TL-01 | elenco | esattamente 15 nomi |
| TL-02 | per tool | `type: object`, properties e required attesi, descrizione presente |
| TL-03 | enum/default | sort, direction, limit, style, auto_attach_pdf, max_characters, dry_run, content_type |
| TL-04 | cardinalità | delete_items 1..50, add_items min 1, collection_key minLength 1 |
| TL-05 | add_items.itemType | enum di 37 tipi; required itemType+title |
| TL-06 | url | `format: uri` |
| TL-07 | tool sconosciuto | isError |

## Helper pubblici (`test/utils/helpers.test.ts`)
| ID | Scenario | Atteso |
|---|---|---|
| H-01 | logger | una riga JSON su stderr per chiamata, mai su stdout |
| H-02/03 | formatErrorResponse | `{error, ...details}`, senza isError; una chiave `error` nei details vince |
| H-04/05 | extractPdfText con unpdf reale | testo e pagine / rifiuta un non-PDF |
| H-06/07 | isZoteroApiError su ErrorResponse reale / errore di rete | true con status / false |
| H-08/09/10 | contratto zotero-api-client | Total-Results e versione; `getData()` con tutti gli oggetti inviati, `getErrors()` con oggetti; DELETE `?itemKey` con If-Unmodified-Since-Version |
| H-11..14 | fetchWithRetry | Retry-After come data passata, 500 senza retry, esaurimento dei retry, errore di rete |
| H-15/16 | resolveDoi | codifica + Accept CSL / 404 con DOI e status nel messaggio |
| H-17/18 | putFulltext | body JSON + API key, 204 / 413 e 500 |

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

## Lacune note
- Il comportamento reale di api.zotero.org (limite di 50 chiavi, limit di default 25, 413 oltre 50 oggetti
  in scrittura) è emulato secondo la documentazione v3, non verificato contro il server: non esistono credenziali.
- `src/server.ts` non esporta la classe `ZoteroServer`; costruttore e lettura dell'env sono coperti solo dagli e2e.
- `fetchWithRetry` con 503 e backoff esponenziale reale (secondi) non viene esercitato a livello di tool, per
  restare veloci. I retry sono già coperti dai test unitari esistenti e da H-11..13.

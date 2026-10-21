# Real fixture corpus

Real, openly licensed works used by the tests to run the server's real code path (DOI resolution → CSL
conversion → Zotero items → `inject_citations`, open-access PDF download and text extraction) on real registry
data instead of hand-made fixtures. Tests never touch the network: the recorded responses are replayed by
`corpusRoutes()` in `test/helpers/corpus.ts`. Not part of the npm package (`package.json` `files` is `["build"]`).
Licences and attribution: [LICENSES.md](LICENSES.md).

| File | What it is |
|---|---|
| `corpus.json` | Hand-maintained list of works: id, Zotero key, expected item type, cases covered, collection, tags, sources to record, licence (verified by hand on the page in `verifiedAt`), PDF URL (sha256 and size filled in by the script) |
| `cassettes/<id>.json` | Recorded responses, `[{request: {method, url, accept}, response: {status, contentType, body \| bodyFile}}]`. Bodies are trimmed to the bibliographic fields (no references, ORCID, affiliations, emails, funders, counters; abstracts only for CC BY / CC0 works, at most 2500 characters) |
| `pdfs/<id>.pdf` | Unmodified PDFs, CC BY / CC0 works only |
| `overrides.json` | Reviewed corrections to what the sources give (e.g. particles that DataCite splits wrongly), and the items with no source to record |
| `library.json` | Curated Zotero items (Web API `data` objects) and collections, built from the cassettes and `overrides.json`: what a correct import of each work gives. Do not edit by hand |
| `LICENSES.md` | Generated attribution list |

## Recording

`scripts/record-corpus.mjs`, run by hand. It calls only official APIs (doi.org content negotiation, Unpaywall,
DataCite, Zenodo, arXiv OAI-PMH, Thoth) and the publisher's PDF URL, one request per second per host (arXiv one
every three seconds, as its terms ask), each under a timeout. The Unpaywall email goes only on the request: the
recorded URL carries `email=REDACTED`, and the script fails if that email, any key/token/email from the
environment, an email address, an `@` in a URL or an ORCID iD appears in any file.

```sh
UNPAYWALL_EMAIL=<yours> timeout 600 node scripts/record-corpus.mjs           # record all, rebuild, check
UNPAYWALL_EMAIL=<yours> timeout 300 node scripts/record-corpus.mjs --only eve2020
timeout 60 node scripts/record-corpus.mjs --offline   # no network: rebuild library.json and LICENSES.md, check
timeout 60 node scripts/record-corpus.mjs --check     # no network, no writes: fail if anything is stale or wrong
```

The same checks run in `npm test` (`test/utils/corpus-fixtures.test.ts`).

## Adding a work

Only public data under CC BY or CC0 (no NC, ND). Open the publisher's page (or the repository record) and check
the licence there, then add the work to `corpus.json` with the page in `licence.verifiedAt` and the sentence that
states the licence; the script also checks every licence it can read from the sources and fails on anything that
is not CC BY / CC0. Keep PDFs small: at most 2.5 MB for all of them, 3 MB for the whole folder. Keys use Zotero's
alphabet (8 characters of `23456789ABCDEFGHIJKLMNPQRSTUVWXYZ`).

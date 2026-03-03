---
name: zotero-mcp-integrations
description: Inject Zotero-compatible citation field codes into a .docx document. Use when the user wants to generate a Word document with live Zotero citations and bibliography, or when writing an academic paper with references.
---

# Zotero Citation Injection Skill

Inject Zotero field codes into a .docx document entirely within Claude's sandbox. No filesystem round-trips through MCP needed.

## When to use

- User asks to write an academic paper, literature review, or report with Zotero citations
- User wants a Word document with live, Zotero-manageable bibliography
- Any .docx generation that references papers in the user's Zotero library

> **Writing a scientific article?** This skill handles citation *injection* — the technical step that turns placeholders into Zotero field codes. It does NOT replace the research workflow. If you are writing an academic paper, follow the `scientific-writing` skill (`scientific-writing/SKILL.md`) **first**: it handles source triage, evidence-based writing, and source transparency. Come back here only at Phase 5 (Deliver) to inject the citations.

## Fallback — if this skill is NOT available

If Claude does NOT have access to this skill, the injection cannot happen in the sandbox. In that case:

1. Generate the .docx with `<zcite>` tags as placeholders
2. Present the file to the user for download
3. Tell the user: **"I generated the document with citation placeholders. To complete the injection, save the file on your PC, tell me the full path, and I'll use the `inject_citations` MCP tool to finalize it."**
4. Once the user provides the path, call the MCP tool `inject_citations`
5. Remind the user to do **Zotero → Add/Edit Bibliography** first, then **Zotero → Refresh** in Word

## Dependencies

```bash
npm install docx jszip fast-xml-parser --registry https://registry.npmjs.org
```

**Always use `--registry https://registry.npmjs.org`** — the sandbox may default to a blocked registry.

**Important:** `jszip` and `fast-xml-parser` must be resolvable from the working directory where you run `inject.js`. If the skill directory is read-only (e.g. `/mnt/skills/...`), copy the script to your working directory first:

```bash
cp <skill_path>/scripts/inject.js ./inject.js
```

The script has a built-in fallback: if the ESM import fails, it tries `createRequire(process.cwd() + "/package.json")` to resolve dependencies from the current working directory's `node_modules`.

## Workflow

### Step 1 — Ask citation style

> **CRITICAL:** Before doing anything else, ask the user which citation style they prefer: **APA** (author-year, default), **IEEE** (numbered [1]), or **Vancouver** (numbered [1]). If the user chooses **IEEE or Vancouver**, every `<zcite>` tag generated in Step 4 MUST include the `num` attribute with the correct sequential citation number. Omitting `num` produces `[?]` placeholders. This choice affects the entire workflow — do not skip this step.

### Step 2 — Search / add papers

> **Document access:** If you cannot access or retrieve a document from the internet (e.g., behind a paywall, blocked URL, PDF not available), the abstract is a perfectly valid source for the claims it contains. See Step 2b for the transparency and PDF upload policies.

Use MCP tools to find or add papers:
- `search_library` — search existing Zotero library
- `add_items_by_doi` — add new papers by DOI, returns item keys
- `add_items` — add items by providing metadata directly (books, theses, reports, etc. — all 37 Zotero types, batch-capable)
- `get_collections` / `get_collection_items` — browse collections
- `find_and_attach_pdfs` — batch lookup and attach OA PDFs for items (by keys or collection)

Note every `item_key` returned — these are needed for citations.

### Step 2b — Source transparency and PDF upload

#### Using abstracts

Abstracts are a perfectly valid source. If the abstract contains the information
you need (quantitative results, study design, sample size, main conclusions),
there is no obligation to retrieve the full text. This saves context and time.

However, **you MUST be transparent** about which sources you used in full text
and which you used only via abstract. Before presenting the final document,
include a brief disclosure, e.g.:

> **Sources used via abstract only:** Smith et al. 2021, Jones et al. 2023.
> All other sources were read in full.

This lets the user judge the evidence quality themselves.

#### PDF attachment policy

There are two distinct mechanisms for attaching PDFs. They have different costs and different defaults.

##### 1. Automatic OA attachment (free — leave enabled)

`add_items_by_doi` has an `auto_attach_pdf` parameter (default: `true`). This performs
a lightweight Unpaywall lookup and attaches freely available open-access PDFs automatically.

> **Do NOT set `auto_attach_pdf: false`.** It is free, adds negligible latency, and
> enriches the user's Zotero library at no cost. Only disable it if you encounter
> errors specifically caused by the PDF attachment step (e.g. upload timeouts,
> Unpaywall failures blocking item creation).

##### 2. Manual PDF upload (only when the user explicitly requests it)

Manual PDF upload via `import_pdf_to_zotero` is a heavier workflow (download → verify →
upload → validate). This happens **only when the user explicitly asks** to upload PDFs.

> **IF the user explicitly asks to upload/import PDFs to Zotero** → PDF upload is
> **MANDATORY and cannot be skipped**. For each source:
>
> - **Freely accessible articles** (open access, PMC, preprints): download and
>   upload via `import_pdf_to_zotero`, following the verify-upload-validate
>   procedure below.
> - **Paywalled articles** (Lancet, NEJM, Nature, JAMA, etc.): present a table
>   to the user listing the paywalled sources and ask them to upload the PDFs
>   to Zotero if they have institutional access. Example:
>
>   > I could not download PDFs for these paywalled sources:
>   >
>   > | Source | Journal | DOI |
>   > |---|---|---|
>   > | Smith et al. 2021 | The Lancet | 10.1016/... |
>   > | Jones et al. 2023 | NEJM | 10.1056/... |
>   >
>   > If you have institutional access, please download and upload them to
>   > Zotero manually. I've already added the bibliographic records.
>
> **IF the user does NOT request PDF upload** → do not use `import_pdf_to_zotero`.
> Just use the sources (abstract or full text as available) and cite them.
> Automatic OA attachment via `auto_attach_pdf` is still active and independent
> from this policy.

#### Verify-upload-validate procedure (when upload is requested)

**NEVER upload a PDF to Zotero without verifying its content first.**
Repositories (especially Europe PMC) can occasionally serve the wrong PDF.

1. **Find a PDF URL** — try these sources in order:
   - Publisher open access (JMIR, Frontiers, PLOS, BMC, MDPI are fully OA)
   - Europe PMC: `https://europepmc.org/backend/ptpmcrender.fcgi?accid=PMC{id}&blobtype=pdf`
   - PubMed Central: `https://pmc.ncbi.nlm.nih.gov/articles/PMC{id}/pdf/`
   - Preprint servers (BioRxiv, MedRxiv, arXiv)
   - Publisher direct PDF (varies by publisher)

2. **Read and verify content** — use `web_fetch` on the URL and confirm:
   - Title matches the expected article
   - Authors match
   - Content is the actual paper, not a login page or different article

3. **Import to Zotero** — once verified, call `import_pdf_to_zotero` with:
   - `url`: the verified PDF URL
   - `parent_item`: the Zotero item key from Step 2
   - `filename`: descriptive name (e.g., `Author_Year_ShortTitle.pdf`)

4. **Validate post-upload** — call `get_item_fulltext` and spot-check the first
   few hundred characters to confirm the indexed content matches the expected paper.

If import fails after 5 attempts, fall back to `add_linked_url_attachment`.

#### Handling green OA (repository copies)

When `find_and_attach_pdfs` or `add_items_by_doi` reports `oa_status: "green"` with
a `landing_url` but no PDF was attached, it means the paper is available at a
repository (e.g., PubMed Central) but Unpaywall has no direct download link.

Action: inform the user that a repository copy exists and provide the landing URL.
If they need the PDF in Zotero, they can download it manually and you can attach it
with `import_pdf_to_zotero`.

#### Known publisher URL patterns for direct PDF access

| Publisher | Pattern |
|---|---|
| Frontiers | `https://public-pages-files-2025.frontiersin.org/journals/{journal}/articles/{doi}/pdf` |
| JMIR | `https://{subdomain}.jmir.org/{year}/{issue}/{article_id}/PDF` |
| PLOS | `https://journals.plos.org/{journal}/article/file?id={doi}&type=printable` |
| BMC / Springer OA | `https://link.springer.com/content/pdf/{doi}.pdf` (may require OA) |
| MDPI | `https://www.mdpi.com/{path}/pdf` |
| Europe PMC | `https://europepmc.org/backend/ptpmcrender.fcgi?accid=PMC{id}&blobtype=pdf` |

### Step 3 — Collect metadata (batch)

Call `get_items_details` with ALL item keys in a single call:

```
get_items_details({ item_keys: ["KEY1", "KEY2", "KEY3", ...] })
```

Save the result as `metadata.json` in the sandbox. The response is a key → metadata map.

**No remapping required.** The inject script accepts the MCP response field names directly (e.g. lowercase `doi`, `url`, `publicationTitle`). You can pass the MCP response as-is.

The script also accepts the canonical inject.js field names (uppercase `DOI`, `URL`, `containerTitle`), so either format works:

| inject.js canonical | MCP response (also accepted) |
|---|---|
| `itemType` | `itemType` |
| `title` | `title` |
| `authors` | `authors` |
| `date` | `date` |
| `DOI` | `doi` |
| `containerTitle` | `publicationTitle` |
| `volume` | `volume` |
| `issue` | `issue` |
| `page` | `pages` |
| `publisher` | `publisher` |
| `URL` | `url` |

**Do NOT include `abstract`** — it bloats field codes.

#### Authors format

The `authors` field is a **comma-separated string** of `"FirstName LastName"` names, e.g.:

```
"John Smith, Jane Doe, Paulo Caetano da Silva"
```

This is the exact format returned by `get_items_details`. The inject script parses each comma-separated token by splitting on whitespace — the **last word** becomes the family name, everything before it becomes the given name. For example, `"Paulo Caetano da Silva"` → `{ family: "Silva", given: "Paulo Caetano da" }`.

#### Example metadata.json

```json
{
  "EUHUT5K3": {
    "title": "Attention Is All You Need",
    "authors": "Ashish Vaswani, Noam Shazeer, Niki Parmar",
    "date": "2017",
    "doi": "10.48550/arXiv.1706.03762",
    "itemType": "journalArticle",
    "publicationTitle": "Advances in Neural Information Processing Systems",
    "url": "https://arxiv.org/abs/1706.03762"
  },
  "F9UQM7N2": {
    "title": "BERT: Pre-training of Deep Bidirectional Transformers",
    "authors": "Jacob Devlin, Ming-Wei Chang, Kenton Lee, Kristina Toutanova",
    "date": "2019",
    "doi": "10.18653/v1/N19-1423",
    "itemType": "conferencePaper",
    "publicationTitle": "Proceedings of NAACL-HLT 2019",
    "url": null
  }
}
```

### Step 4 — Generate the .docx

Generate a .docx using the `docx` npm package. Insert citation placeholders as literal text:

```
<zcite keys="ITEMKEY"/>
```

**Critical rule:** Each `<zcite>` tag MUST be in its own dedicated `TextRun`. Never mix it with surrounding text.

```javascript
new Paragraph({
  children: [
    new TextRun("The transformer architecture "),
    new TextRun('<zcite keys="EUHUT5K3"/>'),   // dedicated TextRun
    new TextRun(" revolutionized NLP."),
  ]
})
```

Supported attributes:

| Attribute | Example | Notes |
|---|---|---|
| `keys` | `"ABC12345"` or `"ABC,DEF"` | Required. Comma-separated for multiple |
| `num` | `"1"` or `"1,2"` | **Required for IEEE/Vancouver.** Without it, citations render as `[?]` |
| `locator` | `"pp. 12-15"` | Page locator |
| `prefix` | `"see "` | Text before citation |
| `suffix` | `", emphasis added"` | Text after citation |

> **Warning:** When using IEEE or Vancouver style, you MUST include the `num` attribute on every `<zcite>` tag with the correct sequential citation number. Omitting `num` produces `[?]` placeholders.

Attributes can appear in any order (the parser is order-independent).

### Step 5 — Run injection

First, get the Zotero user ID by calling the MCP tool `get_user_id`. This returns the numeric user ID needed for field code URIs.

Then execute the injection script bundled with this skill:

```bash
node <skill_path>/scripts/inject.js input.docx output.docx metadata.json <userId> [style]
```

Where:
- `<skill_path>` is the path to this skill's directory (use the location from the skill metadata)
- `userId` is the Zotero user ID from `get_user_id`
- `style` is one of: `apa` (default), `ieee`, `vancouver`, `harvard`, `chicago`

The script outputs JSON to stdout:
```json
{ "output": "output.docx", "found": 3, "injected": 3 }
```

### Step 6 — Present result

Copy the output .docx to `/mnt/user-data/outputs/` and present it. **Always** remind the user:

> Open the file in Microsoft Word with the Zotero plugin installed, then:
> 1. Click **Zotero → Add/Edit Bibliography** to insert the bibliography at the end of the document
> 2. Click **Zotero → Refresh** to finalize all citations and update the bibliography
>
> **Important:** Refresh alone is not enough — you must first add the bibliography via Add/Edit Bibliography, otherwise it will not appear in the document.

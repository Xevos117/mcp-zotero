---
name: scientific-writing
description: >
  Use this skill whenever the user asks to write a scientific article, literature review,
  research paper, case report, systematic review, or any academic/scholarly document.
  Triggers include: "write a paper", "write an article", "literature review", "review article",
  "case report", "research paper", "scientific article", "academic paper", or requests to
  produce documents citing scientific literature. This skill enforces a structured research
  workflow with source triage, evidence-based writing, and transparent disclosure of which
  sources were read in full vs. abstract only. Also use when the user asks to summarize,
  synthesize, or compare multiple scientific papers into a written deliverable.
---

# Scientific Article Writing Skill

## Core Principle

**Abstracts are valid sources. Be transparent about what you used.**

Abstracts contain legitimate, citable information: quantitative results, study
design, sample sizes, effect sizes, p-values, and main conclusions. If the
abstract provides the data you need, there is no obligation to retrieve the
full text — doing so consumes context without adding value.

However, **transparency is non-negotiable**. The user must always know which
sources were read in full and which were used via abstract only. Before
presenting the final document, include a clear disclosure listing abstract-only
sources (see Source Transparency below).

Full-text reading remains valuable for interpretive claims, methodological
details, subgroup analyses, and limitations not covered in the abstract. Use
your judgment: if the abstract is sufficient, use it; if you need more depth,
attempt full-text retrieval.

### PDF Upload Policy

PDF upload to Zotero happens **only when the user explicitly requests it**:

- **If the user explicitly requests PDF upload** → it is **mandatory and cannot
  be skipped**. Follow the verify-upload-validate procedure in the
  `zotero-mcp-integrations` skill. For paywalled sources, present a table to the
  user asking them to upload the PDFs manually if they have access.
- **If the user does NOT request PDF upload** → do not upload PDFs.

### Source Transparency (MANDATORY)

Before presenting the final document, you **MUST** disclose which sources were
used via abstract only. A simple list is sufficient:

> **Sources used via abstract only:** Smith et al. 2021, Jones et al. 2023.
> All other sources were read in full.

This is not a warning — it is an informational disclosure that lets the user
judge the evidence quality and decide whether to provide additional full texts.

---

## Workflow Overview

The workflow has 5 mandatory phases executed in strict order.
No phase can be skipped. Each phase has explicit entry/exit criteria.

```
Phase 1: SCOPE → Phase 2: SEARCH → Phase 3: READ → Phase 4: WRITE → Phase 5: DELIVER
```

See `references/workflow-detail.md` for the complete phase specifications.

---

## Phase 1: SCOPE — Define the Article

**Goal**: Understand exactly what needs to be written before searching anything.

**Actions**:
1. Identify article type (review, research, case report, systematic review, meta-analysis, editorial, letter, etc.)
2. Determine target audience and field
3. Determine approximate length and section structure
4. Identify citation style (Vancouver, APA, IEEE, etc.)
5. Clarify key questions the article must answer
6. Agree on scope boundaries — what is IN and what is OUT

**Exit criteria**: Clear written specification of what will be produced.

**Anti-pattern**: Starting to search before knowing what you're looking for.
This leads to unfocused literature retrieval and wasted effort.

---

## Phase 2: SEARCH — Find Sources

**Goal**: Build a comprehensive, relevant bibliography.

**Actions**:
1. Construct search queries based on the scope (use PubMed, web search, or whatever tools are available)
2. Cast a wide initial net — search for more sources than you'll ultimately cite
3. Triage results: categorize by relevance (essential / supporting / background)
4. Record all sources with their identifiers (DOI, PMID, URL)

**Search strategy by article type**:

| Article Type | Minimum Sources | Search Depth |
|---|---|---|
| Narrative review | 15-30 | Broad, thematic |
| Systematic review | Exhaustive per protocol | Protocol-driven, reproducible |
| Research article | 10-25 | Focused on methods + context |
| Case report | 5-15 | Similar cases + guidelines |
| Short communication | 5-10 | Targeted, recent |

**Exit criteria**: A ranked list of sources with abstracts (and full text where easily available).

**Anti-pattern**: Stopping at 10 PubMed results.

---

## Phase 3: READ — Understand the Sources

**Goal**: Develop sufficient understanding of the source material before writing.

### When abstracts are enough

For many sources — especially supporting or background references — the abstract
provides all the data you need: study design, sample size, key results, main
conclusion. In these cases, there is no need to retrieve the full text.

### When full text adds value

For **essential** sources where you need interpretive depth, methodological detail,
subgroup analyses, or limitations, attempt full-text retrieval:

1. **web_fetch on DOI URL** — often resolves to full HTML text on publisher sites
2. **Open access repositories** — PMC, Europe PMC, BioRxiv, MedRxiv
3. **Publisher open access** — JMIR, PLOS, BMC, Frontiers, MDPI are fully OA
4. **Preprint versions** — BioRxiv, MedRxiv, arXiv, SSRN

If full text is behind a paywall, the abstract is sufficient. Do not waste
effort trying to circumvent access restrictions.

### What to extract from each source

Whether from abstract or full text, for each source you should know:

- What was the study question?
- How was it designed? (sample size, population, key methods)
- What were the main numerical findings?
- How does this fit into the broader evidence base?

For full-text sources, also extract:
- Methodological details not in the abstract
- Stated limitations
- Subgroup analyses or secondary endpoints

### Track your source depth

Keep a mental note of which sources you read in full and which you used via
abstract only. You will need this for the Source Transparency disclosure in
Phase 5.

**Exit criteria**: Sufficient understanding of each source to make accurate claims.

**Anti-pattern**: Paraphrasing abstract conclusions without extracting specific data.
Even when using abstracts, cite concrete numbers, not vague summaries.

---

## Phase 4: WRITE — Compose the Article

**Goal**: Produce a well-structured scientific article grounded in the sources you've read.

### Structure by Article Type

See `references/article-structures.md` for detailed templates.

**General principles that apply to all types**:

1. **Introduction**: Establish context → Identify the gap/need → State the objective
2. **Body**: Organize by theme, chronology, or methodology — NOT by source.
   Never write "Smith et al. found X. Jones et al. found Y. Lee et al. found Z."
   Instead: "Multiple studies have demonstrated X [refs], although the effect varies
   by population [ref1, ref2]."
3. **Discussion/Synthesis**: Integrate findings, identify patterns, acknowledge conflicts
4. **Conclusions**: Answer the question posed in the introduction

### Writing Rules

- **Every factual claim needs a citation**. No exceptions.
- **Use specific data**, not vague summaries. Say "92.5% maintained viral
  suppression at 48 weeks" not "most patients responded well." Abstracts
  often contain these specific numbers — use them.
- **Acknowledge contradictions** in the literature. Don't cherry-pick.
- **Distinguish between what the data shows and what it suggests**. Use language
  appropriately: "demonstrated" vs "suggested" vs "may indicate."
- **State limitations explicitly**, both of individual studies and of the review itself.
- **Track citation numbers** carefully if using numbered styles (Vancouver, IEEE).
  Each unique source gets one number, assigned in order of first appearance.

### Citation Placement

- Citations go AFTER the claim, BEFORE the period: "...maintained suppression [4]."
- Multiple citations: [4,5] or [4-6] for ranges
- Abstract-only sources can be cited for specific factual claims directly stated
  in the abstract (quantitative results, study design, sample size, main conclusion).
  Do NOT use abstract-only sources for interpretive or methodological claims that
  require full-text context.

**Exit criteria**: Complete draft with all citations placed.

**Anti-pattern**: Writing the full text and then "sprinkling" citations afterward.
Citations should be integral to the writing process, not a post-hoc decoration.

---

## Phase 5: DELIVER — Produce the Final Document

**Goal**: Generate a polished, properly formatted deliverable.

**Actions**:
1. Generate the document in the requested format (.docx, .pdf, .md, etc.)
2. If Zotero integration is available, inject citation field codes
3. **Include the Source Transparency disclosure** (see Core Principle) listing
   which sources were used via abstract only
4. If the user requested PDF upload, present a table of paywalled sources they
   may want to upload manually (see `zotero-mcp-integrations` skill)
5. Validate the document
6. Present to user with clear instructions for any post-processing (e.g., Zotero → Add/Edit Bibliography, then Zotero → Refresh)

**Exit criteria**: Downloadable document with working citations.

---

## Tool-Agnostic Principles

This skill works regardless of which tools are available. The workflow is the same whether you have:

- PubMed MCP tools + Zotero MCP tools + web_search
- Only web_search + web_fetch
- Only web_search
- No search tools at all (user provides sources)

The key insight is: **the workflow is about the PROCESS, not the tools.**

| If you have... | Use it for... |
|---|---|
| `pubmed_search_articles` | Phase 2: Structured literature search |
| `pubmed_fetch_contents` | Phase 2-3: Get abstracts and metadata |
| `web_search` | Phase 2: Find sources; Phase 3: Locate full text when needed |
| `web_fetch` | Phase 3: Read full-text HTML when abstract is not sufficient |
| `import_pdf_to_zotero` | Phase 5: Archive PDFs when user requests it (see zotero-mcp-integrations skill) |
| `find_and_attach_pdfs` | Phase 3/5: Batch OA PDF lookup + auto-attach via Unpaywall |
| `get_item_fulltext` | Phase 3: Read indexed full text + validate post-upload content |
| `add_linked_url_attachment` | Phase 5: Fallback when PDF import fails |
| `inject_citations` / skill | Phase 5: Create live Zotero citations in .docx |
| `add_items_by_doi` | Phase 2: Build bibliography in Zotero |
| `add_items` | Phase 2: Add books, theses, reports, etc. that do not have a DOI |
| None of the above | Ask the user to provide source material directly |

**Zotero integration**: If the `zotero-mcp-integrations` skill is available and the user
requests PDF upload, follow its Step 2b during Phase 5. For citation injection,
follow its Steps 4-6 during Phase 5.

---

## Quality Checklist

Before delivering the final document, verify:

- [ ] Every factual claim has a citation
- [ ] Specific numbers (percentages, sample sizes, CIs) are cited — abstracts are a valid source for these
- [ ] Contradictions in the literature are acknowledged
- [ ] Limitations are stated
- [ ] The article answers the question defined in Phase 1
- [ ] Citations are numbered/formatted correctly for the chosen style
- [ ] Abstract-only sources are used appropriately (factual claims only, not interpretive)
- [ ] **Source Transparency disclosure** was presented listing all abstract-only sources
- [ ] If user requested PDF upload: freely available PDFs were verified and uploaded; paywalled sources listed in a table for the user
- [ ] No PDF was uploaded without prior content verification (title, authors, actual content)

---

## Common Failure Modes

| Failure | Cause | Prevention |
|---|---|---|
| Vague claims | Paraphrasing instead of citing specific data | Extract concrete numbers from abstracts or full text |
| Missing context | Skipping Phase 1 scoping | Always define scope before searching |
| Uncritical synthesis | Not considering methods/limitations | When abstract lacks detail, retrieve full text for essential sources |
| Citation errors | Post-hoc citation insertion | Cite while writing, not after |
| Narrow perspective | Too few sources | Search broadly in Phase 2 |
| Hidden abstract-only use | Not disclosing which sources were abstract-only | Always include Source Transparency disclosure |
| Wrong PDF in Zotero | Uploading without content verification | Verify (title+authors+content) → upload → validate |

---

## Paywalled Sources

Many high-impact journals (Lancet, NEJM, Nature, JAMA, Cell, Science) restrict
full-text access to subscribers. This is a normal part of scientific literature,
not a workflow failure.

**What you CAN do with abstract-only sources (paywalled or otherwise):**
- Cite specific quantitative results reported in the abstract (e.g., "HR 0.67, 95% CI 0.54-0.82")
- Reference the study design and sample size stated in the abstract
- Cite the main conclusion as stated by the authors

**What you CANNOT do:**
- Describe methodology details not in the abstract
- Discuss subgroup analyses, secondary endpoints, or limitations not mentioned in the abstract
- Use the source as a primary reference for interpretive or mechanistic claims

**In all cases:** include abstract-only sources in the Source Transparency disclosure.

---

## Dependencies

This skill has no hard dependencies. It works with whatever tools are available.
For optimal results, the following tools enhance the workflow:

- **PubMed MCP server**: Structured biomedical literature search
- **Zotero MCP server**: Reference management and citation injection
- **web_search / web_fetch**: General source discovery and full-text retrieval
- **docx skill**: Professional document generation
- **pdf skill**: PDF reading and generation

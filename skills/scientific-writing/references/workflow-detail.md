# Workflow Detail Reference

## Phase Transitions

Each phase has strict entry and exit criteria. Claude must not advance to the next
phase until exit criteria are met.

```
SCOPE ──→ SEARCH ──→ READ ──→ WRITE ──→ DELIVER
  │          │         │        │          │
  │          │         │        │          └─ Exit: File delivered to user
  │          │         │        └─ Exit: Complete draft with all citations
  │          │         └─ Exit: Full-text notes for all essential sources
  │          └─ Exit: Ranked source list with full-text access confirmed
  └─ Exit: Written spec of what will be produced
```

## Phase 1: SCOPE — Detailed

### Questions to Ask or Infer

If the user hasn't specified, determine:

1. **Type**: What kind of article? (review, original research, case report, systematic review, meta-analysis, editorial, commentary, letter, short communication)
2. **Length**: How long? (expressed as pages, word count, or "brief" / "comprehensive")
3. **Audience**: Who reads this? (clinical physicians, researchers, students, general public)
4. **Field**: What discipline? (this affects terminology, journal conventions, citation style)
5. **Key questions**: What should the reader learn from this article?
6. **Citation style**: Vancouver (numbered), APA (author-year), IEEE, Chicago, etc.
7. **Language**: English, Italian, or other?
8. **Scope boundaries**: What is explicitly excluded?

### When the User Is Vague

If the user says something like "write me a 2-page article on long-acting HIV therapy":
- Infer type = narrative review (most common for general topic requests)
- Infer length = ~1000-1200 words (2 A4 pages, 12pt, single-spaced)
- Infer audience = clinical/scientific audience (HIV is a clinical topic)
- **Ask** about citation style if not specified, or pick Vancouver for biomedical
- Define scope: treatment only? treatment + prevention? include PrEP?

## Phase 2: SEARCH — Detailed

### Search Query Construction

Start with broad queries, then narrow:

```
Iteration 1 (broad):  "long-acting antiretroviral therapy HIV"
Iteration 2 (focused): "cabotegravir rilpivirine clinical trial"
Iteration 3 (specific): "lenacapavir capsid inhibitor phase 3"
Iteration 4 (gaps):    "long-acting HIV adherence equity access"
```

### Source Triage Categories

After initial search results come in, classify each:

- **Essential** (must read full text): Landmark trials, key reviews, directly relevant to the article's core argument
- **Supporting** (read abstract + key sections): Provides additional context, confirms findings
- **Background** (abstract sufficient): Well-established facts, historical context
- **Excluded** (not relevant): Off-topic, superseded, duplicate data

### Recording Sources

For each source, record:

```
PMID/DOI: [identifier]
Title: [title]
Category: Essential / Supporting / Background
Full-text status: Available (URL) / Not available / Not attempted
Access route: PMC / Europe PMC / Publisher OA / Preprint / web_fetch
```

## Phase 3: READ — Detailed

### Reading Priority

Read in this order:
1. Essential sources (all, full text mandatory)
2. Supporting sources (methods + results sections at minimum)
3. Background sources (abstract may suffice for established facts)

### Data Extraction Template

For each essential source, mentally or physically extract:

```
Source: [Author et al., Year]
Design: [e.g., Phase 3, randomized, open-label, non-inferiority]
Population: [N=xxx, key demographics, inclusion criteria]
Intervention: [what was given, dose, frequency, route]
Comparator: [what it was compared to]
Primary endpoint: [what was measured]
Key results:
  - Primary: [exact number, CI, p-value]
  - Secondary: [other important findings]
  - Safety: [adverse events, withdrawals]
Limitations stated by authors: [what they acknowledged]
My assessment: [strengths, weaknesses, relevance to my article]
```

### When Full Text Is Unavailable

If after trying all access routes (PMC, Europe PMC, publisher OA, preprint, web_fetch)
a source remains inaccessible:

1. Mark it as "abstract-only"
2. You may cite it for:
   - The main conclusion stated in the abstract
   - Basic study design characteristics mentioned in the abstract
   - Sample size if stated
3. You may NOT cite it for:
   - Specific subgroup analyses
   - Detailed safety data
   - Methodological nuances
   - Limitations not mentioned in the abstract
4. Consider finding an alternative source that IS accessible

## Phase 4: WRITE — Detailed

### Narrative Review Structure

```
1. Title
2. Abstract (if required)
3. Introduction
   - Opening context (2-3 sentences)
   - Why this topic matters now
   - What this review covers (scope statement)
4. Body sections (organized thematically)
   - Section 1: [Theme, e.g., "Clinical evidence"]
   - Section 2: [Theme, e.g., "Safety profile"]
   - Section 3: [Theme, e.g., "Emerging agents"]
   - Section 4: [Theme, e.g., "Implementation challenges"]
5. Discussion / Synthesis
   - Key takeaways
   - Gaps in the evidence
   - Future directions
6. Conclusions
7. References
```

### Research Article Structure (IMRAD)

```
1. Title
2. Abstract (structured: Background, Methods, Results, Conclusions)
3. Introduction
4. Methods
5. Results
6. Discussion
7. Conclusions
8. References
```

### Case Report Structure

```
1. Title
2. Abstract
3. Introduction (why this case is noteworthy)
4. Case Presentation (chronological, detailed)
5. Discussion (differential diagnosis, literature comparison)
6. Conclusions / Learning Points
7. References
```

### Systematic Review Structure

```
1. Title
2. Abstract (PRISMA-compliant)
3. Introduction
4. Methods (search strategy, inclusion/exclusion, quality assessment, synthesis)
5. Results (PRISMA flow diagram, study characteristics, synthesis)
6. Discussion
7. Conclusions
8. References
```

## Phase 5: DELIVER — Detailed

### Document Generation Checklist

1. Choose the right skill for the output format:
   - `.docx` → use docx skill
   - `.pdf` → use pdf skill
   - `.md` → create file directly
   - `.html` → create file directly

2. If using Zotero for citations:
   - Create/use a collection for this article's sources
   - Add all sources by DOI
   - Import PDFs for accessible sources
   - Get item keys for citation injection
   - Generate .docx with `<zcite>` tags
   - Run injection script (or the `inject_citations` MCP tool)
   - Remind user to do Zotero → Add/Edit Bibliography, then Zotero → Refresh

3. If NOT using Zotero:
   - Format references manually in the chosen style
   - Include them as a numbered or alphabetical list at the end

4. Validate the final document
5. Present to user with summary of what was produced

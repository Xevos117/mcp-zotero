import { describe, it, expect } from "vitest";
import {
  parseVisualReview,
  visualReviewProblems,
  visualReviewFindings,
  visualReviewMarkdown,
  // @ts-expect-error plain .mjs script without type declarations
} from "../../test/live/agent/visual-review.mjs";
// @ts-expect-error plain .mjs script without type declarations
import { buildSummary, escapedInline, leakProblems } from "../../test/live/agent/summary.mjs";

/** agent-out/visual-review.md: the agent's review of the word-render pages (test/live/agent/visual-review.mjs). */

const INDEX = {
  corpus: [{ id: "eve2020" }, { id: "conneau2020" }, { id: "gualandi2022" }],
  knownIssues: [
    { id: "H-W1", steps: ["apa", "proposed"] },
    { id: "itemData", steps: ["apa"] },
  ],
  images: [
    { image: "apa-p2.png", document: "apa" },
    { image: "proposed-p1.png", document: "proposed" },
    { image: "lib-apa-p1.png", document: "lib-apa" },
  ],
};

const REVIEW = `# Revisione visiva

## Problema 1: tesi senza università
- Documento: apa
- Pagina: apa-p2.png
- Posizione: voce di bibliografia 5
- Voce del corpus: gualandi2022
- Reso: "Gualandi, B. (2022). What do we mean … Open Science. https://doi.org/10.5281/zenodo.6385132"
- Atteso: "… Open Science [University of Bologna]. https://doi.org/…"
- Noto: itemData

## Problema 2: citazioni in stile nota dopo OK sul dialogo
- Documento: proposed
- Pagina: proposed-p1.png
- Posizione: paragrafo 2
- Voce del corpus: conneau2020
- Reso: "Conneau et al., “Unsupervised Cross-Lingual …”"
- Atteso: "(Conneau et al., 2020)"
- Noto: H-W1

## Problema 3: curatrice assente
- Documento: lib-apa
- Pagina: lib-apa-p1.png
- Posizione: voce di bibliografia 4
- Voce del corpus: eve2020
- Reso: "Eve, M. P. (2020b). Violins in the Subway. Open Book Publishers."
- Atteso: "… In J. Edmond (Ed.), Digital Technology …"

## Da verificare in Word
- rientro sporgente assente nella bibliografia APA (apa-p2.png)
`;

describe("revisione visiva (VR)", () => {
  it("VR-01 lettura: problemi con tutti i campi, voci del corpus in lista, osservazioni di impaginazione a parte", () => {
    const r = parseVisualReview(REVIEW);
    expect(r.errors).toEqual([]);
    expect(r.problems).toHaveLength(3);
    expect(r.problems[0]).toMatchObject({ n: 1, document: "apa", image: "apa-p2.png", items: ["gualandi2022"], known: "itemData", missing: [] });
    expect(r.wordChecks).toEqual(["rientro sporgente assente nella bibliografia APA (apa-p2.png)"]);
    expect(visualReviewProblems(r, INDEX)).toEqual([]);
  });

  it("VR-02 problema noto → avviso; problema senza Noto → problema (bug)", () => {
    const f = visualReviewFindings(parseVisualReview(REVIEW));
    expect(f.problems).toEqual(["visual 3 (lib-apa-p1.png, voce di bibliografia 4): curatrice assente"]);
    expect(f.warnings).toEqual([
      "visual 1 (apa-p2.png, voce di bibliografia 5): tesi senza università [known: itemData]",
      "visual 2 (proposed-p1.png, paragrafo 2): citazioni in stile nota dopo OK sul dialogo [known: H-W1]",
    ]);
  });

  it("VR-03 riferimenti inesistenti o incoerenti, campi mancanti, file vuoto → errori della revisione", () => {
    const bad = `# Revisione visiva
## Problema 1: x
- Documento: ieee
- Pagina: ieee-p9.png
- Voce del corpus: nessuna
- Reso: a
- Atteso: b
- Noto: H-W9
## Problema 1: y
- Documento: lib-apa
- Pagina: apa-p2.png
- Posizione: voce 1
- Voce del corpus: eve2020
- Reso: a
- Atteso: b
- Noto: H-W1
- Colore: rosso
## Altro
`;
    const problems = visualReviewProblems(parseVisualReview(bad), INDEX);
    expect(problems).toEqual(
      expect.arrayContaining([
        'unknown section "## Altro"',
        'problem 1: unknown field "Colore"',
        "problem 1: number repeated",
        "problem 1: missing where",
        "problem 1: page ieee-p9.png was not rendered",
        "problem 1: nessuna is not a corpus item",
        "problem 1: known issue H-W9 does not exist",
        "problem 1: page apa-p2.png belongs to apa, not lib-apa",
        "problem 1: known issue H-W1 does not concern lib-apa",
      ])
    );
    expect(visualReviewProblems(parseVisualReview("# Revisione visiva\n"), INDEX)).toEqual(['no "## Problema" section and no "Nessun problema di contenuto." line']);
    expect(visualReviewProblems(parseVisualReview("# Revisione visiva\nNessun problema di contenuto.\n"), INDEX)).toEqual([]);
  });

  it("VR-06 noto solo per ciò che descrive: voce fuori dall'elenco dell'issue, H-W1 senza dialogo registrato → errori", () => {
    const index = {
      ...INDEX,
      corpus: [...INDEX.corpus, { id: "kochan2017" }],
      knownIssues: [
        { id: "H-W1", steps: ["apa", "proposed"], requiresDialog: true },
        { id: "itemData", steps: ["apa"], items: ["gualandi2022"] },
      ],
      images: [{ image: "apa-p2.png", document: "apa" }, { image: "proposed-p1.png", document: "proposed", dialog: { title: "Document Preferences" } }],
    };
    const review = (doc: string, img: string, item: string, known: string) =>
      `# Revisione visiva\n## Problema 1: x\n- Documento: ${doc}\n- Pagina: ${img}\n- Posizione: voce 1\n- Voce del corpus: ${item}\n- Reso: a\n- Atteso: b\n- Noto: ${known}\n` +
      "## Problema 2: dialogo\n- Documento: proposed\n- Pagina: proposed-p1.png\n- Posizione: paragrafo 2\n- Voce del corpus: conneau2020\n- Reso: a\n- Atteso: b\n- Noto: H-W1\n";
    expect(visualReviewProblems(parseVisualReview(review("apa", "apa-p2.png", "gualandi2022", "itemData")), index)).toEqual([]);
    expect(visualReviewProblems(parseVisualReview(review("apa", "apa-p2.png", "kochan2017", "itemData")), index)).toEqual(["problem 1: known issue itemData does not concern kochan2017"]);
    expect(visualReviewProblems(parseVisualReview(review("apa", "apa-p2.png", "gualandi2022", "H-W1")), index)).toEqual(["problem 1: known issue H-W1 needs a recorded dialog, apa has none"]);
  });

  it("VR-07 prova della revisione: issue da segnalare (voce per voce) e documenti con dialogo devono comparire tra i problemi", () => {
    const index = {
      ...INDEX,
      knownIssues: [{ id: "itemData", steps: ["apa"], items: ["gualandi2022", "eve2020"], reportsRequired: true }],
      images: [{ image: "apa-p2.png", document: "apa" }, { image: "proposed-p1.png", document: "proposed", dialog: { title: "Document Preferences" } }],
    };
    const one = "# Revisione visiva\n## Problema 1: tesi\n- Documento: apa\n- Pagina: apa-p2.png\n- Posizione: voce 5\n- Voce del corpus: gualandi2022\n- Reso: a\n- Atteso: b\n- Noto: itemData\n";
    expect(visualReviewProblems(parseVisualReview(one), index)).toEqual([
      "known issue itemData not reported for eve2020 (it is visible on the pages)",
      "proposed: Zotero opened a dialog on the first Refresh (index.json) but no problem reports it",
    ]);
    expect(visualReviewProblems(parseVisualReview("# Revisione visiva\nNessun problema di contenuto.\n"), index)).toHaveLength(3);
  });

  it("VR-04 sezione Problemi visivi: <details> per problema, testo dell'agente escapato; nessun problema in una riga", () => {
    const md = visualReviewMarkdown(parseVisualReview(REVIEW + "\n## Problema 4: <img src=x> @owner\n- Documento: apa\n"), escapedInline);
    expect(md).toContain("#### Problemi visivi");
    expect(md).toContain("<details><summary>1. tesi senza università — apa, apa-p2.png, voce di bibliografia 5 (noto: itemData)</summary>");
    expect(md).toContain("**Da verificare in Word**");
    expect(md).toContain("&lt;img src=x&gt;");
    expect(md).not.toContain("<img");
    expect(md).not.toMatch(/@owner/);
    expect(visualReviewMarkdown(parseVisualReview("Nessun problema di contenuto."), escapedInline)).toContain("Nessun problema di contenuto nelle pagine renderizzate.");
  });

  it("VR-05 il riepilogo include la revisione visiva ed è soggetto allo stesso controllo delle fughe", () => {
    const visual = parseVisualReview(REVIEW.replace("voce di bibliografia 4", "users/987654 voce 4"));
    const text = buildSummary({ visual });
    expect(text).toContain("#### Problemi visivi");
    expect(leakProblems(text, {})).toEqual(["1 users/<id> or groups/<id> path(s) in the text"]);
  });
});

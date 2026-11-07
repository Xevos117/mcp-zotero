import { describe, it, expect } from "vitest";
import { parseCites } from "./pandoc-cite.js";
import { parseMarkdown } from "./markdown.js";
import { assignNumbers } from "./number.js";
import { CitationRequest } from "../citation-injector/model.js";

describe("pandoc-cite (CCD)", () => {
  const cites = (t: string) => parseCites(t).filter((i) => i.kind === "cite").map((i: any) => i.request);

  it("CCD-P01 [@K] → una citazione con una chiave", () => {
    expect(cites("See [@ABCD2345].")).toEqual([{ keys: ["ABCD2345"], prefix: undefined, suffix: undefined, locator: undefined, suppressAuthor: false, raw: "[@ABCD2345]" }]);
  });

  it("CCD-P02 [@K1; @K2] → una citazione con due chiavi", () => {
    expect(cites("[@ABCD2345; @EFGH2345]")[0].keys).toEqual(["ABCD2345", "EFGH2345"]);
  });

  it("CCD-P03 [see @K, p. 12] → prefix e locator", () => {
    expect(cites("[see @ABCD2345, p. 12]")[0]).toMatchObject({ keys: ["ABCD2345"], prefix: "see", locator: "p. 12" });
  });

  it("CCD-P04 -@K → soppressione dell'autore; @K in linea", () => {
    expect(cites("-@ABCD2345")[0]).toMatchObject({ keys: ["ABCD2345"], suppressAuthor: true });
    expect(cites("as @ABCD2345 shows")[0]).toMatchObject({ keys: ["ABCD2345"], suppressAuthor: false });
  });

  it("CCD-P05 testo e citazioni alternati", () => {
    const parts = parseCites("A [@ABCD2345] B");
    expect(parts.map((p) => p.kind)).toEqual(["text", "cite", "text"]);
  });

  it("CCD-P06 suffisso non-locator", () => {
    expect(cites("[@ABCD2345, emphasis added]")[0]).toMatchObject({ keys: ["ABCD2345"], suffix: "emphasis added" });
  });

  it("CCD-P07 una email a@b.com non è una citazione (@ dopo un alfanumerico)", () => {
    expect(cites("write to a@b.com or x3@y.org")).toEqual([]);
    expect(parseCites("write to a@b.com").map((i) => i.kind)).toEqual(["text"]);
  });

  it("CCD-P08 una @parola non chiave Zotero resta testo con un avviso, non una citazione", () => {
    const warnings: string[] = [];
    const parts = parseCites("see @notakey and @ABCD2345", (m) => warnings.push(m));
    expect(parts.filter((i) => i.kind === "cite")).toHaveLength(1); // solo ABCD2345
    expect(parts.some((i) => i.kind === "text" && i.text.includes("@notakey"))).toBe(true);
    expect(warnings.join(" ")).toMatch(/@notakey.*not a well-formed Zotero item key/);
  });
});

describe("markdown (CCD)", () => {
  it("CCD-M01 titoli, paragrafi, grassetto, corsivo, elenco", () => {
    const { blocks } = parseMarkdown("# Title\n\nSome **bold** and *italic* text.\n\n- one\n- two");
    expect(blocks[0]).toMatchObject({ type: "heading", level: 1 });
    expect(blocks[1].type).toBe("paragraph");
    const inlines = blocks[1].inlines as any[];
    expect(inlines.find((i) => i.bold)?.text).toBe("bold");
    expect(inlines.find((i) => i.italic)?.text).toBe("italic");
    expect(blocks.filter((b) => b.type === "list-item")).toHaveLength(2);
  });

  it("CCD-M02 citazione dentro un paragrafo", () => {
    const { blocks } = parseMarkdown("Claim [@ABCD2345] here.");
    const kinds = blocks[0].inlines.map((i) => i.kind);
    expect(kinds).toContain("cite");
  });

  it("CCD-M03 costrutti non supportati → testo con avviso", () => {
    const { warnings } = parseMarkdown("> quote\n\n```\ncode\n```\n\n1. first");
    expect(warnings.join(" ")).toMatch(/block quotes/);
    expect(warnings.join(" ")).toMatch(/code blocks/);
    expect(warnings.join(" ")).toMatch(/ordered lists/);
  });

  it("CCD-M04 paragrafi separati da riga vuota", () => {
    const { blocks } = parseMarkdown("First line\ncontinued.\n\nSecond.");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].inlines.map((i: any) => i.text).join("")).toBe("First line continued.");
  });
});

describe("number (CCD)", () => {
  const req = (keys: string[]): CitationRequest => ({ keys, raw: "" });
  it("CCD-N01 numeri in ordine di prima citazione, chiave ripetuta stesso numero", () => {
    const rs = [req(["A"]), req(["B", "C"]), req(["A"])];
    const nums = assignNumbers(rs);
    expect(nums.get(rs[0])).toBe("1");
    expect(nums.get(rs[1])).toBe("2,3");
    expect(nums.get(rs[2])).toBe("1");
  });
});

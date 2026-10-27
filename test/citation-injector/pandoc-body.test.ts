import { describe, it, expect } from "vitest";
import { parsePandocCitesInBody, countPandocMarkers } from "../../src/citation-injector/pandoc-body.js";

/** PB-*: parser dei marcatori Pandoc sul corpo (già XML-escapato) del documento. */
describe("parsePandocCitesInBody (PB)", () => {
  it("PB-01 [@KEY] singolo", () => {
    const r = parsePandocCitesInBody("As shown [@SMITH222] here.");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ keys: ["SMITH222"], raw: "[@SMITH222]" });
  });

  it("PB-02 più voci [@A; @B]", () => {
    const r = parsePandocCitesInBody("Both [@AAAA2222; @BBBB2222] cited.");
    expect(r).toHaveLength(1);
    expect(r[0].keys).toEqual(["AAAA2222", "BBBB2222"]);
    expect(r[0].raw).toBe("[@AAAA2222; @BBBB2222]");
  });

  it("PB-03 prefisso e locator [see @K, p. 12]", () => {
    const [r] = parsePandocCitesInBody("x [see @SMITH222, p. 12] y");
    expect(r).toMatchObject({ keys: ["SMITH222"], prefix: "see", locator: "p. 12" });
  });

  it("PB-04 inline @KEY e soppressione autore -@KEY", () => {
    const r = parsePandocCitesInBody("see @SMITH222 and -@SMITH222.");
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ keys: ["SMITH222"], suppressAuthor: false, raw: "@SMITH222" });
    expect(r[1]).toMatchObject({ keys: ["SMITH222"], suppressAuthor: true, raw: "-@SMITH222" });
  });

  it("PB-05 una email non è una citazione", () => {
    expect(parsePandocCitesInBody("write to john@example.com please")).toEqual([]);
  });

  it("PB-06 citekey Better BibTeX con punteggiatura finale ripulita", () => {
    const [r] = parsePandocCitesInBody("per @rossi2020.");
    expect(r.keys).toEqual(["rossi2020"]);
    expect(r.raw).toBe("@rossi2020"); // il raw non include il punto finale
  });

  it("PB-07 entità XML nel prefisso vengono deescapate", () => {
    const [r] = parsePandocCitesInBody("x [see &amp; cf. @SMITH222] y");
    expect(r.prefix).toBe("see & cf.");
    expect(r.raw).toBe("[see &amp; cf. @SMITH222]"); // raw resta escapato per il replace sul corpo
  });

  it("PB-08 [@] senza chiave valida → nessuna richiesta", () => {
    expect(parsePandocCitesInBody("empty [@] marker")).toEqual([]);
  });

  it("PB-09 il bracket non attraversa un tag, e @ dopo un alfanumerico non è citazione", () => {
    // il bracket contiene un < (confine di tag) → non è un marcatore; e "y@SMITH222" non è inline (y prima di @)
    expect(parsePandocCitesInBody("a [x</w:t><w:t>y@SMITH222] b")).toEqual([]);
  });

  it("PB-10 countPandocMarkers conta i marcatori", () => {
    expect(countPandocMarkers("none here")).toBe(0);
    expect(countPandocMarkers("[@A1B2C3D4] and @E5F6G7H8")).toBe(2);
  });
});

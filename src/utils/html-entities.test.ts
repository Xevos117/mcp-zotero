import { describe, it, expect } from "vitest";
import { decodeHtmlEntities, decodeEntitiesDeep } from "./html-entities.js";

describe("decodeHtmlEntities", () => {
  it("HE-01 entità comuni dei registri → caratteri", () => {
    expect(decodeHtmlEntities("Computers &amp; Operations Research")).toBe("Computers & Operations Research");
    expect(decodeHtmlEntities("p &lt; 0.05 &gt; q, &quot;x&quot; &apos;y&apos;")).toBe(`p < 0.05 > q, "x" 'y'`);
    expect(decodeHtmlEntities("a&nbsp;b &ndash; c &mdash; d")).toBe("a b – c — d");
  });

  it("HE-02 entità numeriche decimali ed esadecimali", () => {
    expect(decodeHtmlEntities("Caf&#233; &#x2014; &#X1F600;")).toBe("Café — \u{1F600}");
  });

  it("HE-03 una sola passata: &amp;lt; diventa il testo &lt;, non <", () => {
    expect(decodeHtmlEntities("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;");
    expect(decodeHtmlEntities("&amp;amp;")).toBe("&amp;");
  });

  it("HE-04 testo ostile resta testo: decodifica senza interpretare HTML", () => {
    expect(decodeHtmlEntities("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe("<script>alert(1)</script>");
    expect(decodeHtmlEntities("]]&gt; &lt;w:r&gt;")).toBe("]]> <w:r>");
  });

  it("HE-05 entità sconosciute, non valide o senza ; restano invariate", () => {
    expect(decodeHtmlEntities("&foo; &#0; &#xD800; &#1114112; & alone &amp no-semicolon")).toBe("&foo; &#0; &#xD800; &#1114112; & alone &amp no-semicolon");
  });

  it("HE-06 testo senza & → stessa stringa", () => {
    const s = "Ånalyse — 分析 ✓";
    expect(decodeHtmlEntities(s)).toBe(s);
  });
});

describe("decodeEntitiesDeep", () => {
  it("HE-07 decodifica ogni stringa di un CSL annidato, chiavi e non-stringhe invariate", () => {
    const csl = {
      "container-title": "Computers &amp; Operations Research",
      author: [{ family: "M&uuml;ller", given: "J&#252;rgen" }],
      issued: { "date-parts": [[2009, 11]] },
      "a&amp;b": 1,
      flag: true,
      none: null,
    };
    expect(decodeEntitiesDeep(csl)).toEqual({
      "container-title": "Computers & Operations Research",
      author: [{ family: "M&uuml;ller", given: "Jürgen" }],
      issued: { "date-parts": [[2009, 11]] },
      "a&amp;b": 1,
      flag: true,
      none: null,
    });
  });
});

import { describe, it, expect } from "vitest";
import {
  itemCitekeys,
  itemMatchesCitekey,
  citekeysOf,
  resolveCitekeys,
  INLINE_LOOKUP_CAP,
  CitekeyLookup,
  CitekeyMatch,
} from "../../src/citation-injector/citekey-resolver.js";
import { CitationRequest, InjectionError } from "../../src/citation-injector/model.js";

const bracket = (keys: string[]): CitationRequest => ({ keys, inline: false, raw: `[@${keys.join("; @")}]` });
const inline = (key: string): CitationRequest => ({ keys: [key], inline: true, raw: `@${key}` });
const lookupOf = (m: Record<string, CitekeyMatch>): CitekeyLookup => async () => new Map(Object.entries(m));

/** CK-*: risoluzione dei citekey Better BibTeX. */
describe("itemCitekeys / itemMatchesCitekey (CK)", () => {
  it("CK-01 campo nativo citationKey + righe Extra (case-insensitive label)", () => {
    expect(itemCitekeys({ citationKey: "rossi2020" })).toEqual(["rossi2020"]);
    expect(itemCitekeys({ extra: "foo: 1\nCitation Key: bianchi2021\ncitationkey: verdi2019" })).toEqual(["bianchi2021", "verdi2019"]);
  });
  it("CK-02 match esatto, case-sensitive", () => {
    expect(itemMatchesCitekey({ citationKey: "Rossi2020" }, "Rossi2020")).toBe(true);
    expect(itemMatchesCitekey({ citationKey: "Rossi2020" }, "rossi2020")).toBe(false);
  });
  it("CK-03 niente falso positivo da sottostringa", () => {
    expect(itemMatchesCitekey({ extra: "Citation Key: abcd" }, "abc")).toBe(false);
  });
});

describe("citekeysOf / resolveCitekeys (CK)", () => {
  it("CK-05 separa i citekey dalle chiavi Zotero", () => {
    expect([...citekeysOf([bracket(["SMITH222", "rossi2020"]), inline("DEEE2222")])]).toEqual(["rossi2020"]);
  });

  it("CK-06 nessun citekey → invariato, nessun lookup", async () => {
    const reqs = [bracket(["SMITH222"])];
    const spy: CitekeyLookup = async () => {
      throw new Error("should not be called");
    };
    expect((await resolveCitekeys(reqs, spy)).requests).toBe(reqs);
  });

  it("CK-07 risolve e sostituisce il citekey con la chiave Zotero", async () => {
    const out = await resolveCitekeys([bracket(["rossi2020"]), bracket(["SMITH222", "rossi2020"])], lookupOf({ rossi2020: { keys: ["RSSI2345"] } }));
    expect(out.requests[0].keys).toEqual(["RSSI2345"]);
    expect(out.requests[1].keys).toEqual(["SMITH222", "RSSI2345"]);
    expect(out.warnings).toEqual([]);
  });

  it("CK-08 citekey BRACKET sconosciuto → InjectionError missing_keys, menziona case-sensitive", async () => {
    const err = await resolveCitekeys([bracket(["nope"])], lookupOf({ nope: { keys: [] } })).catch((e) => e);
    expect(err).toBeInstanceOf(InjectionError);
    expect((err as InjectionError).code).toBe("missing_keys");
    expect((err as Error).message).toMatch(/case-sensitive/);
  });

  it("CK-08b citekey sconosciuto con variante di maiuscole → suggerimento nell'errore", async () => {
    const err = await resolveCitekeys([bracket(["rossi2020"])], lookupOf({ rossi2020: { keys: [], similar: ["Rossi2020"] } })).catch((e) => e);
    expect((err as Error).message).toMatch(/did you mean Rossi2020/);
  });

  it("CK-09 citekey BRACKET ambiguo → InjectionError invalid_key", async () => {
    const err = await resolveCitekeys([bracket(["dup"])], lookupOf({ dup: { keys: ["AAAA2222", "BBBB2222"] } })).catch((e) => e);
    expect((err as InjectionError).code).toBe("invalid_key");
    expect((err as Error).message).toContain("AAAA2222, BBBB2222");
  });

  it("CK-10 INLINE non risolto → scartato (resta testo) con avviso, NESSUN errore", async () => {
    const out = await resolveCitekeys([inline("Component"), bracket(["rossi2020"])], lookupOf({ Component: { keys: [] }, rossi2020: { keys: ["RSSI2345"] } }));
    expect(out.requests.map((r) => r.keys)).toEqual([["RSSI2345"]]); // solo il bracket risolto
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/kept as text/);
  });

  it("CK-11 tutti inline non risolti → requests vuote, un avviso per ciascuno, nessun errore", async () => {
    const out = await resolveCitekeys([inline("foo"), inline("bar")], lookupOf({ foo: { keys: [] }, bar: { keys: [] } }));
    expect(out.requests).toEqual([]);
    expect(out.warnings).toHaveLength(2);
  });

  it("CK-12 inline con chiave Zotero valida → risolto senza lookup", async () => {
    const spy: CitekeyLookup = async () => {
      throw new Error("no lookup for a Zotero key");
    };
    const out = await resolveCitekeys([inline("SMITH222")], spy);
    expect(out.requests[0].keys).toEqual(["SMITH222"]);
  });

  it("CK-13 tetto sui lookup inline: oltre il limite restano testo, al massimo cap token cercati", async () => {
    // cap+10 token inline unici, tutti non risolti; conta quanti citekey arrivano al lookup
    const total = INLINE_LOOKUP_CAP + 10;
    const reqs = Array.from({ length: total }, (_, i) => inline(`handle${i}`));
    let lookedUp = 0;
    const spy: CitekeyLookup = async (cks) => {
      lookedUp += cks.size;
      return new Map([...cks].map((ck) => [ck, { keys: [] as string[] }]));
    };
    const out = await resolveCitekeys(reqs, spy);
    expect(lookedUp).toBe(INLINE_LOOKUP_CAP); // solo i primi cap token sono stati cercati
    expect(out.requests).toEqual([]); // nessuna risolta → tutte testo
    const summary = out.warnings.find((w) => w.includes("over the"));
    expect(summary).toMatch(new RegExp(`${total - INLINE_LOOKUP_CAP} inline @ citation key`));
  });

  it("CK-14 il tetto NON conta i bracket: una forma [@…] oltre il limite viene comunque cercata", async () => {
    const reqs = [
      ...Array.from({ length: INLINE_LOOKUP_CAP }, (_, i) => inline(`h${i}`)),
      bracket(["realkey"]),
    ];
    const looked = new Set<string>();
    const spy: CitekeyLookup = async (cks) => {
      for (const c of cks) looked.add(c);
      return new Map([...cks].map((ck) => [ck, { keys: ck === "realkey" ? ["REAL2222"] : [] }]));
    };
    const out = await resolveCitekeys(reqs, spy);
    expect(looked.has("realkey")).toBe(true); // il bracket è sempre cercato
    expect(looked.size).toBe(INLINE_LOOKUP_CAP + 1);
    expect(out.requests.map((r) => r.keys)).toEqual([["REAL2222"]]);
  });
});

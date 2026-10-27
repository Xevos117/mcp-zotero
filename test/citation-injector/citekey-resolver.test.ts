import { describe, it, expect } from "vitest";
import { itemMatchesCitekey, citekeysOf, resolveCitekeys, CitekeyLookup } from "../../src/citation-injector/citekey-resolver.js";
import { CitationRequest, InjectionError } from "../../src/citation-injector/model.js";

const req = (keys: string[]): CitationRequest => ({ keys, raw: `[@${keys.join("; @")}]` });

/** CK-*: risoluzione dei citekey Better BibTeX. */
describe("itemMatchesCitekey (CK)", () => {
  it("CK-01 campo nativo citationKey", () => {
    expect(itemMatchesCitekey({ citationKey: "rossi2020" }, "rossi2020")).toBe(true);
    expect(itemMatchesCitekey({ citationKey: "rossi2020" }, "altro")).toBe(false);
  });

  it("CK-02 riga 'Citation Key:' in Extra (anche 'Citationkey', case-insensitive)", () => {
    expect(itemMatchesCitekey({ extra: "foo: 1\nCitation Key: bianchi2021\nbar: 2" }, "bianchi2021")).toBe(true);
    expect(itemMatchesCitekey({ extra: "citationkey: verdi2019" }, "verdi2019")).toBe(true);
    expect(itemMatchesCitekey({ extra: "Citation Key: x" }, "y")).toBe(false);
  });

  it("CK-03 non confonde un sottostringa: 'Citation Key: ab' non combacia con 'a'", () => {
    expect(itemMatchesCitekey({ extra: "Citation Key: abcd" }, "abc")).toBe(false);
  });

  it("CK-04 campo/Extra assenti o non stringa", () => {
    expect(itemMatchesCitekey({}, "x")).toBe(false);
    expect(itemMatchesCitekey({ citationKey: 123 as unknown as string }, "123")).toBe(false);
  });
});

describe("citekeysOf / resolveCitekeys (CK)", () => {
  it("CK-05 separa i citekey dalle chiavi Zotero ben formate", () => {
    expect([...citekeysOf([req(["SMITH222", "rossi2020"]), req(["DEEE2222"])])]).toEqual(["rossi2020"]);
  });

  it("CK-06 nessun citekey → richieste invariate, nessun lookup", async () => {
    const reqs = [req(["SMITH222"])];
    const spy: CitekeyLookup = async () => {
      throw new Error("should not be called");
    };
    expect(await resolveCitekeys(reqs, spy)).toBe(reqs);
  });

  it("CK-07 risolve e sostituisce il citekey con la chiave Zotero", async () => {
    const lookup: CitekeyLookup = async () => new Map([["rossi2020", ["RSSI2345"]]]);
    const out = await resolveCitekeys([req(["rossi2020"]), req(["SMITH222", "rossi2020"])], lookup);
    expect(out[0].keys).toEqual(["RSSI2345"]);
    expect(out[1].keys).toEqual(["SMITH222", "RSSI2345"]);
  });

  it("CK-08 citekey sconosciuto → InjectionError missing_keys", async () => {
    const lookup: CitekeyLookup = async () => new Map([["nope", []]]);
    await expect(resolveCitekeys([req(["nope"])], lookup)).rejects.toMatchObject({
      name: "InjectionError",
      code: "missing_keys",
    });
  });

  it("CK-09 citekey ambiguo → InjectionError invalid_key", async () => {
    const lookup: CitekeyLookup = async () => new Map([["dup", ["AAAA2222", "BBBB2222"]]]);
    const err = await resolveCitekeys([req(["dup"])], lookup).catch((e) => e);
    expect(err).toBeInstanceOf(InjectionError);
    expect((err as InjectionError).code).toBe("invalid_key");
    expect((err as Error).message).toContain("AAAA2222, BBBB2222");
  });
});

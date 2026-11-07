import JSZip from "jszip";
import { ZoteroApiInterface } from "../../src/types/zotero-types.js";
import { makeDocx, para, zcite } from "../helpers/fixtures.js";
import { article } from "../helpers/zotero-fake.js";
import { corpusLibrary } from "../helpers/corpus.js";
import type { CitationStyle } from "../helpers/docx-validate.js";

/**
 * Corpus delle fixture per il test golden del percorso Word (PR A): un insieme fisso di documenti
 * .docx iniettati con inject_citations, catturati prima del refactor del nucleo comune e confrontati
 * byte per byte dopo. Copre ogni scenario delle fixture IC più un campione del corpus reale.
 *
 * L'unica differenza ammessa tra due esecuzioni è l'id della citazione (randomUUID) e l'id di sessione
 * delle preferenze (randomBytes): vengono normalizzati prima del confronto, vedi normalizeGolden.
 */

/** Libreria di voci Zotero (formato API) servita alla fake API per chiave. */
export const LIBRARY: Record<string, Record<string, unknown>> = {
  SMITH222: article("SMITH222", {
    title: "On Testing",
    creators: [{ creatorType: "author", firstName: "John", lastName: "Smith" }],
    date: "2023",
  }),
  PAIR2222: article("PAIR2222", {
    title: "Pair Paper",
    creators: [
      { creatorType: "author", firstName: "Jane", lastName: "Doe" },
      { creatorType: "author", firstName: "Rick", lastName: "Roe" },
    ],
    date: "2019-03-01",
  }),
  MANY2222: article("MANY2222", {
    title: "Many Authors",
    date: "2020-06-25",
    creators: ["Pessoa", "Sadykov", "Uchoa", "Vanderbeck"].map((lastName) => ({ creatorType: "author", firstName: "A.", lastName })),
  }),
  HALLMANN: article("HALLMANN", {
    title: "Insects",
    date: "2017-10-18",
    creators: [
      { creatorType: "author", firstName: "Caspar A.", lastName: "Hallmann" },
      { creatorType: "author", firstName: "Hans", lastName: "de Kroon" },
    ],
  }),
  UNI22222: article("UNI22222", { title: "Über «Lernen» & 学习", date: "2021", creators: [{ creatorType: "author", firstName: "Jürgen", lastName: "Müller-Ødegård" }] }),
  NAUTH222: article("NAUTH222", { title: "Anonymous memo", date: "2019", creators: [] }),
  CNSRTIUM: { itemType: "report", title: "Consortium report", date: "2021", creators: [{ creatorType: "author", name: "Test Consortium" }] },
  FULL2222: article("FULL2222", {
    title: "Full Record",
    creators: [{ creatorType: "author", firstName: "Hans", lastName: "de Kroon" }],
    date: "2017-10-18",
    volume: "12",
    issue: "10",
    pages: "e0185809",
    publisher: "PLOS",
    place: "San Francisco",
    abstractNote: "A long abstract that must not end up in the field code.",
  }),
  CHAPTER2: {
    itemType: "bookSection",
    title: "Gamma chapter",
    bookTitle: "Collected Gammas",
    publisher: "G Press",
    pages: "5-30",
    date: "2020",
    series: "",
    creators: [
      { creatorType: "author", firstName: "Gina", lastName: "Gamma" },
      { creatorType: "author", name: "Gamma Consortium" },
      { creatorType: "editor", firstName: "Ugo", lastName: "Gialli" },
      { creatorType: "seriesEditor", firstName: "Sara", lastName: "Serie" },
      { creatorType: "contributor", firstName: "Not", lastName: "Cited" },
    ],
  },
  HQST2345: article("HQST2345", {
    title: "<script>alert(1)</script> & ]]> \"quoted\" <w:r><w:t>x</w:t></w:r>",
    publicationTitle: "Computers & Operations Research",
    creators: [{ creatorType: "author", firstName: "Ángel", lastName: "Felipe & <Co>" }],
    date: "2009",
  }),
};

// Un campione del corpus reale (open-licensed): esercita il percorso su dati veri.
const corpusItems = corpusLibrary().items.filter((i) => i.itemType !== "attachment" && i.itemType !== "note");
const CORPUS_SAMPLE = corpusItems.slice(0, 4);
for (const item of CORPUS_SAMPLE) LIBRARY[item.key] = item as Record<string, unknown>;

/** Corpo IC-V01: 5 citazioni, 7 voci distinte, in ordine di prima citazione. */
const MATRIX_BODY = (numbered: boolean) =>
  para("Single ", zcite({ keys: "SMITH222", ...(numbered && { num: "1" }) })) +
  para("Pair and many ", zcite({ keys: "PAIR2222,MANY2222", ...(numbered && { num: "2,3" }) })) +
  para("Locator ", zcite({ keys: "HALLMANN", locator: "pp. 12-15", prefix: "see ", suffix: ", fig. 2", ...(numbered && { num: "4" }) })) +
  para("Unicode, no author, institution ", zcite({ keys: "UNI22222,NAUTH222,CNSRTIUM", ...(numbered && { num: "5-7" }) })) +
  para("Repeated ", zcite({ keys: "SMITH222", ...(numbered && { num: "1" }) }));

const CORPUS_BODY = (numbered: boolean) =>
  CORPUS_SAMPLE.map((item, i) => para(`Ref ${i} `, zcite({ keys: item.key, ...(numbered && { num: String(i + 1) }) }))).join("");

export interface GoldenCase {
  name: string;
  style: CitationStyle;
  libraryType: "user" | "group";
  userId: string;
  /** Produce il .docx di input (default: makeDocx(body)). */
  input: () => Promise<Buffer>;
}

const docxCase = (name: string, body: string, style: CitationStyle = "apa", libraryType: "user" | "group" = "user", userId = "424242"): GoldenCase => ({
  name,
  style,
  libraryType,
  userId,
  input: () => makeDocx(body),
});

const STYLES: CitationStyle[] = ["apa", "harvard", "chicago", "ieee", "vancouver"];
const numbered = (s: CitationStyle) => s === "ieee" || s === "vancouver";

export const GOLDEN_CASES: GoldenCase[] = [
  docxCase("single", para("As shown ", zcite({ keys: "SMITH222" }), " before.")),
  docxCase("multi", para("A ", zcite({ keys: "SMITH222" })) + para("B ", zcite({ keys: "SMITH222,PAIR2222" })) + para("C ", zcite({ keys: "PAIR2222" }))),
  docxCase("full-record", para(zcite({ keys: "FULL2222" }))),
  docxCase("chapter", para(zcite({ keys: "CHAPTER2" }))),
  docxCase("hostile", para("See ", zcite({ keys: "HQST2345" }), ".")),
  docxCase("unicode", para("Testo ", zcite({ keys: "UNI22222" }), " e ", zcite({ keys: "NAUTH222" }))),
  docxCase("attrs", para(zcite({ keys: "SMITH222", locator: "pp. 12-15", prefix: "see ", suffix: ", emphasis added" }))),
  // matrice completa nei 5 stili
  ...STYLES.map((s) => docxCase(`matrix-${s}`, MATRIX_BODY(numbered(s)), s)),
  // locator/prefix/suffix nei 5 stili
  ...STYLES.map((s) => docxCase(`attrs-${s}`, para(zcite({ keys: "SMITH222", num: "1", locator: "12-15", prefix: "see", suffix: ", fig. 2" })), s)),
  // libreria di gruppo
  { ...docxCase("group", para(zcite({ keys: "SMITH222,PAIR2222" }))), libraryType: "group", userId: "777" },
  // campione del corpus reale, apa e ieee
  docxCase("corpus-apa", CORPUS_BODY(false), "apa"),
  docxCase("corpus-ieee", CORPUS_BODY(true), "ieee"),
  // preferenze: parte custom non unibile (H1c) → preferenze non scritte, parte intatta
  {
    ...docxCase("prefs-unmergeable", MATRIX_BODY(false)),
    input: async () => {
      const zip = await JSZip.loadAsync(await makeDocx(MATRIX_BODY(false)));
      zip.file("docProps/custom.xml", '<?xml version="1.0"?><x:Other xmlns:x="y"/>');
      return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
    },
  },
  // preferenze: documento già gestito da Zotero (H1b) → lasciate come sono
  {
    ...docxCase("prefs-managed", MATRIX_BODY(false), "ieee"),
    input: async () => {
      const zip = await JSZip.loadAsync(await makeDocx(MATRIX_BODY(false)));
      const zotero = '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="ZOTERO_PREF_1"><vt:lpwstr>KEEP</vt:lpwstr></property>';
      zip.file("docProps/custom.xml", `<?xml version="1.0"?><Properties xmlns:vt="v">${zotero}</Properties>`);
      return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
    },
  },
];

/** Fake Zotero API che serve LIBRARY per chiave; 404 (ZoteroApiError) per chiavi assenti. */
export function fakeZoteroApi(library: Record<string, Record<string, unknown>> = LIBRARY): ZoteroApiInterface {
  let pendingKey: string | undefined;
  const make = (): ZoteroApiInterface =>
    ({
      library: () => make(),
      collections: () => make(),
      items: (key?: string) => {
        if (key !== undefined) pendingKey = key;
        return make();
      },
      children: () => make(),
      top: () => make(),
      trash: () => make(),
      version: () => make(),
      async get() {
        const data = library[pendingKey!];
        if (!data) {
          const err = new Error("Item not found") as Error & { response: { status: number } };
          err.response = { status: 404 };
          throw err;
        }
        return { getData: () => data, getVersion: () => 1, getTotalResults: () => null };
      },
      post: async () => {
        throw new Error("not supported in golden fake");
      },
      delete: async () => {
        throw new Error("not supported in golden fake");
      },
    }) as unknown as ZoteroApiInterface;
  return make();
}

/**
 * Normalizza le parti variabili: l'id della citazione (8 hex da randomUUID) e l'id di sessione delle
 * preferenze del documento (sia grezzo sia XML-escapato). Tutto il resto deve restare identico.
 */
export function normalizeGolden(xml: string): string {
  return xml
    // citationID nel field code: il JSON è XML-escapato dentro w:instrText
    .replace(/("citationID":")[0-9a-fA-F]+(")/g, "$1CID$2")
    .replace(/(&quot;citationID&quot;:&quot;)[0-9a-fA-F]+(&quot;)/g, "$1CID$2")
    // id di sessione nelle preferenze (custom.xml), grezzo o escapato
    .replace(/(session id=")[^"]*(")/g, "$1SID$2")
    .replace(/(session id=&quot;)[^&]*(&quot;)/g, "$1SID$2");
}

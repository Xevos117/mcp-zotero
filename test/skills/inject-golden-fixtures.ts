import { makeDocx, para, zcite } from "../helpers/fixtures.js";
import { normalizeGolden } from "../citation-injector/golden-fixtures.js";

/**
 * Fixture per il golden dello script della skill (PR B): lo `inject.js` generato dal sorgente TS deve
 * produrre lo stesso docx dello script scritto a mano di oggi. Gli snapshot (test/fixtures/golden-skill/)
 * sono stati catturati dallo script precedente al refactor; `UPDATE_SKILL_GOLDEN=1` li rigenera.
 *
 * I metadati sono nel formato di get_items_details (authors come stringa oppure creators strutturati,
 * campi con i nomi di Zotero), così si esercita metadataToCsl della CLI.
 */

export const METADATA: Record<string, Record<string, unknown>> = {
  SMITH222: { itemType: "journalArticle", title: "On Testing", authors: "John Smith", date: "2023", DOI: "10.1/x", publicationTitle: "J. Tests", volume: "4", pages: "1-9" },
  PAIR2222: { itemType: "book", title: "Pair Book", authors: "Jane Doe, Rick Roe", date: "2019-03-01", publisher: "Press", place: "Rome" },
  CHAPTER2: { itemType: "bookSection", title: "Gamma chapter", bookTitle: "Collected Gammas", pages: "5-30", date: "2020", creators: [{ creatorType: "author", firstName: "Gina", lastName: "Gamma" }, { creatorType: "editor", firstName: "Ugo", lastName: "Gialli" }] },
  CPNSPRTR: { itemType: "report", title: "Consortium report", date: "2021", institution: "Research Data Alliance", reportNumber: "RDA-50", creators: [{ creatorType: "author", name: "Test Consortium" }] },
  NPAUTHQR: { itemType: "document", title: "Anonymous memo but a rather long one", date: "2019", creators: [] },
  THESIS22: { itemType: "thesis", title: "A thesis", date: "October 2023", university: "University of Bologna", thesisType: "PhD thesis", numPages: "210", language: "en", creators: [{ creatorType: "author", firstName: "Ada", lastName: "Gualandi" }] },
};

export interface SkillGoldenCase {
  name: string;
  style: string;
  library: string;
  input: () => Promise<Buffer>;
}

const MATRIX = (numbered: boolean) =>
  para("A ", zcite({ keys: "SMITH222", ...(numbered && { num: "1" }) })) +
  para("B ", zcite({ keys: "PAIR2222,CHAPTER2", locator: "p. 3", prefix: "see ", ...(numbered && { num: "2,3" }) })) +
  para("C ", zcite({ keys: "CPNSPRTR,NPAUTHQR", ...(numbered && { num: "4,5" }) })) +
  para("D ", zcite({ keys: "THESIS22", ...(numbered && { num: "6" }) }));

const mk = (name: string, body: string, style: string, library = "users/424242"): SkillGoldenCase => ({
  name,
  style,
  library,
  input: () => makeDocx(body),
});

export const SKILL_GOLDEN_CASES: SkillGoldenCase[] = [
  mk("apa", MATRIX(false), "apa"),
  mk("harvard", MATRIX(false), "harvard"),
  mk("chicago", MATRIX(false), "chicago"),
  mk("ieee", MATRIX(true), "ieee"),
  mk("vancouver", MATRIX(true), "vancouver"),
  mk("group", para(zcite({ keys: "SMITH222,PAIR2222" })), "apa", "groups/777"),
];

export { normalizeGolden };

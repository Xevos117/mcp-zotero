import { CslItemData, CslName } from "../types/csl-types.js";
import { ZoteroItemData } from "../types/zotero-types.js";
import { ITEM_TYPE_CREATOR_TYPES, ITEM_TYPE_FIELDS, ZoteroItemType } from "./zotero-item-types.js";

const CSL_TO_ZOTERO_TYPE: Record<string, string> = {
  // Standard CSL types
  "article": "journalArticle",
  "article-journal": "journalArticle",
  "article-magazine": "magazineArticle",
  "article-newspaper": "newspaperArticle",
  "bill": "bill",
  "book": "book",
  "broadcast": "tvBroadcast",
  "chapter": "bookSection",
  "dataset": "dataset",
  "document": "document",
  "entry-dictionary": "dictionaryEntry",
  "entry-encyclopedia": "encyclopediaArticle",
  "figure": "artwork",
  "graphic": "artwork",
  "hearing": "hearing",
  "interview": "interview",
  "legal_case": "case",
  "legislation": "statute",
  "manuscript": "manuscript",
  "map": "map",
  "motion_picture": "film",
  "paper-conference": "conferencePaper",
  "patent": "patent",
  "personal_communication": "letter",
  "post": "forumPost",
  "post-weblog": "blogPost",
  "report": "report",
  "review": "journalArticle",
  "review-book": "journalArticle",
  "software": "computerProgram",
  "song": "audioRecording",
  "speech": "presentation",
  "standard": "standard",
  "thesis": "thesis",
  "webpage": "webpage",
  // Non-standard types returned by CrossRef/DataCite DOI content negotiation
  "journal-article": "journalArticle",
  "book-chapter": "bookSection",
  "proceedings-article": "conferencePaper",
  "posted-content": "preprint",
  "dissertation": "thesis",
  "monograph": "book",
  "reference-entry": "encyclopediaArticle",
  "component": "document",
  "peer-review": "journalArticle",
  "edited-book": "book",
  "reference-book": "book",
  "book-series": "book",
  "book-part": "bookSection",
  "proceedings": "book",
  "journal": "journalArticle",
  "report-series": "report",
};

const ZOTERO_TO_CSL_TYPE: Record<string, string> = {
  journalArticle: "article-journal",
  magazineArticle: "article-magazine",
  newspaperArticle: "article-newspaper",
  bill: "bill",
  book: "book",
  tvBroadcast: "broadcast",
  bookSection: "chapter",
  dataset: "dataset",
  document: "document",
  dictionaryEntry: "entry-dictionary",
  encyclopediaArticle: "entry-encyclopedia",
  artwork: "graphic",
  hearing: "hearing",
  interview: "interview",
  case: "legal_case",
  statute: "legislation",
  manuscript: "manuscript",
  map: "map",
  film: "motion_picture",
  conferencePaper: "paper-conference",
  patent: "patent",
  letter: "personal_communication",
  forumPost: "post",
  blogPost: "post-weblog",
  report: "report",
  computerProgram: "software",
  audioRecording: "song",
  presentation: "speech",
  standard: "standard",
  thesis: "thesis",
  webpage: "webpage",
  radioBroadcast: "broadcast",
  videoRecording: "motion_picture",
  preprint: "article",
  podcast: "song",
  email: "personal_communication",
  instantMessage: "personal_communication",
};

/**
 * Maps CSL `container-title` to the correct Zotero field name per item type.
 * Types not listed here have no container-title equivalent.
 */
const CONTAINER_TITLE_FIELD: Partial<Record<ZoteroItemType, string>> = {
  journalArticle: "publicationTitle",
  magazineArticle: "publicationTitle",
  newspaperArticle: "publicationTitle",
  bookSection: "bookTitle",
  dictionaryEntry: "dictionaryTitle",
  conferencePaper: "proceedingsTitle",
  blogPost: "blogTitle",
  encyclopediaArticle: "encyclopediaTitle",
  forumPost: "forumTitle",
  webpage: "websiteTitle",
  radioBroadcast: "programTitle",
  tvBroadcast: "programTitle",
  podcast: "programTitle",
};

/**
 * CSL name variables ⇄ Zotero creator types, as in Zotero's CSL mappings. Authors first: the
 * order of the CSL arrays becomes the order of the Zotero creators.
 */
const CSL_NAME_CREATOR_TYPES = [
  ["author", "author"],
  ["editor", "editor"],
  ["container-author", "bookAuthor"],
  ["collection-editor", "seriesEditor"],
  ["translator", "translator"],
] as const;

/** Zotero field holding the CSL publisher, for the types that call it otherwise (Zotero's base field mappings). */
const PUBLISHER_FIELD: Partial<Record<ZoteroItemType, string>> = {
  thesis: "university",
  report: "institution",
  preprint: "repository",
};

/** Zotero field holding the CSL number (report number, standard or manuscript number). */
const NUMBER_FIELD: Partial<Record<ZoteroItemType, string>> = {
  report: "reportNumber",
  standard: "number",
  manuscript: "number",
};

/** arXiv DOIs (DataCite): the item is a preprint in the arXiv repository. */
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i;

/** JATS abstract (Crossref: <jats:p>, <jats:italic>, …) → plain text, one line per paragraph, as Zotero's import does. */
function plainAbstract(abstract: string): string {
  if (!/<jats:/.test(abstract)) return abstract;
  return abstract
    .split(/<\/jats:p>/)
    .map((p) => p.replace(/<\/?jats:[^>]*>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

type ZoteroCreatorOut = { firstName: string; lastName: string; creatorType: string } | { name: string; creatorType: string };

export interface CslToZoteroOptions {
  collectionKey?: string;
  tags?: string[];
}

export interface CslToZoteroResult {
  itemType: string;
  creators: ZoteroCreatorOut[];
  collections: string[];
  tags: Array<{ tag: string }>;
  [field: string]: unknown;
}

export function cslToZoteroItem(
  csl: CslItemData,
  options?: CslToZoteroOptions
): CslToZoteroResult {
  const arxiv = ARXIV_DOI.exec(csl.DOI ?? "");
  const itemType = (arxiv ? "preprint" : (CSL_TO_ZOTERO_TYPE[csl.type] ?? "journalArticle")) as ZoteroItemType;

  // Authors always (as before); other roles only where the item type has them, or the API rejects the item.
  // A CSL `literal` (institution, consortium) is Zotero's single-field name
  const validCreatorTypes = ITEM_TYPE_CREATOR_TYPES[itemType];
  const creators: ZoteroCreatorOut[] = CSL_NAME_CREATOR_TYPES.flatMap(([variable, creatorType]) =>
    creatorType !== "author" && !validCreatorTypes?.has(creatorType)
      ? []
      : (csl[variable] ?? []).map((a): ZoteroCreatorOut =>
          a.literal && !a.family ? { name: a.literal, creatorType } : { firstName: a.given ?? "", lastName: a.family ?? "", creatorType }
        )
  );

  const dateParts = csl.issued?.["date-parts"]?.[0];
  const date = dateParts ? dateParts.join("-") : csl.issued?.literal ?? csl.issued?.raw ?? "";

  const collections: string[] = [];
  if (options?.collectionKey) {
    collections.push(options.collectionKey);
  }

  const tags = (options?.tags ?? []).map((t) => ({ tag: t }));

  // Zotero joins the subtitle to the title; the article number is the item's number, or its pages when it has none
  const subtitle = Array.isArray(csl.subtitle) ? csl.subtitle[0] : csl.subtitle;
  const title = subtitle ? `${csl.title ?? ""}: ${subtitle}` : (csl.title ?? "");
  const number = csl.number ?? csl["article-number"] ?? "";
  const numberField = NUMBER_FIELD[itemType];

  // Build candidate fields (CSL → Zotero field names)
  const candidates: Record<string, string> = {
    title,
    date,
    DOI: csl.DOI ?? "",
    volume: csl.volume ?? "",
    issue: csl.issue ?? "",
    pages: csl.page ?? (numberField ? "" : (csl["article-number"] ?? "")),
    publisher: csl.publisher ?? "",
    place: csl["publisher-place"] ?? "",
    url: csl.URL ?? "",
    abstractNote: csl.abstract ? plainAbstract(csl.abstract) : "",
    ISBN: Array.isArray(csl.ISBN) ? csl.ISBN[0] : csl.ISBN ?? "",
    ISSN: Array.isArray(csl.ISSN) ? csl.ISSN[0] : csl.ISSN ?? "",
    edition: csl.edition ?? "",
    numPages: csl["number-of-pages"] ?? "",
    series: csl["collection-title"] ?? "",
    language: csl.language ?? "",
    journalAbbreviation: csl["container-title-short"] ?? "",
    conferenceName: csl["event-title"] ?? csl.event ?? "",
  };
  if (numberField) candidates[numberField] = number;
  const publisherField = PUBLISHER_FIELD[itemType];
  if (publisherField) candidates[publisherField] = arxiv ? "arXiv" : (csl.publisher ?? "");
  if (arxiv) candidates.archiveID = `arXiv:${arxiv[1]}`;

  // Map container-title to the correct field for this item type
  const containerTitleField = CONTAINER_TITLE_FIELD[itemType];
  if (containerTitleField) {
    candidates[containerTitleField] = csl["container-title"] ?? "";
  }

  // Filter: only include fields valid for this item type
  const validFields = ITEM_TYPE_FIELDS[itemType];
  const result: CslToZoteroResult = { itemType, creators, collections, tags };

  if (validFields) {
    for (const [field, value] of Object.entries(candidates)) {
      if (validFields.has(field)) {
        result[field] = value;
      }
    }
  } else {
    // Unknown item type — include all fields as fallback
    for (const [field, value] of Object.entries(candidates)) {
      result[field] = value;
    }
  }

  return result;
}

/** Zotero creator → CSL name: a single-field name (institution) is a CSL `literal`. */
function cslName(c: { firstName?: string; lastName?: string; name?: string }): CslName {
  if (c.name && !c.lastName) return { literal: c.name };
  return { family: c.lastName ?? "", given: c.firstName ?? "" };
}

/** CSL title of the container, from the item type's own field (bookTitle, proceedingsTitle, ...) or publicationTitle. */
function containerTitle(item: ZoteroItemData): string | undefined {
  const field = CONTAINER_TITLE_FIELD[item.itemType as ZoteroItemType];
  const fields = item as Record<string, unknown>;
  const value = (field && fields[field]) || item.publicationTitle;
  return typeof value === "string" && value ? value : undefined;
}

/**
 * CSL date of a Zotero date: "YYYY-MM-DD" (or a prefix of it) as date-parts; a date that does not start that way
 * ("October 2023", "Spring 2023") as `raw`, which citeproc parses itself, instead of being dropped.
 */
export function cslDate(value: string | undefined): CslItemData["issued"] | undefined {
  if (!value) return undefined;
  const parts = value.split("-").map(Number).filter((n) => !isNaN(n));
  return parts.length > 0 ? { "date-parts": [parts] } : { raw: value };
}

export function zoteroItemToCsl(item: ZoteroItemData): CslItemData {
  const names: Partial<Record<(typeof CSL_NAME_CREATOR_TYPES)[number][0], CslName[]>> = {};
  for (const [variable, creatorType] of CSL_NAME_CREATOR_TYPES) {
    const list = (item.creators ?? []).filter((c) => c.creatorType === creatorType).map(cslName);
    if (list.length > 0) names[variable] = list;
  }

  // The Zotero API returns every field of the item type, empty ones as "": keep them out of the field code
  const fields = item as Record<string, unknown>;
  const text = (...values: unknown[]) => values.find((v): v is string => typeof v === "string" && v !== "") ?? undefined;
  // accessDate is "YYYY-MM-DD hh:mm:ss" or ISO: only the day
  const accessDate = text(fields.accessDate)?.replace(/[T ].*$/, "");
  return {
    type: ZOTERO_TO_CSL_TYPE[item.itemType ?? ""] ?? "article-journal",
    title: text(item.title),
    ...names,
    issued: cslDate(item.date),
    DOI: text(item.DOI),
    "container-title": containerTitle(item),
    volume: text(item.volume),
    issue: text(item.issue),
    page: text(item.pages),
    // Zotero's base fields: university (thesis), institution (report), repository (preprint) are the publisher;
    // reportNumber and archiveID the number; thesisType and reportType the genre
    publisher: text(item.publisher, fields.university, fields.institution, fields.repository),
    "publisher-place": text(item.place),
    number: text(fields.reportNumber, fields.archiveID),
    genre: text(fields.thesisType, fields.reportType),
    URL: text(item.url),
    accessed: cslDate(accessDate),
    ISBN: text(fields.ISBN),
    ISSN: text(fields.ISSN),
    edition: text(fields.edition),
    language: text(fields.language),
    "number-of-pages": text(fields.numPages),
    // abstract deliberately omitted: it bloats every field code (same choice as the skill's inject.js)
  };
}

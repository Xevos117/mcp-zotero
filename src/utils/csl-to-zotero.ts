import { CslItemData, CslName } from "../types/csl-types.js";
import { ZoteroItemData } from "../types/zotero-types.js";
import { ITEM_TYPE_FIELDS, ZoteroItemType } from "./zotero-item-types.js";

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

export interface CslToZoteroOptions {
  collectionKey?: string;
  tags?: string[];
}

export interface CslToZoteroResult {
  itemType: string;
  creators: Array<{ firstName: string; lastName: string; creatorType: string }>;
  collections: string[];
  tags: Array<{ tag: string }>;
  [field: string]: unknown;
}

export function cslToZoteroItem(
  csl: CslItemData,
  options?: CslToZoteroOptions
): CslToZoteroResult {
  const itemType = (CSL_TO_ZOTERO_TYPE[csl.type] ?? "journalArticle") as ZoteroItemType;

  const creators = (csl.author ?? []).map((a) => ({
    firstName: a.given ?? "",
    lastName: a.family ?? a.literal ?? "",
    creatorType: "author",
  }));

  const dateParts = csl.issued?.["date-parts"]?.[0];
  const date = dateParts ? dateParts.join("-") : csl.issued?.literal ?? csl.issued?.raw ?? "";

  const collections: string[] = [];
  if (options?.collectionKey) {
    collections.push(options.collectionKey);
  }

  const tags = (options?.tags ?? []).map((t) => ({ tag: t }));

  // Build candidate fields (CSL → Zotero field names)
  const candidates: Record<string, string> = {
    title: csl.title ?? "",
    date,
    DOI: csl.DOI ?? "",
    volume: csl.volume ?? "",
    issue: csl.issue ?? "",
    pages: csl.page ?? "",
    publisher: csl.publisher ?? "",
    place: csl["publisher-place"] ?? "",
    url: csl.URL ?? "",
    abstractNote: csl.abstract ?? "",
    ISBN: Array.isArray(csl.ISBN) ? csl.ISBN[0] : csl.ISBN ?? "",
    ISSN: Array.isArray(csl.ISSN) ? csl.ISSN[0] : csl.ISSN ?? "",
    edition: csl.edition ?? "",
    numPages: csl["number-of-pages"] ?? "",
    series: csl["collection-title"] ?? "",
    language: csl.language ?? "",
  };

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

export function zoteroItemToCsl(item: ZoteroItemData): CslItemData {
  const authors: CslName[] = (item.creators ?? [])
    .filter((c) => c.creatorType === "author")
    .map((c) => ({
      family: c.lastName ?? c.name ?? "",
      given: c.firstName ?? "",
    }));

  let issued: CslItemData["issued"] | undefined;
  if (item.date) {
    const parts = item.date.split("-").map(Number).filter((n) => !isNaN(n));
    if (parts.length > 0) {
      issued = { "date-parts": [parts] };
    }
  }

  return {
    type: ZOTERO_TO_CSL_TYPE[item.itemType ?? ""] ?? "article-journal",
    title: item.title,
    author: authors.length > 0 ? authors : undefined,
    issued,
    DOI: item.DOI,
    "container-title": item.publicationTitle,
    URL: item.url,
    abstract: item.abstractNote,
  };
}

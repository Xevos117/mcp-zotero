import { CslItemData, CslName } from "../types/csl-types.js";
import { ZoteroItemData } from "../types/zotero-types.js";

const CSL_TO_ZOTERO_TYPE: Record<string, string> = {
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

interface ZoteroItemPayload {
  itemType: string;
  title: string;
  creators: Array<{
    firstName: string;
    lastName: string;
    creatorType: string;
  }>;
  date: string;
  DOI: string;
  publicationTitle: string;
  volume: string;
  issue: string;
  pages: string;
  publisher: string;
  place: string;
  url: string;
  abstractNote: string;
  ISBN: string;
  ISSN: string;
  edition: string;
  numPages: string;
  series: string;
  language: string;
  collections: string[];
  tags: Array<{ tag: string }>;
}

export interface CslToZoteroOptions {
  collectionKey?: string;
  tags?: string[];
}

export function cslToZoteroItem(
  csl: CslItemData,
  options?: CslToZoteroOptions
): ZoteroItemPayload {
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

  return {
    itemType: CSL_TO_ZOTERO_TYPE[csl.type] ?? "journalArticle",
    title: csl.title ?? "",
    creators,
    date,
    DOI: csl.DOI ?? "",
    publicationTitle: csl["container-title"] ?? "",
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
    collections,
    tags,
  };
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

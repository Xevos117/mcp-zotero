export interface CslName {
  family?: string;
  given?: string;
  literal?: string;
}

export interface CslDate {
  "date-parts"?: (string | number)[][];
  literal?: string;
  raw?: string;
}

export interface CslItemData {
  id?: string | number;
  type: string;
  title?: string;
  author?: CslName[];
  issued?: CslDate;
  DOI?: string;
  "container-title"?: string;
  volume?: string;
  issue?: string;
  page?: string;
  publisher?: string;
  "publisher-place"?: string;
  URL?: string;
  abstract?: string;
  ISSN?: string | string[];
  ISBN?: string | string[];
  language?: string;
  edition?: string;
  editor?: CslName[];
  "container-author"?: CslName[];
  "collection-editor"?: CslName[];
  translator?: CslName[];
  "collection-title"?: string;
  "number-of-pages"?: string;
  /** Crossref sends it as an array. */
  subtitle?: string | string[];
  "container-title-short"?: string;
  event?: string;
  "event-title"?: string;
  number?: string;
  "article-number"?: string;
  /** Kind of thesis or report (Zotero thesisType, reportType). */
  genre?: string;
  accessed?: CslDate;
}

export interface ZoteroCitationItem {
  id: number;
  uris: string[];
  uri: string[];
  itemData: CslItemData;
  locator?: string;
  prefix?: string;
  suffix?: string;
}

export interface ZoteroCslCitation {
  citationID: string;
  properties: {
    formattedCitation: string;
  };
  citationItems: ZoteroCitationItem[];
  schema: string;
}

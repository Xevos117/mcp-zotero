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
  "collection-title"?: string;
  "number-of-pages"?: string;
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

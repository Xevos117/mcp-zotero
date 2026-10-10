export interface ZoteroCreator {
  firstName?: string;
  lastName?: string;
  name?: string;
  creatorType?: string;
}

export interface ZoteroTag {
  tag: string;
  type?: number;
}

export interface ZoteroNote {
  key: string;
  version: number;
  note: string;
}

export interface ZoteroItemData {
  key?: string;
  version?: number;
  itemType?: string;
  title?: string;
  creators?: ZoteroCreator[];
  abstractNote?: string;
  date?: string;
  dateAdded?: string;
  dateModified?: string;
  DOI?: string;
  url?: string;
  tags?: ZoteroTag[];
  collections?: string[];
  notes?: ZoteroNote[];
  publicationTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  place?: string;
  contentType?: string;
  parentCollection?: string;
  numItems?: number;
  name?: string;
  linkMode?: string;
  parentItem?: string;
  websiteTitle?: string;
  accessDate?: string;
}

export interface ZoteroItem {
  key: string;
  version: number;
  library: {
    type: string;
    id: number;
    name: string;
  };
  links: {
    self: {
      href: string;
      type: string;
    };
    alternate: {
      href: string;
      type: string;
    };
  };
  meta: {
    numItems?: number;
    numCollections?: number;
  };
  data: ZoteroItemData;
}

export interface ZoteroRequestConfig {
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  params?: Record<string, unknown>;
}

export interface ZoteroResponse {
  getData(): ZoteroItemData | ZoteroItemData[];
  getVersion(): number | null;
  getTotalResults(): number | null;
}

/** Failure entry of a multi-object write, keyed by request index in getErrors(). */
export interface ZoteroWriteError {
  key?: string;
  code?: number;
  message?: string;
}

export interface ZoteroWriteResponse {
  isSuccess(): boolean;
  getData(): ZoteroItemData[];
  getErrors(): Record<string, ZoteroWriteError>;
  getEntityByIndex(index: number): ZoteroItemData;
}

export interface ZoteroDeleteResponse {
  getVersion(): number;
}

export interface ZoteroApiInterface {
  library(type: string, id: number | string): ZoteroApiInterface;
  collections(key?: string): ZoteroApiInterface;
  items(key?: string): ZoteroApiInterface;
  children(): ZoteroApiInterface;
  top(): ZoteroApiInterface;
  trash(): ZoteroApiInterface;
  version(version: number): ZoteroApiInterface;
  get(config?: Record<string, unknown>): Promise<ZoteroResponse>;
  post(data: unknown[], opts?: Record<string, unknown>): Promise<ZoteroWriteResponse>;
  delete(keysToDelete?: string[]): Promise<ZoteroDeleteResponse>;
}

export interface ZoteroFulltextResponse {
  content: string;
  indexedPages?: number;
  totalPages?: number;
  indexedChars?: number;
  totalChars?: number;
}

export interface ZoteroApi {
  (key?: string): ZoteroApiInterface;
}

export interface ZoteroApiError extends Error {
  response: { status: number; url?: string };
}

export function isZoteroApiError(err: unknown): err is ZoteroApiError {
  if (!(err instanceof Error)) return false;
  const rec = err as unknown as Record<string, unknown>;
  if (typeof rec.response !== "object" || rec.response === null) return false;
  const resp = rec.response as Record<string, unknown>;
  return typeof resp.status === "number";
}

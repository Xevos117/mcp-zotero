import { z } from "zod";

/** Zotero object keys (items, collections): 8 characters from this alphabet, never 0, 1, O or lowercase. */
export const ZOTERO_KEY = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;

export const INVALID_KEY_MESSAGE = "Invalid Zotero key: expected 8 characters from 23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";

/**
 * Schema for every key argument of every tool. Keys end up in API URL paths (zotero-api-client does not
 * encode path segments, and URL parsing resolves "..") and in itemKey filters (ignored by the API when
 * no key is well-formed): a malformed key must be rejected before any request.
 */
export const zoteroKey = () => z.string().regex(ZOTERO_KEY, INVALID_KEY_MESSAGE);

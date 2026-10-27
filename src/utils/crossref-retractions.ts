import { fetchWithRetry } from "./fetch-retry.js";
import { readJsonObject } from "./json-response.js";

/**
 * Retraction / correction lookup via the Crossref REST API. The retraction data comes from Crossref's
 * `updated-by` array on `/works/{doi}` (sourced from Retraction Watch): each entry is a later notice about this
 * work, with its `type` (retraction, expression_of_concern, correction, erratum, …), `label`, `source` and date.
 * Verified against the real API: `updated-by` carries the notices on the retracted work itself (a normal work has
 * none); `update-to` is null there (it lives on the notice, not the retracted work). One request per DOI.
 */

/** Per-item status. `no_doi` is decided by the caller (the item has no DOI); the rest come from the lookup. */
export type RetractionStatus =
  | "retracted"
  | "expression_of_concern"
  | "corrected"
  | "ok"
  | "no_doi"
  | "not_in_crossref"
  | "lookup_failed";

export interface RetractionNotice {
  /** Crossref update type, e.g. retraction, expression_of_concern, correction, erratum. */
  type: string;
  /** DOI of the notice (the retraction/correction article), when given. */
  doi?: string;
  /** Notice date, YYYY-MM-DD, when given. */
  date?: string;
  /** Crossref source of the update, e.g. retraction-watch, crossref, publisher. */
  source?: string;
  /** Human label Crossref assigns, e.g. "Retraction", "Expression of concern". */
  label?: string;
}

export interface RetractionLookup {
  status: Exclude<RetractionStatus, "no_doi">;
  notices: RetractionNotice[];
}

const CROSSREF_WORKS = "https://api.crossref.org/works/";

// Crossref update `type` → status bucket, most severe first. A work can carry several notices (e.g. a correction
// and a later retraction); the status is the most severe present, while `notices` keeps them all.
const RETRACTED_TYPES = new Set(["retraction", "partial_retraction", "removal", "withdrawal"]);
const CONCERN_TYPES = new Set(["expression_of_concern"]);

/**
 * Canonical form of a Crossref update `type`: lowercase, hyphens and spaces to underscores. Crossref returns both
 * `expression_of_concern` and `expression-of-concern` (the hyphen form is rarer but real), so normalize before
 * comparing with the Sets above, and store the normalized form in the notices.
 */
export function normalizeType(type: unknown): string {
  return (typeof type === "string" ? type : "update").trim().toLowerCase().replace(/[-\s]+/g, "_");
}

/** The most severe status implied by a work's notices. */
export function classifyNotices(notices: RetractionNotice[]): Exclude<RetractionStatus, "no_doi" | "not_in_crossref" | "lookup_failed"> {
  if (notices.some((n) => RETRACTED_TYPES.has(n.type))) return "retracted";
  if (notices.some((n) => CONCERN_TYPES.has(n.type))) return "expression_of_concern";
  if (notices.length > 0) return "corrected";
  return "ok";
}

/** A Crossref date object ({date-time} / {date-parts}) → YYYY-MM-DD, or undefined. */
function noticeDate(updated: unknown): string | undefined {
  if (!updated || typeof updated !== "object") return undefined;
  const u = updated as Record<string, unknown>;
  if (typeof u["date-time"] === "string") return (u["date-time"] as string).slice(0, 10);
  const parts = u["date-parts"];
  if (Array.isArray(parts) && Array.isArray(parts[0]) && parts[0].length) {
    return (parts[0] as number[]).map((n, i) => (i > 0 ? String(n).padStart(2, "0") : String(n))).join("-");
  }
  return undefined;
}

/**
 * Normalize a raw DOI value (from the item's DOI field or an "DOI: …" line in Extra): drop a doi.org/doi: prefix,
 * trim and lowercase (Crossref stores DOIs lowercase). Returns undefined when the value is not a DOI.
 */
export function normalizeDoi(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const doi = raw
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim()
    .toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : undefined;
}

/** The DOI of a Zotero item: the DOI field, else a "DOI: …" line in Extra (types without a DOI field). */
export function itemDoi(item: { DOI?: unknown; extra?: unknown }): string | undefined {
  const field = typeof item.DOI === "string" ? normalizeDoi(item.DOI) : undefined;
  if (field) return field;
  if (typeof item.extra === "string") {
    const m = item.extra.match(/^\s*DOI:\s*(\S.*?)\s*$/im);
    if (m) return normalizeDoi(m[1]);
  }
  return undefined;
}

/** Look up one DOI on Crossref. Never throws: a network/timeout/parse error becomes `lookup_failed`. */
export async function lookupRetraction(doi: string, mailto?: string): Promise<RetractionLookup> {
  const url = CROSSREF_WORKS + encodeURIComponent(doi) + (mailto ? `?mailto=${encodeURIComponent(mailto)}` : "");
  const userAgent = `mcp-zotero/1.0 (retraction check${mailto ? `; mailto:${mailto}` : ""})`;
  let response: Response;
  try {
    response = await fetchWithRetry(
      url,
      { headers: { Accept: "application/json", "User-Agent": userAgent } },
      // Retry the transient server statuses Crossref can return, a bounded number of times (per-attempt timeout
      // and backoff come from fetchWithRetry); 404 and other 4xx are definitive and not retried.
      { label: "Crossref retraction lookup", retryableStatuses: [429, 500, 502, 503, 504], maxRetries: 2 }
    );
  } catch {
    return { status: "lookup_failed", notices: [] };
  }
  if (response.status === 404) return { status: "not_in_crossref", notices: [] };
  if (!response.ok) return { status: "lookup_failed", notices: [] };

  let updatedBy: Array<Record<string, unknown>>;
  try {
    const body = await readJsonObject<{ message?: { "updated-by"?: unknown } }>(response);
    const raw = body.message?.["updated-by"];
    updatedBy = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  } catch {
    return { status: "lookup_failed", notices: [] };
  }

  const notices: RetractionNotice[] = updatedBy.map((u) => ({
    type: normalizeType(u["type"]),
    doi: typeof u["DOI"] === "string" ? (u["DOI"] as string).toLowerCase() : undefined,
    date: noticeDate(u["updated"]),
    source: typeof u["source"] === "string" ? (u["source"] as string) : undefined,
    label: typeof u["label"] === "string" ? (u["label"] as string) : undefined,
  }));
  return { status: classifyNotices(notices), notices };
}

import { InvalidJsonResponseError, readJsonObject } from "./json-response.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { logger } from "./logger.js";
import { errorMessage } from "./error-formatter.js";
import { SERVER_SETTINGS } from "./error-hints.js";

export interface UnpaywallOaLocation {
  url_for_pdf: string | null;
  url: string | null;
  host_type: "publisher" | "repository";
  license: string | null;
  version: "publishedVersion" | "acceptedVersion" | "submittedVersion";
}

export interface UnpaywallResult {
  doi: string;
  is_oa: boolean;
  oa_status: "gold" | "green" | "hybrid" | "bronze" | "closed";
  best_oa_location: UnpaywallOaLocation | null;
  oa_locations: UnpaywallOaLocation[];
}

export interface OaPdfLookupResult {
  found: boolean;
  pdf_url: string | null;
  landing_url?: string | null;
  /** host_type of the location behind landing_url, when only a landing page exists. */
  landing_host_type?: UnpaywallOaLocation["host_type"] | null;
  source: string | null;
  license: string | null;
  oa_status: string | null;
  warning?: string;
}

/** Per-item reason when the lookup is disabled; tools add UNPAYWALL_EMAIL_HINT once at top level. */
export const UNPAYWALL_EMAIL_MISSING =
  "UNPAYWALL_EMAIL is not set or invalid in the server configuration: open-access PDF lookup skipped.";

export const UNPAYWALL_EMAIL_HINT =
  "No PDF lookup was done (the items themselves are fine). Tell the user that open-access PDF lookup needs UNPAYWALL_EMAIL " +
  `(a valid email address of theirs, which Unpaywall requires with each request) in ${SERVER_SETTINGS}, and then run find_and_attach_pdfs.`;

const SKIPPED_RESULT: OaPdfLookupResult = {
  found: false,
  pdf_url: null,
  source: null,
  license: null,
  oa_status: null,
  warning: UNPAYWALL_EMAIL_MISSING,
};

/** Unpaywall unreachable or failing: not the same as "no open access copy", so say so. */
function unavailableResult(what: string): OaPdfLookupResult {
  return {
    found: false,
    pdf_url: null,
    source: null,
    license: null,
    oa_status: null,
    warning: `Unpaywall lookup failed (${what}): this does not mean there is no open access PDF. Retry later with find_and_attach_pdfs.`,
  };
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Look up open-access PDF locations for a DOI via the Unpaywall API, the same data source as
 * Zotero Desktop's "Find Available PDFs". Like Zotero, it tries best_oa_location first and then the
 * other oa_locations in order: `primary` is the first location with a direct PDF, `fallback_urls`
 * the remaining distinct PDF URLs.
 */
export async function lookupOaPdfWithFallbacks(doi: string): Promise<{
  primary: OaPdfLookupResult;
  fallback_urls: string[];
}> {
  const email = process.env.UNPAYWALL_EMAIL;
  if (!email || !isValidEmail(email)) {
    logger.warn("Unpaywall lookup skipped: UNPAYWALL_EMAIL not set or invalid");
    return { primary: SKIPPED_RESULT, fallback_urls: [] };
  }
  const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;

  let response: Response;
  try {
    response = await fetchWithRetry(url, undefined, { label: "Unpaywall lookup" });
  } catch (err) {
    const detail = errorMessage(err);
    logger.error("Unpaywall API network error", { doi, error: detail });
    return { primary: unavailableResult(detail), fallback_urls: [] };
  }

  if (!response.ok) {
    logger.error("Unpaywall API error", { doi, status: response.status });
    if (response.status === 404) {
      // Unpaywall does not know the DOI (not a Crossref DOI, e.g. DataCite): nothing to look up
      return { primary: { found: false, pdf_url: null, source: null, license: null, oa_status: null }, fallback_urls: [] };
    }
    return { primary: unavailableResult(`HTTP ${response.status}`), fallback_urls: [] };
  }

  let data: UnpaywallResult;
  try {
    data = await readJsonObject<UnpaywallResult>(response);
  } catch (err) {
    if (!(err instanceof InvalidJsonResponseError)) throw err;
    logger.error("Unpaywall API returned an invalid response", { doi, error: err.message });
    return { primary: unavailableResult(err.message), fallback_urls: [] };
  }

  const locations = data.is_oa
    ? [data.best_oa_location, ...(data.oa_locations ?? [])].filter((l): l is UnpaywallOaLocation => l !== null && l !== undefined)
    : [];
  const withPdf = locations.filter((l) => l.url_for_pdf);

  if (withPdf.length === 0) {
    const landing = locations.find((l) => l.url) ?? null;
    return {
      primary: {
        found: false,
        pdf_url: null,
        landing_url: landing?.url ?? null,
        landing_host_type: landing?.host_type ?? null,
        source: null,
        license: data.best_oa_location?.license ?? null,
        oa_status: data.oa_status ?? null,
      },
      fallback_urls: [],
    };
  }

  const loc = withPdf[0];
  const pdfUrls = [...new Set(withPdf.map((l) => l.url_for_pdf as string))];

  return {
    primary: {
      found: true,
      pdf_url: loc.url_for_pdf,
      source: `unpaywall_${loc.host_type === "repository" ? "green" : data.oa_status}`,
      license: loc.license,
      oa_status: data.oa_status,
    },
    fallback_urls: pdfUrls.slice(1),
  };
}

/** Reason shown when an OA copy only has a landing page, naming where it is actually hosted. */
export function landingPageOnlyReason(result: OaPdfLookupResult): string {
  const where =
    result.landing_host_type === "publisher"
      ? "on the publisher's site"
      : result.landing_host_type === "repository"
        ? "at a repository"
        : "online";
  return `Open access copy exists ${where} but no direct PDF link is available. The user can download it manually from the landing page and use import_pdf_to_zotero to attach it.`;
}

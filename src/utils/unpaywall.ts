import { fetchWithRetry } from "./fetch-retry.js";
import { logger } from "./logger.js";
import { errorMessage } from "./error-formatter.js";

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

const SKIPPED_RESULT: OaPdfLookupResult = {
  found: false,
  pdf_url: null,
  source: null,
  license: null,
  oa_status: null,
  warning: "UNPAYWALL_EMAIL environment variable is not set or invalid. Set it to a valid email address to enable OA PDF lookup.",
};

const UNAVAILABLE_RESULT: OaPdfLookupResult = { found: false, pdf_url: null, source: null, license: null, oa_status: null };

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
    response = await fetchWithRetry(url);
  } catch (err) {
    const detail = errorMessage(err);
    logger.error("Unpaywall API network error", { doi, error: detail });
    return { primary: { ...UNAVAILABLE_RESULT }, fallback_urls: [] };
  }

  if (!response.ok) {
    logger.error("Unpaywall API error", { doi, status: response.status });
    return { primary: { ...UNAVAILABLE_RESULT }, fallback_urls: [] };
  }

  const data = (await response.json()) as UnpaywallResult;

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

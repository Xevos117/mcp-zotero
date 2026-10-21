import { CslItemData } from "../types/csl-types.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { errorMessage } from "./error-formatter.js";
import { InvalidJsonResponseError, readJsonObject } from "./json-response.js";

export async function resolveDoi(doi: string): Promise<CslItemData> {
  const response = await fetchWithRetry(`https://doi.org/${encodeURIComponent(doi)}`, {
    headers: {
      Accept: "application/vnd.citationstyles.csl+json",
    },
    redirect: "follow",
  }, { label: "DOI resolution" });

  if (!response.ok) {
    const why =
      response.status === 404
        ? " (DOI not registered or mistyped)"
        : response.status === 429 || response.status >= 500
          ? " (doi.org or the registry is busy or failing: retry later)"
          : "";
    const status = [response.status, response.statusText].filter(Boolean).join(" ");
    throw new Error(`DOI resolution failed for ${doi}: ${status}${why}`);
  }

  try {
    return await readJsonObject<CslItemData>(response);
  } catch (err) {
    // doi.org answers some unresolvable DOIs with an HTML page and status 200
    if (err instanceof InvalidJsonResponseError) throw new Error(`DOI not found or not resolvable: ${doi} (${err.message})`);
    throw err;
  }
}

export interface DoiResolutionResult {
  success: Array<{ doi: string; data: CslItemData }>;
  failed: Array<{ doi: string; error: string }>;
}

export async function resolveDois(
  dois: string[],
  concurrency?: number
): Promise<DoiResolutionResult> {
  const settled = await mapWithConcurrency(
    dois,
    (doi) => resolveDoi(doi),
    concurrency
  );

  const result: DoiResolutionResult = { success: [], failed: [] };
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    const doi = dois[i];
    if (r.status === "fulfilled") {
      result.success.push({ doi, data: r.value });
    } else {
      const message = errorMessage(r.reason);
      result.failed.push({ doi, error: message });
    }
  }

  return result;
}

import { CslItemData } from "../types/csl-types.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { errorMessage } from "./error-formatter.js";

export async function resolveDoi(doi: string): Promise<CslItemData> {
  const response = await fetchWithRetry(`https://doi.org/${encodeURIComponent(doi)}`, {
    headers: {
      Accept: "application/vnd.citationstyles.csl+json",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(
      `DOI resolution failed for ${doi}: ${response.status} ${response.statusText}`
    );
  }

  return (await response.json()) as CslItemData;
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

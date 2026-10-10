import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { landingPageOnlyReason, lookupOaPdfWithFallbacks } from "./unpaywall.js";

/** Primary location only (the old lookupOaPdf API). */
const lookupPrimary = async (doi: string) => (await lookupOaPdfWithFallbacks(doi)).primary;

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, UNPAYWALL_EMAIL: "test@university.edu" };
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = ORIGINAL_ENV;
});

describe("lookupOaPdfWithFallbacks: primary", () => {
  it("returns found=true for gold OA with PDF URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            doi: "10.1234/test",
            is_oa: true,
            oa_status: "gold",
            best_oa_location: {
              url_for_pdf: "https://journal.org/article.pdf",
              host_type: "publisher",
              license: "cc-by",
              version: "publishedVersion",
            },
            oa_locations: [],
          }),
      })
    );

    const result = await lookupPrimary("10.1234/test");
    expect(result.found).toBe(true);
    expect(result.pdf_url).toBe("https://journal.org/article.pdf");
    expect(result.source).toBe("unpaywall_gold");
    expect(result.license).toBe("cc-by");
    expect(result.oa_status).toBe("gold");
  });

  it("returns found=true for green OA (repository)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            doi: "10.1234/test",
            is_oa: true,
            oa_status: "green",
            best_oa_location: {
              url_for_pdf: "https://repo.org/paper.pdf",
              host_type: "repository",
              license: null,
              version: "acceptedVersion",
            },
            oa_locations: [],
          }),
      })
    );

    const result = await lookupPrimary("10.1234/test");
    expect(result.found).toBe(true);
    expect(result.pdf_url).toBe("https://repo.org/paper.pdf");
    expect(result.source).toBe("unpaywall_green");
  });

  it("returns found=false for closed access", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            doi: "10.1234/closed",
            is_oa: false,
            oa_status: "closed",
            best_oa_location: null,
            oa_locations: [],
          }),
      })
    );

    const result = await lookupPrimary("10.1234/closed");
    expect(result.found).toBe(false);
    expect(result.pdf_url).toBeNull();
    expect(result.oa_status).toBe("closed");
  });

  it("returns found=false when OA but no pdf_url", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            doi: "10.1234/no-pdf",
            is_oa: true,
            oa_status: "bronze",
            best_oa_location: {
              url_for_pdf: null,
              url: "https://publisher.org/article/123",
              host_type: "publisher",
              license: null,
              version: "publishedVersion",
            },
            oa_locations: [],
          }),
      })
    );

    const result = await lookupPrimary("10.1234/no-pdf");
    expect(result.found).toBe(false);
    expect(result.pdf_url).toBeNull();
    expect(result.landing_url).toBe("https://publisher.org/article/123");
    expect(result.oa_status).toBe("bronze");
  });

  it("returns landing_url for green OA with repository URL but no pdf_url", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            doi: "10.1126/science.abb4808",
            is_oa: true,
            oa_status: "green",
            best_oa_location: {
              url_for_pdf: null,
              url: "https://europepmc.org/articles/PMC7164389",
              host_type: "repository",
              license: null,
              version: "acceptedVersion",
            },
            oa_locations: [],
          }),
      })
    );

    const result = await lookupPrimary("10.1126/science.abb4808");
    expect(result.found).toBe(false);
    expect(result.pdf_url).toBeNull();
    expect(result.landing_url).toBe("https://europepmc.org/articles/PMC7164389");
    expect(result.oa_status).toBe("green");
  });

  it("returns landing_url=null for closed access (not OA)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            doi: "10.1234/closed",
            is_oa: false,
            oa_status: "closed",
            best_oa_location: null,
            oa_locations: [],
          }),
      })
    );

    const result = await lookupPrimary("10.1234/closed");
    expect(result.found).toBe(false);
    expect(result.landing_url).toBeNull();
  });

  it("returns found=false on 404 (DOI not found)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: false, status: 404 })
    );

    const result = await lookupPrimary("10.9999/nonexistent");
    expect(result.found).toBe(false);
  });

  it("returns found=false on network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"))
    );

    const result = await lookupPrimary("10.1234/test");
    expect(result.found).toBe(false);
  });

  it("uses UNPAYWALL_EMAIL env var in the request URL", async () => {
    process.env = { ...ORIGINAL_ENV, UNPAYWALL_EMAIL: "user@university.edu" };

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          doi: "10.1234/test",
          is_oa: false,
          oa_status: "closed",
          best_oa_location: null,
          oa_locations: [],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await lookupPrimary("10.1234/test");

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("email=user%40university.edu");
  });

  it("returns warning and skips when UNPAYWALL_EMAIL is not set", async () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.UNPAYWALL_EMAIL;

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await lookupPrimary("10.1234/test");
    expect(result.found).toBe(false);
    expect(result.warning).toContain("UNPAYWALL_EMAIL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns warning when UNPAYWALL_EMAIL is invalid", async () => {
    process.env = { ...ORIGINAL_ENV, UNPAYWALL_EMAIL: "not-an-email" };

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await lookupPrimary("10.1234/test");
    expect(result.found).toBe(false);
    expect(result.warning).toContain("UNPAYWALL_EMAIL");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("lookupOaPdfWithFallbacks", () => {
  it("returns primary and fallback URLs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            doi: "10.1234/test",
            is_oa: true,
            oa_status: "gold",
            best_oa_location: {
              url_for_pdf: "https://primary.org/paper.pdf",
              host_type: "publisher",
              license: "cc-by",
              version: "publishedVersion",
            },
            oa_locations: [
              {
                url_for_pdf: "https://primary.org/paper.pdf",
                host_type: "publisher",
                license: "cc-by",
                version: "publishedVersion",
              },
              {
                url_for_pdf: "https://fallback.org/paper.pdf",
                host_type: "repository",
                license: null,
                version: "acceptedVersion",
              },
              {
                url_for_pdf: null,
                host_type: "repository",
                license: null,
                version: "submittedVersion",
              },
            ],
          }),
      })
    );

    const result = await lookupOaPdfWithFallbacks("10.1234/test");
    expect(result.primary.found).toBe(true);
    expect(result.primary.pdf_url).toBe("https://primary.org/paper.pdf");
    expect(result.fallback_urls).toEqual(["https://fallback.org/paper.pdf"]);
  });

  it("returns landing_url in primary for green OA with no pdf_url", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            doi: "10.1126/science.abb4808",
            is_oa: true,
            oa_status: "green",
            best_oa_location: {
              url_for_pdf: null,
              url: "https://europepmc.org/articles/PMC7164389",
              host_type: "repository",
              license: null,
              version: "acceptedVersion",
            },
            oa_locations: [
              {
                url_for_pdf: null,
                url: "https://europepmc.org/articles/PMC7164389",
                host_type: "repository",
                license: null,
                version: "acceptedVersion",
              },
            ],
          }),
      })
    );

    const result = await lookupOaPdfWithFallbacks("10.1126/science.abb4808");
    expect(result.primary.found).toBe(false);
    expect(result.primary.landing_url).toBe("https://europepmc.org/articles/PMC7164389");
    expect(result.primary.oa_status).toBe("green");
    expect(result.fallback_urls).toEqual([]);
  });

  it("returns warning when UNPAYWALL_EMAIL is not set", async () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.UNPAYWALL_EMAIL;

    const result = await lookupOaPdfWithFallbacks("10.1234/test");
    expect(result.primary.found).toBe(false);
    expect(result.primary.warning).toContain("UNPAYWALL_EMAIL");
    expect(result.fallback_urls).toEqual([]);
  });
});

describe("Unpaywall locations beyond best_oa_location", () => {
  // Shape of 10.1371/journal.pmed.0020124 observed live: the best location is the publisher landing
  // page without url_for_pdf, the PLOS printable PDF is listed in another location.
  const plos = {
    doi: "10.1371/journal.pmed.0020124",
    is_oa: true,
    oa_status: "gold",
    best_oa_location: {
      url_for_pdf: null,
      url: "https://doi.org/10.1371/journal.pmed.0020124",
      host_type: "publisher",
      license: "cc-by",
      version: "publishedVersion",
    },
    oa_locations: [
      {
        url_for_pdf: null,
        url: "https://doi.org/10.1371/journal.pmed.0020124",
        host_type: "publisher",
        license: "cc-by",
        version: "publishedVersion",
      },
      {
        url_for_pdf: "https://journals.plos.org/plosmedicine/article/file?id=10.1371/journal.pmed.0020124&type=printable",
        url: "https://journals.plos.org/plosmedicine/article?id=10.1371/journal.pmed.0020124",
        host_type: "repository",
        license: "cc-by",
        version: "publishedVersion",
      },
      {
        url_for_pdf: "https://europepmc.org/articles/pmc1182327?pdf=render",
        url: "https://europepmc.org/articles/pmc1182327",
        host_type: "repository",
        license: "cc-by",
        version: "publishedVersion",
      },
      {
        url_for_pdf: "https://europepmc.org/articles/pmc1182327?pdf=render",
        url: "https://europepmc.org/articles/pmc1182327",
        host_type: "repository",
        license: null,
        version: "publishedVersion",
      },
    ],
  };
  const stub = (body: unknown) =>
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(body) }));

  it("primary is the PDF in a later location when best_oa_location has none", async () => {
    stub(plos);
    const result = await lookupPrimary(plos.doi);
    expect(result.found).toBe(true);
    expect(result.pdf_url).toBe(plos.oa_locations[1].url_for_pdf);
    expect(result.source).toBe("unpaywall_green");
  });

  it("lookupOaPdfWithFallbacks keeps the location order and de-duplicates PDF URLs", async () => {
    stub(plos);
    const result = await lookupOaPdfWithFallbacks(plos.doi);
    expect(result.primary.pdf_url).toBe(plos.oa_locations[1].url_for_pdf);
    expect(result.fallback_urls).toEqual(["https://europepmc.org/articles/pmc1182327?pdf=render"]);
  });

  it("names the real host of a landing-page-only copy", async () => {
    stub({ ...plos, oa_locations: [plos.oa_locations[0]] });
    const result = await lookupPrimary(plos.doi);
    expect(result.found).toBe(false);
    expect(result.landing_host_type).toBe("publisher");
    expect(landingPageOnlyReason(result)).toContain("on the publisher's site");
    expect(landingPageOnlyReason({ ...result, landing_host_type: "repository" })).toContain("at a repository");
  });
});

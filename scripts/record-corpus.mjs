#!/usr/bin/env node
// Records the real fixture corpus of test/fixtures/corpus/ (run by hand, needs network; tests never do).
// For every work of corpus.json it calls only official APIs (doi.org content negotiation, Unpaywall, DataCite,
// Zenodo, arXiv OAI-PMH, Thoth) and the publisher's PDF URL, at most 1 request/s per host (arXiv 1 every 3 s),
// trims each response to the fields the tests use (no references, ORCID, affiliations, emails, funders, counters),
// writes cassettes/<id>.json and pdfs/<id>.pdf, then rebuilds library.json and LICENSES.md and runs the checks.
// Abstracts are kept only for works under CC BY / CC0, PDFs only under CC BY / CC0 (no NC/ND).
// Nothing of whoever records may end up in the files: the Unpaywall email is replaced in the recorded URL and
// the checks fail if it (or any key/token from the environment, an email address, an '@' in a URL, an ORCID)
// appears anywhere.
//
// Usage:
//   UNPAYWALL_EMAIL=<yours> node scripts/record-corpus.mjs [--only id,id]   record, rebuild, check
//   node scripts/record-corpus.mjs --offline                                  rebuild library.json/LICENSES.md, check
//   node scripts/record-corpus.mjs --check                                    check only, fail if a rebuild would change files
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CORPUS_DIR = resolve(fileURLToPath(new URL("../test/fixtures/corpus/", import.meta.url)));
const USER_AGENT = "mcp-zotero-corpus-recorder/1 (+https://github.com/Xevos117/mcp-zotero)";
const CSL_ACCEPT = "application/vnd.citationstyles.csl+json";
const MAX_BODY_BYTES = 5 * 1024;
const MAX_PDF_TOTAL = 2.5 * 1024 * 1024;
const MAX_CORPUS_TOTAL = 3 * 1024 * 1024;
const MAX_ABSTRACT = 2500;
const REDACTED = "REDACTED";
/** Zotero item keys: 8 characters of this alphabet (no 0, 1, O). */
const ZOTERO_KEY = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;
const OPEN_LICENCE = /^https?:\/\/creativecommons\.org\/(licenses\/by\/\d\.\d|publicdomain\/zero\/1\.0)\/?(legalcode)?$/i;
const OPEN_SPDX = /^(cc-by-\d\.\d|cc0-1\.0)$/i;

// ─── Network (recording only) ───────────────────────────────────

const lastRequest = new Map();
const minInterval = (host) => (host === "export.arxiv.org" ? 3000 : 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function politeFetch(url, init = {}, timeoutMs = 30_000) {
  const host = new URL(url).host;
  const wait = (lastRequest.get(host) ?? 0) + minInterval(host) - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest.set(host, Date.now());
  const res = await fetch(url, {
    ...init,
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${redactUrl(url)}: HTTP ${res.status}`);
  return res;
}

function redactUrl(url) {
  const u = new URL(url);
  if (u.searchParams.has("email")) u.searchParams.set("email", REDACTED);
  return u.href;
}

// ─── Trimming ───────────────────────────────────────────────────

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));
const nonEmpty = (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
const NAME_KEYS = ["given", "family", "literal", "suffix", "non-dropping-particle", "dropping-particle"];
const CSL_KEYS = [
  "type", "title", "subtitle", "container-title", "container-title-short", "collection-title", "event", "event-title",
  "volume", "issue", "page", "article-number", "publisher", "publisher-place", "publisher-location", "issued", "DOI", "URL",
  "ISBN", "ISSN", "language", "number-of-pages", "edition", "copyright", "version",
];

/** CSL-JSON reduced to the bibliographic fields; abstract only when the work's licence allows it. */
export function trimCsl(csl, keepAbstract) {
  const out = {};
  for (const k of CSL_KEYS) if (nonEmpty(csl[k])) out[k] = csl[k];
  for (const role of ["author", "editor", "contributor", "translator"]) {
    if (nonEmpty(csl[role])) out[role] = csl[role].map((n) => pick(n, NAME_KEYS));
  }
  if (out.issued) out.issued = pick(out.issued, ["date-parts", "literal", "raw"]);
  if (nonEmpty(csl.license)) out.license = csl.license.map((l) => pick(l, ["URL", "content-version"]));
  if (keepAbstract && typeof csl.abstract === "string" && csl.abstract.length <= MAX_ABSTRACT) out.abstract = csl.abstract;
  return out;
}

const LOCATION_KEYS = ["url_for_pdf", "url", "host_type", "license", "version"];
export function trimUnpaywall(u) {
  return {
    ...pick(u, ["doi", "is_oa", "oa_status"]),
    best_oa_location: u.best_oa_location ? pick(u.best_oa_location, LOCATION_KEYS) : null,
    oa_locations: (u.oa_locations ?? []).map((l) => pick(l, LOCATION_KEYS)),
  };
}

export function trimDatacite(d) {
  const a = d.data?.attributes ?? {};
  const names = (list) => (list ?? []).map((n) => pick(n, ["name", "nameType", "givenName", "familyName", "contributorType"]));
  return {
    data: {
      ...pick(d.data, ["id", "type"]),
      attributes: {
        ...pick(a, ["doi", "publicationYear", "url", "language"]),
        titles: (a.titles ?? []).map((t) => pick(t, ["title", "titleType"])),
        creators: names(a.creators),
        contributors: names(a.contributors),
        publisher: typeof a.publisher === "string" ? a.publisher : pick(a.publisher, ["name"]),
        types: pick(a.types, ["resourceTypeGeneral", "resourceType", "citeproc"]),
        rightsList: (a.rightsList ?? []).map((r) => pick(r, ["rights", "rightsUri", "rightsIdentifier"])),
      },
    },
  };
}

export function trimZenodo(z) {
  const m = z.metadata ?? {};
  return {
    ...pick(z, ["id", "doi"]),
    metadata: {
      ...pick(m, ["title", "publication_date", "resource_type", "license", "thesis"]),
      creators: (m.creators ?? []).map((c) => pick(c, ["name"])),
      contributors: (m.contributors ?? []).map((c) => pick(c, ["name", "type"])),
    },
  };
}

/** arXiv OAI-PMH GetRecord: only the <metadata> element. */
export function trimArxivOai(xml) {
  const m = xml.match(/<metadata>[\s\S]*<\/metadata>/);
  if (!m) throw new Error("arXiv OAI-PMH: no <metadata> in the response");
  return m[0].replace(/\n\s*\n/g, "\n");
}

const THOTH_QUERY =
  "query($doi: Doi!) { workByDoi(doi: $doi) { fullTitle workType license landingPage publicationDate place pageCount " +
  "imprint { publisher { publisherName } } contributions { fullName contributionType contributionOrdinal } } }";

// ─── Recording ──────────────────────────────────────────────────

function interaction(method, url, accept, status, contentType, body, extra = {}) {
  return { request: { method, url: redactUrl(url), ...(accept ? { accept } : {}), ...extra }, response: { status, contentType, ...body } };
}

async function recordWork(work, email) {
  const s = work.sources;
  const open = isOpenLicenceId(work.licence.id);
  const out = [];
  const doiUrl = (doi) => `https://doi.org/${doi}`;
  if (s.doi) {
    const res = await politeFetch(doiUrl(s.doi), { headers: { Accept: CSL_ACCEPT } });
    const csl = trimCsl(await res.json(), open);
    out.push(interaction("GET", doiUrl(s.doi), CSL_ACCEPT, res.status, res.headers.get("content-type"), { body: csl }));
  }
  if (s.unpaywall) {
    if (!email) throw new Error(`${work.id}: UNPAYWALL_EMAIL is required to record the Unpaywall response`);
    const url = `https://api.unpaywall.org/v2/${s.doi}?email=${encodeURIComponent(email)}`;
    const res = await politeFetch(url);
    out.push(interaction("GET", url, null, res.status, res.headers.get("content-type"), { body: trimUnpaywall(await res.json()) }));
  }
  if (s.datacite) {
    const url = `https://api.datacite.org/dois/${s.doi}`;
    const res = await politeFetch(url, { headers: { Accept: "application/vnd.api+json" } });
    out.push(interaction("GET", url, "application/vnd.api+json", res.status, res.headers.get("content-type"), { body: trimDatacite(await res.json()) }));
  }
  if (s.zenodo) {
    const url = `https://zenodo.org/api/records/${s.zenodo}`;
    const res = await politeFetch(url, { headers: { Accept: "application/json" } });
    out.push(interaction("GET", url, "application/json", res.status, res.headers.get("content-type"), { body: trimZenodo(await res.json()) }));
  }
  if (s.arxiv) {
    const url = `https://export.arxiv.org/oai2?verb=GetRecord&identifier=oai:arXiv.org:${s.arxiv}&metadataPrefix=arXiv`;
    const res = await politeFetch(url);
    out.push(interaction("GET", url, null, res.status, res.headers.get("content-type"), { body: trimArxivOai(await res.text()) }));
  }
  if (s.thoth) {
    const url = "https://api.thoth.pub/graphql";
    const reqBody = { query: THOTH_QUERY, variables: { doi: `https://doi.org/${s.thoth}` } };
    const res = await politeFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqBody) });
    const json = await res.json();
    if (!json.data?.workByDoi) throw new Error(`${work.id}: Thoth has no work for ${s.thoth}`);
    out.push(interaction("POST", url, null, res.status, res.headers.get("content-type"), { body: json }, { body: reqBody }));
  }
  if (work.pdf) {
    if (!open) throw new Error(`${work.id}: PDF only for CC BY / CC0 works`);
    const res = await politeFetch(work.pdf.url, {}, 90_000);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error(`${work.id}: ${work.pdf.url} is not a PDF`);
    mkdirSync(join(CORPUS_DIR, "pdfs"), { recursive: true });
    writeFileSync(join(CORPUS_DIR, "pdfs", `${work.id}.pdf`), buf);
    work.pdf.sha256 = createHash("sha256").update(buf).digest("hex");
    work.pdf.bytes = buf.length;
    out.push(interaction("GET", work.pdf.url, null, res.status, res.headers.get("content-type"), { bodyFile: `pdfs/${work.id}.pdf` }));
  }
  return out;
}

// ─── Building library.json ──────────────────────────────────────

const text = (v) => (Array.isArray(v) ? v[0] : v);
const decodeEntities = (s) => {
  let prev;
  do {
    prev = s;
    s = s
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  } while (s !== prev);
  return s;
};
/** JATS abstract (Crossref) → plain text, one line per paragraph, as Zotero's import does; other text as it is. */
const plainAbstract = (s) => {
  if (!/<jats:/.test(s)) return s;
  return s
    .split(/<\/jats:p>/)
    .map((p) => decodeEntities(p.replace(/<\/?jats:[^>]*>/g, " ")).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
};
const fullTitle = (csl) => {
  const title = text(csl.title) ?? "";
  const sub = text(csl.subtitle);
  return sub ? `${title}: ${sub}` : title;
};
const isoDate = (issued) => {
  const parts = issued?.["date-parts"]?.[0];
  if (!parts) return issued?.literal ?? issued?.raw ?? "";
  return parts.map((p, i) => (i === 0 ? String(p) : String(p).padStart(2, "0"))).join("-");
};
const creator = (creatorType, n) =>
  n.literal
    ? { creatorType, name: n.literal }
    : { creatorType, firstName: [n.given, n["dropping-particle"]].filter(Boolean).join(" "), lastName: [n["non-dropping-particle"], n.family].filter(Boolean).join(" ") };

/** Fields of a curated Zotero item per type (Zotero 10 schema), from the CSL of the work. */
function zoteroFromCsl(work, csl, context) {
  const type = work.itemType;
  const creators = [];
  for (const [role, zrole] of [["author", "author"], ["editor", "editor"], ["contributor", "contributor"], ["translator", "translator"]]) {
    for (const n of csl[role] ?? []) creators.push(creator(zrole, n));
  }
  for (const n of context.container?.editor ?? []) creators.push(creator("editor", n));
  // registries send some strings HTML-escaped ("Arthropod Systematics &amp; Phylogeny"): a correct import has the text
  const item = { itemType: type, title: decodeEntities(fullTitle(csl)), creators };
  const set = (field, value) => {
    if (nonEmpty(value)) item[field] = decodeEntities(String(value));
  };
  if (csl.abstract) set("abstractNote", plainAbstract(csl.abstract));
  set("date", isoDate(csl.issued));
  set("DOI", work.sources.doi);
  set("url", csl.URL);
  set("language", csl.language);
  const place = csl["publisher-place"] ?? csl["publisher-location"];
  switch (type) {
    case "journalArticle":
      set("publicationTitle", text(csl["container-title"]));
      set("journalAbbreviation", text(csl["container-title-short"]));
      set("publisher", csl.publisher);
      set("volume", csl.volume);
      set("issue", csl.issue);
      set("pages", csl.page ?? csl["article-number"]);
      set("ISSN", text(csl.ISSN));
      break;
    case "conferencePaper":
      set("proceedingsTitle", text(csl["container-title"]));
      set("conferenceName", csl["event-title"] ?? csl.event);
      set("publisher", csl.publisher);
      set("place", place);
      set("pages", csl.page);
      break;
    case "bookSection":
      set("bookTitle", context.container ? fullTitle(context.container) : text(csl["container-title"]));
      set("publisher", csl.publisher);
      set("place", place);
      set("pages", csl.page);
      set("ISBN", text(csl.ISBN));
      break;
    case "book":
      set("publisher", csl.publisher);
      set("place", place);
      set("numPages", csl["number-of-pages"]);
      set("ISBN", text(csl.ISBN));
      set("series", text(csl["collection-title"]));
      break;
    case "thesis":
      set("university", context.zenodo?.metadata?.thesis?.university ?? csl.publisher);
      break;
    case "report":
      set("institution", csl.publisher);
      break;
    case "preprint":
      set("repository", csl.publisher);
      if (work.sources.arxiv) set("archiveID", `arXiv:${work.sources.arxiv}`);
      break;
    default:
      throw new Error(`${work.id}: no field mapping for item type ${type}`);
  }
  return item;
}

function applyOverrides(item, ov) {
  if (!ov) return item;
  const out = { ...item, ...(ov.fields ?? {}) };
  if (ov.creators) {
    const pending = new Set(Object.keys(ov.creators));
    out.creators = out.creators.map((c) => {
      const patch = ov.creators[c.lastName];
      if (!patch) return c;
      pending.delete(c.lastName);
      return { ...c, ...patch };
    });
    if (pending.size) throw new Error(`overrides: no creator with lastName ${[...pending].join(", ")}`);
  }
  return out;
}

const doiCsl = (cassettes, id, doi) => (cassettes[id] ?? []).find((i) => i.request.url === `https://doi.org/${doi}`)?.response.body;
const responseBody = (cassette, host) => cassette.find((i) => new URL(i.request.url).host === host)?.response.body;

/** library.json: the curated Zotero items (Web API `data` objects) of the corpus. */
export function buildLibrary(manifest, cassettes, overrides) {
  const collectionKey = Object.fromEntries(manifest.collections.map((c) => [c.name, c.key]));
  const items = manifest.works.map((work) => {
    const ov = overrides.works[work.id];
    let item;
    if (ov?.item) {
      item = { ...ov.item };
    } else {
      const cassette = cassettes[work.id] ?? [];
      const csl = doiCsl(cassettes, work.id, work.sources.doi);
      if (!csl) throw new Error(`${work.id}: no doi.org response in the cassette`);
      let container;
      if (work.sources.containerDoi) {
        const parent = manifest.works.find((w) => w.sources.doi === work.sources.containerDoi);
        if (!parent) throw new Error(`${work.id}: containerDoi ${work.sources.containerDoi} is not the DOI of a corpus work`);
        container = doiCsl(cassettes, parent.id, parent.sources.doi);
      }
      item = applyOverrides(zoteroFromCsl(work, csl, { container, zenodo: responseBody(cassette, "zenodo.org") }), ov);
    }
    return {
      key: work.key,
      ...item,
      collections: work.collections.map((name) => {
        if (!collectionKey[name]) throw new Error(`${work.id}: unknown collection ${name}`);
        return collectionKey[name];
      }),
      tags: work.tags.map((tag) => ({ tag })),
      relations: {},
    };
  });
  return {
    description: "Curated Zotero items of the corpus (Web API data objects), built by scripts/record-corpus.mjs from the cassettes and overrides.json. Do not edit by hand.",
    collections: manifest.collections.map((c) => ({ key: c.key, name: c.name, parentCollection: false, relations: {} })),
    items,
  };
}

// ─── LICENSES.md ────────────────────────────────────────────────

const creatorText = (c) => c.name ?? [c.firstName, c.lastName].filter(Boolean).join(" ");
export function renderLicenses(manifest, library) {
  const byKey = Object.fromEntries(library.items.map((i) => [i.key, i]));
  const lines = [
    "# Corpus: licences and attribution",
    "",
    "Generated by `scripts/record-corpus.mjs` from `corpus.json` and `library.json`: edit those, not this file.",
    "Each work is redistributed here, as metadata (and, where listed, its PDF), under the licence shown; the",
    "licence was checked by hand on the page in \"Verified at\" and, where a registry exposes it, by the script.",
    "These works are not under this repository's MIT licence. The registry metadata comes from Crossref (almost none",
    "of it is subject to copyright; abstracts are kept only for CC BY / CC0 works), DataCite (CC0), arXiv (metadata",
    "CC0), Unpaywall (CC0), Zenodo and Thoth (the repository's and the publisher's records of the same works).",
    "",
    `Recorded on ${manifest.recordedOn}.`,
    "",
  ];
  for (const w of manifest.works) {
    const item = byKey[w.key];
    const authors = item.creators.map((c) => `${creatorText(c)}${c.creatorType === "author" ? "" : ` (${c.creatorType})`}`).join("; ");
    lines.push(`## ${w.id}`, "");
    lines.push(`- Title: ${item.title}`);
    lines.push(`- Authors: ${authors}`);
    lines.push(`- Identifier: ${w.sources.doi ? `https://doi.org/${w.sources.doi}` : item.url}`);
    lines.push(`- Licence: ${w.licence.id} (${w.licence.url})`);
    lines.push(`- Verified at: ${w.licence.verifiedAt} (${manifest.recordedOn}). ${w.licence.statement}`);
    lines.push(`- Source of the metadata: ${Object.keys(w.sources).filter((k) => w.sources[k]).join(", ") || "entered by hand"}`);
    if (w.pdf) {
      lines.push(`- PDF: \`pdfs/${w.id}.pdf\` from ${w.pdf.url}, ${w.pdf.bytes} bytes, sha256 \`${w.pdf.sha256}\`; unmodified`);
    } else {
      lines.push("- PDF: not included");
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ─── Checks ─────────────────────────────────────────────────────

function isOpenLicenceId(id) {
  return /^(CC-BY-\d\.\d|CC0-1\.0)$/.test(id);
}

/** Licence URLs/ids that the recorded sources state for a work. */
export function recordedLicences(cassette) {
  const found = [];
  for (const { request, response } of cassette) {
    const host = new URL(request.url).host;
    const b = response.body;
    if (host === "doi.org") for (const l of b?.license ?? []) found.push(l.URL);
    if (host === "api.unpaywall.org" && b?.best_oa_location?.license) found.push(b.best_oa_location.license);
    if (host === "api.datacite.org") for (const r of b?.data?.attributes?.rightsList ?? []) found.push(r.rightsIdentifier ?? r.rightsUri);
    if (host === "zenodo.org" && b?.metadata?.license?.id) found.push(b.metadata.license.id);
    if (host === "export.arxiv.org") {
      const m = String(b).match(/<license>([^<]+)<\/license>/);
      if (m) found.push(m[1]);
    }
    if (host === "api.thoth.pub" && b?.data?.workByDoi?.license) found.push(b.data.workByDoi.license);
  }
  return found;
}

const isOpenLicence = (l) => OPEN_LICENCE.test(l) || OPEN_SPDX.test(l) || l === "cc-by" || l === "cc0";

function walk(value, visit, path = "") {
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, visit, `${path}[${i}]`));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      visit(k, v, `${path}.${k}`);
      walk(v, visit, `${path}.${k}`);
    }
  }
}

const FORBIDDEN_KEYS = new Set(["ORCID", "orcid", "authenticated-orcid", "affiliation", "funder", "z_authors", "reference", "nameIdentifiers", "email"]);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/;
const URL_WITH_AT = /https?:\/\/[^\s"'<>]*@/;
const ORCID_ID = /\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b/;
const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|EMAIL|USER_ID)/;

/** Values from the environment that must never be written into the corpus. */
export function secretValues(env = process.env) {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_ENV.test(k) && typeof v === "string" && v.length >= 6)
    .map(([, v]) => v);
}

/** Every problem of the corpus on disk (empty = fine). `secrets`: values that must not appear in any file. */
export function corpusProblems(dir = CORPUS_DIR, secrets = secretValues()) {
  const problems = [];
  const manifest = JSON.parse(readFileSync(join(dir, "corpus.json"), "utf8"));
  const keys = new Set();
  let pdfTotal = 0;
  const years = {};
  for (const w of manifest.works) {
    if (!ZOTERO_KEY.test(w.key)) problems.push(`${w.id}: key ${w.key} is not a valid Zotero key`);
    if (keys.has(w.key)) problems.push(`${w.id}: duplicate key ${w.key}`);
    keys.add(w.key);
    if (!isOpenLicenceId(w.licence?.id)) problems.push(`${w.id}: licence ${w.licence?.id} is not CC BY or CC0`);
    if (!w.licence?.verifiedAt) problems.push(`${w.id}: licence not verified on a page (verifiedAt)`);
    const cassettePath = join(dir, "cassettes", `${w.id}.json`);
    const hasSources = Object.values(w.sources).some(Boolean);
    if (!hasSources) continue;
    if (!existsSync(cassettePath)) {
      problems.push(`${w.id}: cassette missing`);
      continue;
    }
    const cassette = JSON.parse(readFileSync(cassettePath, "utf8"));
    for (const { request, response } of cassette) {
      const size = Buffer.byteLength(typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? ""));
      if (size > MAX_BODY_BYTES) problems.push(`${w.id}: ${request.url} body is ${size} bytes (> ${MAX_BODY_BYTES})`);
    }
    const licences = recordedLicences(cassette);
    if (licences.length === 0) problems.push(`${w.id}: no licence in the recorded sources`);
    for (const l of licences) if (!isOpenLicence(l)) problems.push(`${w.id}: recorded licence ${l} is not CC BY / CC0`);
    walk(cassette, (k, _v, path) => {
      if (FORBIDDEN_KEYS.has(k)) problems.push(`${w.id}: forbidden field ${path}`);
    });
    const csl = cassette.find((i) => i.request.url === `https://doi.org/${w.sources.doi}`)?.response.body;
    if (csl?.abstract && !isOpenLicenceId(w.licence.id)) problems.push(`${w.id}: abstract of a work that is not CC BY / CC0`);
    years[w.id] = csl?.issued?.["date-parts"]?.[0]?.[0];
    if (w.pdf) {
      const file = join(dir, "pdfs", `${w.id}.pdf`);
      if (!existsSync(file)) {
        problems.push(`${w.id}: pdfs/${w.id}.pdf missing`);
        continue;
      }
      const buf = readFileSync(file);
      pdfTotal += buf.length;
      if (createHash("sha256").update(buf).digest("hex") !== w.pdf.sha256 || buf.length !== w.pdf.bytes) {
        problems.push(`${w.id}: pdf sha256/bytes differ from corpus.json`);
      }
      if (!cassette.some((i) => i.response.bodyFile === `pdfs/${w.id}.pdf`)) problems.push(`${w.id}: no cassette entry serves the PDF`);
      // the product downloads the first PDF location Unpaywall gives: that is the URL to record
      const oa = cassette.find((i) => new URL(i.request.url).host === "api.unpaywall.org")?.response.body;
      const first = oa && [oa.best_oa_location, ...(oa.oa_locations ?? [])].find((l) => l?.url_for_pdf)?.url_for_pdf;
      if (w.sources.unpaywall && first !== w.pdf.url) problems.push(`${w.id}: pdf.url is not Unpaywall's first PDF location (${first})`);
    }
  }
  for (const w of manifest.works) {
    if (w.sameYearAs && years[w.id] !== years[w.sameYearAs]) {
      problems.push(`${w.id}: issued year ${years[w.id]} differs from ${w.sameYearAs} (${years[w.sameYearAs]}): pick another pair`);
    }
  }
  if (pdfTotal > MAX_PDF_TOTAL) problems.push(`PDFs total ${pdfTotal} bytes > ${MAX_PDF_TOTAL}`);
  let total = 0;
  for (const f of listFiles(dir)) {
    const buf = readFileSync(f);
    total += buf.length;
    for (const s of secrets) if (buf.includes(s)) problems.push(`${f.slice(dir.length + 1)}: contains a value from the environment`);
    if (f.endsWith(".pdf")) continue;
    const t = buf.toString("utf8");
    if (EMAIL.test(t)) problems.push(`${f.slice(dir.length + 1)}: contains an email address`);
    if (URL_WITH_AT.test(t)) problems.push(`${f.slice(dir.length + 1)}: contains a URL with '@'`);
    if (ORCID_ID.test(t)) problems.push(`${f.slice(dir.length + 1)}: contains an ORCID iD`);
    if (/mailto:/i.test(t)) problems.push(`${f.slice(dir.length + 1)}: contains mailto:`);
  }
  if (total > MAX_CORPUS_TOTAL) problems.push(`corpus total ${total} bytes > ${MAX_CORPUS_TOTAL}`);
  return problems;
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]
  );
}

// ─── Main ───────────────────────────────────────────────────────

export function loadCorpus(dir = CORPUS_DIR) {
  const manifest = JSON.parse(readFileSync(join(dir, "corpus.json"), "utf8"));
  const overrides = JSON.parse(readFileSync(join(dir, "overrides.json"), "utf8"));
  const cassettes = {};
  for (const w of manifest.works) {
    const p = join(dir, "cassettes", `${w.id}.json`);
    if (existsSync(p)) cassettes[w.id] = JSON.parse(readFileSync(p, "utf8"));
  }
  return { manifest, overrides, cassettes };
}

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

async function main(argv) {
  const offline = argv.includes("--offline") || argv.includes("--check");
  const checkOnly = argv.includes("--check");
  const onlyArg = argv[argv.indexOf("--only") + 1];
  const only = argv.includes("--only") ? new Set(onlyArg.split(",")) : null;
  const { manifest, overrides, cassettes } = loadCorpus();
  if (!offline) {
    const email = process.env.UNPAYWALL_EMAIL;
    mkdirSync(join(CORPUS_DIR, "cassettes"), { recursive: true });
    for (const work of manifest.works) {
      if (only && !only.has(work.id)) continue;
      if (!Object.values(work.sources).some(Boolean)) continue;
      process.stdout.write(`recording ${work.id}\n`);
      cassettes[work.id] = await recordWork(work, email);
      writeFileSync(join(CORPUS_DIR, "cassettes", `${work.id}.json`), json(cassettes[work.id]));
    }
    writeFileSync(join(CORPUS_DIR, "corpus.json"), json(manifest));
  }
  const library = buildLibrary(manifest, cassettes, overrides);
  const outputs = { "library.json": json(library), "LICENSES.md": renderLicenses(manifest, library) };
  const stale = [];
  for (const [name, content] of Object.entries(outputs)) {
    const p = join(CORPUS_DIR, name);
    const current = existsSync(p) ? readFileSync(p, "utf8") : null;
    if (current === content) continue;
    if (checkOnly) stale.push(`${name} is out of date: run node scripts/record-corpus.mjs --offline`);
    else writeFileSync(p, content);
  }
  const problems = [...stale, ...corpusProblems()];
  for (const p of problems) process.stderr.write(`record-corpus: ${p}\n`);
  if (problems.length) process.exit(1);
  process.stdout.write(`record-corpus: ${manifest.works.length} works, ${library.items.length} items, checks passed\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`record-corpus: ${err.message}\n`);
    process.exit(1);
  });
}

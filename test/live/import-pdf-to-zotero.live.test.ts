import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { live, startLive, LiveServer, createItems, title, trackItems, rawItem, rawChildren, FAKE_KEY } from "./helpers/live.js";
import { makePdf } from "../helpers/fixtures.js";
import { FIXTURE_PDF_TEXT } from "./helpers/fixture-server.js";

describe.skipIf(!live.enabled)("import_pdf_to_zotero (live)", () => {
  let s: LiveServer;
  let parent: string;
  let rejected: string;
  const pdf = makePdf(FIXTURE_PDF_TEXT);
  beforeAll(async () => {
    s = await startLive();
    [parent, rejected] = await createItems([
      { itemType: "journalArticle", title: title("IP parent") },
      { itemType: "journalArticle", title: title("IP parent for rejected files") },
    ]);
  });
  afterAll(async () => {
    await s?.close();
  });

  it("LIVE-IP-01 PDF figlio dal server di fixture → dimensione, md5 e fulltext corretti su Zotero", async () => {
    const r = await s.call("import_pdf_to_zotero", { url: `${live.fixtureBase}/paper.pdf`, parent_item: parent, tags: [live.runTag] });
    trackItems(r.json?.item_key);
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ parent_item: parent, size_bytes: pdf.length, link_mode: "imported_url", fulltext_indexed: true, filename: "paper.pdf" });
    expect(await rawItem(r.json.item_key)).toMatchObject({
      itemType: "attachment",
      linkMode: "imported_url",
      parentItem: parent,
      contentType: "application/pdf",
      md5: createHash("md5").update(pdf).digest("hex"),
    });
  });

  it("LIVE-IP-02 standalone con filename, titolo e collezioni", async () => {
    const r = await s.call("import_pdf_to_zotero", { url: `${live.fixtureBase}/paper.pdf`, filename: "mzt-named.pdf", title: title("IP named PDF"), collections: [live.collection] });
    trackItems(r.json?.item_key);
    expect(r.json).toMatchObject({ filename: "mzt-named.pdf", title: title("IP named PDF"), parent_item: null });
    expect(await rawItem(r.json.item_key)).toMatchObject({ filename: "mzt-named.pdf", title: title("IP named PDF"), collections: [live.collection] });
  });

  it("LIVE-IP-03 senza filename → nome da Content-Disposition", async () => {
    const r = await s.call("import_pdf_to_zotero", { url: `${live.fixtureBase}/download`, parent_item: parent });
    trackItems(r.json?.item_key);
    expect(r.json.filename).toBe("mzt-fixture-disposition.pdf");
  });

  it("LIVE-IP-04 HTML servito come PDF → not_pdf, nessun allegato creato", async () => {
    const r = await s.call("import_pdf_to_zotero", { url: `${live.fixtureBase}/login.pdf`, parent_item: rejected });
    trackItems(r.json?.item_key);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/HTML page instead of a PDF/);
    expect(await rawChildren(rejected)).toEqual([]);
  });

  // Ex riga segnata OK a mano (LIVE-STALE-5): il tool accetta solo PDF (controllo dei byte %PDF-), anche se
  // content_type è una stringa libera; un HTML dichiarato text/html viene rifiutato come not_pdf.
  it("LIVE-IP-05 content_type text/html con una pagina HTML → rifiutato (tool solo PDF)", async () => {
    const r = await s.call("import_pdf_to_zotero", { url: `${live.fixtureBase}/page.html`, content_type: "text/html", filename: "page.html", parent_item: rejected });
    trackItems(r.json?.item_key);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/HTML page instead of a PDF/);
    expect(await rawChildren(rejected)).toEqual([]);
  });

  it("LIVE-IP-06 404 → errore con lo status", async () => {
    const r = await s.call("import_pdf_to_zotero", { url: `${live.fixtureBase}/missing.pdf`, parent_item: rejected });
    trackItems(r.json?.item_key);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/404/);
  });

  it("LIVE-IP-07 genitore inesistente → isError leggibile; URL non valido → errore di validazione", async () => {
    const r = await s.call("import_pdf_to_zotero", { url: `${live.fixtureBase}/paper.pdf`, parent_item: FAKE_KEY, title: title("IP orphan") });
    trackItems(r.json?.item_key);
    expect(r.isError).toBe(true);
    expect(r.text).not.toMatch(/\[object Object\]/);
    expect((await s.call("import_pdf_to_zotero", { url: "ftp//x" })).text).toMatch(/url/);
  });

  it("LIVE-IP-08 override library_type user", async () => {
    const r = await s.call("import_pdf_to_zotero", { url: `${live.fixtureBase}/paper.pdf`, parent_item: parent, library_type: "user" });
    trackItems(r.json?.item_key);
    expect(r.json.size_bytes).toBe(pdf.length);
  });
});

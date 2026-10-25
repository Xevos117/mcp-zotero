// Fail-closed check before a word-proxy / word-render artifact is uploaded (artifacts of a public repo are readable by
// anyone). The jobs use no account and only the placeholder libraries, so this is a net: it fails if any file
// (docx parts unzipped, PNG text chunks included) holds a Zotero library URI other than users/000000 or groups/777,
// an email address, a home directory other than the runner's, a value of a key/token/email/user variable of the
// environment, or a file type that is not expected. Prints only file names and the kind of problem, never the match.
// Usage: node check-artifacts.mjs <dir>...
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import JSZip from "jszip";

const ALLOWED = new Set([".docx", ".odt", ".trace", ".driver", ".json", ".jsonl", ".png", ".pdf", ".md", ".txt"]);
const LIBRARY_URI = /zotero\.org\/(users|groups)\/(\d+)/g;
const PLACEHOLDER = { users: "000000", groups: "777" };
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const HOME = /\/home\/([A-Za-z0-9._-]+)/g;
const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|EMAIL|USER_ID|USERNAME|GROUP)/;

export function secretValues(env = process.env) {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_ENV.test(k) && typeof v === "string" && v.length >= 4)
    .map(([, v]) => v);
}

/** Problems of one text (empty = clean). */
export function textProblems(text, secrets) {
  const out = [];
  for (const m of text.matchAll(LIBRARY_URI)) {
    if (m[2] !== PLACEHOLDER[m[1]]) {
      out.push(`library URI other than the placeholders (${m[1]}/…)`);
      break;
    }
  }
  if (EMAIL.test(text)) out.push("email address");
  for (const m of text.matchAll(HOME)) {
    if (m[1] !== "runner") {
      out.push("home directory other than the runner's");
      break;
    }
  }
  if (secrets.some((s) => text.includes(s))) out.push("value of a secret-like environment variable");
  return out;
}

/** Text parts of a file: every part of a docx/odt (ZIP), PNG/PDF bytes as latin1, the file itself otherwise. */
async function texts(path) {
  const buf = readFileSync(path);
  if (path.endsWith(".docx") || path.endsWith(".odt")) {
    const zip = await JSZip.loadAsync(buf);
    return Promise.all(Object.values(zip.files).filter((f) => !f.dir).map((f) => f.async("string")));
  }
  if (path.endsWith(".png") || path.endsWith(".pdf")) return [buf.toString("latin1")];
  return [buf.toString("utf8")];
}

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

export async function artifactProblems(dirs, secrets = secretValues()) {
  const out = [];
  for (const dir of dirs) {
    for (const f of files(dir)) {
      if (!ALLOWED.has(extname(f))) {
        out.push(`${f}: unexpected file type`);
        continue;
      }
      const found = new Set((await texts(f)).flatMap((t) => textProblems(t, secrets)));
      for (const p of found) out.push(`${f}: ${p}`);
    }
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("check-artifacts.mjs")) {
  const problems = await artifactProblems(process.argv.slice(2));
  for (const p of problems) console.log(`::error::${p}: artifact not uploaded`);
  if (problems.length) process.exit(1);
  console.log(`check-artifacts: clean (${process.argv.slice(2).join(", ")})`);
}

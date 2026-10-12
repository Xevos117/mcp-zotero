import { describe, it, expect } from "vitest";
// @ts-expect-error plain .mjs script without type declarations
import { credentialKinds } from "../../scripts/check-public-text.mjs";

/** Testi dell'agente dipendenze pubblicati (descrizione della PR, issue `dipendenze`): mai credenziali. */
describe("check-public-text: testi pubblicati senza credenziali (CP)", () => {
  it("CP-01 JWT, chiave Anthropic, token GitHub e npm, credenziali in URL, chiave privata → segnalati", () => {
    const jwt = `eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJyZXBvOngifQ.${"a".repeat(20)}`;
    expect(credentialKinds(`token: ${jwt}`)).toEqual(["JWT (e.g. an OIDC token)"]);
    expect(credentialKinds(`sk-ant-api03-${"x".repeat(20)}`)).toEqual(["Anthropic key"]);
    expect(credentialKinds(`ghs_${"A".repeat(36)}`)).toEqual(["GitHub token"]);
    expect(credentialKinds(`github_pat_${"B".repeat(30)}`)).toEqual(["GitHub token"]);
    expect(credentialKinds(`npm_${"c".repeat(36)}`)).toEqual(["npm token"]);
    expect(credentialKinds("https://x-access-token:abc@github.com/o/r.git")).toEqual(["credential in a URL"]);
    expect(credentialKinds("-----BEGIN OPENSSH PRIVATE KEY-----")).toEqual(["private key"]);
  });

  it("CP-02 testo normale di una PR o issue delle dipendenze → nessun problema", () => {
    const text = [
      "Dipendenze: da valutare (2026-11)",
      "| zod | 4.6.5 → 5.0.0 | major |",
      "`src/tools/search.ts` usa `z.string().email()`, deprecato in zod 5.",
      "npm_config_ignore_scripts=true, ghost-package 1.2.3, eyJ breve.",
    ].join("\n");
    expect(credentialKinds(text)).toEqual([]);
  });
});

# CSL fixtures (vendored)

Used only by the tests (`test/helpers/docx-validate.ts`) to render injected citations with
citeproc-js and the real CSL styles, and to validate the field JSON against the official schemas.
They are not part of the npm package (`package.json` `files` is `["build"]`).

Fetched on 2026-10-11 from the Citation Style Language repositories, pinned to these commits:

| File | Source | Commit |
|---|---|---|
| `apa.csl` | [styles/apa.csl](https://github.com/citation-style-language/styles/blob/77f22e723a299243a6f6f5f01fb2e11441604c95/apa.csl) — APA Style 7th edition | `77f22e723a299243a6f6f5f01fb2e11441604c95` |
| `ieee.csl` | [styles/ieee.csl](https://github.com/citation-style-language/styles/blob/77f22e723a299243a6f6f5f01fb2e11441604c95/ieee.csl) — IEEE Reference Guide 11.29.2023 | `77f22e72…` |
| `nlm-citation-sequence.csl` | [styles/nlm-citation-sequence.csl](https://github.com/citation-style-language/styles/blob/77f22e723a299243a6f6f5f01fb2e11441604c95/nlm-citation-sequence.csl) — NLM/Vancouver, Citing Medicine 2nd ed. (citation-sequence). Used for the tool style `vancouver`: the repository's `dependent/vancouver-nlm.csl` has this style as independent parent (there is no `vancouver.csl` any more) | `77f22e72…` |
| `harvard-cite-them-right.csl` | [styles/harvard-cite-them-right.csl](https://github.com/citation-style-language/styles/blob/77f22e723a299243a6f6f5f01fb2e11441604c95/harvard-cite-them-right.csl) — Cite Them Right 12th edition (Harvard) | `77f22e72…` |
| `chicago-author-date.csl` | [styles/chicago-author-date.csl](https://github.com/citation-style-language/styles/blob/77f22e723a299243a6f6f5f01fb2e11441604c95/chicago-author-date.csl) — Chicago Manual of Style 18th edition (author-date). The tool style `chicago` writes author-date placeholder text | `77f22e72…` |
| `locales-en-US.xml` | [locales/locales-en-US.xml](https://github.com/citation-style-language/locales/blob/a89adece41013402236e2c9020972d7e931fbab8/locales-en-US.xml) | `a89adece41013402236e2c9020972d7e931fbab8` |
| `csl-data.json` | [schema/schemas/input/csl-data.json](https://github.com/citation-style-language/schema/blob/e3ce254a72c4470a5ed3b9d23b428017d25674e9/schemas/input/csl-data.json) | `e3ce254a72c4470a5ed3b9d23b428017d25674e9` |
| `csl-citation.json` | [schema/schemas/input/csl-citation.json](https://github.com/citation-style-language/schema/blob/e3ce254a72c4470a5ed3b9d23b428017d25674e9/schemas/input/csl-citation.json) (its `$ref` points to `csl-data.json`, both are registered with Ajv) | `e3ce254a…` |

Files are unmodified. The relaxations applied at load time (e.g. `itemData` without `id`) are
listed in `RELAXATIONS` in `test/helpers/docx-validate.ts`.

To update: re-download the same paths at a newer commit (with a timeout, e.g.
`timeout 30 curl -fsSL --max-time 25 -o apa.csl https://raw.githubusercontent.com/citation-style-language/styles/<sha>/apa.csl`),
update the commits above and run `npm test`.

## License and attribution

- The CSL styles and the en-US locale are © their respective authors and contributors (listed in
  each file's `<info>` block) and are licensed under the
  [Creative Commons Attribution-ShareAlike 3.0 Unported License](https://creativecommons.org/licenses/by-sa/3.0/)
  (CC BY-SA 3.0), as stated in each file's `<rights>` element. They are redistributed here
  unmodified and remain under CC BY-SA 3.0, not under this repository's MIT license.
- The CSL JSON schemas come from [citation-style-language/schema](https://github.com/citation-style-language/schema),
  licensed under the MIT License.

# Schema fixtures (vendored)

Used only by `test/utils/release-metadata.test.ts` to validate `server.json` (the MCP Registry entry)
offline. Not part of the npm package (`package.json` `files` is `["build"]`).

| File | Source | Commit |
|---|---|---|
| `server.schema.json` | [schemas/2025-12-11/server.schema.json](https://github.com/modelcontextprotocol/static/blob/a9ba437d9fbbe92076a24b20d56449ac7c7786ac/schemas/2025-12-11/server.schema.json), served as `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json` (the `$schema` of `server.json`) | `a9ba437d9fbbe92076a24b20d56449ac7c7786ac` |

Fetched on 2026-10-21, unmodified. To move to a newer schema version: download it (with a timeout, e.g.
`timeout 30 curl -fsSL --max-time 25 -o server.schema.json https://static.modelcontextprotocol.io/schemas/<date>/server.schema.json`),
update `$schema` in `server.json` and the table above, and run `npm test`.

License: [modelcontextprotocol/static](https://github.com/modelcontextprotocol/static) is MIT licensed.

#!/usr/bin/env node
import dotenv from "dotenv";
dotenv.config({ quiet: true });
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "module";
import { ZoteroApiInterface } from "./types/zotero-types.js";
import { registerAllTools } from "./tools/index.js";
import { registerAllPrompts } from "./prompts/index.js";
import { logger } from "./utils/logger.js";
import { parseUnsafeOperations, UnsafeOperationsMode } from "./utils/unsafe-operations.js";
import { getDefaultLibrary } from "./utils/library-context.js";
import { withRequestTimeout } from "./utils/timeouts.js";

// Report the package version in the MCP handshake (package.json sits one level above both src/ and build/).
const { version: SERVER_VERSION } = createRequire(import.meta.url)("../package.json") as { version: string };

// Re-export for backward compatibility with existing tests
export { formatErrorResponse } from "./utils/error-formatter.js";
export { handleToolCall } from "./tools/index.js";

export interface ZoteroServerOptions {
  userId?: string;
  apiKey?: string;
  zoteroApi?: ZoteroApiInterface;
}

class ZoteroServer {
  private server: McpServer;
  private zoteroApi: ZoteroApiInterface;
  private userId: string;
  private unsafeOps: UnsafeOperationsMode;

  constructor(options: ZoteroServerOptions = {}) {
    this.server = new McpServer(
      { name: "zotero", version: SERVER_VERSION },
      {
        capabilities: { tools: {}, prompts: {} },
        instructions: [
          "Zotero library management and citation injection for Word documents.",
          "",
          "CITATION WORKFLOW:",
          "1. Collect item keys: use add_items_by_doi for items with DOIs, add_items for items without DOIs (or search_library for existing items)",
          "2. Generate the document: create a .docx (Word) or .odt (LibreOffice) with <zcite keys=\"ITEMKEY\"/> placeholders where citations should appear. Each <zcite> must be in its own run.",
          "3. Call inject_citations with the file path — it fetches metadata from Zotero automatically and picks the format from the extension (.docx or .odt; pass format to override). The file must be on the machine where this server runs.",
          "4. Tell the user to open it in Word or LibreOffice with the Zotero plugin → Zotero → Add/Edit Bibliography, then Zotero → Refresh.",
          "",
          "To write a whole document from scratch (not fill placeholders in an existing one), use create_cited_document: give it Markdown with pandoc-style citations ([@KEY], [@K1; @K2], [see @KEY, p. 12], -@KEY) and an output .docx/.odt path. It never overwrites an existing file.",
          "",
          "KEY NOTES:",
          "- add_items_by_doi auto-attaches open-access PDFs found via Unpaywall (needs UNPAYWALL_EMAIL in the server settings; uses the user's Zotero storage). Do not disable auto_attach_pdf unless it causes errors.",
          "- For IEEE/Vancouver (numbered) citation styles, every <zcite> MUST include a num attribute. num is the citation number assigned in order of first appearance in the text (first cited = num=\"1\", second = num=\"2\", etc.). For multi-item citations use comma-separated values: keys=\"KEY1,KEY2\" num=\"1,2\". Without num, citations render as [?].",
          "- If the .docx is in a sandbox or cloud workspace this server cannot see (code execution in Claude.ai or Claude Desktop), use the zotero-mcp-integrations skill instead of inject_citations. If it is not installed, recommend zotero-skill-mcp-integrations.zip from https://github.com/Xevos117/mcp-zotero/releases/latest.",
          "- get_user_id is only needed by the skill script (inject.js), not by the inject_citations tool.",
          "- To edit an existing item, call get_items_details first (it returns each item's version), then update_item with that version; if it returns version_conflict, re-read and retry. Use create_note to attach a plain-text note to an item.",
          "- To check whether items have been retracted, flagged with an expression of concern, or corrected, use check_retractions with item_keys (up to 50) or a collection_key: it looks up each DOI on Crossref (read-only) and returns a status per item. Rerun only the items that come back lookup_failed.",
          "- Deleting is off unless the server setting UNSAFE_OPERATIONS (\"Deletions allowed\" in the Claude Desktop extension) allows it ('items': delete_items; 'all': also delete_collection). delete_items moves items to the Zotero trash by default (recoverable); pass permanent: true to delete for good. delete_collection is always permanent (collections have no trash). Never work around a blocked deletion with other tools.",
          "- Errors carry a hint with the next step. When it says the fix is on the user's side (API key, server settings), tell the user instead of retrying.",
        ].join("\n"),
      }
    );

    this.unsafeOps = parseUnsafeOperations(process.env.UNSAFE_OPERATIONS);

    if (options.zoteroApi) {
      this.userId = options.userId || "";
      this.zoteroApi = options.zoteroApi;
    } else {
      const apiKey = process.env.ZOTERO_API_KEY || "";
      if (!apiKey) {
        throw new Error("Missing ZOTERO_API_KEY environment variable (create a key at https://www.zotero.org/settings/keys)");
      }
      // Validate the library configuration eagerly so a misconfigured server fails
      // fast at startup rather than on the first tool call. ZOTERO_LIBRARY_ID takes
      // precedence (group libraries); ZOTERO_USER_ID is the user-library fallback.
      this.userId = getDefaultLibrary().id;

      // zotero-api-client >= 0.51 ships a single CJS entry (lib/main.cjs) that relies on the
      // global fetch; the old lib/main-node.cjs (cross-fetch polyfill) no longer exists.
      const require = createRequire(import.meta.url);
      const { default: zoteroApiFactory } = require("zotero-api-client") as typeof import("zotero-api-client");
      // every request carries its own AbortSignal.timeout (TIMEOUTS.zoteroApiMs)
      this.zoteroApi = withRequestTimeout(zoteroApiFactory(apiKey) as ZoteroApiInterface);
    }
  }

  private setupHandlers() {
    registerAllTools(this.server, this.zoteroApi, this.userId, this.unsafeOps);
    registerAllPrompts(this.server);
  }

  async start() {
    this.setupHandlers();
    const transport = new StdioServerTransport();
    logger.info("Starting Zotero MCP Server", { transport: "stdio" });
    try {
      await this.server.connect(transport);
      logger.info("Server connected");
    } catch (error) {
      logger.error("Connection failed", { error: String(error) });
      throw error;
    }
  }
}

async function main() {
  try {
    const server = new ZoteroServer();
    await server.start();
  } catch (error) {
    logger.error("Fatal error", { error: String(error) });
    process.exit(1);
  }
}

main();

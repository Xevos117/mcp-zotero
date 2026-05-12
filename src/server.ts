#!/usr/bin/env node
import dotenv from "dotenv";
dotenv.config({ quiet: true });
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "module";
import { ZoteroApiInterface } from "./types/zotero-types.js";
import { registerAllTools } from "./tools/index.js";
import { logger } from "./utils/logger.js";
import { parseUnsafeOperations, UnsafeOperationsMode } from "./utils/unsafe-operations.js";
import { getLibraryType } from "./utils/library-context.js";

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
      { name: "zotero", version: "1.0.0" },
      {
        capabilities: { tools: {} },
        instructions: [
          "Zotero library management and citation injection for Word documents.",
          "",
          "CITATION WORKFLOW:",
          "1. Collect item keys: use add_items_by_doi for items with DOIs, add_items for items without DOIs (or search_library for existing items)",
          "2. Generate .docx: create a Word document with <zcite keys=\"ITEMKEY\"/> placeholders where citations should appear. Each <zcite> must be in its own TextRun.",
          "3. Call inject_citations with the .docx file path — it fetches metadata from Zotero automatically.",
          "4. Tell the user to open in Word with Zotero plugin → click Zotero → Refresh.",
          "",
          "KEY NOTES:",
          "- add_items_by_doi auto-attaches OA PDFs via Unpaywall at no cost. Do not disable auto_attach_pdf unless it causes errors.",
          "- For IEEE/Vancouver (numbered) citation styles, every <zcite> MUST include a num attribute. num is the citation number assigned in order of first appearance in the text (first cited = num=\"1\", second = num=\"2\", etc.). For multi-item citations use comma-separated values: keys=\"KEY1,KEY2\" num=\"1,2\". Without num, citations render as [?].",
          "- get_user_id is only needed by the standalone skill script (inject.js), not by the inject_citations tool.",
        ].join("\n"),
      }
    );

    this.unsafeOps = parseUnsafeOperations(process.env.UNSAFE_OPERATIONS);

    if (options.zoteroApi) {
      this.userId = options.userId || "";
      this.zoteroApi = options.zoteroApi;
    } else {
      // ZOTERO_LIBRARY_ID takes precedence so the server can target a group
      // library; falls back to ZOTERO_USER_ID for back-compat (user libraries).
      this.userId =
        process.env.ZOTERO_LIBRARY_ID || process.env.ZOTERO_USER_ID || "";
      const apiKey = process.env.ZOTERO_API_KEY || "";
      if (!apiKey || !this.userId) {
        throw new Error(
          "Missing ZOTERO_API_KEY or ZOTERO_USER_ID/ZOTERO_LIBRARY_ID environment variables"
        );
      }
      // Validate ZOTERO_LIBRARY_TYPE eagerly so a misconfigured server fails
      // fast at startup rather than on the first tool call.
      getLibraryType();

      const require = createRequire(import.meta.url);
      const zoteroApiFactory = require("zotero-api-client/lib/main-node.cjs").default;
      this.zoteroApi = zoteroApiFactory(apiKey) as ZoteroApiInterface;
    }
  }

  private setupHandlers() {
    registerAllTools(this.server, this.zoteroApi, this.userId, this.unsafeOps);
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

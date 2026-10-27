import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZoteroApiInterface } from "../types/zotero-types.js";
import { UnsafeOperationsMode } from "../utils/unsafe-operations.js";
import { handleGetCollections, toolConfig as collectionsConfig } from "./get-collections.js";
import { handleGetCollectionItems, toolConfig as collectionItemsConfig } from "./get-collection-items.js";
import { handleGetItemsDetails, toolConfig as itemsDetailsConfig } from "./get-items-details.js";
import { handleSearchLibrary, toolConfig as searchConfig } from "./search-library.js";
import { handleCreateCollection, toolConfig as createCollectionConfig } from "./create-collection.js";
import { handleAddItemsByDoi, toolConfig as addItemsByDoiConfig } from "./add-items-by-doi.js";
import { handleInjectCitations, toolConfig as injectCitationsConfig } from "./inject-citations.js";
import { handleCreateCitedDocument, toolConfig as createCitedDocumentConfig } from "./create-cited-document.js";
import { handleGetItemFulltext, toolConfig as getItemFulltextConfig } from "./get-item-fulltext.js";
import { handleGetUserId, toolConfig as getUserIdConfig } from "./get-user-id.js";
import { handleAddLinkedUrlAttachment, toolConfig as addLinkedUrlAttachmentConfig } from "./add-linked-url-attachment.js";
import { handleAddItems, toolConfig as addItemsConfig } from "./add-items.js";
import { handleUpdateItem, toolConfig as updateItemConfig } from "./update-item.js";
import { handleCreateNote, toolConfig as createNoteConfig } from "./create-note.js";
import { handleImportPdfToZotero, toolConfig as importPdfToZoteroConfig } from "./import-pdf-to-zotero.js";
import { handleFindAndAttachPdfs, toolConfig as findAndAttachPdfsConfig } from "./find-and-attach-pdfs.js";
import { handleFindDuplicates, toolConfig as findDuplicatesConfig } from "./find-duplicates.js";
import { handleDeleteCollection, toolConfig as deleteCollectionConfig } from "./delete-collection.js";
import { handleDeleteItems, toolConfig as deleteItemsConfig } from "./delete-items.js";
import { handleCheckRetractions, toolConfig as checkRetractionsConfig } from "./check-retractions.js";

import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodRawShape } from "zod";
import { formatErrorResponse, logToolError } from "../utils/error-formatter.js";
import { describeError } from "../utils/error-hints.js";

type ToolHandler = (
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>,
  unsafeOps?: UnsafeOperationsMode
) => Promise<CallToolResult>;

const tools: Array<{ config: { name: string; description: string; inputSchema: ZodRawShape }; handler: ToolHandler }> = [
  { config: collectionsConfig, handler: handleGetCollections },
  { config: collectionItemsConfig, handler: handleGetCollectionItems },
  { config: itemsDetailsConfig, handler: handleGetItemsDetails },
  { config: searchConfig, handler: handleSearchLibrary },
  { config: createCollectionConfig, handler: handleCreateCollection },
  { config: addItemsByDoiConfig, handler: handleAddItemsByDoi },
  { config: injectCitationsConfig, handler: handleInjectCitations },
  { config: createCitedDocumentConfig, handler: handleCreateCitedDocument },
  { config: getItemFulltextConfig, handler: handleGetItemFulltext },
  { config: getUserIdConfig, handler: handleGetUserId },
  { config: addLinkedUrlAttachmentConfig, handler: handleAddLinkedUrlAttachment },
  { config: addItemsConfig, handler: handleAddItems },
  { config: updateItemConfig, handler: handleUpdateItem },
  { config: createNoteConfig, handler: handleCreateNote },
  { config: importPdfToZoteroConfig, handler: handleImportPdfToZotero },
  { config: findAndAttachPdfsConfig, handler: handleFindAndAttachPdfs },
  { config: findDuplicatesConfig, handler: handleFindDuplicates },
  { config: deleteCollectionConfig, handler: handleDeleteCollection },
  { config: deleteItemsConfig, handler: handleDeleteItems },
  { config: checkRetractionsConfig, handler: handleCheckRetractions },
];

const handlers = new Map(tools.map(({ config, handler }) => [config.name, handler]));

/**
 * Run a tool handler; Zotero API errors it throws are logged here once for every tool. API, timeout and
 * network errors become a structured error with a hint on what to do next; anything else (a bug) is rethrown.
 */
async function runTool(
  name: string,
  handler: ToolHandler,
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>,
  unsafeOps: UnsafeOperationsMode
): Promise<CallToolResult> {
  try {
    return await handler(zoteroApi, userId, args, unsafeOps);
  } catch (err) {
    logToolError(name, err);
    const described = describeError(err);
    if (!described) throw err;
    const { error, ...details } = described;
    return formatErrorResponse(error, details);
  }
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  zoteroApi: ZoteroApiInterface,
  userId: string,
  unsafeOps: UnsafeOperationsMode = "none"
): Promise<CallToolResult> {
  const handler = handlers.get(name);
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return runTool(name, handler, zoteroApi, userId, args, unsafeOps);
}

export function registerAllTools(
  server: McpServer,
  zoteroApi: ZoteroApiInterface,
  userId: string,
  unsafeOps: UnsafeOperationsMode = "none"
): void {
  for (const { config, handler } of tools) {
    server.registerTool(config.name, {
      description: config.description,
      inputSchema: config.inputSchema,
    }, async (args: Record<string, unknown>) => runTool(config.name, handler, zoteroApi, userId, args, unsafeOps));
  }
}

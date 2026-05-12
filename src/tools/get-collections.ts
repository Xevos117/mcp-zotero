import { z } from "zod";
import { ZoteroApiInterface, isZoteroApiError } from "../types/zotero-types.js";
import { formatErrorResponse } from "../utils/error-formatter.js";
import { logger } from "../utils/logger.js";
import { fetchAllPages } from "../utils/pagination.js";
import { getLibraryType } from "../utils/library-context.js";

export const toolConfig = {
  name: "get_collections",
  description: "List all collections (folders) in your Zotero library. Returns collection keys, names, and parent relationships. Use collection keys with get_collection_items or as parent_collection in create_collection. Trashed collections are excluded by default.",
  inputSchema: {
    include_trashed: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include trashed (deleted) collections. Default false."),
  },
} as const;

const GetCollectionsSchema = z.object(toolConfig.inputSchema);

export async function handleGetCollections(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { include_trashed } = GetCollectionsSchema.parse(args);

  try {
    const { items: allCollections } = await fetchAllPages((params) =>
      zoteroApi.library(getLibraryType(), userId).collections().get(params)
    );

    if (!Array.isArray(allCollections) || allCollections.length === 0) {
      return formatErrorResponse("No collections found", {
        suggestion:
          "Create a collection in your Zotero library first",
        helpUrl: "https://www.zotero.org/support/collections",
      });
    }

    // Zotero API returns deleted collections despite not requesting them —
    // filter client-side as a workaround
    const collections = include_trashed
      ? allCollections
      : allCollections.filter((c) => !(c as Record<string, unknown>).deleted);

    if (collections.length === 0) {
      return formatErrorResponse("No collections found", {
        suggestion:
          "All collections are in the trash. Use include_trashed=true to see them.",
      });
    }

    return {
      content: [
        { type: "text", text: JSON.stringify(collections, null, 2) },
      ],
    };
  } catch (err) {
    if (isZoteroApiError(err)) {
      logger.error("Tool execution failed", {
        tool: "get_collections",
        status: err.response?.status,
        errorMessage: err.message,
        url: err.response?.url,
      });
    }
    throw err;
  }
}

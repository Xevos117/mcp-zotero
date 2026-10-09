import { z } from "zod";
import { ZoteroApiInterface, isZoteroApiError } from "../types/zotero-types.js";
import { formatErrorResponse } from "../utils/error-formatter.js";
import { logger } from "../utils/logger.js";
import { getLibraryType, resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";

export const toolConfig = {
  name: "create_collection",
  description:
    "Create a new collection (folder) in your Zotero library. Optionally nest it under a parent collection. Returns the new collection key and name. Use the key with add_items_by_doi to organize imported papers.",
  inputSchema: {
    name: z.string().describe("Name of the new collection"),
    parent_collection: z
      .string()
      .optional()
      .describe(
        "Zotero collection key of the parent collection. Get this from get_collections."
      ),
    ...libraryArgsSchema,
  },
} as const;

const CreateCollectionSchema = z.object(toolConfig.inputSchema);

export async function handleCreateCollection(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { name, parent_collection, library_type, library_id } = CreateCollectionSchema.parse(args);
  const { type: libraryType, id: libraryId } = resolveLibrary({ library_type, library_id }, userId);

  if (!name?.trim()) {
    return formatErrorResponse("Collection name is required");
  }

  try {
    const collectionData: Record<string, unknown> = { name: name.trim() };
    if (parent_collection) {
      collectionData.parentCollection = parent_collection;
    }

    const response = await zoteroApi
      .library(libraryType, libraryId)
      .collections()
      .post([collectionData]);

    if (!response.isSuccess()) {
      const errors = response.getErrors();
      const errorMsg = Object.values(errors).join("; ") || "Unknown error";
      return formatErrorResponse("Failed to create collection", {
        details: errorMsg,
      });
    }

    const created = response.getData();
    const collection = created[0];

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              collection_key: collection.key,
              name: collection.name,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (err) {
    if (isZoteroApiError(err)) {
      logger.error("Tool execution failed", {
        tool: "create_collection",
        status: err.response?.status,
        errorMessage: err.message,
        url: err.response?.url,
      });
    }
    throw err;
  }
}

import { z } from "zod";
import { ZoteroApiInterface, isZoteroApiError } from "../types/zotero-types.js";
import { formatErrorResponse } from "../utils/error-formatter.js";
import { logger } from "../utils/logger.js";
import {
  ZOTERO_ITEM_TYPES,
  ITEM_TYPE_FIELDS,
  ITEM_TYPE_CREATOR_TYPES,
  TITLE_FIELD_NAME,
  ZoteroItemType,
} from "../utils/zotero-item-types.js";
import { getLibraryType } from "../utils/library-context.js";

const CreatorSchema = z
  .object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    name: z.string().optional(),
    creatorType: z.string().default("author"),
  })
  .refine(
    (data) =>
      data.name != null || (data.firstName != null && data.lastName != null),
    {
      message:
        "Provide either 'name' (institutional) or both firstName+lastName",
    }
  );

const ItemSchema = z
  .object({
    itemType: z.enum(ZOTERO_ITEM_TYPES),
    title: z.string(),
    creators: z.array(CreatorSchema).optional(),
  })
  .catchall(z.string())
  .superRefine((data, ctx) => {
    const itemType = data.itemType as ZoteroItemType;
    const validFields = ITEM_TYPE_FIELDS[itemType];

    for (const key of Object.keys(data)) {
      if (key === "itemType" || key === "title" || key === "creators") continue;
      if (!validFields.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `Field "${key}" is not valid for itemType "${data.itemType}". Valid fields: ${[...validFields].join(", ")}`,
          path: [key],
        });
      }
    }

    const validCreatorTypes = ITEM_TYPE_CREATOR_TYPES[itemType];
    for (const [i, creator] of (data.creators ?? []).entries()) {
      if (!validCreatorTypes.has(creator.creatorType)) {
        ctx.addIssue({
          code: "custom",
          message: `Invalid creatorType "${creator.creatorType}" for "${data.itemType}". Valid: ${[...validCreatorTypes].join(", ")}`,
          path: ["creators", i, "creatorType"],
        });
      }
    }
  });

export const toolConfig = {
  name: "add_items",
  description: `Add items to Zotero by providing metadata directly. Supports ALL 37 Zotero item types.

WHEN TO USE:
- For items that do not have a DOI (books, theses, reports, etc.)
- When you need full control over metadata (e.g., override a title, set a specific itemType, add custom fields) — even if a DOI exists, use add_items when the auto-resolved metadata would be incorrect or incomplete
- Mixed batch: if some items have DOIs and others don't, call add_items_by_doi for the DOIs and add_items for the rest (two separate calls)
- Prefer add_items_by_doi when DOIs are available AND you don't need to override metadata (it auto-resolves everything and attaches OA PDFs)

BATCH: Pass multiple items in the 'items' array (single API call).

COMMON FIELDS (available for most types):
title, date, abstractNote, url, DOI, publisher, place, pages, volume, language, extra

ITEM TYPE QUICK REFERENCE:
- journalArticle: publicationTitle, volume, issue, pages, DOI, ISSN
- book: publisher, ISBN, edition, numPages, series, seriesNumber
- bookSection: bookTitle, publisher, pages, ISBN, edition
- conferencePaper: proceedingsTitle, conferenceName, publisher, DOI
- thesis: thesisType ("PhD thesis"|"Master's thesis"), university
- report: reportType, reportNumber, institution
- webpage: websiteTitle, websiteType, accessDate
- preprint: repository, archiveID, genre ("Preprint")
- patent: patentNumber, assignee, issuingAuthority, filingDate
- computerProgram: versionNumber, company, system, programmingLanguage

CREATORS: Array of {firstName, lastName, creatorType} or {name, creatorType} for institutional.
Default creatorType is "author". Some types use different primary types (e.g., "director" for film, "inventor" for patent, "artist" for artwork).

Invalid fields or creatorTypes for a given type are rejected with helpful error messages listing the valid options.`,
  inputSchema: {
    items: z
      .array(ItemSchema)
      .min(1)
      .describe(
        "Array of items to add. Each item must have itemType and title. Additional fields depend on the item type."
      ),
    collection_key: z
      .string()
      .optional()
      .describe(
        "Zotero collection key to add all items to. Get this from create_collection or get_collections."
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe("Tags to apply to all items"),
  },
} as const;

const AddItemsSchema = z.object(toolConfig.inputSchema);

export async function handleAddItems(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { items, collection_key, tags } = AddItemsSchema.parse(args);

  const payloads = items.map((item) => {
    const { itemType, title, creators, ...fields } = item;
    const titleFieldName =
      TITLE_FIELD_NAME[itemType as ZoteroItemType] ?? "title";

    const payload: Record<string, unknown> = {
      itemType,
      ...fields,
      [titleFieldName]: title,
      creators: (creators ?? []).map((c) => {
        if (c.name) {
          return { name: c.name, creatorType: c.creatorType };
        }
        return {
          firstName: c.firstName,
          lastName: c.lastName,
          creatorType: c.creatorType,
        };
      }),
      collections: collection_key ? [collection_key] : [],
      tags: (tags ?? []).map((t) => ({ tag: t })),
    };

    if (fields.url && !fields.accessDate) {
      payload.accessDate = new Date().toISOString().split("T")[0];
    }

    return payload;
  });

  try {
    const response = await zoteroApi
      .library(getLibraryType(), userId)
      .items()
      .post(payloads);

    const errors = response.getErrors();
    const errorIndices = new Set(Object.keys(errors));

    const success: Array<{
      index: number;
      item_key: string;
      title: string;
      item_type: string;
    }> = [];
    const failed: Array<{ index: number; title: string; error: string }> = [];

    for (const [idx, msg] of Object.entries(errors)) {
      const i = Number(idx);
      failed.push({ index: i, title: items[i].title, error: msg });
    }

    const created = response.getData();
    let successIdx = 0;
    for (let i = 0; i < items.length; i++) {
      if (!errorIndices.has(String(i))) {
        const entity = created[successIdx++];
        success.push({
          index: i,
          item_key: entity?.key ?? "unknown",
          title: entity?.title ?? items[i].title,
          item_type: items[i].itemType,
        });
      }
    }

    if (success.length === 0 && failed.length > 0) {
      return formatErrorResponse("All items failed to create", { failed });
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success,
              ...(failed.length > 0 ? { failed } : {}),
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
        tool: "add_items",
        status: err.response?.status,
        errorMessage: err.message,
        url: err.response?.url,
      });
    }
    throw err;
  }
}

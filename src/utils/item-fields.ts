import { z } from "zod";
import {
  ITEM_TYPE_FIELDS,
  ITEM_TYPE_CREATOR_TYPES,
  ZoteroItemType,
} from "./zotero-item-types.js";

/**
 * Creator input shared by add_items and update_item: either an institutional single-field `name`
 * or both `firstName` and `lastName`. creatorType defaults to "author".
 */
export const CreatorSchema = z
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

export type CreatorInput = z.infer<typeof CreatorSchema>;

/** A validation problem, with the same path/message shape zod's ctx.addIssue expects. */
export interface ItemFieldIssue {
  path: Array<string | number>;
  message: string;
}

/**
 * Issues for every key not valid for `itemType`, ignoring the names in `skip` (fields handled
 * elsewhere, e.g. the universal `title`/`creators` inputs of add_items). Messages match the
 * historical add_items wording so error text stays stable.
 */
export function fieldValidationIssues(
  itemType: ZoteroItemType,
  keys: Iterable<string>,
  skip: ReadonlySet<string> = new Set()
): ItemFieldIssue[] {
  const validFields = ITEM_TYPE_FIELDS[itemType];
  const issues: ItemFieldIssue[] = [];
  for (const key of keys) {
    if (skip.has(key)) continue;
    if (!validFields.has(key)) {
      issues.push({
        path: [key],
        message: `Field "${key}" is not valid for itemType "${itemType}". Valid fields: ${[...validFields].join(", ")}`,
      });
    }
  }
  return issues;
}

/** Issues for every creator whose creatorType is not valid for `itemType`. */
export function creatorValidationIssues(
  itemType: ZoteroItemType,
  creators: ReadonlyArray<{ creatorType?: string }> = []
): ItemFieldIssue[] {
  const validCreatorTypes = ITEM_TYPE_CREATOR_TYPES[itemType];
  const issues: ItemFieldIssue[] = [];
  for (const [i, creator] of creators.entries()) {
    const creatorType = creator.creatorType ?? "author";
    if (!validCreatorTypes.has(creatorType)) {
      issues.push({
        path: ["creators", i, "creatorType"],
        message: `Invalid creatorType "${creatorType}" for "${itemType}". Valid: ${[...validCreatorTypes].join(", ")}`,
      });
    }
  }
  return issues;
}

/** Map a validated creator to the Zotero API shape (institutional `name` or first/last name). */
export function toZoteroCreator(c: CreatorInput): Record<string, string | undefined> {
  if (c.name) {
    return { name: c.name, creatorType: c.creatorType };
  }
  return { firstName: c.firstName, lastName: c.lastName, creatorType: c.creatorType };
}

import { ZoteroCreator, ZoteroTag } from "../types/zotero-types.js";

export function formatCreators(creators?: ZoteroCreator[]): string {
  return (
    creators
      // single-field names (institutions, consortia) are stored in `name`
      ?.map((c) => (c.name?.trim() || `${c.firstName || ""} ${c.lastName || ""}`.trim()))
      .filter(Boolean)
      .join(", ") || "No authors listed"
  );
}

/** The display name of the first creator (an institutional `name`, else "First Last"), or null if there is none. */
export function firstCreatorName(creators?: ZoteroCreator[]): string | null {
  const first = creators?.[0];
  if (!first) return null;
  const name = first.name?.trim() || `${first.firstName || ""} ${first.lastName || ""}`.trim();
  return name || null;
}

export function formatTags(tags?: ZoteroTag[]): string[] {
  return tags?.map((t) => t.tag).filter(Boolean) || [];
}

import { ZoteroApiInterface } from "../types/zotero-types.js";
import { resolveLibrary } from "../utils/library-context.js";

export const toolConfig = {
  name: "get_user_id",
  description:
    "Returns the Zotero library configured in the server environment: user_id, library_type, library_id and library_path (\"users/<id>\" or \"groups/<id>\"). Pass library_path to the standalone inject-citations skill script (inject.js) to generate Zotero field code URIs. Not needed when using the inject_citations MCP tool, which reads the library internally.",
  inputSchema: {},
} as const;

export async function handleGetUserId(
  _zoteroApi: ZoteroApiInterface,
  userId: string,
  _args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { type, id } = resolveLibrary({}, userId);
  // For group libraries `userId` holds the group ID, so report the real user ID separately
  const user_id = type === "user" ? id : process.env.ZOTERO_USER_ID || null;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ user_id, library_type: type, library_id: id, library_path: `${type}s/${id}` }),
      },
    ],
  };
}

// Setup script for the test plugin (pref extensions.wcauto.setup): saves the items of $WCAUTO_ITEMS
// (Zotero Web API JSON: {libraries: [{type: "user"|"group", id, name?, items: [{key, data}]}]}) into the
// fresh local database with their original keys, so the documents' URIs resolve to library items
// (http://zotero.org/users/<any id>/items/KEY -> local user library; groups/<id> -> local group <id>).
// No sync and no request to zotero.org: the JSON is the curated corpus library (items.mjs).
const path = Services.env.get("WCAUTO_ITEMS");
if (path) {
  const input = JSON.parse(await Zotero.File.getContentsAsync(path));
  for (const lib of input.libraries) {
    let libraryID = Zotero.Libraries.userLibraryID;
    if (lib.type === "group") {
      const groupID = Number(lib.id);
      let group = Zotero.Groups.get(groupID);
      if (!group) {
        group = new Zotero.Group({ groupID, name: lib.name || `group ${groupID}`, description: "", version: 0, editable: true, filesEditable: false });
        await group.saveTx();
      }
      libraryID = group.libraryID;
    }
    let saved = 0;
    for (const { key, data } of lib.items) {
      if (!data || data.parentItem || ["note", "attachment", "annotation"].includes(data.itemType)) continue;
      const json = { ...data };
      for (const f of ["key", "version", "collections", "relations", "dateAdded", "dateModified"]) delete json[f];
      // Same steps as sync (syncLocal.js) for an object that is new locally
      const item = new Zotero.Item();
      item.libraryID = libraryID;
      item.key = key;
      await item.loadPrimaryData();
      item.fromJSON(json);
      await item.saveTx();
      saved++;
    }
    log({ loaded: saved, library: lib.type, libraryID });
  }
}

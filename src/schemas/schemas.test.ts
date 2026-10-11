import { describe, it, expect } from "vitest";
import { z } from "zod";
import { toolConfig as collectionItemsConfig } from "../tools/get-collection-items.js";
import { toolConfig as itemsDetailsConfig } from "../tools/get-items-details.js";
import { toolConfig as searchConfig } from "../tools/search-library.js";
import { toolConfig as createCollectionConfig } from "../tools/create-collection.js";
import { toolConfig as addItemsByDoiConfig } from "../tools/add-items-by-doi.js";
import { toolConfig as injectCitationsConfig } from "../tools/inject-citations.js";
import { toolConfig as getItemFulltextConfig } from "../tools/get-item-fulltext.js";
import { toolConfig as addLinkedUrlAttachmentConfig } from "../tools/add-linked-url-attachment.js";
import { toolConfig as addItemsConfig } from "../tools/add-items.js";
import { toolConfig as importPdfToZoteroConfig } from "../tools/import-pdf-to-zotero.js";
import { toolConfig as findAndAttachPdfsConfig } from "../tools/find-and-attach-pdfs.js";
import { toolConfig as deleteCollectionConfig } from "../tools/delete-collection.js";
import { toolConfig as deleteItemsConfig } from "../tools/delete-items.js";

const GetCollectionItemsSchema = z.object(collectionItemsConfig.inputSchema);
const FindAndAttachPdfsSchema = z.object(findAndAttachPdfsConfig.inputSchema);
const GetItemsDetailsSchema = z.object(itemsDetailsConfig.inputSchema);
const SearchLibrarySchema = z.object(searchConfig.inputSchema);
const CreateCollectionSchema = z.object(createCollectionConfig.inputSchema);
const AddItemsByDoiSchema = z.object(addItemsByDoiConfig.inputSchema);
const InjectCitationsSchema = z.object(injectCitationsConfig.inputSchema);
const GetItemFulltextSchema = z.object(getItemFulltextConfig.inputSchema);
const AddLinkedUrlAttachmentSchema = z.object(addLinkedUrlAttachmentConfig.inputSchema);
const AddItemsSchema = z.object(addItemsConfig.inputSchema);
const ImportPdfToZoteroSchema = z.object(importPdfToZoteroConfig.inputSchema);
const DeleteCollectionSchema = z.object(deleteCollectionConfig.inputSchema);
const DeleteItemsSchema = z.object(deleteItemsConfig.inputSchema);

describe("GetCollectionItemsSchema", () => {
  it("accepts valid collectionKey", () => {
    const result = GetCollectionItemsSchema.parse({ collectionKey: "ABCR23ZZ" });
    expect(result.collectionKey).toBe("ABCR23ZZ");
  });

  it("rejects missing collectionKey", () => {
    expect(() => GetCollectionItemsSchema.parse({})).toThrow();
  });

  it("rejects non-string collectionKey", () => {
    expect(() => GetCollectionItemsSchema.parse({ collectionKey: 123 })).toThrow();
  });

  it("defaults excludeAttachments to true", () => {
    const result = GetCollectionItemsSchema.parse({ collectionKey: "ABCR23ZZ" });
    expect(result.excludeAttachments).toBe(true);
  });

  it("accepts excludeAttachments as boolean", () => {
    const result = GetCollectionItemsSchema.parse({
      collectionKey: "ABCR23ZZ",
      excludeAttachments: false,
    });
    expect(result.excludeAttachments).toBe(false);
  });
});

describe("GetItemsDetailsSchema", () => {
  it("accepts valid item_keys array", () => {
    const result = GetItemsDetailsSchema.parse({ item_keys: ["ITEMQQRZ", "ITEMQQ2Z"] });
    expect(result.item_keys).toEqual(["ITEMQQRZ", "ITEMQQ2Z"]);
  });

  it("accepts single item key", () => {
    const result = GetItemsDetailsSchema.parse({ item_keys: ["ITEMQQRZ"] });
    expect(result.item_keys).toHaveLength(1);
  });

  it("rejects missing item_keys", () => {
    expect(() => GetItemsDetailsSchema.parse({})).toThrow();
  });

  it("rejects non-array item_keys", () => {
    expect(() => GetItemsDetailsSchema.parse({ item_keys: "ITEMQQRZ" })).toThrow();
  });

  it("defaults include_abstract to false", () => {
    const result = GetItemsDetailsSchema.parse({ item_keys: ["ITEMQQRZ"] });
    expect(result.include_abstract).toBe(false);
  });

  it("accepts include_abstract as true", () => {
    const result = GetItemsDetailsSchema.parse({ item_keys: ["ITEMQQRZ"], include_abstract: true });
    expect(result.include_abstract).toBe(true);
  });

  it("rejects non-boolean include_abstract", () => {
    expect(() => GetItemsDetailsSchema.parse({ item_keys: ["ITEMQQRZ"], include_abstract: "yes" })).toThrow();
  });
});

describe("SearchLibrarySchema", () => {
  it("accepts valid query", () => {
    const result = SearchLibrarySchema.parse({ query: "machine learning" });
    expect(result.query).toBe("machine learning");
  });

  it("accepts omitted query (for listing mode)", () => {
    const result = SearchLibrarySchema.parse({});
    expect(result.query).toBeUndefined();
  });

  it("rejects non-string query", () => {
    expect(() => SearchLibrarySchema.parse({ query: true })).toThrow();
  });

  it("defaults sort to dateAdded", () => {
    const result = SearchLibrarySchema.parse({});
    expect(result.sort).toBe("dateAdded");
  });

  it("accepts valid sort values", () => {
    for (const sort of ["dateAdded", "dateModified", "title", "creator", "date"]) {
      const result = SearchLibrarySchema.parse({ sort });
      expect(result.sort).toBe(sort);
    }
  });

  it("rejects invalid sort value", () => {
    expect(() => SearchLibrarySchema.parse({ sort: "invalid" })).toThrow();
  });

  it("defaults direction to desc", () => {
    const result = SearchLibrarySchema.parse({});
    expect(result.direction).toBe("desc");
  });

  it("accepts asc direction", () => {
    const result = SearchLibrarySchema.parse({ direction: "asc" });
    expect(result.direction).toBe("asc");
  });

  it("defaults limit to 25", () => {
    const result = SearchLibrarySchema.parse({});
    expect(result.limit).toBe(25);
  });

  it("accepts custom limit", () => {
    const result = SearchLibrarySchema.parse({ limit: 50 });
    expect(result.limit).toBe(50);
  });

  it("rejects non-number limit", () => {
    expect(() => SearchLibrarySchema.parse({ limit: "ten" })).toThrow();
  });
});


describe("CreateCollectionSchema", () => {
  it("accepts valid name", () => {
    const result = CreateCollectionSchema.parse({ name: "My Collection" });
    expect(result.name).toBe("My Collection");
  });

  it("rejects missing name", () => {
    expect(() => CreateCollectionSchema.parse({})).toThrow();
  });

  it("accepts optional parent_collection", () => {
    const result = CreateCollectionSchema.parse({
      name: "Sub Collection",
      parent_collection: "PARENTQR",
    });
    expect(result.parent_collection).toBe("PARENTQR");
  });
});

describe("AddItemsByDoiSchema", () => {
  it("accepts array of DOIs", () => {
    const result = AddItemsByDoiSchema.parse({
      dois: ["10.1038/s41586-023-06647-8"],
    });
    expect(result.dois).toHaveLength(1);
  });

  it("rejects missing dois", () => {
    expect(() => AddItemsByDoiSchema.parse({})).toThrow();
  });

  it("accepts optional collection_key and tags", () => {
    const result = AddItemsByDoiSchema.parse({
      dois: ["10.1234/test"],
      collection_key: "CPLQQRZZ",
      tags: ["ai", "nlp"],
    });
    expect(result.collection_key).toBe("CPLQQRZZ");
    expect(result.tags).toEqual(["ai", "nlp"]);
  });

  it("defaults auto_attach_pdf to true", () => {
    const result = AddItemsByDoiSchema.parse({
      dois: ["10.1234/test"],
    });
    expect(result.auto_attach_pdf).toBe(true);
  });

  it("accepts auto_attach_pdf as false", () => {
    const result = AddItemsByDoiSchema.parse({
      dois: ["10.1234/test"],
      auto_attach_pdf: false,
    });
    expect(result.auto_attach_pdf).toBe(false);
  });
});

describe("InjectCitationsSchema", () => {
  it("accepts valid file_path", () => {
    const result = InjectCitationsSchema.parse({
      file_path: "/tmp/doc.docx",
    });
    expect(result.file_path).toBe("/tmp/doc.docx");
  });

  it("accepts valid style enum values", () => {
    for (const style of ["apa", "ieee", "vancouver", "harvard", "chicago"]) {
      const result = InjectCitationsSchema.parse({
        file_path: "/tmp/doc.docx",
        style,
      });
      expect(result.style).toBe(style);
    }
  });

  it("defaults style to apa", () => {
    const result = InjectCitationsSchema.parse({
      file_path: "/tmp/doc.docx",
    });
    expect(result.style).toBe("apa");
  });

  it("rejects invalid style", () => {
    expect(() =>
      InjectCitationsSchema.parse({
        file_path: "/tmp/doc.docx",
        style: "invalid",
      })
    ).toThrow();
  });
});

describe("GetItemFulltextSchema", () => {
  it("accepts valid item_key", () => {
    const result = GetItemFulltextSchema.parse({ item_key: "ABCR2345" });
    expect(result.item_key).toBe("ABCR2345");
  });

  it("rejects missing item_key", () => {
    expect(() => GetItemFulltextSchema.parse({})).toThrow();
  });

  it("defaults max_characters to 50000", () => {
    const result = GetItemFulltextSchema.parse({ item_key: "ABCR2345" });
    expect(result.max_characters).toBe(50000);
  });
});

describe("AddLinkedUrlAttachmentSchema", () => {
  it("accepts valid URL (only required field)", () => {
    const result = AddLinkedUrlAttachmentSchema.parse({
      url: "https://arxiv.org/abs/2301.00001",
    });
    expect(result.url).toBe("https://arxiv.org/abs/2301.00001");
  });

  it("rejects missing url", () => {
    expect(() => AddLinkedUrlAttachmentSchema.parse({})).toThrow();
  });

  it("rejects invalid url", () => {
    expect(() =>
      AddLinkedUrlAttachmentSchema.parse({ url: "not-a-url" })
    ).toThrow();
  });

  it("accepts optional title and content_type", () => {
    const result = AddLinkedUrlAttachmentSchema.parse({
      url: "https://example.com/paper.pdf",
      title: "My Paper",
      content_type: "application/pdf",
    });
    expect(result.title).toBe("My Paper");
    expect(result.content_type).toBe("application/pdf");
  });

  it("accepts optional parent_item", () => {
    const result = AddLinkedUrlAttachmentSchema.parse({
      url: "https://example.com/paper.pdf",
      parent_item: "ITEMQQRZ",
    });
    expect(result.parent_item).toBe("ITEMQQRZ");
  });

  it("accepts optional collections", () => {
    const result = AddLinkedUrlAttachmentSchema.parse({
      url: "https://example.com/paper.pdf",
      collections: ["CPLQQRZZ", "CPLQQ2ZZ"],
    });
    expect(result.collections).toEqual(["CPLQQRZZ", "CPLQQ2ZZ"]);
  });

  it("accepts optional tags", () => {
    const result = AddLinkedUrlAttachmentSchema.parse({
      url: "https://example.com/paper.pdf",
      tags: ["ai", "nlp"],
    });
    expect(result.tags).toEqual(["ai", "nlp"]);
  });
});

describe("AddItemsSchema", () => {
  it("accepts valid items array with different item types", () => {
    const result = AddItemsSchema.parse({
      items: [
        { itemType: "journalArticle", title: "A Paper", DOI: "10.1234/test" },
        { itemType: "book", title: "A Book", publisher: "Penguin" },
        { itemType: "thesis", title: "My Thesis", university: "MIT" },
        { itemType: "webpage", title: "A Page", url: "https://example.com" },
      ],
    });
    expect(result.items).toHaveLength(4);
  });

  it("rejects empty items array", () => {
    expect(() => AddItemsSchema.parse({ items: [] })).toThrow();
  });

  it("rejects missing items", () => {
    expect(() => AddItemsSchema.parse({})).toThrow();
  });

  it("rejects invalid itemType", () => {
    expect(() =>
      AddItemsSchema.parse({
        items: [{ itemType: "invalidType", title: "Test" }],
      })
    ).toThrow();
  });

  it("rejects invalid field for a given itemType", () => {
    expect(() =>
      AddItemsSchema.parse({
        items: [{ itemType: "book", title: "Test", proceedingsTitle: "Conf" }],
      })
    ).toThrow(/not valid for itemType/);
  });

  it("rejects invalid creatorType for a given itemType", () => {
    expect(() =>
      AddItemsSchema.parse({
        items: [
          {
            itemType: "book",
            title: "Test",
            creators: [
              { firstName: "John", lastName: "Smith", creatorType: "director" },
            ],
          },
        ],
      })
    ).toThrow(/Invalid creatorType/);
  });

  it("accepts creators with name (institutional)", () => {
    const result = AddItemsSchema.parse({
      items: [
        {
          itemType: "report",
          title: "Test",
          creators: [{ name: "UNESCO" }],
        },
      ],
    });
    expect(result.items[0].creators![0].name).toBe("UNESCO");
  });

  it("defaults creatorType to author", () => {
    const result = AddItemsSchema.parse({
      items: [
        {
          itemType: "book",
          title: "Test",
          creators: [{ firstName: "John", lastName: "Smith" }],
        },
      ],
    });
    expect(result.items[0].creators![0].creatorType).toBe("author");
  });

  it("collection_key and tags are optional", () => {
    const result = AddItemsSchema.parse({
      items: [{ itemType: "book", title: "Test" }],
      collection_key: "CPLQQRZZ",
      tags: ["ai", "nlp"],
    });
    expect(result.collection_key).toBe("CPLQQRZZ");
    expect(result.tags).toEqual(["ai", "nlp"]);
  });

  it("accepts items without collection_key and tags", () => {
    const result = AddItemsSchema.parse({
      items: [{ itemType: "book", title: "Test" }],
    });
    expect(result.collection_key).toBeUndefined();
    expect(result.tags).toBeUndefined();
  });

  it("rejects creator with neither name nor firstName+lastName", () => {
    expect(() =>
      AddItemsSchema.parse({
        items: [
          {
            itemType: "book",
            title: "Test",
            creators: [{ creatorType: "author" }],
          },
        ],
      })
    ).toThrow();
  });
});

describe("ImportPdfToZoteroSchema", () => {
  it("accepts valid URL (only required field)", () => {
    const result = ImportPdfToZoteroSchema.parse({
      url: "https://arxiv.org/pdf/2301.00001.pdf",
    });
    expect(result.url).toBe("https://arxiv.org/pdf/2301.00001.pdf");
  });

  it("rejects missing url", () => {
    expect(() => ImportPdfToZoteroSchema.parse({})).toThrow();
  });

  it("rejects invalid url", () => {
    expect(() =>
      ImportPdfToZoteroSchema.parse({ url: "not-a-url" })
    ).toThrow();
  });

  it("accepts optional filename and title", () => {
    const result = ImportPdfToZoteroSchema.parse({
      url: "https://example.com/paper.pdf",
      filename: "my-paper.pdf",
      title: "My Paper",
    });
    expect(result.filename).toBe("my-paper.pdf");
    expect(result.title).toBe("My Paper");
  });

  it("defaults content_type to application/pdf", () => {
    const result = ImportPdfToZoteroSchema.parse({
      url: "https://example.com/paper.pdf",
    });
    expect(result.content_type).toBe("application/pdf");
  });

  it("accepts optional parent_item, collections, and tags", () => {
    const result = ImportPdfToZoteroSchema.parse({
      url: "https://example.com/paper.pdf",
      parent_item: "PARENTQR",
      collections: ["CPLQQRZZ"],
      tags: ["ai", "nlp"],
    });
    expect(result.parent_item).toBe("PARENTQR");
    expect(result.collections).toEqual(["CPLQQRZZ"]);
    expect(result.tags).toEqual(["ai", "nlp"]);
  });
});

describe("FindAndAttachPdfsSchema", () => {
  it("accepts item_keys array", () => {
    const result = FindAndAttachPdfsSchema.parse({ item_keys: ["KEYRZZZZ", "KEY2ZZZZ"] });
    expect(result.item_keys).toEqual(["KEYRZZZZ", "KEY2ZZZZ"]);
  });

  it("accepts collection_key string", () => {
    const result = FindAndAttachPdfsSchema.parse({ collection_key: "CPLQQRZZ" });
    expect(result.collection_key).toBe("CPLQQRZZ");
  });

  it("accepts empty args (validation of mutual exclusion is in handler)", () => {
    const result = FindAndAttachPdfsSchema.parse({});
    expect(result.item_keys).toBeUndefined();
    expect(result.collection_key).toBeUndefined();
  });

  it("defaults skip_if_attachment_exists to true", () => {
    const result = FindAndAttachPdfsSchema.parse({ item_keys: ["KEYRZZZZ"] });
    expect(result.skip_if_attachment_exists).toBe(true);
  });

  it("defaults dry_run to false", () => {
    const result = FindAndAttachPdfsSchema.parse({ item_keys: ["KEYRZZZZ"] });
    expect(result.dry_run).toBe(false);
  });

  it("accepts all params together", () => {
    const result = FindAndAttachPdfsSchema.parse({
      item_keys: ["KEYRZZZZ"],
      skip_if_attachment_exists: false,
      dry_run: true,
    });
    expect(result.skip_if_attachment_exists).toBe(false);
    expect(result.dry_run).toBe(true);
  });
});

describe("DeleteCollectionSchema", () => {
  it("accepts valid collection_key", () => {
    const result = DeleteCollectionSchema.parse({ collection_key: "CPLQQRZZ" });
    expect(result.collection_key).toBe("CPLQQRZZ");
  });

  it("rejects missing collection_key", () => {
    expect(() => DeleteCollectionSchema.parse({})).toThrow();
  });

  it("rejects non-string collection_key", () => {
    expect(() => DeleteCollectionSchema.parse({ collection_key: 123 })).toThrow();
  });

  it("rejects empty string collection_key", () => {
    expect(() => DeleteCollectionSchema.parse({ collection_key: "" })).toThrow();
  });
});

describe("DeleteItemsSchema", () => {
  it("accepts valid item_keys array", () => {
    const result = DeleteItemsSchema.parse({ item_keys: ["KEYRZZZZ", "KEY2ZZZZ"] });
    expect(result.item_keys).toEqual(["KEYRZZZZ", "KEY2ZZZZ"]);
  });

  it("accepts single item key", () => {
    const result = DeleteItemsSchema.parse({ item_keys: ["KEYRZZZZ"] });
    expect(result.item_keys).toHaveLength(1);
  });

  it("rejects missing item_keys", () => {
    expect(() => DeleteItemsSchema.parse({})).toThrow();
  });

  it("rejects empty item_keys array", () => {
    expect(() => DeleteItemsSchema.parse({ item_keys: [] })).toThrow();
  });

  it("rejects non-array item_keys", () => {
    expect(() => DeleteItemsSchema.parse({ item_keys: "KEYRZZZZ" })).toThrow();
  });

  it("rejects more than 50 item keys", () => {
    const keys = Array.from({ length: 51 }, (_, i) => `KEY${i}`);
    expect(() => DeleteItemsSchema.parse({ item_keys: keys })).toThrow();
  });

  it("accepts exactly 50 item keys", () => {
    const keys = Array.from({ length: 50 }, (_, i) => `KEY${"23456789ABCDEFGHIJKLMNPQRSTUVWXYZ"[Math.floor(i / 33)]}${"23456789ABCDEFGHIJKLMNPQRSTUVWXYZ"[i % 33]}222`);
    const result = DeleteItemsSchema.parse({ item_keys: keys });
    expect(result.item_keys).toHaveLength(50);
  });
});

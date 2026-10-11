import { vi } from "vitest";

// Fixture: full item with all fields
export const fullItemFixture = {
  key: "ABCR2345",
  itemType: "journalArticle",
  title: "Deep Learning for Natural Language Processing",
  creators: [
    { firstName: "John", lastName: "Smith", creatorType: "author" },
    { firstName: "Jane", lastName: "Doe", creatorType: "author" },
  ],
  date: "2024-01-15",
  dateAdded: "2024-02-01T10:30:00Z",
  abstractNote: "This paper presents a comprehensive survey of deep learning methods for NLP.",
  DOI: "10.1234/example.2024.001",
  url: "https://example.com/paper",
  publicationTitle: "Journal of Machine Learning",
  tags: [{ tag: "deep-learning" }, { tag: "NLP" }],
  collections: ["CPLQQRZZ", "CPLQQ2ZZ"],
};

// Fixture: minimal item (tests fallback values)
export const minimalItemFixture = {
  key: "MINQQQQR",
  itemType: "book",
};

// Fixture: collection data
export const collectionFixture = {
  key: "CPLQQRZZ",
  name: "Machine Learning Papers",
  parentCollection: false,
  numItems: 42,
};

export interface WriteResponseData {
  isSuccess: boolean;
  data: unknown[];
  errors: Record<string, string>;
}

/**
 * Creates a chainable mock of the Zotero API client.
 *
 * Usage:
 *   const { mock, getStub } = createZoteroApiMock(fixtureData);
 *   // fixtureData is what getData() returns
 *   // getStub is the vi.fn() for .get() — you can override it per-test
 *
 *   const { mock, getStub, postStub } = createZoteroApiMock(readData, writeData);
 *   // writeData configures the post() response
 */
export function createZoteroApiMock(
  data: unknown = [],
  writeData?: WriteResponseData
) {
  const getStub = vi.fn().mockResolvedValue({
    getData: () => data,
    getVersion: () => 1,
    getTotalResults: () => (Array.isArray(data) ? data.length : data ? 1 : 0),
  });

  const defaultWriteData: WriteResponseData = writeData ?? {
    isSuccess: true,
    data: Array.isArray(data) ? data : [data],
    errors: {},
  };

  const postStub = vi.fn().mockResolvedValue({
    isSuccess: () => defaultWriteData.isSuccess,
    getData: () => defaultWriteData.data,
    getErrors: () => defaultWriteData.errors,
    getEntityByIndex: (index: number) => defaultWriteData.data[index],
  });

  const deleteStub = vi.fn().mockResolvedValue({
    getVersion: () => 1,
  });

  const chainable: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop) {
      if (prop === "get") return getStub;
      if (prop === "post") return postStub;
      if (prop === "delete") return deleteStub;
      // All other methods return the proxy itself (chainable)
      return (..._args: unknown[]) => new Proxy(chainable, handler);
    },
  };

  const mock = new Proxy(chainable, handler);

  return { mock, getStub, postStub, deleteStub };
}

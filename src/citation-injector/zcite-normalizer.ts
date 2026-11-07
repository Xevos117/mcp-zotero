import { XMLParser, XMLBuilder } from "fast-xml-parser";

// Pattern to detect a complete zcite tag in entity-encoded text
// (processEntities: false keeps &lt; etc. as literals)
const ZCITE_PATTERN = /&lt;zcite\s+[\s\S]*?\/&gt;/;

// A complete Pandoc bracketed citation `[... @key ...]` within a single text node (no tag `<` inside).
// Used by the Pandoc branch of inject_citations to merge a marker Word split across runs. The zcite
// path keeps ZCITE_PATTERN, so its behaviour (and the golden Word output) is unchanged.
const PANDOC_PATTERN = /\[[^\]<]*@[^\]<]*\]/;

interface FxpNode {
  [tagName: string]: unknown;
  ":@"?: Record<string, string>;
  "#text"?: string;
}

type FxpChildren = FxpNode[];

const PARSER_OPTIONS = {
  preserveOrder: true,
  ignoreAttributes: false,
  processEntities: false,
  trimValues: false,
  // Prevent fast-xml-parser from parsing numeric/boolean text
  parseTagValue: false,
  parseAttributeValue: false,
};

const BUILDER_OPTIONS = {
  preserveOrder: true,
  ignoreAttributes: false,
  processEntities: false,
  format: false,
  suppressEmptyNode: false,
  suppressBooleanAttributes: false,
};

/**
 * Extract text content from a w:r (run) node in the parsed tree.
 * Returns the concatenated #text of all w:t children, or "" if none.
 */
function extractRunText(runChildren: FxpChildren): string {
  let text = "";
  for (const child of runChildren) {
    if ("w:t" in child) {
      const wtChildren = child["w:t"] as FxpChildren;
      for (const tc of wtChildren) {
        if ("#text" in tc) {
          text += String(tc["#text"]);
        }
      }
    }
  }
  return text;
}

/**
 * Check if a node is a w:r element (run).
 */
function isRunNode(node: FxpNode): boolean {
  return "w:r" in node;
}

/**
 * Check if a run has any w:t children (text elements).
 */
function hasTextContent(runChildren: FxpChildren): boolean {
  return runChildren.some((child) => "w:t" in child);
}

interface RunGroup {
  startIndex: number;
  endIndex: number; // inclusive
  texts: string[];
}

/**
 * Collect groups of consecutive w:r nodes that have text content.
 * Non-w:r nodes or w:r nodes without w:t break the group.
 */
function collectConsecutiveRunGroups(children: FxpChildren): RunGroup[] {
  const groups: RunGroup[] = [];
  let currentGroup: RunGroup | null = null;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (isRunNode(child)) {
      const runChildren = child["w:r"] as FxpChildren;
      if (hasTextContent(runChildren)) {
        const text = extractRunText(runChildren);
        if (currentGroup) {
          currentGroup.endIndex = i;
          currentGroup.texts.push(text);
        } else {
          currentGroup = { startIndex: i, endIndex: i, texts: [text] };
        }
        continue;
      }
    }
    // Non-w:r or w:r without w:t → flush current group
    if (currentGroup && currentGroup.texts.length >= 2) {
      groups.push(currentGroup);
    }
    currentGroup = null;
  }
  // Flush final group
  if (currentGroup && currentGroup.texts.length >= 2) {
    groups.push(currentGroup);
  }

  return groups;
}

/**
 * Given a group of consecutive runs, find a zcite tag that spans multiple runs.
 * Returns the sub-range [startOffset, endOffset] within the group (0-indexed),
 * or null if no split zcite found.
 */
function findSplitZcite(
  group: RunGroup,
  pattern: RegExp
): { startOffset: number; endOffset: number } | null {
  const { texts } = group;

  // Sliding window: try all start positions
  for (let start = 0; start < texts.length; start++) {
    let concat = "";
    for (let end = start; end < texts.length; end++) {
      concat += texts[end];
      // Only interested in splits (spanning 2+ runs)
      if (end <= start) continue;

      const m = pattern.exec(concat);
      if (m) {
        // Verify the match actually spans runs: the zcite must start before
        // the last run's text and end at or after the last run's start.
        // i.e., it's not entirely within one run of this sub-range.
        const matchStart = m.index;
        const matchEnd = m.index + m[0].length;
        // Calculate where the last run's text starts in the concatenated string
        const lastRunStart = concat.length - texts[end].length;
        // The zcite is split if it starts before lastRunStart AND extends
        // into the last run's territory, OR if it starts in a prior run.
        if (matchStart < lastRunStart && matchEnd > lastRunStart) {
          return { startOffset: start, endOffset: end };
        }
        // Also check: could a zcite fully within a single earlier run exist?
        // If so, skip this end and continue — no split needed for this combo.
      }
    }
  }
  return null;
}

/**
 * Merge runs from startIdx to endIdx (inclusive) in the children array.
 * The merged run gets the w:rPr from the first run and a single w:t with
 * the concatenated text of all merged runs.
 */
function mergeRunsInPlace(
  children: FxpChildren,
  group: RunGroup,
  startOffset: number,
  endOffset: number
): void {
  const absStart = group.startIndex + startOffset;
  const absEnd = group.startIndex + endOffset;
  const count = absEnd - absStart + 1;

  // Concatenate text from all runs in the range
  let mergedText = "";
  for (let i = absStart; i <= absEnd; i++) {
    const runChildren = children[i]["w:r"] as FxpChildren;
    mergedText += extractRunText(runChildren);
  }

  // Build new run node
  const firstRunChildren = children[absStart]["w:r"] as FxpChildren;
  const newRunChildren: FxpChildren = [];

  // Copy w:rPr from first run if present
  for (const child of firstRunChildren) {
    if ("w:rPr" in child) {
      newRunChildren.push(child);
      break;
    }
  }

  // Add single w:t with merged text
  newRunChildren.push({
    "w:t": [{ "#text": mergedText }],
    ":@": { "@_xml:space": "preserve" },
  });

  const newRun: FxpNode = { "w:r": newRunChildren };

  // Copy attributes from first run if any
  const firstRunAttrs = children[absStart][":@"];
  if (firstRunAttrs) {
    newRun[":@"] = firstRunAttrs;
  }

  // Splice: replace N runs with 1 merged run
  children.splice(absStart, count, newRun);
}

/**
 * Scan a paragraph's children for split zcite tags and merge them.
 * Returns true if any modifications were made.
 */
function normalizeParagraphRuns(children: FxpChildren, pattern: RegExp): boolean {
  let modified = false;

  // Use a while loop since indices shift after each merge
  let changed = true;
  while (changed) {
    changed = false;
    const groups = collectConsecutiveRunGroups(children);

    for (const group of groups) {
      const split = findSplitZcite(group, pattern);
      if (split) {
        mergeRunsInPlace(children, group, split.startOffset, split.endOffset);
        modified = true;
        changed = true;
        break; // Restart scan since indices shifted
      }
    }
  }

  return modified;
}

/**
 * Recursively walk the parsed tree, finding w:p elements and normalizing
 * their runs.
 */
function walkAndNormalize(nodes: FxpChildren, pattern: RegExp): boolean {
  let modified = false;

  for (const node of nodes) {
    if ("w:p" in node) {
      const pChildren = node["w:p"] as FxpChildren;
      if (normalizeParagraphRuns(pChildren, pattern)) {
        modified = true;
      }
    }

    // Recurse into all child arrays
    for (const key of Object.keys(node)) {
      if (key === ":@" || key === "#text") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        if (walkAndNormalize(value as FxpChildren, pattern)) {
          modified = true;
        }
      }
    }
  }

  return modified;
}

/**
 * Pre-process document.xml to merge zcite tags that Word has split across
 * multiple w:r runs (e.g. due to language or font changes mid-tag).
 *
 * If no split zcites are found, returns the original string unchanged
 * (zero risk of round-trip encoding differences).
 */
function normalizeMarkers(documentXml: string, pattern: RegExp, quick: string): string {
  // Quick check: if the marker cannot be present, skip parsing entirely
  if (!documentXml.includes(quick)) {
    return documentXml;
  }

  const parser = new XMLParser(PARSER_OPTIONS);
  const parsed = parser.parse(documentXml) as FxpChildren;

  const modified = walkAndNormalize(parsed, pattern);

  if (!modified) {
    return documentXml; // Return original string, no changes
  }

  const builder = new XMLBuilder(BUILDER_OPTIONS);
  return builder.build(parsed) as string;
}

export function normalizeZciteTags(documentXml: string): string {
  return normalizeMarkers(documentXml, ZCITE_PATTERN, "zcite");
}

/**
 * Merge Pandoc `[@…]` citation markers that Word split across runs, so the whole bracket is one run and
 * the Pandoc branch can find and replace it. The quick-check requires both `[` and `@` to be present.
 */
export function normalizePandocMarkers(documentXml: string): string {
  if (!documentXml.includes("[") || !documentXml.includes("@")) return documentXml;
  return normalizeMarkers(documentXml, PANDOC_PATTERN, "[");
}

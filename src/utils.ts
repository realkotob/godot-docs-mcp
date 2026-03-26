import { createDocument } from '@mixmark-io/domino';
import MiniSearch, { type Options as MiniSearchOptions } from 'minisearch';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

type Version = 'stable' | 'latest' | '4.6' | '4.5' | '4.4' | '4.3';

type SearchIndexItem = {
  id: number;
  name: string;
  category: string;
  url: string;
};

type HeadingNode = {
  address: string;
  heading: string;
  level: number;
  content: string;
  lineCount: number;
  charCount: number;
  children: HeadingNode[];
};

type ParsedPage = {
  url: string;
  title: string;
  description: string;
  root: HeadingNode[];
  totalLines: number;
  totalChars: number;
};

const PAGE_SIZE = 10_000;

/** Bucket of miniseaches for each version */
const miniSearches = new Map<Version, MiniSearch<SearchIndexItem>>();

/** Parsed docs pages - avoids refetching and reparsing */
const fetchedPages = new Map<string, ParsedPage>();

const miniSearchOptions: MiniSearchOptions = {
  fields: ['name'], // fields to index for full-text search
  storeFields: ['name', 'category', 'url'], // fields to return with search results
  searchOptions: {
    boostDocument: (_, __, storedFields) => {
      // boost class pages
      return storedFields?.category === 'classes' ? 2 : 1;
    },
    fuzzy: 0.2,
  },
};

const turndownService = new TurndownService({
  hr: '---',
  codeBlockStyle: 'fenced',
});

function makeFullUrl(version: Version, page: string) {
  return `https://docs.godotengine.org/en/${version}${page}`;
}

function toMarkdown(html: string) {
  const doc = createDocument(html);
  const content = doc.querySelector('div[role="main"]');

  return turndownService.use(gfm).turndown(content);
}

type FlatHeading = {
  level: number;
  heading: string;
  startOffset: number;
};

function findHeadings(markdown: string): FlatHeading[] {
  const headings: FlatHeading[] = [];
  const lines = markdown.split('\n');
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for setext H1: next line is ===+
    if (i + 1 < lines.length && line.trim().length > 0 && /^={3,}$/.test(lines[i + 1].trim())) {
      headings.push({ level: 1, heading: line.trim(), startOffset: offset });
    }

    // Check for setext H2: next line is ---+ (but current line must be non-empty text)
    if (i + 1 < lines.length && line.trim().length > 0 && /^-{3,}$/.test(lines[i + 1].trim())) {
      // Avoid matching horizontal rules: the preceding line must not be empty
      // and must not look like a heading underline itself
      if (!/^[=-]+$/.test(line.trim())) {
        headings.push({ level: 2, heading: line.trim(), startOffset: offset });
      }
    }

    // Check for ATX headings (H3-H6): lines starting with ###+
    const atxMatch = line.match(/^(#{3,6})\s+(.+)/);
    if (atxMatch) {
      headings.push({
        level: atxMatch[1].length,
        heading: atxMatch[2].trim(),
        startOffset: offset,
      });
    }

    offset += line.length + 1; // +1 for the newline
  }

  return headings;
}

function buildHeadingTree(markdown: string, headings: FlatHeading[]): HeadingNode[] {
  if (headings.length === 0) {
    return [{
      address: '0',
      heading: '(Full Page)',
      level: 1,
      content: markdown,
      lineCount: markdown.split('\n').length,
      charCount: markdown.length,
      children: [],
    }];
  }

  // Find the minimum heading level used as "top-level" sections
  // Typically H2 for Godot docs, but we detect it dynamically
  const minSectionLevel = Math.min(...headings.filter(h => h.level > 1).map(h => h.level));
  const topLevel = minSectionLevel || 2;

  const root: HeadingNode[] = [];

  // If there's content before the first heading, add as Introduction
  const firstHeadingOffset = headings[0].startOffset;
  // Skip the H1 title heading - find first non-H1 heading
  const firstSectionIdx = headings.findIndex(h => h.level >= topLevel);
  const introEnd = firstSectionIdx >= 0 ? headings[firstSectionIdx].startOffset : markdown.length;

  if (introEnd > 0) {
    const introContent = markdown.slice(0, introEnd).trimEnd();
    if (introContent.length > 0) {
      root.push({
        address: '0',
        heading: '(Introduction)',
        level: topLevel,
        content: introContent,
        lineCount: introContent.split('\n').length,
        charCount: introContent.length,
        children: [],
      });
    }
  }

  // Build sections from non-H1 headings
  const sectionHeadings = headings.filter(h => h.level >= topLevel);

  for (let i = 0; i < sectionHeadings.length; i++) {
    const start = sectionHeadings[i].startOffset;
    const end = i + 1 < sectionHeadings.length ? sectionHeadings[i + 1].startOffset : markdown.length;
    const content = markdown.slice(start, end).trimEnd();

    sectionHeadings[i] = { ...sectionHeadings[i], startOffset: start };
    // We'll use this content when building the tree
  }

  // Now build the tree recursively using a stack-based approach
  function buildNodes(
    flatHeadings: { level: number; heading: string; startOffset: number }[],
    parentAddress: string,
    startIdx: number,
    endIdx: number,
    parentLevel: number,
  ): HeadingNode[] {
    const nodes: HeadingNode[] = [];
    let childIndex = 0;
    let i = startIdx;

    while (i < endIdx) {
      const h = flatHeadings[i];
      if (h.level > parentLevel) {
        // This shouldn't happen at this level, skip
        i++;
        continue;
      }

      // Find the extent of this heading's content (until next heading at same or higher level)
      let nextSameOrHigher = i + 1;
      while (nextSameOrHigher < endIdx && flatHeadings[nextSameOrHigher].level > h.level) {
        nextSameOrHigher++;
      }

      const contentStart = h.startOffset;
      const contentEnd = nextSameOrHigher < endIdx
        ? flatHeadings[nextSameOrHigher].startOffset
        : (endIdx < flatHeadings.length ? flatHeadings[endIdx].startOffset : markdown.length);

      const fullContent = markdown.slice(contentStart, contentEnd).trimEnd();

      // Own content = from this heading to the first child heading
      const firstChildIdx = i + 1;
      const ownContentEnd = firstChildIdx < nextSameOrHigher
        ? flatHeadings[firstChildIdx].startOffset
        : contentEnd;
      const ownContent = markdown.slice(contentStart, ownContentEnd).trimEnd();

      const address = parentAddress ? `${parentAddress}.${childIndex}` : `${root.length}`;

      const node: HeadingNode = {
        address,
        heading: h.heading,
        level: h.level,
        content: ownContent,
        lineCount: fullContent.split('\n').length,
        charCount: fullContent.length,
        children: [],
      };

      // Recursively build children
      if (firstChildIdx < nextSameOrHigher) {
        node.children = buildNodes(flatHeadings, address, firstChildIdx, nextSameOrHigher, h.level + 1);
      }

      nodes.push(node);
      childIndex++;
      i = nextSameOrHigher;
    }

    return nodes;
  }

  // Group top-level (topLevel) headings and build tree
  let i = 0;
  while (i < sectionHeadings.length) {
    const h = sectionHeadings[i];
    if (h.level !== topLevel) {
      i++;
      continue;
    }

    // Find extent until next top-level heading
    let nextTopLevel = i + 1;
    while (nextTopLevel < sectionHeadings.length && sectionHeadings[nextTopLevel].level > topLevel) {
      nextTopLevel++;
    }

    const contentStart = h.startOffset;
    const contentEnd = nextTopLevel < sectionHeadings.length
      ? sectionHeadings[nextTopLevel].startOffset
      : markdown.length;
    const fullContent = markdown.slice(contentStart, contentEnd).trimEnd();

    // Own content (from heading to first child)
    const firstChildIdx = i + 1;
    const ownContentEnd = firstChildIdx < nextTopLevel
      ? sectionHeadings[firstChildIdx].startOffset
      : contentEnd;
    const ownContent = markdown.slice(contentStart, ownContentEnd).trimEnd();

    const address = `${root.length}`;

    const node: HeadingNode = {
      address,
      heading: h.heading,
      level: h.level,
      content: ownContent,
      lineCount: fullContent.split('\n').length,
      charCount: fullContent.length,
      children: [],
    };

    // Build children recursively
    if (firstChildIdx < nextTopLevel) {
      node.children = buildNodes(sectionHeadings, address, firstChildIdx, nextTopLevel, topLevel + 1);
    }

    root.push(node);
    i = nextTopLevel;
  }

  return root;
}

function parseMarkdownIntoHeadingTree(markdown: string): HeadingNode[] {
  const headings = findHeadings(markdown);
  return buildHeadingTree(markdown, headings);
}

function resolveSection(root: HeadingNode[], address: string): HeadingNode | null {
  const parts = address.split('.').map(Number);
  if (parts.some(isNaN)) return null;

  let current: HeadingNode[] = root;
  let node: HeadingNode | null = null;

  for (const idx of parts) {
    if (idx < 0 || idx >= current.length) return null;
    node = current[idx];
    current = node.children;
  }

  return node;
}

function getFullContent(node: HeadingNode): string {
  if (node.children.length === 0) return node.content;

  const parts = [node.content];
  for (const child of node.children) {
    parts.push(getFullContent(child));
  }
  return parts.join('\n\n');
}

function formatToc(nodes: HeadingNode[], indent: number = 0): string {
  const lines: string[] = [];
  const prefix = '  '.repeat(indent);

  for (const node of nodes) {
    lines.push(`${prefix}${node.address}. ${node.heading} - ${node.lineCount} lines, ${node.charCount} chars`);
    if (node.children.length > 0) {
      lines.push(formatToc(node.children, indent + 1));
    }
  }

  return lines.join('\n');
}

function extractDescription(root: HeadingNode[]): string {
  if (root.length === 0) return '';

  const intro = root[0];
  const lines = intro.content.split('\n');

  // Skip H1 heading (setext: title line + === line) or other heading lines
  let startLine = 0;
  // Skip setext H1
  if (lines.length > 1 && /^={3,}$/.test(lines[1]?.trim())) {
    startLine = 2;
  }

  // Find first non-empty paragraph
  let desc = '';
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) {
      if (desc.length > 0) break; // end of paragraph
      continue;
    }
    // Skip anchor links like [](#...)
    if (/^\[.*\]\(#.*\)$/.test(line)) continue;
    desc += (desc ? ' ' : '') + line;
  }

  if (desc.length > 300) {
    desc = desc.slice(0, 297) + '...';
  }

  return desc;
}

function buildParsedPage(url: string, markdown: string): ParsedPage {
  const root = parseMarkdownIntoHeadingTree(markdown);
  const description = extractDescription(root);
  const title = root.length > 0 && root[0].heading === '(Introduction)'
    ? extractTitleFromIntro(root[0].content)
    : root.length > 0 ? root[0].heading : '';

  return {
    url,
    title,
    description,
    root,
    totalLines: markdown.split('\n').length,
    totalChars: markdown.length,
  };
}

function extractTitleFromIntro(content: string): string {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[0].trim().length > 0) {
    return lines[0].trim();
  }
  return '';
}

function paginateContent(content: string, page: number): { text: string; totalPages: number } {
  const totalPages = Math.ceil(content.length / PAGE_SIZE);
  if (totalPages <= 1) {
    return { text: content, totalPages: 1 };
  }

  const nominalStart = (page - 1) * PAGE_SIZE;
  const nominalEnd = page * PAGE_SIZE;

  // Adjust to line boundaries
  let start = nominalStart;
  if (page > 1) {
    const prevNewline = content.lastIndexOf('\n', nominalStart);
    start = prevNewline >= 0 ? prevNewline + 1 : nominalStart;
  }

  let end = nominalEnd;
  if (page < totalPages) {
    const nextNewline = content.indexOf('\n', nominalEnd);
    end = nextNewline >= 0 ? nextNewline : nominalEnd;
  } else {
    end = content.length;
  }

  return { text: content.slice(start, end), totalPages };
}

/** Tracks versions whose index failed to load */
const unavailableVersions = new Set<Version>();

async function search(searchTerm: string, version: Version = 'stable') {
  if (unavailableVersions.has(version)) {
    throw new Error(`Documentation index for version "${version}" is not available`);
  }

  // keep the DB from being recreated/reindexed over and over
  if (!miniSearches.has(version)) {
    console.info(`Creating index for ${version}`);

    try {
      const miniSearch = new MiniSearch<SearchIndexItem>(miniSearchOptions);

      const searchIndex: SearchIndexItem[] = await import(
        `./indexes/${version}/searchindex.js.json`
      ).then((mod) => mod.default);

      miniSearch.removeAll();
      miniSearch.addAll(searchIndex);

      miniSearches.set(version, miniSearch);
    } catch (err) {
      console.error(`Failed to load index for version "${version}":`, err);
      unavailableVersions.add(version);
      throw new Error(`Documentation index for version "${version}" is not available`);
    }
  }

  const miniSearch = miniSearches.get(version);

  if (!miniSearch) {
    throw new Error(`No minisearch could be created for ${version}`);
  }

  const output = miniSearch.search(searchTerm);

  return output.map(({ url }) => makeFullUrl(version, url));
}

export const searchDocs = async (
  searchTerm: string,
  version: Version = 'stable',
) => {
  let results: string[];
  try {
    results = await search(searchTerm, version);
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: err instanceof Error ? err.message : `Failed to search for "${searchTerm}" in version "${version}"`,
        },
      ],
      isError: true,
    };
  }

  if (results.length < 1) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Failed to find any documentation for "${searchTerm}"`,
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: results.join('\n'),
      },
    ],
  };
};

export const getDocsPageForTerm = async (
  searchTerm: string,
  version: Version = 'stable',
  section?: string,
  page?: number,
) => {
  // Validate: page requires section
  if (page !== undefined && section === undefined) {
    return {
      content: [{ type: 'text' as const, text: 'The \'page\' parameter requires a \'section\' parameter.' }],
      isError: true,
    };
  }

  let results: string[];
  try {
    results = await search(searchTerm, version);
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: err instanceof Error ? err.message : `Failed to search for "${searchTerm}" in version "${version}"`,
        },
      ],
      isError: true,
    };
  }

  if (results.length < 1) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Failed to find any documentation for "${searchTerm}"`,
        },
      ],
      isError: true,
    };
  }

  const url = results[0];

  // Get or build the parsed page
  let parsedPage = fetchedPages.get(url);

  if (!parsedPage) {
    const res = await fetch(url);

    if (!res.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to fetch ${url}: ${res.status} ${res.statusText}\n${res.body}`,
          },
        ],
        isError: true,
      };
    }

    const contentType = res.headers.get('content-type') || '';
    const isHTML = contentType.includes('html');
    const body = await res.text();
    const markdown = !isHTML ? body : toMarkdown(body);

    console.info(`Created markdown for ${url}`);

    parsedPage = buildParsedPage(url, markdown);
    fetchedPages.set(url, parsedPage);
  } else {
    console.info(`Reused existing parsed page for ${url}`);
  }

  // Mode 1: TOC (no section param)
  if (section === undefined) {
    const tocLines = [
      `URL: ${parsedPage.url}`,
      `Total size: ${parsedPage.totalLines} lines, ${parsedPage.totalChars} chars`,
      '',
      `Description:`,
      parsedPage.description,
      '',
      'Sections:',
      formatToc(parsedPage.root),
      '',
      'To fetch a section, call this tool again with the same searchTerm and the section address (e.g., section="1" or section="5.1").',
    ];

    return {
      content: [{ type: 'text' as const, text: tocLines.join('\n') }],
    };
  }

  // Validate section format
  if (!/^\d+(\.\d+)*$/.test(section)) {
    return {
      content: [{
        type: 'text' as const,
        text: `Invalid section format '${section}'. Use dot notation like '3', '5.1', '5.1.2'.`,
      }],
      isError: true,
    };
  }

  // Resolve the section
  const node = resolveSection(parsedPage.root, section);

  if (!node) {
    // Build a helpful error message
    const parts = section.split('.').map(Number);
    let parentNodes = parsedPage.root;
    let resolvedAddress = '';

    for (let i = 0; i < parts.length; i++) {
      if (parts[i] >= parentNodes.length || parts[i] < 0) {
        const rangeEnd = parentNodes.length - 1;
        const parentDesc = resolvedAddress
          ? `Section '${resolvedAddress}' has subsections ${resolvedAddress}.0-${resolvedAddress}.${rangeEnd}`
          : `This page has sections 0-${rangeEnd}`;
        return {
          content: [{
            type: 'text' as const,
            text: `Section '${section}' does not exist. ${parentDesc}.`,
          }],
          isError: true,
        };
      }
      resolvedAddress = resolvedAddress ? `${resolvedAddress}.${parts[i]}` : `${parts[i]}`;
      parentNodes = parentNodes[parts[i]].children;
    }

    return {
      content: [{ type: 'text' as const, text: `Section '${section}' does not exist.` }],
      isError: true,
    };
  }

  // Get full content (including children)
  const fullContent = getFullContent(node);

  // Mode 2: Section fits in one page
  if (fullContent.length <= PAGE_SIZE) {
    const header = `URL: ${parsedPage.url}\nSection ${node.address}: ${node.heading} (${node.lineCount} lines, ${node.charCount} chars)\n\n`;
    return {
      content: [{ type: 'text' as const, text: header + fullContent }],
    };
  }

  // Mode 3: Paginated section
  const requestedPage = page ?? 1;
  const { text: pageText, totalPages } = paginateContent(fullContent, requestedPage);

  if (requestedPage > totalPages || requestedPage < 1) {
    return {
      content: [{
        type: 'text' as const,
        text: `Page ${requestedPage} does not exist for section '${section}'. This section has ${totalPages} pages.`,
      }],
      isError: true,
    };
  }

  const headerLines = [
    `URL: ${parsedPage.url}`,
    `Section ${node.address}: ${node.heading} (page ${requestedPage} of ${totalPages}, ${fullContent.length} total chars)`,
    '',
  ];

  const footerLines: string[] = [];
  if (requestedPage < totalPages) {
    footerLines.push('', '---', `To continue reading, call again with section="${section}", page=${requestedPage + 1}.`);
  }
  if (node.children.length > 0) {
    footerLines.push(`Or fetch a specific subsection like section="${node.children[0].address}" for just that part.`);
  }

  return {
    content: [{
      type: 'text' as const,
      text: headerLines.join('\n') + pageText + footerLines.join('\n'),
    }],
  };
};

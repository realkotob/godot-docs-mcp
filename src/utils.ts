import { createDocument } from '@mixmark-io/domino';
import MiniSearch, { type Options as MiniSearchOptions } from 'minisearch';
import TurndownService from 'turndown';
import { gfm } from '@joplin/turndown-plugin-gfm';

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
turndownService.use(gfm);

function makeFullUrl(version: Version, page: string) {
  return `https://docs.godotengine.org/en/${version}${page}`;
}

/**
 * Convert an array of DOM elements to markdown by wrapping them in a temp container.
 * We pass DOM nodes (not strings) to Turndown so it uses domino's DOM instead of
 * trying to access the browser's `document` (which doesn't exist in Workers).
 */
function elementsToMarkdown(elements: Element[], doc: Document): string {
  if (elements.length === 0) return '';
  const container = doc.createElement('div');
  for (const el of elements) {
    container.appendChild(el.cloneNode(true));
  }
  return turndownService.turndown(container as unknown as HTMLElement).trim();
}

/**
 * Convert a single DOM element to markdown.
 * Must pass the DOM node directly, not outerHTML string.
 */
function elementToMarkdown(element: Element, doc: Document): string {
  // Wrap in a container to avoid losing the element itself
  const container = doc.createElement('div');
  container.appendChild(element.cloneNode(true));
  return turndownService.turndown(container as unknown as HTMLElement).trim();
}

/**
 * Get children of an element as an array (domino NodeList isn't iterable).
 */
function childArray(el: Element): Element[] {
  const result: Element[] = [];
  for (let i = 0; i < el.children.length; i++) {
    result.push(el.children[i]);
  }
  return result;
}

/**
 * Split a section's children on <hr class="classref-item-separator"> elements
 * to find individual property/method subsections.
 */
function splitOnItemSeparators(sectionEl: Element): { heading: string; elements: Element[] }[] {
  const children = childArray(sectionEl);
  const groups: { heading: string; elements: Element[] }[] = [];
  let currentElements: Element[] = [];
  let isFirstGroup = true;

  for (const child of children) {
    // Skip the H2 heading (it belongs to the parent section, not subsections)
    if (isFirstGroup && child.tagName === 'H2') {
      continue;
    }

    // Split on item separators
    if (child.tagName === 'HR' && child.className.includes('classref-item-separator')) {
      if (currentElements.length > 0) {
        const heading = extractItemName(currentElements);
        groups.push({ heading, elements: currentElements });
        currentElements = [];
        isFirstGroup = false;
      }
      continue;
    }

    currentElements.push(child);
  }

  // Don't forget the last group
  if (currentElements.length > 0) {
    const heading = extractItemName(currentElements);
    groups.push({ heading, elements: currentElements });
  }

  return groups;
}

/**
 * Extract the item name from the first classref-* element in a group.
 * Handles: classref-property, classref-method, classref-signal,
 * classref-enumeration, classref-constant
 */
function extractItemName(elements: Element[]): string {
  for (const el of elements) {
    const cls = el.className;

    // Properties, methods, signals: name is in <strong>
    if (cls.includes('classref-property') ||
        cls.includes('classref-method') ||
        cls.includes('classref-signal')) {
      const strong = el.querySelector('strong');
      if (strong) return strong.textContent?.trim() || '(unnamed)';
      const text = el.textContent?.trim() || '(unnamed)';
      return text.slice(0, 50);
    }

    // Enumerations: "enum ProcessMode:" or "flags ProcessThreadMessages:" → extract name
    if (cls.includes('classref-enumeration') && !cls.includes('classref-enumeration-constant')) {
      const text = el.textContent?.trim() || '';
      // Format: "enum ProcessMode: 🔗" or "flags ProcessThreadMessages: 🔗"
      const match = text.match(/^(?:enum|flags)\s+(\S+)/);
      if (match) return match[1].replace(/:$/, '');
      return text.slice(0, 50) || '(unnamed)';
    }

    // Constants: "NOTIFICATION_ENTER_TREE = 10 🔗" → extract name
    if (cls.includes('classref-constant')) {
      const text = el.textContent?.trim() || '';
      const match = text.match(/^(\S+)/);
      if (match) return match[1];
      return text.slice(0, 50) || '(unnamed)';
    }
  }
  return '(unnamed)';
}

/**
 * Parse HTML into a structured ParsedPage with heading tree.
 * Sections are identified from the DOM structure, not from markdown headings.
 * Each section/subsection is converted to markdown individually (many small
 * Turndown calls are faster than one large call in the Workers runtime).
 */
function parseHtmlPage(html: string, url: string): ParsedPage {
  const doc = createDocument(html);
  const main = doc.querySelector('div[role="main"]');

  if (!main) {
    const markdown = turndownService.turndown(html).trim();
    return {
      url,
      title: '',
      description: '',
      root: [{
        address: '0',
        heading: '(Full Page)',
        level: 1,
        content: markdown,
        lineCount: markdown.split('\n').length,
        charCount: markdown.length,
        children: [],
      }],
      totalLines: markdown.split('\n').length,
      totalChars: markdown.length,
    };
  }

  // Find the main content section (e.g., <section id="node3d">)
  const mainSection = main.querySelector('section[id]');
  const container = mainSection || main;
  const children = childArray(container);

  const root: HeadingNode[] = [];
  let title = '';
  let description = '';

  // Collect intro elements (everything before the first <section> child)
  const introElements: Element[] = [];
  let sectionStartIdx = 0;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.tagName === 'SECTION') {
      sectionStartIdx = i;
      break;
    }
    if (child.tagName === 'H1') {
      title = child.textContent?.trim() || '';
    }
    introElements.push(child);
    sectionStartIdx = i + 1;
  }

  // Build Introduction section (section 0)
  if (introElements.length > 0) {
    const introMarkdown = elementsToMarkdown(introElements, doc);
    root.push({
      address: '0',
      heading: '(Introduction)',
      level: 2,
      content: introMarkdown,
      lineCount: introMarkdown.split('\n').length,
      charCount: introMarkdown.length,
      children: [],
    });
  }

  // Process remaining children: <section> elements and <hr> separators
  for (let i = sectionStartIdx; i < children.length; i++) {
    const child = children[i];

    // Skip section-level separators between top-level sections
    if (child.tagName === 'HR') continue;

    // Skip non-section elements
    if (child.tagName !== 'SECTION') continue;

    const sectionId = child.id || '';
    const h2 = child.querySelector('h2');
    const sectionHeading = h2?.textContent?.trim() || sectionId || '(Untitled)';
    const sectionAddress = `${root.length}`;

    // Only split into subsections if this section contains named items (properties/methods/signals)
    // Check direct children only (not deep descendants) to avoid matching
    // items from sibling sections that are nested under the same parent
    const directChildren = childArray(child);
    const hasNamedItems = directChildren.some(c =>
      c.className?.includes('classref-property') ||
      c.className?.includes('classref-method') ||
      c.className?.includes('classref-signal') ||
      c.className?.includes('classref-enumeration') ||
      c.className?.includes('classref-constant')
    ) && directChildren.some(c =>
      c.tagName === 'HR' && c.className?.includes('classref-item-separator')
    );

    if (hasNamedItems) {
      // Split into subsections
      const subsections = splitOnItemSeparators(child);

      // The parent section's own content is the H2 heading only (rendered as markdown)
      const h2Markdown = h2 ? elementToMarkdown(h2, doc) : sectionHeading;

      // Build children
      const childNodes: HeadingNode[] = [];
      let totalContent = h2Markdown;

      for (let j = 0; j < subsections.length; j++) {
        const sub = subsections[j];
        const subMarkdown = elementsToMarkdown(sub.elements, doc);
        const childAddress = `${sectionAddress}.${j}`;

        childNodes.push({
          address: childAddress,
          heading: sub.heading,
          level: 3,
          content: subMarkdown,
          lineCount: subMarkdown.split('\n').length,
          charCount: subMarkdown.length,
          children: [],
        });

        totalContent += '\n\n' + subMarkdown;
      }

      root.push({
        address: sectionAddress,
        heading: sectionHeading,
        level: 2,
        content: h2Markdown,
        lineCount: totalContent.split('\n').length,
        charCount: totalContent.length,
        children: childNodes,
      });
    } else {
      // No subsections - convert entire section to markdown
      const sectionMarkdown = elementToMarkdown(child, doc);

      root.push({
        address: sectionAddress,
        heading: sectionHeading,
        level: 2,
        content: sectionMarkdown,
        lineCount: sectionMarkdown.split('\n').length,
        charCount: sectionMarkdown.length,
        children: [],
      });
    }

    // Extract description from the "description" section
    if (sectionId === 'description' && !description) {
      const paragraphs = child.querySelectorAll('p');
      for (let p = 0; p < paragraphs.length; p++) {
        const text = paragraphs[p].textContent?.trim();
        if (text && text.length > 0) {
          description = text.length > 300 ? text.slice(0, 297) + '...' : text;
          break;
        }
      }
    }
  }

  // Calculate totals from all sections
  let totalChars = 0;
  let totalLines = 0;
  for (const node of root) {
    const fullContent = getFullContent(node);
    totalChars += fullContent.length;
    totalLines += fullContent.split('\n').length;
  }

  return {
    url,
    title,
    description,
    root,
    totalLines,
    totalChars,
  };
}

// --- Section navigation helpers (unchanged from previous implementation) ---

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

// --- Search infrastructure (unchanged) ---

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

// --- Exported tool handlers ---

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

    const body = await res.text();

    console.info(`Parsing page for ${url}`);

    parsedPage = parseHtmlPage(body, url);
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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';
import packageJson from '../package.json';
import { getDocsPageForTerm, searchDocs, SUPPORTED_VERSIONS } from './utils';

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
  server = new McpServer({
    name: 'Godot Documentation',
    version: packageJson.version,
  });

  async init() {
    this.server.tool(
    'search_docs',
    'Search the Godot documentation by term. Returns URLs to the full documentation for each matching term. The resulting URLs will need to have their page content fetched to see the documentation.',
    {
      searchTerm: z.string(),
      version: z.enum(SUPPORTED_VERSIONS).optional().default('stable'),
    },
    ({ searchTerm, version }) => searchDocs(searchTerm, version),
  );
  this.server.tool(
    'get_docs_page_for_term',
    'Fetch content from the Godot documentation by term. Without a section parameter, returns a table of contents with nested section addresses and sizes. With a section address (e.g. "3", "5.1"), returns that section\'s content. Large sections are automatically paginated.',
    {
      searchTerm: z.string(),
      version: z.enum(SUPPORTED_VERSIONS).optional().default('stable'),
      section: z.string().optional()
...
          .describe('Section address from the TOC using dot notation (e.g., "3", "5.1", "5.1.2"). Omit to get the table of contents. You can fetch multiple sections at once by separating addresses with spaces (e.g., "1 3 5.1").'),
        page: z.number().int().min(1).optional()
          .describe('Page number for large sections (1-indexed). Only needed when section content exceeds ~10000 chars.'),
      },
      ({ searchTerm, version, section, page }) => getDocsPageForTerm(searchTerm, version, section, page),
    );
  }
}

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === '/mcp') {
      if (request.method === 'GET' && !request.headers.get('accept')?.includes('text/event-stream')) {
        return new Response('OK', { status: 200 });
      }

      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const { success } = await env.MCP_RATE_LIMITER.limit({ key: ip });

      if (!success) {
        return new Response('Rate limited', { status: 429 });
      }

      return MyMCP.serve('/mcp').fetch(request, env, ctx);
    }

    return Response.redirect(
      'https://github.com/james2doyle/godot-docs-mcp',
      302,
    );
  },
};

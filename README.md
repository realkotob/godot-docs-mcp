# Godot Docs MCP

![demo.png](demo.png)

*This project is [hosted on Cloudflare using their Agents framework](https://developers.cloudflare.com/agents/)*

> [!WARNING]
> Due to the popularity of this project, a rate limit of 15 requests per 60 second has been added. If you want to avoid that, [create a free Cloudflare account yourself and deploy this project](#deploy-to-cloudflare).

Look up documentation in Godot using fuzz search. Supports `stable`, `latest`, `4.6`, `4.5`, `4.4`, and `4.3` versions. The default version is "stable".

## Tools

**search_docs** `(searchTerm: string, version: "stable" | "latest" | "4.6" | "4.5" | "4.4" | "4.3" = "stable")`

> Search the Godot docs by term. Will return URLs to the documentation for each matching term. The resulting URLs will need to have their page content fetched to see the documentation.

**get_docs_page_for_term** `(searchTerm: string, version: "stable" | "latest" | "4.6" | "4.5" | "4.4" | "4.3" = "stable")`

> Get the Godot docs content by term. Will return the full documentation page for the first matching result.

## Configure the MCP server

### Claude Code

Run this command to add the MCP server:

```sh
claude mcp add --transport http godot-docs https://godot-docs-mcp.j2d.workers.dev/mcp
```

### Claude Desktop, Cursor, and other clients (native HTTP support)

Add this to your MCP config file:

```json
{
  "mcpServers": {
    "godot-docs": {
      "type": "http",
      "url": "https://godot-docs-mcp.j2d.workers.dev/mcp"
    }
  }
}
```

### Clients without native HTTP MCP support

Use `mcp-remote` as a bridge (requires Node.js):

```json
{
  "mcpServers": {
    "godot-docs": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://godot-docs-mcp.j2d.workers.dev/mcp"
      ]
    }
  }
}
```

### How this works

The docs site uses a frontend search tool to handle the docs search. There is a file called `searchindex.js` in the docs site that contains an index of all the pages (URLs and titles, not content) on the site.

This project takes advantage of that in the following ways:

- downloads each of those `searchindex.js` files for each version of the docs
- converts the `searchindex.js` to a `searchindex.js.json` that is just json we need
- indexes that new json using [lucaong/minisearch](https://github.com/lucaong/minisearch)
- when a docs page is requested, the URL for the page is converted from HTML to markdown

## Local development

### Prerequisites

- [Node.js](https://nodejs.org/) v22.12+ (recommended to install via [nvm](https://github.com/nvm-sh/nvm))
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (installed via `npm install`)

### MCP server

```sh
npm install
npm run dev
```

Then, set up your tool:

```json
{
  "mcpServers": {
    "godot-docs": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://localhost:8787/mcp"
      ]
    }
  }
}
```

To debug the server, you can use [this browser tool](https://github.com/modelcontextprotocol/inspector):

```sh
# in another tab
npx @modelcontextprotocol/inspector
```

Then open http://localhost:6274/#tools.

You can also use https://www.mcpplayground.io/ to look at the tools in the live HTTP server.

### Generating the docs

Download and generate search indexes for all supported versions:

```sh
npm run generate-indexes
```

Or for specific versions only:

```sh
npm run generate-indexes -- stable 4.6
```

Run `npm run generate-indexes -- --help` for more details.

## Deploy to Cloudflare

To deploy your own instance (recommended to avoid rate limits):

1. Create a free [Cloudflare account](https://dash.cloudflare.com/sign-up)
2. Install and authenticate Wrangler:

```sh
npm install -g wrangler
wrangler login
```

3. Change the `ratelimits` settings in the `wrangler.jsonc` (recommended value 120 for personal use).
4. Clone and deploy:

```sh
git clone https://github.com/your-repo/godot-docs-mcp.git
cd godot-docs-mcp
npm install
npm run deploy
```

5. Update your server URL:

After deployment, update your MCP config with your worker URL:

```json
{
  "mcpServers": {
    "godot-docs": {
      "type": "http",
      "url": "https://godot-docs-mcp.YOUR-SUBDOMAIN.workers.dev/mcp"
    }
  }
}
```

### Adjusting the Rate Limit

The default rate limit is **15 requests per 60 seconds**. To increase or disable it, edit `wrangler.jsonc`:

**Increase the limit:**

```jsonc
"ratelimits": [
  {
    "name": "MCP_RATE_LIMITER",
    "namespace_id": "1001",
    "simple": {
      "limit": 1000,
      "period": 60
    }
  }
]
```

**Disable rate limiting entirely:**
Remove the entire `ratelimits` array from `wrangler.jsonc`.

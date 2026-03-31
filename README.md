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

To avoid rate limits, it is recommended to deploy your own instance of the Godot Docs MCP server.

### Option 1: Direct Git Deployment (Recommended)

This is the easiest way to keep your server up-to-date. When you push to your repository, Cloudflare will automatically build and deploy your worker.

1. Fork this repository to your GitHub account.
2. In the [Cloudflare Dashboard](https://dash.cloudflare.com/), go to **Workers & Pages** > **Create application** > **Create Worker**.
3. Select **Deploy from a Git repository** and connect your forked repo.
4. In the **Build settings** section, configure the following:
   - **Build command:** `npm run build`
   - **Build output directory:** (Leave empty)
5. After the first deployment, go to **Settings** > **Runtime** and ensure:
   - **Compatibility Date:** `2025-03-10` or later.
   - **Compatibility Flags:** Add `nodejs_compat`.
6. Go to **Settings** > **Bindings** and ensure the following are configured (Wrangler usually handles this, but verify in the dashboard):
   - **Durable Object:** Name: `MCP_OBJECT`, Class: `MyMCP`.
   - **Rate Limiter:** Name: `MCP_RATE_LIMITER`, ID: `1001`.

### Option 2: Manual CLI Deployment (Wrangler)

If you prefer deploying from your local machine:

1. Create a free [Cloudflare account](https://dash.cloudflare.com/sign-up).
2. Install and authenticate Wrangler:
   ```sh
   npm install -g wrangler
   wrangler login
   ```
3. Clone the repository and install dependencies:
   ```sh
   git clone https://github.com/your-repo/godot-docs-mcp.git
   cd godot-docs-mcp
   npm install
   ```
4. Deploy the server:
   ```sh
   npm run deploy
   ```
   *Note: This script will verify that search indexes are generated before deploying.*

### 5. Update your server URL

After deployment (via either method), update your MCP config with your worker URL:

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

The default rate limit is **15 requests per 60 seconds**.

#### Option 1: Using Cloudflare Environment Variables (Recommended)

This method allows you to adjust the rate limit directly in the Cloudflare Dashboard without modifying the code.

1.  In the [Cloudflare Dashboard](https://dash.cloudflare.com/), select your Worker.
2.  Go to **Settings** > **Variables** > **Environment Variables**.
3.  Add the following variables as **Text**:
    *   `RATE_LIMIT`: e.g., `100` (Number of requests)
    *   `RATE_PERIOD`: e.g., `60` (Time period in seconds)
4.  The next time your Worker is built/deployed, it will automatically use these values.

#### Option 2: Hardcoding in `wrangler.jsonc`

Alternatively, you can edit the values directly in `wrangler.jsonc`:

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

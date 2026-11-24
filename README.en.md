# conta-mcp (English summary)

An MCP server (stdio) that lets AI assistants work with the API of
[Conta](https://conta.no), a Norwegian invoicing and accounting system. It works with any
Model Context Protocol client, such as Claude Desktop, Claude Code, Cursor, VS Code and
OpenAI Codex. The full documentation is in Norwegian: [README.md](README.md).

> **Unofficial project.** conta-mcp is not developed, endorsed or supported by Conta AS.
> "Conta" is Conta's trademark and is only used to describe which API this server talks to.
> Use at your own risk, see [LICENSE](LICENSE).

## Security first

- The API key has the same access as the Conta user who created it.
- Keep the key in `~/.config/conta-mcp/.env`, not in the chat or the client config.
- Read-only by default: only read tools are registered. Enable writes with
  `CONTA_READ_ONLY=false`. Unrecognised values (such as `on`) stop the server.
- Deletion is off by default. `delete_payment`, and `removePaymentsIfExist` on
  `create_credit_note`, only work with `CONTA_ALLOW_DELETE=true`.
- `create_invoice` creates a real, legally binding invoice. Use `dryRun: true` first.
  On a dry run, delivery recipients are never sent, so nothing can reach a customer.
- Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`) so clients can ask
  for confirmation.
- Test against Conta's sandbox first: `CONTA_BASE_URL=https://api.gateway.conta-sandbox.no`.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Quick start

1. Create an API key in Conta: profile → **User → Data & Access → Create new API key**
   ([Conta's API guide](https://hjelp.conta.no/api)).
2. Ask your AI assistant (Claude Code, Codex, Cursor): "Set up Conta MCP from
   https://github.com/vektra-as/conta-mcp". The instructions for the assistant are in
   [README.md](README.md#instruks-til-ai-assistenten).
3. Paste the key yourself into `~/.config/conta-mcp/.env` after `CONTA_API_KEY=` and restart
   the client. Never paste the key into the chat.

Node 22 or newer is required. The server is fetched and built from GitHub:

```json
{
  "mcpServers": {
    "conta": {
      "command": "npx",
      "args": ["-y", "github:vektra-as/conta-mcp"]
    }
  }
}
```

Settings are read from the environment and from the key file `~/.config/conta-mcp/.env`
(mode 600; the server warns if others can read it). Only `CONTA_*` variables are taken from
the file, and values already set in the environment win. `CONTA_ENV_FILE` points to another
file.

| Variable | Required | Description |
|---|---|---|
| `CONTA_API_KEY` | yes | API key, sent as the `apiKey` header. |
| `CONTA_ORG_ID` | no | Default organization. Find it with `list_organizations`. |
| `CONTA_READ_ONLY` | no | Default `true` = read tools only. `false` enables write tools. |
| `CONTA_ALLOW_DELETE` | no | `true` = register `delete_payment` and allow `removePaymentsIfExist`. |
| `CONTA_BASE_URL` | no | Default `https://api.gateway.conta.no`. Must be `https://`. |
| `CONTA_LANGUAGE` | no | `NO` (default) or `EN`. |
| `CONTA_TIMEOUT_MS` | no | Per-request timeout, default `30000`. |
| `CONTA_MAX_RESPONSE_CHARS` | no | Longer results are truncated, default `100000`. |

The server exposes 33 tools for customers, invoices, drafts, credit notes, payments,
products, projects and read-only reports, plus four Norwegian workflow prompts. Tool
descriptions are in Norwegian, which modern models handle well.

## Development

```bash
npm install
npm run build
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE). `docs/conta-external-api.json` belongs to Conta and is not covered by the
license.

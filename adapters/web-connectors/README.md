# ChatGPT, Gemini, and Grok web connector templates

These files describe the intended remote MCP connection only. They are **not runnable today** because this PoC backend returns HTTP 501 at `/mcp`.

Before use, deploy a public HTTPS Streamable HTTP MCP bridge with real authentication, per-user scope derived from the authenticated identity (never from model-supplied tool arguments), rate limits, audit logs, and tools that preserve approval:

- `memory_context`: read approved canonical context only.
- `memory_propose`: create a pending proposal; never auto-approve.
- `memory_checkpoint`: optional, explicitly enabled session checkpoint.

ChatGPT Web support refers to custom MCP apps in ChatGPT developer mode. It is
plan- and workspace-policy-dependent, connects only to remote MCP servers, and
does not provide a deterministic local chat lifecycle hook. Full MCP actions
are currently a beta capability for Business and Enterprise/Edu workspaces;
Pro users can currently connect custom apps with read/fetch permissions in
developer mode. ChatGPT connects to remote MCP servers rather than a local
loopback endpoint; a private/local server needs a supported secure tunnel or a
separately verified HTTPS/OAuth gateway. See OpenAI's official [developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt)
and [Apps in ChatGPT](https://help.openai.com/en/articles/11487775-connectors-in).

Gemini support refers to eligible Gemini Spark custom connectors, not every Gemini web account. Availability and write-confirmation behavior are account/product dependent. Grok web support refers to its Bring Your Own MCP connector surface. None of these connectors proves that a platform's private native memory was synchronized.

The JSON files are operator-readable examples, not files that can necessarily
be imported directly into each consumer UI. Replace `memory.example.com` only
after the bridge's TLS certificate, auth flow, tool scopes, and read/write
receipts have been verified. Do not put a token directly in a committed
manifest.

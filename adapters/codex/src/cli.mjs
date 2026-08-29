import { HubClient } from "./client.mjs";
import { loadConfig } from "./config.mjs";
import { assertNoProjectionEcho, assertNoSecrets } from "./security.mjs";

const SCOPE_FLAGS = new Set(["--user-id", "--project-id", "--scope"]);

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help") return { command: "help" };
  if (!["context", "propose", "checkpoint"].includes(command)) {
    throw Object.assign(new Error("unknown command"), { code: "invalid_command" });
  }
  const options = { command, send: false, json: false, metadata: {} };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (SCOPE_FLAGS.has(token)) {
      throw Object.assign(new Error("scope must come from environment"), { code: "scope_env_only" });
    }
    if (token === "--send") options.send = true;
    else if (token === "--json") options.json = true;
    else if (["--query", "--session-id", "--metadata-json"].includes(token)) {
      const value = rest[index + 1];
      if (value === undefined) {
        throw Object.assign(new Error(`missing value for ${token}`), { code: "invalid_argument" });
      }
      index += 1;
      if (token === "--query") options.query = value;
      if (token === "--session-id") options.sessionId = value;
      if (token === "--metadata-json") {
        try {
          options.metadata = JSON.parse(value);
        } catch {
          throw Object.assign(new Error("invalid metadata JSON"), { code: "invalid_metadata" });
        }
      }
    } else {
      throw Object.assign(new Error(`unknown option: ${token}`), { code: "invalid_argument" });
    }
  }
  if (!options.metadata || Array.isArray(options.metadata) || typeof options.metadata !== "object") {
    throw Object.assign(new Error("metadata must be an object"), { code: "invalid_metadata" });
  }
  return options;
}

function line(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function helpText() {
  return [
    "omnimemory-hub context [--query TEXT] [--session-id ID] [--json]",
    "omnimemory-hub propose [--session-id ID] [--metadata-json JSON] [--send] < content",
    "omnimemory-hub checkpoint [--session-id ID] [--metadata-json JSON] [--send] < summary",
    "",
    "Scope is read only from MEMORY_HUB_USER_ID and MEMORY_HUB_PROJECT_ID.",
    "Writes are dry-run unless both --send and MEMORY_HUB_WRITE_ENABLED=1 are set.",
  ].join("\n");
}

export async function runCli(
  argv,
  {
    environment = process.env,
    stdinText = "",
    stdout = process.stdout,
    stderr = process.stderr,
    fetchImplementation = globalThis.fetch,
  } = {},
) {
  try {
    const options = parseArguments(argv);
    if (options.command === "help") {
      stdout.write(`${helpText()}\n`);
      return 0;
    }
    const config = loadConfig(environment);
    const client = new HubClient(config, fetchImplementation);

    if (options.command === "context") {
      const query = options.query ?? (String(stdinText).trim() || undefined);
      const result = await client.context({ query, sessionId: options.sessionId });
      if (options.json) {
        line(stdout, {
          delivery_state: result.deliveryState,
          item_count: result.items.length,
          text: result.text,
        });
      } else if (result.text) {
        stdout.write(`${result.text}\n`);
      }
      return 0;
    }

    const content = String(stdinText).trim();
    if (!content) throw Object.assign(new Error("stdin is required"), { code: "empty_input" });
    assertNoSecrets(content);
    assertNoSecrets(options.metadata);
    assertNoProjectionEcho(options.metadata);
    if (!options.send) {
      line(stdout, {
        command: options.command,
        content_length: content.length,
        mode: "dry-run",
        would_send: false,
      });
      return 0;
    }

    const result =
      options.command === "propose"
        ? await client.propose({ content, sessionId: options.sessionId, metadata: options.metadata })
        : await client.checkpoint({ summary: content, sessionId: options.sessionId, metadata: options.metadata });
    line(stdout, {
      command: options.command,
      id: result.item?.id || result.checkpoint?.id,
      status: result.item?.status || "created",
    });
    return 0;
  } catch (error) {
    line(stderr, { error: error?.code || "adapter_error" });
    return 2;
  }
}

export { helpText, parseArguments };

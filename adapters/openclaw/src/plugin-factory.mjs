export function createPlugin({ definePluginEntry, clientFactory, formatContext }) {
  return definePluginEntry({
    id: "omnimemory",
    name: "OmniMemory",
    description: "Inject approved Hub context into OpenClaw turns.",
    register(api) {
      api.on(
        "before_prompt_build",
        async (event, context) => {
          const client = clientFactory(context?.pluginConfig);
          const result = await client.context({
            query: typeof event?.prompt === "string" ? event.prompt : undefined,
            sessionId: context?.sessionId,
          });
          if (!result.text) return undefined;
          return { prependContext: formatContext(result.text) };
        },
        { timeoutMs: 5_000 },
      );
    },
  });
}

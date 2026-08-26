// Drives the server over stdio exactly as a real MCP client does.
// Usage: npm run smoke   (requires a working z.ai key)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "glm-mcp-smoke", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({ command: "node", args: [join(root, "dist", "index.js")] }),
);

const show = (label, r) => {
  console.log(`\n--- ${label} ---`);
  console.log("isError:", r.isError ?? false);
  console.log(r.content[0].text.slice(0, 400));
};

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

show("glm_models", await client.callTool({ name: "glm_models", arguments: {} }));

show(
  "glm_ask + reasoning",
  await client.callTool({
    name: "glm_ask",
    arguments: { prompt: "What is 17 * 23? Reply with just the number.", reasoning: "low" },
  }),
);

show(
  "glm_ask + file context",
  await client.callTool({
    name: "glm_ask",
    arguments: {
      cwd: root,
      files: ["src/glm.ts"],
      prompt: "In one sentence: where does this code look for an API key, in order?",
      reasoning: "low",
    },
  }),
);

show(
  "reasoning:none auto-raised on glm-5.3",
  await client.callTool({
    name: "glm_ask",
    arguments: { prompt: "Reply with exactly: FINE", reasoning: "none" },
  }),
);

show(
  "missing file degrades gracefully",
  await client.callTool({
    name: "glm_ask",
    arguments: { cwd: root, files: ["nope.ts"], prompt: "Reply with exactly: OK", reasoning: "low" },
  }),
);

await client.close();

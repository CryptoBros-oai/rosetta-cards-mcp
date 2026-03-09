import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { registry } from "./tool_registry.js";
import { assertTierAccess } from "./tiers/policy.js";
import { getCurrentTier } from "./tiers/context.js";

const server = new Server(
  { name: "rosetta-cards-kb", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: Array.from(registry.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const tool = registry.get(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  assertTierAccess(getCurrentTier(), name);
  return tool.handler(args);
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "kb://cards",
        name: "Cards index (file-backed)",
        description: "Cards are stored on disk under data/cards/*.json and *.png",
        mimeType: "application/json"
      }
    ]
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

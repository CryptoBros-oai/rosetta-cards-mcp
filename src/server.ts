import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { addDocument, buildCard, searchCards, getCard } from "./kb/store.js";

const server = new Server(
  { name: "rosetta-cards-kb", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "kb.add_document",
        description: "Add a document (markdown/text) to the KB. Splits into chunks and stores metadata.",
        inputSchema: {
          type: "object" as const,
          properties: {
            title: { type: "string" as const },
            text: { type: "string" as const },
            tags: { type: "array" as const, items: { type: "string" as const } },
            source_url: { type: "string" as const }
          },
          required: ["title", "text"]
        }
      },
      {
        name: "kb.build_card",
        description: "Generate a visual card (PNG) + structured JSON for a doc or chunk, optionally embedding a QR payload.",
        inputSchema: {
          type: "object" as const,
          properties: {
            doc_id: { type: "string" as const },
            chunk_id: { type: "number" as const },
            style: { type: "string" as const, enum: ["default", "dark", "light"] },
            include_qr: { type: "boolean" as const }
          },
          required: ["doc_id"]
        }
      },
      {
        name: "kb.search",
        description: "Search over cards (currently lexical cosine; swap to embeddings later).",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: { type: "string" as const },
            top_k: { type: "number" as const }
          },
          required: ["query"]
        }
      },
      {
        name: "kb.get_card",
        description: "Fetch a card JSON and PNG path by card_id.",
        inputSchema: {
          type: "object" as const,
          properties: {
            card_id: { type: "string" as const }
          },
          required: ["card_id"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "kb.add_document") {
    const parsed = z
      .object({
        title: z.string(),
        text: z.string(),
        tags: z.array(z.string()).optional(),
        source_url: z.string().optional()
      })
      .parse(args);
    const out = await addDocument(parsed);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "kb.build_card") {
    const parsed = z
      .object({
        doc_id: z.string(),
        chunk_id: z.number().optional(),
        style: z.enum(["default", "dark", "light"]).optional(),
        include_qr: z.boolean().optional()
      })
      .parse(args);
    const out = await buildCard(parsed);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "kb.search") {
    const parsed = z
      .object({
        query: z.string(),
        top_k: z.number().optional()
      })
      .parse(args);
    const out = await searchCards(parsed);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "kb.get_card") {
    const parsed = z.object({ card_id: z.string() }).parse(args);
    const out = await getCard(parsed.card_id);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
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

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { addDocument, buildCard, searchCards, getCard } from "./kb/store.js";
import { createEventCard } from "./kb/hooks.js";
import { loadMeta, mergeMeta } from "./kb/vault.js";
import { MetaPatchSchema } from "./kb/schema.js";
import { rebuildIndex, loadIndexSnapshot, SNAPSHOT_PATH } from "./kb/index.js";
import { createWeeklySummary } from "./kb/summary.js";
import { renderCardPngToDerived, renderSummaryPngToDerived, storageReport } from "./kb/derived.js";

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
      },
      {
        name: "kb.create_event",
        description: "Create a deterministic event card (temporal memory atom). Timestamps are excluded from the hashed payload.",
        inputSchema: {
          type: "object" as const,
          properties: {
            title: { type: "string" as const },
            summary: { type: "string" as const },
            event: {
              type: "object" as const,
              properties: {
                kind: { type: "string" as const, enum: ["deployment", "incident", "decision", "meeting", "build", "research", "ops", "personal", "other"] },
                status: { type: "string" as const, enum: ["observed", "confirmed", "resolved", "superseded"] },
                severity: { type: "string" as const, enum: ["info", "low", "medium", "high", "critical"] },
                confidence: { type: "number" as const },
                participants: { type: "array" as const, items: { type: "object" as const, properties: { role: { type: "string" as const }, name: { type: "string" as const } }, required: ["role", "name"] } },
                refs: { type: "array" as const, items: { type: "object" as const, properties: { ref_type: { type: "string" as const, enum: ["artifact_id", "url", "external_id"] }, value: { type: "string" as const } }, required: ["ref_type", "value"] } }
              },
              required: ["kind", "status", "severity", "confidence", "participants", "refs"]
            },
            tags: { type: "array" as const, items: { type: "string" as const } },
            rosetta: {
              type: "object" as const,
              properties: {
                verb: { type: "string" as const, enum: ["Attract", "Contain", "Release", "Repel", "Transform"] },
                polarity: { type: "string" as const, enum: ["+", "0", "-"] },
                weights: { type: "object" as const, properties: { A: { type: "number" as const }, C: { type: "number" as const }, L: { type: "number" as const }, P: { type: "number" as const }, T: { type: "number" as const } }, required: ["A", "C", "L", "P", "T"] }
              },
              required: ["verb", "polarity", "weights"]
            }
          },
          required: ["title", "summary", "event", "tags", "rosetta"]
        }
      },
      {
        name: "kb.get_meta",
        description: "Retrieve the sidecar metadata for an artifact by hash and type.",
        inputSchema: {
          type: "object" as const,
          properties: {
            artifact_hash: { type: "string" as const },
            artifact_type: { type: "string" as const, enum: ["card", "event"] }
          },
          required: ["artifact_hash", "artifact_type"]
        }
      },
      {
        name: "kb.merge_meta",
        description: "Merge a patch into the sidecar metadata for an artifact. Creates the meta file if it does not exist.",
        inputSchema: {
          type: "object" as const,
          properties: {
            artifact_hash: { type: "string" as const },
            artifact_type: { type: "string" as const, enum: ["card", "event"] },
            patch: { type: "object" as const }
          },
          required: ["artifact_hash", "artifact_type", "patch"]
        }
      },
      {
        name: "kb.rebuild_index",
        description: "Scan all on-disk artifacts and meta sidecars and rebuild the index snapshot. Returns summary counts and the snapshot path.",
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: []
        }
      },
      {
        name: "kb.index_status",
        description: "Return the current index snapshot if it exists, or {status: 'none'} if not yet built.",
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: []
        }
      },
      {
        name: "kb.create_weekly_summary",
        description: "Create a deterministic weekly summary artifact from referenced events and cards. week_start is normalized to Monday of that ISO week.",
        inputSchema: {
          type: "object" as const,
          properties: {
            week_start: { type: "string" as const, description: "Any date in YYYY-MM-DD; normalized to Monday of that week." },
            references: {
              type: "object" as const,
              properties: {
                events: { type: "array" as const, items: { type: "string" as const } },
                cards: { type: "array" as const, items: { type: "string" as const } }
              }
            },
            highlights: { type: "array" as const, items: { type: "string" as const } },
            decisions: { type: "array" as const, items: { type: "string" as const } },
            open_loops: { type: "array" as const, items: { type: "string" as const } },
            risks: { type: "array" as const, items: { type: "string" as const } },
            rosetta_balance: {
              type: "object" as const,
              properties: {
                A: { type: "number" as const }, C: { type: "number" as const },
                L: { type: "number" as const }, P: { type: "number" as const },
                T: { type: "number" as const }
              }
            }
          },
          required: ["week_start", "references", "highlights", "decisions", "open_loops", "risks"]
        }
      },
      {
        name: "kb.render_card_png",
        description: "Render a card's PNG into derived/cards/ by hash. Updates the MetaV1 sidecar render pointer. The PNG never affects the card's identity hash.",
        inputSchema: {
          type: "object" as const,
          properties: {
            hash: { type: "string" as const, description: "Full SHA-256 hex hash of the card." },
            style: { type: "string" as const, enum: ["default", "dark", "light"] },
            include_qr: { type: "boolean" as const }
          },
          required: ["hash"]
        }
      },
      {
        name: "kb.render_weekly_summary_png",
        description: "Render a weekly summary PNG into derived/summaries/ by hash. Writes a lightweight render.v1 sidecar. Never affects the summary's identity hash.",
        inputSchema: {
          type: "object" as const,
          properties: {
            hash: { type: "string" as const, description: "Full SHA-256 hex hash of the weekly summary." }
          },
          required: ["hash"]
        }
      },
      {
        name: "kb.storage_report",
        description: "Report vault disk usage across all data/ and derived/ subdirectories with optional budget threshold warnings.",
        inputSchema: {
          type: "object" as const,
          properties: {
            thresholds: {
              type: "object" as const,
              description: "Optional per-directory budget thresholds in GB. Keys: docs_gb, cards_gb, events_gb, blobs_gb, index_gb, derived_gb, total_gb.",
              properties: {
                docs_gb:    { type: "number" as const },
                cards_gb:   { type: "number" as const },
                events_gb:  { type: "number" as const },
                blobs_gb:   { type: "number" as const },
                index_gb:   { type: "number" as const },
                derived_gb: { type: "number" as const },
                total_gb:   { type: "number" as const }
              }
            }
          },
          required: []
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

  if (name === "kb.create_event") {
    const parsed = z
      .object({
        title: z.string(),
        summary: z.string(),
        event: z.object({
          kind: z.enum(["deployment", "incident", "decision", "meeting", "build", "research", "ops", "personal", "other"]),
          status: z.enum(["observed", "confirmed", "resolved", "superseded"]),
          severity: z.enum(["info", "low", "medium", "high", "critical"]),
          confidence: z.number().min(0).max(1),
          participants: z.array(z.object({ role: z.string(), name: z.string() })),
          refs: z.array(z.object({
            ref_type: z.enum(["artifact_id", "url", "external_id"]),
            value: z.string(),
          })),
        }),
        tags: z.array(z.string()),
        rosetta: z.object({
          verb: z.enum(["Attract", "Contain", "Release", "Repel", "Transform"]),
          polarity: z.enum(["+", "0", "-"]),
          weights: z.object({
            A: z.number(), C: z.number(), L: z.number(),
            P: z.number(), T: z.number(),
          }),
        }),
      })
      .parse(args);
    const out = await createEventCard(parsed);
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  if (name === "kb.get_meta") {
    const parsed = z
      .object({
        artifact_hash: z.string(),
        artifact_type: z.enum(["card", "event"]),
      })
      .strict()
      .parse(args);
    const meta = await loadMeta(parsed.artifact_hash, parsed.artifact_type);
    if (!meta) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "not_found" }) }] };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(meta, null, 2) }] };
  }

  if (name === "kb.merge_meta") {
    const parsed = z
      .object({
        artifact_hash: z.string(),
        artifact_type: z.enum(["card", "event"]),
        patch: z.record(z.unknown()),
      })
      .strict()
      .parse(args);
    // Validate with MetaPatchSchema — identity fields are structurally absent,
    // so any attempt to spoof schema_version / artifact_hash / artifact_type
    // is rejected as an unrecognized key.
    const validPatch = MetaPatchSchema.parse(parsed.patch);
    const result = await mergeMeta(
      parsed.artifact_hash,
      parsed.artifact_type,
      validPatch,
    );
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }

  if (name === "kb.create_weekly_summary") {
    const parsed = z
      .object({
        week_start: z.string(),
        references: z.object({
          events: z.array(z.string()).optional(),
          cards: z.array(z.string()).optional(),
        }).strict(),
        highlights: z.array(z.string()),
        decisions: z.array(z.string()),
        open_loops: z.array(z.string()),
        risks: z.array(z.string()),
        rosetta_balance: z
          .object({
            A: z.number(), C: z.number(), L: z.number(),
            P: z.number(), T: z.number(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(args);
    const summary = await createWeeklySummary(parsed);
    return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
  }

  if (name === "kb.rebuild_index") {
    const snapshot = await rebuildIndex();
    const summary = {
      counts: snapshot.counts,
      snapshot_path: SNAPSHOT_PATH,
      built_at: snapshot.built_at,
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
  }

  if (name === "kb.index_status") {
    const snapshot = await loadIndexSnapshot();
    if (!snapshot) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ status: "none" }) }] };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(snapshot, null, 2) }] };
  }

  if (name === "kb.render_card_png") {
    const parsed = z
      .object({
        hash: z.string(),
        style: z.enum(["default", "dark", "light"]).optional(),
        include_qr: z.boolean().optional(),
      })
      .strict()
      .parse(args);
    const result = await renderCardPngToDerived(parsed.hash, {
      style: parsed.style,
      include_qr: parsed.include_qr,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }

  if (name === "kb.render_weekly_summary_png") {
    const parsed = z
      .object({ hash: z.string() })
      .strict()
      .parse(args);
    const result = await renderSummaryPngToDerived(parsed.hash);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }

  if (name === "kb.storage_report") {
    const parsed = z
      .object({
        thresholds: z
          .object({
            docs_gb:    z.number().optional(),
            cards_gb:   z.number().optional(),
            events_gb:  z.number().optional(),
            blobs_gb:   z.number().optional(),
            index_gb:   z.number().optional(),
            derived_gb: z.number().optional(),
            total_gb:   z.number().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(args);
    const report = await storageReport(parsed.thresholds ?? {});
    return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
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

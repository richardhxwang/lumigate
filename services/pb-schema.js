"use strict";

/**
 * services/pb-schema.js — PocketBase collection auto-provisioning.
 *
 * On startup, ensures all required PB collections exist.
 * Uses the PB admin API to check/create collections.
 * Safe to call multiple times — skips already-existing collections.
 */

// ---------------------------------------------------------------------------
// Collection definitions
// ---------------------------------------------------------------------------

const PB_COLLECTIONS = [
  // Knowledge Base
  {
    name: "knowledge_bases",
    type: "base",
    schema: [
      { name: "name", type: "text", required: true },
      { name: "description", type: "text" },
      { name: "embedding_model", type: "text" },
      { name: "embedding_dimension", type: "number" },
      { name: "chunk_strategy", type: "text" },
      { name: "rag_strategy", type: "text" },
      { name: "document_count", type: "number" },
      { name: "chunk_count", type: "number" },
      { name: "owner_id", type: "text" },
      { name: "org_id", type: "text" },
      { name: "config", type: "json" },
      { name: "status", type: "text" },
    ],
  },
  {
    name: "kb_documents",
    type: "base",
    schema: [
      { name: "kb_id", type: "text", required: true },
      { name: "filename", type: "text" },
      { name: "file_type", type: "text" },
      { name: "file_size", type: "number" },
      { name: "chunk_count", type: "number" },
      { name: "status", type: "text" },
      { name: "error_message", type: "text" },
      { name: "metadata", type: "json" },
      { name: "file", type: "file" },
    ],
  },
  // Workflows
  {
    name: "workflows",
    type: "base",
    schema: [
      { name: "name", type: "text", required: true },
      { name: "description", type: "text" },
      { name: "nodes", type: "json" },
      { name: "edges", type: "json" },
      { name: "variables", type: "json" },
      { name: "owner_id", type: "text" },
      { name: "org_id", type: "text" },
      { name: "status", type: "text" },
      { name: "version", type: "text" },
      { name: "published_channel", type: "text" },
    ],
  },
  {
    name: "workflow_executions",
    type: "base",
    schema: [
      { name: "workflow_id", type: "text", required: true },
      { name: "status", type: "text" },
      { name: "input", type: "json" },
      { name: "output", type: "json" },
      { name: "context", type: "json" },
      { name: "current_node", type: "text" },
      { name: "trace", type: "json" },
      { name: "started_by", type: "text" },
      { name: "duration_ms", type: "number" },
      { name: "error", type: "text" },
    ],
  },
  // Traces / Observability
  {
    name: "traces",
    type: "base",
    schema: [
      { name: "trace_id", type: "text", required: true },
      { name: "type", type: "text" },
      { name: "user_id", type: "text" },
      { name: "session_id", type: "text" },
      { name: "status", type: "text" },
      { name: "duration_ms", type: "number" },
      { name: "token_count", type: "number" },
      { name: "cost_usd", type: "number" },
      { name: "spans", type: "json" },
      { name: "metadata", type: "json" },
      { name: "error", type: "text" },
    ],
  },
  {
    name: "trace_evaluations",
    type: "base",
    schema: [
      { name: "trace_id", type: "text", required: true },
      { name: "score", type: "number" },
      { name: "feedback", type: "text" },
      { name: "criteria", type: "text" },
      { name: "evaluator", type: "text" },
      { name: "evaluator_model", type: "text" },
    ],
  },
  // Versions
  {
    name: "entity_versions",
    type: "base",
    schema: [
      { name: "entity_type", type: "text", required: true },
      { name: "entity_id", type: "text", required: true },
      { name: "version", type: "text" },
      { name: "data", type: "json" },
      { name: "message", type: "text" },
      { name: "author", type: "text" },
      { name: "channel", type: "text" },
    ],
  },
  // Plugins
  {
    name: "plugins",
    type: "base",
    schema: [
      { name: "name", type: "text", required: true },
      { name: "description", type: "text" },
      { name: "version", type: "text" },
      { name: "author", type: "text" },
      { name: "plugin_type", type: "text" },
      { name: "schema", type: "json" },
      { name: "endpoint", type: "json" },
      { name: "config", type: "json" },
      { name: "tags", type: "json" },
      { name: "enabled", type: "bool" },
    ],
  },
  // User Memory (long-term per-user RAG memory)
  {
    name: "user_memories",
    type: "base",
    schema: [
      { name: "user_id", type: "text", required: true },
      { name: "category", type: "text" },      // preference, fact, entity, event, relationship
      { name: "text", type: "text" },
      { name: "source_session", type: "text" },
      { name: "entity_id", type: "text" },      // for pet profiles: pet ID
      { name: "entity_type", type: "text" },    // 'pet', 'person', 'place', etc.
      { name: "metadata", type: "json" },
      { name: "embedding_id", type: "text" },   // Qdrant point ID
    ],
  },
  {
    name: "user_profiles",
    type: "base",
    schema: [
      { name: "user_id", type: "text", required: true },
      { name: "profile", type: "json" },        // structured profile summary
      { name: "pet_profiles", type: "json" },   // { petId: { name, breed, age, ... } }
      { name: "last_updated", type: "text" },
    ],
  },
  // Tool calls (logged from server.js tool execution pipeline)
  {
    name: "tool_calls",
    type: "base",
    schema: [
      { name: "user", type: "text" },
      { name: "source", type: "text" },
      { name: "tool_name", type: "text", required: true },
      { name: "input_json", type: "text" },
      { name: "output_json", type: "text" },
      { name: "status", type: "text" },
      { name: "error_message", type: "text" },
      { name: "duration_ms", type: "number" },
      { name: "session_id", type: "text" },
    ],
  },
  // Generated files (tool-produced files saved to PB)
  {
    name: "generated_files",
    type: "base",
    schema: [
      { name: "filename", type: "text" },
      { name: "mime_type", type: "text" },
      { name: "user", type: "text" },
      { name: "file", type: "file" },
    ],
  },
  // Security events (PII detection, command guard, etc.)
  {
    name: "security_events",
    type: "base",
    schema: [
      { name: "type", type: "text" },
      { name: "severity", type: "text" },
      { name: "details", type: "text" },
      { name: "detail_json", type: "text" },
      { name: "projectId", type: "text" },
      { name: "user", type: "text" },
      { name: "source", type: "text" },
      { name: "event_type", type: "text" },
      { name: "session_id", type: "text" },
      { name: "ip_address", type: "text" },
      { name: "timestamp", type: "text" },
    ],
  },
  // Audit log (login, project changes, tool executions)
  {
    name: "audit_log",
    type: "base",
    schema: [
      { name: "event_type", type: "text" },
      { name: "user", type: "text" },
      { name: "project", type: "text" },
      { name: "source", type: "text" },
      { name: "success", type: "bool" },
      { name: "detail_json", type: "text" },
      { name: "ip_address", type: "text" },
      { name: "timestamp", type: "text" },
    ],
  },
  // Async tasks
  {
    name: "async_tasks",
    type: "base",
    schema: [
      { name: "task_type", type: "text" },
      { name: "status", type: "text" },
      { name: "payload", type: "json" },
      { name: "result", type: "json" },
      { name: "error", type: "text" },
      { name: "progress", type: "number" },
      { name: "started_by", type: "text" },
      { name: "duration_ms", type: "number" },
      { name: "priority", type: "number" },
    ],
  },

  // ── LumiTrade collections ──────────────────────────────────────────────────
  {
    name: "trade_signals",
    type: "base",
    schema: [
      { name: "symbol", type: "text", required: true },
      { name: "direction", type: "text" },
      { name: "entry_price", type: "number" },
      { name: "stop_loss", type: "number" },
      { name: "take_profit", type: "number" },
      { name: "risk_reward", type: "number" },
      { name: "confidence", type: "number" },
      { name: "timeframe", type: "text" },
      { name: "indicators", type: "json" },
      { name: "source", type: "text" },
      { name: "status", type: "text" },
      { name: "news_sentiment", type: "number" },
      { name: "broker", type: "text" },
      { name: "user_id", type: "text" },
      { name: "action", type: "text" },
      { name: "price", type: "number" },
      { name: "raw", type: "text" },
    ],
  },
  {
    name: "trade_positions",
    type: "base",
    schema: [
      { name: "symbol", type: "text", required: true },
      { name: "broker", type: "text" },
      { name: "direction", type: "text" },
      { name: "quantity", type: "number" },
      { name: "entry_price", type: "number" },
      { name: "current_price", type: "number" },
      { name: "stop_loss", type: "number" },
      { name: "take_profit", type: "number" },
      { name: "unrealized_pnl", type: "number" },
      { name: "realized_pnl", type: "number" },
      { name: "status", type: "text" },
      { name: "opened_at", type: "text" },
      { name: "closed_at", type: "text" },
      { name: "user_id", type: "text" },
    ],
  },
  {
    name: "trade_history",
    type: "base",
    schema: [
      { name: "symbol", type: "text" },
      { name: "broker", type: "text" },
      { name: "direction", type: "text" },
      { name: "entry_price", type: "number" },
      { name: "exit_price", type: "number" },
      { name: "quantity", type: "number" },
      { name: "pnl", type: "number" },
      { name: "pnl_pct", type: "number" },
      { name: "duration_minutes", type: "number" },
      { name: "entry_time", type: "text" },
      { name: "exit_time", type: "text" },
      { name: "strategy", type: "text" },
      { name: "signal_id", type: "text" },
      { name: "user_id", type: "text" },
    ],
  },
  {
    name: "trade_pnl",
    type: "base",
    schema: [
      { name: "date", type: "text", required: true },
      { name: "daily_pnl", type: "number" },
      { name: "cumulative_pnl", type: "number" },
      { name: "win_count", type: "number" },
      { name: "loss_count", type: "number" },
      { name: "win_rate", type: "number" },
      { name: "portfolio_value", type: "number" },
      { name: "max_drawdown", type: "number" },
      { name: "user_id", type: "text" },
    ],
  },
  {
    name: "trade_news",
    type: "base",
    schema: [
      { name: "symbol", type: "text" },
      { name: "headline", type: "text" },
      { name: "summary", type: "text" },
      { name: "source", type: "text" },
      { name: "url", type: "text" },
      { name: "published_at", type: "text" },
      { name: "finnhub_sentiment", type: "number" },
      { name: "finbert_sentiment", type: "number" },
      { name: "llm_sentiment", type: "number" },
      { name: "final_sentiment", type: "number" },
      { name: "impact", type: "text" },
      { name: "processed", type: "bool" },
    ],
  },
  {
    name: "trade_strategies",
    type: "base",
    schema: [
      { name: "name", type: "text", required: true },
      { name: "description", type: "text" },
      { name: "config", type: "json" },
      { name: "is_active", type: "bool" },
      { name: "symbols", type: "json" },
      { name: "timeframes", type: "json" },
      { name: "backtest_results", type: "json" },
      { name: "user_id", type: "text" },
    ],
  },
  {
    name: "trade_journal",
    type: "base",
    schema: [
      { name: "date", type: "text", required: true },
      { name: "session", type: "text" },        // london, ny, asian, overlap
      { name: "mood_before", type: "text" },     // user's mood before trading
      { name: "mood_after", type: "text" },      // user's mood after trading
      { name: "notes", type: "text" },           // free-form notes from user
      { name: "ai_summary", type: "text" },      // LLM-generated daily summary
      { name: "trades_count", type: "number" },
      { name: "wins", type: "number" },
      { name: "losses", type: "number" },
      { name: "total_pnl", type: "number" },
      { name: "best_trade", type: "json" },      // {symbol, pnl, entry, exit}
      { name: "worst_trade", type: "json" },
      { name: "session_breakdown", type: "json" }, // {london: {wins, losses, pnl}, ny: {...}, ...}
      { name: "killzone_performance", type: "json" }, // performance by killzone
      { name: "patterns_noted", type: "json" },  // SMC patterns that worked/failed
      { name: "lessons", type: "text" },         // AI-extracted lessons
      { name: "user_id", type: "text" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Auto-provisioning
// ---------------------------------------------------------------------------

/**
 * Ensure all PB_COLLECTIONS exist. Creates missing ones, skips existing.
 *
 * @param {string} pbUrl - PocketBase base URL (e.g. http://localhost:8090)
 * @param {string} adminToken - PB admin auth token
 * @param {function} [log] - Optional logger (level, msg, ctx)
 * @returns {Promise<{created: string[], skipped: string[], errors: string[]}>}
 */
async function ensureCollections(pbUrl, adminToken, log) {
  const _log = log || (() => {});
  const created = [];
  const skipped = [];
  const errors = [];

  if (!pbUrl || !adminToken) {
    _log("warn", "pb_schema_skip", {
      component: "pb-schema",
      reason: !pbUrl ? "no PB_URL" : "no admin token",
    });
    return { created, skipped, errors };
  }

  // Fetch existing collection names
  let existingNames = new Set();
  try {
    const res = await fetch(`${pbUrl}/api/collections?perPage=500`, {
      headers: { Authorization: adminToken },
    });
    if (res.ok) {
      const data = await res.json();
      existingNames = new Set((data.items || []).map((c) => c.name));
    }
  } catch (err) {
    _log("error", "pb_schema_fetch_failed", {
      component: "pb-schema",
      error: err.message,
    });
    return { created, skipped, errors: ["Failed to fetch existing collections: " + err.message] };
  }

  for (const collection of PB_COLLECTIONS) {
    if (existingNames.has(collection.name)) {
      skipped.push(collection.name);
      continue;
    }

    try {
      const body = {
        name: collection.name,
        type: collection.type || "base",
        schema: collection.schema.map((field) => ({
          name: field.name,
          type: field.type,
          required: field.required || false,
        })),
      };

      const res = await fetch(`${pbUrl}/api/collections`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: adminToken,
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        created.push(collection.name);
        _log("info", "pb_collection_created", {
          component: "pb-schema",
          collection: collection.name,
        });
      } else {
        const errText = await res.text().catch(() => "");
        // 400 with "already exists" is OK (race condition)
        if (res.status === 400 && errText.includes("already exists")) {
          skipped.push(collection.name);
        } else {
          errors.push(`${collection.name}: ${res.status} ${errText.slice(0, 200)}`);
          _log("warn", "pb_collection_create_failed", {
            component: "pb-schema",
            collection: collection.name,
            status: res.status,
            error: errText.slice(0, 200),
          });
        }
      }
    } catch (err) {
      errors.push(`${collection.name}: ${err.message}`);
      _log("error", "pb_collection_create_error", {
        component: "pb-schema",
        collection: collection.name,
        error: err.message,
      });
    }
  }

  _log("info", "pb_schema_provisioned", {
    component: "pb-schema",
    created: created.length,
    skipped: skipped.length,
    errors: errors.length,
  });

  return { created, skipped, errors };
}

module.exports = { PB_COLLECTIONS, ensureCollections };

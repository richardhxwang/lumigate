"use strict";

/**
 * services/memory/user-memory.js — Per-user long-term memory (RAG-based).
 *
 * Stores structured facts extracted from conversations into Qdrant + PocketBase.
 * Recalls relevant memories via vector similarity search before each chat turn.
 *
 * Design principles:
 * - Ingest is fire-and-forget (never blocks chat response)
 * - Recall must be < 100ms (vector search only, no LLM)
 * - Per-user isolation via Qdrant collection prefix
 * - Graceful degradation: if Qdrant/PB is down, skip silently
 */

const crypto = require("crypto");

const COLLECTION_PREFIX = "user_mem_";
const PB_MEMORIES_COLLECTION = "user_memories";
const PB_PROFILES_COLLECTION = "user_profiles";
const MAX_MEMORIES_PER_USER = 10000;
const PROFILE_UPDATE_INTERVAL_MS = 30 * 60 * 1000; // 30 min
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

/** Categories for extracted facts. */
const CATEGORIES = ["preference", "fact", "entity", "event", "relationship"];

/**
 * Fact extraction prompt — sent to a lightweight LLM to extract structured
 * knowledge from a conversation turn.
 */
const EXTRACTION_PROMPT = `Extract structured facts from this conversation turn. Return a JSON array only (no markdown, no explanation).
Each element:
{
  "category": "fact|preference|entity|event|relationship",
  "text": "concise fact statement",
  "entity_type": "pet|person|place|null",
  "entity_id": "identifier or null",
  "importance": 1-5
}

Rules:
- Only extract NEW information. Skip greetings, pleasantries, and generic knowledge.
- Focus on: personal details, preferences, pet info, health data, dates, relationships.
- Keep "text" concise (one sentence max).
- "importance": 5 = critical (pet health emergency, allergy), 1 = trivial.
- If no new facts, return [].`;

class UserMemory {
  /**
   * @param {object} opts
   * @param {import('../knowledge/vector-store').VectorStore} opts.vectorStore
   * @param {import('../knowledge/embedder').Embedder} opts.embedder
   * @param {import('../pb-store').PBStore} opts.pbStore
   * @param {function} opts.llmFetch — async (messages, opts?) => string
   * @param {function} [opts.log]
   */
  constructor({ vectorStore, embedder, pbStore, llmFetch, log } = {}) {
    if (!vectorStore) throw new Error("UserMemory: vectorStore is required");
    if (!embedder) throw new Error("UserMemory: embedder is required");
    if (!pbStore) throw new Error("UserMemory: pbStore is required");
    if (typeof llmFetch !== "function") throw new Error("UserMemory: llmFetch must be a function");

    this.vectorStore = vectorStore;
    this.embedder = embedder;
    this.pbStore = pbStore;
    this.llmFetch = llmFetch;
    this.log = log || (() => {});

    // In-memory caches
    this._profileCache = new Map(); // userId -> { profile, ts }
    this._lastProfileUpdate = new Map(); // userId -> timestamp
    this._ensuredCollections = new Set(); // userId set
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Ingest a conversation turn into user memory.
   * Called AFTER every /v1/chat response completes (fire-and-forget).
   *
   * @param {string} userId
   * @param {object} turn
   * @param {string} turn.userMessage
   * @param {string} turn.assistantMessage
   * @param {string} [turn.provider]
   * @param {string} [turn.model]
   * @param {string} [turn.sessionId]
   * @param {object} [turn.metadata]
   */
  async ingest(userId, { userMessage, assistantMessage, provider, model, sessionId, metadata = {} }) {
    if (!userId || !userMessage) return;

    try {
      // 1. Ensure per-user Qdrant collection exists
      await this._ensureCollection(userId);

      // 2. Extract structured facts via LLM
      const facts = await this._extractFacts(userMessage, assistantMessage);
      if (!facts || facts.length === 0) return;

      // 3. Check memory count limit
      const currentCount = await this._getMemoryCount(userId);
      if (currentCount >= MAX_MEMORIES_PER_USER) {
        this.log("warn", "user_memory_limit", {
          component: "user-memory",
          userId,
          count: currentCount,
          max: MAX_MEMORIES_PER_USER,
        });
        // Prune oldest low-importance memories
        await this._pruneOldMemories(userId, Math.max(50, facts.length));
      }

      // 4. Store each fact
      for (const fact of facts) {
        await this._storeFact(userId, fact, { provider, model, sessionId, metadata });
      }

      // 5. Periodically update profile summary
      if (this._shouldUpdateProfile(userId)) {
        await this._updateProfile(userId);
      }

      this.log("info", "user_memory_ingested", {
        component: "user-memory",
        userId,
        factsExtracted: facts.length,
        sessionId,
      });
    } catch (err) {
      this.log("warn", "user_memory_ingest_failed", {
        component: "user-memory",
        userId,
        error: err.message,
      });
    }
  }

  /**
   * Recall relevant memories for a new query.
   * Called BEFORE sending to AI in /v1/chat.
   *
   * @param {string} userId
   * @param {string} query
   * @param {object} [opts]
   * @param {number} [opts.limit=10]
   * @param {number} [opts.recencyWeight=0.3]
   * @param {number} [opts.scoreThreshold=0.55]
   * @returns {Promise<string>} — formatted context for system prompt injection
   */
  async recall(userId, query, { limit = 10, recencyWeight = 0.3, scoreThreshold = 0.55 } = {}) {
    if (!userId || !query) return "";

    try {
      // 1. Vector search for semantically relevant memories
      const collectionName = this._collectionName(userId);
      const collectionExists = this._ensuredCollections.has(userId);
      if (!collectionExists) {
        // Check if collection exists before searching
        const exists = await this._collectionExists(userId);
        if (!exists) return ""; // No memories yet
      }

      const queryVector = await this.embedder.embedOne(query);
      if (!queryVector) return "";

      const raw = await this.vectorStore.search(collectionName, queryVector, {
        limit: limit * 2,
        scoreThreshold,
      });

      if (!raw || raw.length === 0) return "";

      // 2. Apply recency boost
      const scored = this._applyRecencyBoost(raw, recencyWeight);

      // 3. De-duplicate by text similarity
      const deduped = this._deduplicateMemories(scored);

      // 4. Get user profile summary
      const profile = await this._getProfile(userId);

      // 5. Format for system prompt injection
      return this._formatContext(profile, deduped.slice(0, limit));
    } catch (err) {
      this.log("warn", "user_memory_recall_failed", {
        component: "user-memory",
        userId,
        error: err.message,
      });
      return ""; // Graceful degradation
    }
  }

  /**
   * Search user's memories (for API access).
   * @param {string} userId
   * @param {string} query
   * @param {object} [opts]
   * @param {number} [opts.limit=20]
   * @returns {Promise<Array<{id, category, text, date, score}>>}
   */
  async search(userId, query, { limit = 20 } = {}) {
    if (!userId || !query) return [];

    const exists = await this._collectionExists(userId);
    if (!exists) return [];

    const queryVector = await this.embedder.embedOne(query);
    if (!queryVector) return [];

    const results = await this.vectorStore.search(this._collectionName(userId), queryVector, {
      limit,
      scoreThreshold: 0.4,
    });

    return results.map((r) => ({
      id: r.payload?.pb_id || r.id,
      category: r.payload?.category || "fact",
      text: r.payload?.text || "",
      entity_type: r.payload?.entity_type || null,
      entity_id: r.payload?.entity_id || null,
      date: r.payload?.created_at || "",
      score: r.score,
    }));
  }

  /**
   * Delete a specific memory by PB record ID.
   * @param {string} userId
   * @param {string} memoryId — PB record ID
   * @returns {Promise<boolean>}
   */
  async deleteMemory(userId, memoryId) {
    if (!userId || !memoryId) return false;

    try {
      // Find the PB record to get the embedding_id
      const record = await this.pbStore.findOne(PB_MEMORIES_COLLECTION, `user_id='${userId}' && id='${memoryId}'`);
      if (!record) return false;

      // Delete from Qdrant
      if (record.embedding_id) {
        try {
          await this.vectorStore.delete(this._collectionName(userId), [record.embedding_id]);
        } catch (err) {
          this.log("warn", "user_memory_qdrant_delete_failed", {
            component: "user-memory",
            userId,
            embeddingId: record.embedding_id,
            error: err.message,
          });
        }
      }

      // Delete from PB
      await this.pbStore.delete(PB_MEMORIES_COLLECTION, memoryId);
      return true;
    } catch (err) {
      this.log("warn", "user_memory_delete_failed", {
        component: "user-memory",
        userId,
        memoryId,
        error: err.message,
      });
      return false;
    }
  }

  // ===========================================================================
  // FurNote — Pet Profiles
  // ===========================================================================

  /**
   * Get all pet profiles for a user.
   * @param {string} userId
   * @returns {Promise<object>} — { petId: { name, breed, age, ... }, ... }
   */
  async getPetProfiles(userId) {
    if (!userId) return {};
    const profile = await this._getProfile(userId);
    return profile?.pet_profiles || {};
  }

  /**
   * Get a specific pet profile.
   * @param {string} userId
   * @param {string} petId
   * @returns {Promise<object|null>}
   */
  async getPetProfile(userId, petId) {
    const profiles = await this.getPetProfiles(userId);
    return profiles[petId] || null;
  }

  /**
   * Update a pet profile. Merges with existing data.
   * @param {string} userId
   * @param {string} petId
   * @param {object} data — { name, breed, age, weight, allergies, ... }
   */
  async updatePetProfile(userId, petId, data) {
    if (!userId || !petId || !data) return;

    try {
      // Read current profile
      const profileRecord = await this.pbStore.findOne(PB_PROFILES_COLLECTION, `user_id='${userId}'`);
      const existing = profileRecord?.pet_profiles || {};
      existing[petId] = { ...(existing[petId] || {}), ...data, updated_at: new Date().toISOString() };

      if (profileRecord) {
        await this.pbStore.update(PB_PROFILES_COLLECTION, profileRecord.id, {
          pet_profiles: existing,
          last_updated: new Date().toISOString(),
        });
      } else {
        await this.pbStore.create(PB_PROFILES_COLLECTION, {
          user_id: userId,
          profile: {},
          pet_profiles: existing,
          last_updated: new Date().toISOString(),
        });
      }

      // Invalidate cache
      this._profileCache.delete(userId);

      // Also store as a fact in vector memory for semantic recall
      const factText = `Pet ${data.name || petId}: ${Object.entries(data).filter(([k]) => k !== "updated_at").map(([k, v]) => `${k}=${v}`).join(", ")}`;
      await this._ensureCollection(userId);
      await this._storeFact(userId, {
        category: "entity",
        text: factText,
        entity_type: "pet",
        entity_id: petId,
        importance: 4,
      }, {});

      this.log("info", "pet_profile_updated", {
        component: "user-memory",
        userId,
        petId,
      });
    } catch (err) {
      this.log("warn", "pet_profile_update_failed", {
        component: "user-memory",
        userId,
        petId,
        error: err.message,
      });
    }
  }

  // ===========================================================================
  // Internal Methods
  // ===========================================================================

  /** Per-user Qdrant collection name. */
  _collectionName(userId) {
    return `${COLLECTION_PREFIX}${userId}`;
  }

  /** Check if a user's Qdrant collection exists. */
  async _collectionExists(userId) {
    try {
      const info = await this.vectorStore.getCollectionInfo(this._collectionName(userId));
      if (info) {
        this._ensuredCollections.add(userId);
        return true;
      }
    } catch (err) {
      if (err.status === 404) return false;
      throw err;
    }
    return false;
  }

  /** Ensure per-user Qdrant collection exists (lazy, cached). */
  async _ensureCollection(userId) {
    if (this._ensuredCollections.has(userId)) return;

    const exists = await this._collectionExists(userId);
    if (!exists) {
      await this.vectorStore.createCollection(this._collectionName(userId), {
        dimension: this.embedder.getDimension(),
        distance: "Cosine",
      });
      this.log("info", "user_memory_collection_created", {
        component: "user-memory",
        userId,
        collection: this._collectionName(userId),
      });
    }
    this._ensuredCollections.add(userId);
  }

  /**
   * Extract structured facts from a conversation turn via LLM.
   * @param {string} userMsg
   * @param {string} assistantMsg
   * @returns {Promise<Array<{category, text, entity_type, entity_id, importance}>>}
   */
  async _extractFacts(userMsg, assistantMsg) {
    const conversationText = `User: ${(userMsg || "").slice(0, 2000)}\nAssistant: ${(assistantMsg || "").slice(0, 2000)}`;

    try {
      const response = await this.llmFetch([
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content: conversationText },
      ], { temperature: 0, maxTokens: 1024 });

      // Parse JSON from response — handle markdown fences
      let jsonStr = response.trim();
      const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) jsonStr = fenceMatch[1].trim();

      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) return [];

      // Validate and filter
      return parsed
        .filter((f) => f && typeof f.text === "string" && f.text.trim().length > 0)
        .map((f) => ({
          category: CATEGORIES.includes(f.category) ? f.category : "fact",
          text: f.text.trim().slice(0, 500),
          entity_type: f.entity_type || null,
          entity_id: f.entity_id || null,
          importance: Math.min(5, Math.max(1, Number(f.importance) || 3)),
        }));
    } catch (err) {
      this.log("warn", "user_memory_extract_failed", {
        component: "user-memory",
        error: err.message,
      });
      return [];
    }
  }

  /**
   * Store a single fact as vector embedding + PB record.
   * @param {string} userId
   * @param {object} fact
   * @param {object} context — { provider, model, sessionId, metadata }
   */
  async _storeFact(userId, fact, context) {
    const pointId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Embed the fact text
    const vector = await this.embedder.embedOne(fact.text);
    if (!vector) return;

    // Upsert to Qdrant
    await this.vectorStore.upsert(this._collectionName(userId), [{
      id: pointId,
      vector,
      payload: {
        text: fact.text,
        category: fact.category,
        entity_type: fact.entity_type,
        entity_id: fact.entity_id,
        importance: fact.importance,
        created_at: now,
        source_session: context.sessionId || "",
        user_id: userId,
      },
    }]);

    // Write to PB (fire-and-forget)
    this.pbStore.createAsync(PB_MEMORIES_COLLECTION, {
      user_id: userId,
      category: fact.category,
      text: fact.text,
      source_session: context.sessionId || "",
      entity_type: fact.entity_type,
      entity_id: fact.entity_id,
      metadata: {
        importance: fact.importance,
        provider: context.provider,
        model: context.model,
        ...(context.metadata || {}),
      },
      embedding_id: pointId,
    });
  }

  /**
   * Get total memory count for a user from Qdrant.
   * @param {string} userId
   * @returns {Promise<number>}
   */
  async _getMemoryCount(userId) {
    try {
      const info = await this.vectorStore.getCollectionInfo(this._collectionName(userId));
      return info?.points_count || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Prune oldest low-importance memories to make room.
   * @param {string} userId
   * @param {number} count — how many to remove
   */
  async _pruneOldMemories(userId, count) {
    try {
      // Scroll oldest points, sorted by created_at ascending (Qdrant scrolls in insertion order)
      const { points } = await this.vectorStore.scroll(this._collectionName(userId), { limit: count });
      if (!points || points.length === 0) return;

      // Filter to low-importance memories first
      const lowImportance = points.filter((p) => (p.payload?.importance || 3) <= 2);
      const toDelete = lowImportance.length >= count
        ? lowImportance.slice(0, count)
        : points.slice(0, count);

      const ids = toDelete.map((p) => p.id);
      await this.vectorStore.delete(this._collectionName(userId), ids);

      // Also delete from PB
      for (const p of toDelete) {
        if (p.payload?.pb_id) {
          this.pbStore.delete(PB_MEMORIES_COLLECTION, p.payload.pb_id).catch(() => {});
        }
      }

      this.log("info", "user_memory_pruned", {
        component: "user-memory",
        userId,
        pruned: ids.length,
      });
    } catch (err) {
      this.log("warn", "user_memory_prune_failed", {
        component: "user-memory",
        userId,
        error: err.message,
      });
    }
  }

  /**
   * Apply recency boost: newer memories score higher.
   * score = semantic_score * (1 - weight) + recency_score * weight
   * recency_score = exp(-age_days / 30)  → half-life ~30 days
   *
   * @param {Array<{id, score, payload}>} results
   * @param {number} weight — 0..1
   * @returns {Array<{id, score, payload, category, text, date}>}
   */
  _applyRecencyBoost(results, weight) {
    const now = Date.now();
    return results
      .map((r) => {
        const createdAt = r.payload?.created_at ? new Date(r.payload.created_at).getTime() : now;
        const ageDays = Math.max(0, (now - createdAt) / 86400000);
        const recencyScore = Math.exp(-ageDays / 30);
        const boostedScore = r.score * (1 - weight) + recencyScore * weight;

        // Importance bonus: high-importance facts get a small boost
        const importance = r.payload?.importance || 3;
        const importanceBonus = (importance - 3) * 0.02; // +/- 0.04 max

        return {
          id: r.id,
          score: boostedScore + importanceBonus,
          payload: r.payload,
          category: r.payload?.category || "fact",
          text: r.payload?.text || "",
          date: r.payload?.created_at || "",
          entity_type: r.payload?.entity_type || null,
          entity_id: r.payload?.entity_id || null,
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  /**
   * De-duplicate memories with very similar text (simple Jaccard on words).
   * @param {Array} memories
   * @returns {Array}
   */
  _deduplicateMemories(memories) {
    const seen = [];
    return memories.filter((m) => {
      const words = new Set(m.text.toLowerCase().split(/\s+/));
      for (const s of seen) {
        const intersection = [...words].filter((w) => s.has(w)).length;
        const union = new Set([...words, ...s]).size;
        if (union > 0 && intersection / union > 0.8) return false;
      }
      seen.push(words);
      return true;
    });
  }

  /**
   * Determine if we should update the user profile summary.
   * Rate-limited to once per PROFILE_UPDATE_INTERVAL_MS per user.
   */
  _shouldUpdateProfile(userId) {
    const last = this._lastProfileUpdate.get(userId) || 0;
    return Date.now() - last > PROFILE_UPDATE_INTERVAL_MS;
  }

  /**
   * Summarize user profile from accumulated facts via LLM.
   * Stored in PB `user_profiles` collection.
   */
  async _updateProfile(userId) {
    this._lastProfileUpdate.set(userId, Date.now());

    try {
      // Fetch recent facts from PB
      const result = await this.pbStore.getList(PB_MEMORIES_COLLECTION, {
        filter: `user_id='${userId}'`,
        sort: "-created",
        perPage: 100,
      });

      const facts = (result.items || []).map((r) => `[${r.category}] ${r.text}`).join("\n");
      if (!facts) return;

      const response = await this.llmFetch([
        {
          role: "system",
          content: `Summarize these user facts into a structured JSON profile. Return ONLY valid JSON, no markdown.
Format: { "name": "...", "preferences": [...], "pets": [{"name":"...","breed":"...","age":"...","health_notes":"..."}], "important_dates": [...], "relationships": [...], "notes": [...] }
Only include fields with actual data. Keep it concise.`,
        },
        { role: "user", content: facts },
      ], { temperature: 0, maxTokens: 1024 });

      let profile;
      let jsonStr = response.trim();
      const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) jsonStr = fenceMatch[1].trim();
      profile = JSON.parse(jsonStr);

      // Upsert to PB
      const existing = await this.pbStore.findOne(PB_PROFILES_COLLECTION, `user_id='${userId}'`);
      const profileData = {
        user_id: userId,
        profile,
        last_updated: new Date().toISOString(),
      };

      if (existing) {
        // Preserve pet_profiles from existing record
        profileData.pet_profiles = existing.pet_profiles || {};
        await this.pbStore.update(PB_PROFILES_COLLECTION, existing.id, profileData);
      } else {
        profileData.pet_profiles = {};
        await this.pbStore.create(PB_PROFILES_COLLECTION, profileData);
      }

      // Update cache
      this._profileCache.set(userId, {
        profile: { ...profile, pet_profiles: profileData.pet_profiles },
        ts: Date.now(),
      });

      this.log("info", "user_profile_updated", {
        component: "user-memory",
        userId,
        factCount: result.items?.length || 0,
      });
    } catch (err) {
      this.log("warn", "user_profile_update_failed", {
        component: "user-memory",
        userId,
        error: err.message,
      });
    }
  }

  /**
   * Get user profile (cached with TTL).
   * @param {string} userId
   * @returns {Promise<object|null>}
   */
  async _getProfile(userId) {
    // Check cache
    const cached = this._profileCache.get(userId);
    if (cached && Date.now() - cached.ts < PROFILE_CACHE_TTL_MS) {
      return cached.profile;
    }

    try {
      const record = await this.pbStore.findOne(PB_PROFILES_COLLECTION, `user_id='${userId}'`);
      if (!record) return null;

      const profile = {
        ...(record.profile || {}),
        pet_profiles: record.pet_profiles || {},
      };

      this._profileCache.set(userId, { profile, ts: Date.now() });
      return profile;
    } catch {
      return null;
    }
  }

  /**
   * Format memories + profile for system prompt injection.
   * @param {object|null} profile
   * @param {Array} memories
   * @returns {string}
   */
  _formatContext(profile, memories) {
    const parts = [];

    if (profile && Object.keys(profile).length > 0) {
      parts.push("=== User Profile ===");
      if (profile.name) parts.push(`Name: ${profile.name}`);
      if (profile.preferences?.length) parts.push(`Preferences: ${profile.preferences.join("; ")}`);
      if (profile.pets?.length) {
        for (const pet of profile.pets) {
          const details = Object.entries(pet).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(", ");
          parts.push(`Pet: ${details}`);
        }
      }
      if (profile.pet_profiles && Object.keys(profile.pet_profiles).length > 0) {
        for (const [petId, pet] of Object.entries(profile.pet_profiles)) {
          const details = Object.entries(pet).filter(([k, v]) => v && k !== "updated_at").map(([k, v]) => `${k}: ${v}`).join(", ");
          parts.push(`Pet [${petId}]: ${details}`);
        }
      }
      if (profile.important_dates?.length) parts.push(`Important dates: ${profile.important_dates.join("; ")}`);
      if (profile.relationships?.length) parts.push(`Relationships: ${profile.relationships.join("; ")}`);
      if (profile.notes?.length) parts.push(`Notes: ${profile.notes.join("; ")}`);
    }

    if (memories.length > 0) {
      parts.push("");
      parts.push("=== Relevant Memories ===");
      for (const m of memories) {
        const dateStr = m.date ? ` (${m.date.slice(0, 10)})` : "";
        parts.push(`[${m.category}] ${m.text}${dateStr}`);
      }
    }

    if (parts.length === 0) return "";

    return parts.join("\n") + "\n";
  }

  /**
   * Health check — verify Qdrant connectivity.
   * @returns {Promise<{ok: boolean, collections: number}>}
   */
  async health() {
    try {
      const alive = await this.vectorStore.ping();
      if (!alive) return { ok: false, collections: 0 };

      const allCollections = await this.vectorStore.listCollections();
      const memoryCollections = allCollections.filter((n) => n.startsWith(COLLECTION_PREFIX));
      return { ok: true, collections: memoryCollections.length };
    } catch {
      return { ok: false, collections: 0 };
    }
  }
}

module.exports = {
  UserMemory,
  COLLECTION_PREFIX,
  PB_MEMORIES_COLLECTION,
  PB_PROFILES_COLLECTION,
  MAX_MEMORIES_PER_USER,
};

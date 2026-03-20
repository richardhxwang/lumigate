"use strict";

/**
 * services/knowledge/chunker.js — Document chunking for RAG pipelines.
 *
 * Strategies:
 *  - recursive:    paragraphs -> sentences -> words, respecting chunkSize
 *  - semantic:     split by headings/sections (markdown/HTML)
 *  - fixed:        fixed-size windows with overlap
 *  - parentChild:  large parent chunks split into small child chunks;
 *                  children are embedded, but parent is returned on match
 */

const crypto = require("crypto");

class Chunker {
  /**
   * @param {object} [opts]
   * @param {number} [opts.chunkSize=512]          — target chunk size in characters
   * @param {number} [opts.overlap=64]             — overlap between consecutive chunks
   * @param {'recursive'|'semantic'|'fixed'|'parentChild'} [opts.strategy='recursive']
   * @param {number} [opts.parentChunkSize=1024]   — parent chunk size (parentChild strategy)
   * @param {number} [opts.childChunkSize=256]     — child chunk size (parentChild strategy)
   */
  constructor({ chunkSize = 512, overlap = 64, strategy = "recursive", parentChunkSize = 1024, childChunkSize = 256 } = {}) {
    this.chunkSize = Math.max(64, chunkSize);
    this.overlap = Math.max(0, Math.min(overlap, Math.floor(chunkSize / 2)));
    this.strategy = strategy;
    this.parentChunkSize = Math.max(128, parentChunkSize);
    this.childChunkSize = Math.max(64, childChunkSize);
  }

  /**
   * Split text into chunks with metadata.
   *
   * @param {string} text
   * @param {object} [metadata={}] — extra metadata to attach to every chunk
   * @returns {Array<{text: string, metadata: object}>}
   */
  chunk(text, metadata = {}) {
    if (!text || typeof text !== "string") return [];
    const cleaned = text.replace(/\r\n/g, "\n").trim();
    if (!cleaned) return [];

    // Parent-child strategy returns a different structure
    if (this.strategy === "parentChild") {
      return this._parentChildSplit(cleaned, metadata);
    }

    let rawChunks;
    switch (this.strategy) {
      case "semantic":
        rawChunks = this._semanticSplit(cleaned);
        break;
      case "fixed":
        rawChunks = this._fixedSplit(cleaned);
        break;
      case "recursive":
      default:
        rawChunks = this._recursiveSplit(cleaned);
        break;
    }

    // Attach metadata
    return rawChunks.map((c, i) => ({
      text: c.text,
      metadata: {
        ...metadata,
        chunkIndex: i,
        startChar: c.startChar,
        endChar: c.endChar,
      },
    }));
  }

  // ── Recursive strategy ──────────────────────────────────────────────────────

  /**
   * Split by paragraphs first, then sentences, then words if needed.
   * Merge small segments up to chunkSize.
   */
  _recursiveSplit(text) {
    // Level 1: split by double newlines (paragraphs)
    const paragraphs = this._splitKeepPositions(text, /\n\s*\n/);

    // Merge paragraphs into chunks respecting chunkSize
    const merged = this._mergeSegments(paragraphs);

    // Level 2: if any chunk is still too big, split by sentences
    const refined = [];
    for (const seg of merged) {
      if (seg.text.length <= this.chunkSize) {
        refined.push(seg);
      } else {
        const sentences = this._splitKeepPositions(seg.text, /(?<=[.!?。！？])\s+/);
        const sentenceMerged = this._mergeSegments(sentences);
        // Adjust positions relative to original text
        for (const s of sentenceMerged) {
          refined.push({
            text: s.text,
            startChar: seg.startChar + s.startChar,
            endChar: seg.startChar + s.endChar,
          });
        }
      }
    }

    // Level 3: if still too big, hard split by words
    const final = [];
    for (const seg of refined) {
      if (seg.text.length <= this.chunkSize * 1.5) {
        // Allow slight overshoot to avoid splitting mid-sentence
        final.push(seg);
      } else {
        const hardChunks = this._hardSplit(seg.text);
        for (const h of hardChunks) {
          final.push({
            text: h.text,
            startChar: seg.startChar + h.startChar,
            endChar: seg.startChar + h.endChar,
          });
        }
      }
    }

    return this._addOverlap(final, text);
  }

  // ── Semantic strategy ───────────────────────────────────────────────────────

  /**
   * Split by markdown headings or HTML heading tags, then recursive within sections.
   */
  _semanticSplit(text) {
    // Match markdown headings (# ... ##) or HTML headings (<h1>...<h6>)
    const headingPattern = /^(?:#{1,6}\s+.+|<h[1-6][^>]*>.*?<\/h[1-6]>)/gim;
    const sections = [];
    let lastEnd = 0;

    let match;
    const indices = [];
    while ((match = headingPattern.exec(text)) !== null) {
      indices.push(match.index);
    }

    if (indices.length === 0) {
      // No headings found, fall back to recursive
      return this._recursiveSplit(text);
    }

    for (let i = 0; i < indices.length; i++) {
      // Text before first heading
      if (i === 0 && indices[0] > 0) {
        const pre = text.slice(0, indices[0]).trim();
        if (pre) sections.push({ text: pre, startChar: 0, endChar: indices[0] });
      }

      const start = indices[i];
      const end = i + 1 < indices.length ? indices[i + 1] : text.length;
      const sectionText = text.slice(start, end).trim();
      if (sectionText) {
        sections.push({ text: sectionText, startChar: start, endChar: end });
      }
      lastEnd = end;
    }

    // Recursively chunk sections that are too large
    const result = [];
    for (const section of sections) {
      if (section.text.length <= this.chunkSize) {
        result.push(section);
      } else {
        const sub = this._recursiveSplit(section.text);
        for (const s of sub) {
          result.push({
            text: s.text,
            startChar: section.startChar + s.startChar,
            endChar: section.startChar + s.endChar,
          });
        }
      }
    }

    return this._addOverlap(result, text);
  }

  // ── Fixed strategy ──────────────────────────────────────────────────────────

  /**
   * Fixed-size windows with overlap. Simple and predictable.
   */
  _fixedSplit(text) {
    const chunks = [];
    const step = this.chunkSize - this.overlap;
    for (let i = 0; i < text.length; i += step) {
      const end = Math.min(i + this.chunkSize, text.length);
      const slice = text.slice(i, end).trim();
      if (slice) {
        chunks.push({ text: slice, startChar: i, endChar: end });
      }
      if (end >= text.length) break;
    }
    return chunks;
  }

  // ── Parent-Child strategy ───────────────────────────────────────────────────

  /**
   * Split into large parent chunks, then subdivide into smaller child chunks.
   * Child chunks are what gets embedded and searched.
   * When a child matches, the parent chunk provides more context.
   *
   * Each chunk has metadata: { parentId, childIndex, parentText }
   *
   * @param {string} text
   * @param {object} metadata
   * @returns {Array<{text: string, metadata: object}>}
   */
  _parentChildSplit(text, metadata) {
    // Step 1: Create parent chunks using fixed-size split
    const savedChunkSize = this.chunkSize;
    const savedOverlap = this.overlap;

    this.chunkSize = this.parentChunkSize;
    this.overlap = Math.floor(this.parentChunkSize * 0.1); // 10% overlap for parents
    const parentChunks = this._fixedSplit(text);
    this.chunkSize = savedChunkSize;
    this.overlap = savedOverlap;

    // Step 2: For each parent, create child chunks
    const allChildren = [];
    let globalChildIndex = 0;

    for (let pi = 0; pi < parentChunks.length; pi++) {
      const parent = parentChunks[pi];
      const parentId = crypto.createHash("md5").update(`parent:${pi}:${parent.startChar}`).digest("hex").slice(0, 16);

      // Split parent text into children
      const childStep = this.childChunkSize - Math.floor(this.childChunkSize * 0.15);
      for (let ci = 0, offset = 0; offset < parent.text.length; ci++, offset += childStep) {
        const end = Math.min(offset + this.childChunkSize, parent.text.length);
        const childText = parent.text.slice(offset, end).trim();
        if (!childText) continue;

        allChildren.push({
          text: childText,
          metadata: {
            ...metadata,
            chunkIndex: globalChildIndex,
            startChar: parent.startChar + offset,
            endChar: parent.startChar + end,
            parentId,
            parentIndex: pi,
            childIndex: ci,
            parentText: parent.text,
            parentStartChar: parent.startChar,
            parentEndChar: parent.endChar,
            isChildChunk: true,
          },
        });

        globalChildIndex++;
        if (end >= parent.text.length) break;
      }
    }

    return allChildren;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Split text by a regex, keeping track of char positions.
   * @returns {Array<{text: string, startChar: number, endChar: number}>}
   */
  _splitKeepPositions(text, separator) {
    const parts = [];
    let lastIndex = 0;
    const segments = text.split(separator);

    for (const seg of segments) {
      const idx = text.indexOf(seg, lastIndex);
      const start = idx >= 0 ? idx : lastIndex;
      const trimmed = seg.trim();
      if (trimmed) {
        parts.push({ text: trimmed, startChar: start, endChar: start + seg.length });
      }
      lastIndex = start + seg.length;
    }
    return parts;
  }

  /**
   * Merge small segments into chunks up to chunkSize.
   */
  _mergeSegments(segments) {
    if (segments.length === 0) return [];
    const merged = [];
    let current = { text: "", startChar: 0, endChar: 0 };

    for (const seg of segments) {
      if (!current.text) {
        current = { ...seg };
      } else if (current.text.length + seg.text.length + 1 <= this.chunkSize) {
        current.text += "\n\n" + seg.text;
        current.endChar = seg.endChar;
      } else {
        merged.push(current);
        current = { ...seg };
      }
    }
    if (current.text) merged.push(current);
    return merged;
  }

  /**
   * Hard split by word boundaries when all else fails.
   */
  _hardSplit(text) {
    const words = text.split(/\s+/);
    const chunks = [];
    let buf = "";
    let startChar = 0;

    for (const word of words) {
      if (buf.length + word.length + 1 > this.chunkSize && buf) {
        chunks.push({ text: buf, startChar, endChar: startChar + buf.length });
        // Step back by overlap amount for the next chunk
        const overlapText = buf.slice(Math.max(0, buf.length - this.overlap));
        buf = overlapText + " " + word;
        startChar = startChar + buf.length - overlapText.length - word.length - 1;
      } else {
        buf = buf ? buf + " " + word : word;
      }
    }
    if (buf) {
      chunks.push({ text: buf, startChar, endChar: startChar + buf.length });
    }
    return chunks;
  }

  /**
   * Add overlap context to chunks from the recursive/semantic strategies.
   * For fixed strategy, overlap is handled inline.
   */
  _addOverlap(chunks, fullText) {
    if (this.overlap === 0 || chunks.length <= 1) return chunks;

    return chunks.map((chunk, i) => {
      if (i === 0) return chunk;
      // Prepend overlap from end of previous chunk
      const prev = chunks[i - 1];
      const overlapText = prev.text.slice(Math.max(0, prev.text.length - this.overlap));
      if (overlapText && !chunk.text.startsWith(overlapText)) {
        return {
          text: overlapText + " " + chunk.text,
          startChar: chunk.startChar - overlapText.length,
          endChar: chunk.endChar,
        };
      }
      return chunk;
    });
  }
}

module.exports = { Chunker };

"use strict";

/**
 * command-guard.js — Detect destructive or dangerous shell commands in text content.
 *
 * Ported from OpenclawS security-core/src/command-guard.ts for LumiGate context.
 * Instead of intercepting shell tool calls, this scans AI message text (user input
 * and AI responses) for dangerous command patterns.
 */

// ---------------------------------------------------------------------------
// Built-in block rules
// ---------------------------------------------------------------------------

const BUILTIN_RULES = [
  {
    name: "rm -rf targeting absolute path or home",
    test: (cmd) => {
      // Normalise: strip leading env/command/backslash prefixes that can bypass detection
      const stripped = cmd
        .replace(/\b(?:env|command|builtin)\s+/g, "")
        .replace(/\\(rm)\b/g, "$1");

      // Detect "cd / && rm" or "cd ~ && rm" chaining patterns
      if (/\bcd\s+[/~]\s*[;&|]+\s*rm\b/.test(stripped)) return true;

      // Match rm with recursive+force flags in any order (-rf, -r -f, -fr, -Rf, etc.)
      const rmRf =
        /\brm\s+(?:-\w*[rR]\w*f\w*|-\w*f\w*[rR]\w*|(?:-\w*[rR]\w*\s+-\w*f\w*)|(?:-\w*f\w*\s+-\w*[rR]\w*))\s+/;
      if (!rmRf.test(stripped)) return false;

      // Block if any target is an absolute path starting with /
      return /\s+(?:\/\S*|~\/?[^\s]*)/.test(stripped);
    },
  },
  {
    name: "xargs rm with recursive+force flags targeting absolute paths",
    test: (cmd) =>
      /\bxargs\s+.*\brm\s+(?:-\w*[rR]\w*f\w*|-\w*f\w*[rR]\w*|(?:-\w*[rR]\w*\s+-\w*f\w*)|(?:-\w*f\w*\s+-\w*[rR]\w*))/.test(
        cmd,
      ),
  },
  {
    name: "pipe to shell interpreter",
    test: (cmd) => /\|\s*(?:bash|sh|zsh|eval)\b/.test(cmd),
  },
  {
    name: "disk formatting tool",
    test: (cmd) => /\b(?:mkfs|mkfs\.\w+)\b/.test(cmd),
  },
  {
    name: "dd raw disk write",
    test: (cmd) => /\bdd\s+.*\bif=/.test(cmd),
  },
  {
    name: "fdisk",
    test: (cmd) => /\bfdisk\b/.test(cmd),
  },
  {
    name: "diskutil eraseDisk",
    test: (cmd) => /\bdiskutil\s+eraseDisk\b/.test(cmd),
  },
  {
    name: "system shutdown/reboot/halt",
    test: (cmd) => /\b(?:shutdown|reboot|halt)\b/.test(cmd),
  },
  {
    name: "init runlevel 0 or 6",
    test: (cmd) => /\binit\s+[06]\b/.test(cmd),
  },
  {
    name: "chmod 777 on root",
    test: (cmd) => /\bchmod\s+(?:-R\s+)?777\s+\//.test(cmd),
  },
  {
    name: "kill init process",
    test: (cmd) => /\bkill\s+-9\s+1\b/.test(cmd),
  },
  {
    name: "fork bomb",
    test: (cmd) => /:\(\)\s*\{[^}]*\|[^}]*&\s*\}\s*;?\s*:/.test(cmd),
  },
  {
    name: "sensitive file access (.ssh)",
    test: (cmd) => /\/\.ssh\//.test(cmd),
  },
  {
    name: "sensitive file access (.gnupg)",
    test: (cmd) => /\/\.gnupg\//.test(cmd),
  },
  {
    name: "sensitive file access (/etc/shadow)",
    test: (cmd) => /\/etc\/shadow/.test(cmd),
  },
  {
    name: "sensitive file access (/etc/passwd)",
    test: (cmd) => /\/etc\/passwd/.test(cmd),
  },
  {
    name: "environment variable exfiltration",
    test: (cmd) =>
      /\b(?:env|printenv|set)\b.*\|/.test(cmd) &&
      /\b(?:curl|wget|nc|ncat)\b/.test(cmd),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s, max) {
  return s.length <= max ? s : s.slice(0, max) + "...";
}

/**
 * Extract code-fenced or backtick-wrapped command snippets from text,
 * plus the raw text itself, so we catch commands both inline and in prose.
 */
function extractCommandSegments(text) {
  const segments = [text];
  // Also extract fenced code blocks (``` ... ```)
  const fenced = text.match(/```[\s\S]*?```/g);
  if (fenced) {
    for (const block of fenced) {
      segments.push(block.replace(/```\w*/g, "").trim());
    }
  }
  // Inline backticks
  const inlined = text.match(/`([^`]+)`/g);
  if (inlined) {
    for (const snippet of inlined) {
      segments.push(snippet.replace(/`/g, ""));
    }
  }
  return segments;
}

// ---------------------------------------------------------------------------
// checkCommand — simple function for use in proxy pipeline
// ---------------------------------------------------------------------------

/**
 * Scan text content for dangerous shell commands.
 *
 * @param {string} text — the text to scan (user message, AI response, etc.)
 * @returns {{ blocked: boolean, rule?: string, command?: string }}
 */
function checkCommand(text) {
  if (!text || typeof text !== "string") return { blocked: false };

  const segments = extractCommandSegments(text);

  for (const segment of segments) {
    for (const rule of BUILTIN_RULES) {
      if (rule.test(segment)) {
        return {
          blocked: true,
          rule: rule.name,
          command: truncate(segment, 120),
        };
      }
    }
  }

  return { blocked: false };
}

// ---------------------------------------------------------------------------
// createCommandGuard — middleware-compatible factory
// ---------------------------------------------------------------------------

/**
 * Create a command guard handler for use as middleware in the LumiGate proxy.
 *
 * @param {{ enabled: boolean, customBlockPatterns: string[], customAllowPatterns: string[] }} config
 * @returns {function(string): { blocked: boolean, rule?: string, command?: string }}
 */
function createCommandGuard(config) {
  const customBlock = (config.customBlockPatterns || []).map(
    (p) => new RegExp(p),
  );
  const customAllow = (config.customAllowPatterns || []).map(
    (p) => new RegExp(p),
  );

  /**
   * Scan text for dangerous commands, respecting custom allow/block patterns.
   *
   * @param {string} text — text content to check
   * @returns {{ blocked: boolean, rule?: string, command?: string }}
   */
  return function guard(text) {
    if (!config.enabled) return { blocked: false };
    if (!text || typeof text !== "string") return { blocked: false };

    const segments = extractCommandSegments(text);

    for (const segment of segments) {
      // Custom allow patterns override everything — if matched, skip this segment
      let allowed = false;
      for (const allow of customAllow) {
        if (allow.test(segment)) {
          allowed = true;
          break;
        }
      }
      if (allowed) continue;

      // Built-in rules
      for (const rule of BUILTIN_RULES) {
        if (rule.test(segment)) {
          return {
            blocked: true,
            rule: rule.name,
            command: truncate(segment, 120),
          };
        }
      }

      // Custom block patterns
      for (const pat of customBlock) {
        if (pat.test(segment)) {
          return {
            blocked: true,
            rule: `custom pattern: ${pat.source}`,
            command: truncate(segment, 120),
          };
        }
      }
    }

    return { blocked: false };
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { createCommandGuard, checkCommand };

"use strict";

/**
 * presidio-layer.js — Pure regex-based PII / secret detection.
 *
 * Inspired by Microsoft Presidio but zero-dependency; runs in any JS runtime.
 */

// ---------------------------------------------------------------------------
// Luhn check (credit-card validation)
// ---------------------------------------------------------------------------

function luhnCheck(digits) {
  const nums = digits.replace(/\D/g, "");
  if (nums.length < 13 || nums.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let i = nums.length - 1; i >= 0; i--) {
    let n = parseInt(nums[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

const PATTERNS = [
  // Credit cards (space / dash separated groups)
  {
    type: "credit_card",
    regex: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{1,7}\b/g,
    score: 0.85,
    validate: (m) => luhnCheck(m),
  },

  // OpenAI-style keys (use lookaround instead of \b for CJK compatibility)
  // Allows hyphens for sk-proj-... format
  {
    type: "api_key_openai",
    regex: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9][A-Za-z0-9\-]{19,}(?![A-Za-z0-9_-])/g,
    score: 0.95,
  },

  // GitHub personal access tokens (classic & fine-grained)
  {
    type: "api_key_github",
    regex: /\bghp_[A-Za-z0-9]{36,}\b/g,
    score: 0.95,
  },
  {
    type: "api_key_github_oauth",
    regex: /\bgho_[A-Za-z0-9]{36,}\b/g,
    score: 0.9,
  },

  // GitLab
  {
    type: "api_key_gitlab",
    regex: /\bglpat-[A-Za-z0-9\-_]{20,}\b/g,
    score: 0.95,
  },

  // Slack tokens
  {
    type: "api_key_slack",
    regex: /\bxox[bp]-[A-Za-z0-9\-]{24,}\b/g,
    score: 0.95,
  },

  // AWS access key ID
  {
    type: "aws_access_key",
    regex: /\bAKIA[A-Z0-9]{16}\b/g,
    score: 0.95,
  },

  // AWS secret key (40-char base64 near "aws" context — simplified)
  {
    type: "aws_secret_key",
    regex: /(?:aws.{0,20})?['\"]([A-Za-z0-9/+=]{40})['\"]|(?:SECRET|secret).{0,10}['\"]([A-Za-z0-9/+=]{40})['\"/]/g,
    score: 0.7,
  },

  // Bearer tokens in text (e.g. "Authorization: Bearer ey…")
  {
    type: "bearer_token",
    regex: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
    score: 0.85,
  },

  // Private key headers
  {
    type: "private_key",
    regex: /-----BEGIN\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    score: 0.99,
  },

  // Connection strings
  {
    type: "connection_string",
    regex: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp|mssql):\/\/[^\s'"]+/g,
    score: 0.9,
  },

  // Generic hex/base64 secrets near sensitive keywords (long values, high confidence)
  // (Chinese keywords included: 密码 密钥 令牌 口令)
  {
    type: "generic_secret",
    regex:
      /(?:password|passwd|token|secret|key|api.?key|密码|密钥|令牌|口令)\s*[:=]\s*['\"]?([A-Za-z0-9/+=\-_.]{16,})['\"]?/gi,
    score: 0.7,
  },

  // Short passwords/secrets near Chinese context verbs (是/为/改成/设为/设成)
  // e.g. "我的密码是 123456", "口令改成 abc123"
  {
    type: "password_cn",
    regex:
      /(?:密码|密钥|令牌|口令|password|passwd|token|secret)\s*(?:是|为|改成|设为|设成|[:=])\s*['\"]?(\S{4,})['\"]?/gi,
    score: 0.8,
  },

  // Anthropic API keys
  {
    type: "api_key_anthropic",
    regex: /\bsk-ant-[A-Za-z0-9\-]{20,}\b/g,
    score: 0.95,
  },

  // Google API keys
  {
    type: "api_key_google",
    regex: /\bAIza[A-Za-z0-9\-_]{35}\b/g,
    score: 0.9,
  },

  // Stripe keys
  {
    type: "api_key_stripe",
    regex: /\b[sr]k_(test|live)_[A-Za-z0-9]{20,}\b/g,
    score: 0.95,
  },

  // Twilio
  {
    type: "api_key_twilio",
    regex: /\bSK[a-f0-9]{32}\b/g,
    score: 0.8,
  },

  // npm tokens
  {
    type: "api_key_npm",
    regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
    score: 0.95,
  },

  // PyPI tokens
  {
    type: "api_key_pypi",
    regex: /\bpypi-[A-Za-z0-9\-_]{50,}\b/g,
    score: 0.95,
  },

  // High-entropy hex strings (32+ hex chars) near sensitive keywords
  {
    type: "high_entropy_hex",
    regex:
      /(?:key|token|secret|credential|密钥|令牌).{0,30}(?<![A-Za-z0-9])([a-f0-9]{32,})(?![A-Za-z0-9])/gi,
    score: 0.65,
    validate: (m) => {
      // Extract the hex portion (the capture group content is in the full match)
      const hexMatch = m.match(/[a-f0-9]{32,}/i);
      if (!hexMatch) return false;
      return shannonEntropy(hexMatch[0]) > 3.0;
    },
  },
];

// ---------------------------------------------------------------------------
// Shannon entropy
// ---------------------------------------------------------------------------

function shannonEntropy(s) {
  const freq = new Map();
  for (const c of s) {
    freq.set(c, (freq.get(c) ?? 0) + 1);
  }
  let entropy = 0;
  const len = s.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ---------------------------------------------------------------------------
// High-entropy string near sensitive context
// ---------------------------------------------------------------------------

const SENSITIVE_CONTEXT_RE =
  /(?:password|passwd|token|secret|key|api.?key|credential|密码|密钥|令牌|口令)\s*[:=]\s*/gi;

function detectHighEntropyNearContext(text) {
  const results = [];
  let m;
  const re = new RegExp(SENSITIVE_CONTEXT_RE.source, "gi");
  while ((m = re.exec(text)) !== null) {
    const afterIdx = m.index + m[0].length;
    const rest = text.slice(afterIdx, afterIdx + 120);
    // Grab the token right after the assignment
    const tok = rest.match(/^['\"]?([^\s'"]{12,})/);
    if (tok) {
      const candidate = tok[1];
      const ent = shannonEntropy(candidate);
      if (ent > 3.5) {
        // Already covered by PATTERNS generic_secret? Deduplicate later.
        results.push({
          type: "high_entropy_secret",
          value: candidate,
          start: afterIdx + (tok.index ?? 0),
          end: afterIdx + (tok.index ?? 0) + candidate.length,
          score: Math.min(0.5 + ent / 10, 0.95),
        });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function detectPII(text) {
  const entities = [];
  const seen = new Set(); // dedup by "type:start:end"

  for (const pat of PATTERNS) {
    const re = new RegExp(pat.regex.source, pat.regex.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = m[0];
      if (pat.validate && !pat.validate(value)) continue;
      const key = `${pat.type}:${m.index}:${m.index + value.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entities.push({
        type: pat.type,
        value,
        start: m.index,
        end: m.index + value.length,
        score: pat.score,
      });
    }
  }

  // High-entropy near context
  for (const ent of detectHighEntropyNearContext(text)) {
    const key = `${ent.type}:${ent.start}:${ent.end}`;
    if (!seen.has(key)) {
      seen.add(key);
      entities.push(ent);
    }
  }

  // Filter out matches whose extracted value is an env var reference, not a real secret
  const ENV_VAR_RE = /(?:process\.env\.\w|os\.environ|ENV\[)/;
  const filtered = entities.filter((e) => !ENV_VAR_RE.test(e.value));

  // Sort by position
  filtered.sort((a, b) => a.start - b.start);

  return { found: filtered.length > 0, entities: filtered };
}

module.exports = { detectPII };

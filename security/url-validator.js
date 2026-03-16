"use strict";
const { URL } = require("url");
const dns = require("dns");
const { promisify } = require("util");
const dnsLookup = promisify(dns.lookup);

const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGN
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.gke.internal",
]);

async function validateExternalUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, error: "Only http/https URLs allowed" };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block known internal hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { ok: false, error: "Access to internal hosts is not allowed" };
  }

  // Block Docker internal hostnames
  if (hostname.startsWith("lumigate-") || hostname === "host.docker.internal") {
    return { ok: false, error: "Access to internal services is not allowed" };
  }

  // Resolve DNS and check IP
  try {
    const { address } = await dnsLookup(hostname);
    for (const range of PRIVATE_RANGES) {
      if (range.test(address)) {
        return { ok: false, error: "Access to private IP ranges is not allowed" };
      }
    }
    // IPv6 loopback
    if (address === "::1" || address.startsWith("fd") || address.startsWith("fe80")) {
      return { ok: false, error: "Access to private IP ranges is not allowed" };
    }
  } catch {
    return { ok: false, error: "DNS resolution failed" };
  }

  return { ok: true };
}

module.exports = { validateExternalUrl };

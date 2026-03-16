"use strict";
const crypto = require("node:crypto");

class SecretMapping {
  #map = new Map();        // placeholder → real
  #reverseMap = new Map(); // real → placeholder

  add(realValue, label) {
    const existing = this.#reverseMap.get(realValue);
    if (existing) return existing;
    const id = crypto.randomBytes(4).toString("hex");
    const placeholder = `[SEC_${id}]`;
    this.#map.set(placeholder, realValue);
    this.#reverseMap.set(realValue, placeholder);
    return placeholder;
  }

  resolve(text) {
    let result = text;
    for (const [placeholder, real] of this.#map) {
      result = replaceAll(result, placeholder, real);
    }
    return result;
  }

  mask(text) {
    let result = text;
    const sorted = [...this.#reverseMap.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [real, placeholder] of sorted) {
      result = replaceAll(result, real, placeholder);
    }
    return result;
  }

  hasSecrets() { return this.#map.size > 0; }

  clear() {
    this.#map.clear();
    this.#reverseMap.clear();
  }

  entries() { return this.#map.entries(); }
}

function replaceAll(text, search, replacement) {
  if (!search) return text;
  let result = text;
  let idx = result.indexOf(search);
  while (idx !== -1) {
    result = result.slice(0, idx) + replacement + result.slice(idx + search.length);
    idx = result.indexOf(search, idx + replacement.length);
  }
  return result;
}

function deepTransform(obj, fn) {
  if (typeof obj === "string") return fn(obj);
  if (Array.isArray(obj)) return obj.map(v => deepTransform(v, fn));
  if (obj !== null && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = deepTransform(v, fn);
    }
    return out;
  }
  return obj;
}

module.exports = { SecretMapping, deepTransform, replaceAll };

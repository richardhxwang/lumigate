'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid() {
  return crypto.randomBytes(12).toString('hex');
}

function now() {
  return new Date().toISOString();
}

function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_ENTITY_TYPES = ['agent', 'workflow', 'prompt', 'plugin'];
const VALID_CHANNELS = ['draft', 'canary', 'stable'];

function validateEntityType(entityType) {
  if (!VALID_ENTITY_TYPES.includes(entityType)) {
    throw Object.assign(
      new Error(`Invalid entityType. Allowed: ${VALID_ENTITY_TYPES.join(', ')}`),
      { status: 400 },
    );
  }
}

// ---------------------------------------------------------------------------
// Semver helpers
// ---------------------------------------------------------------------------

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function bumpPatch(v) {
  const s = parseSemver(v);
  if (!s) return '0.0.1';
  return `${s.major}.${s.minor}.${s.patch + 1}`;
}

// ---------------------------------------------------------------------------
// VersionManager
// ---------------------------------------------------------------------------

class VersionManager {
  /**
   * @param {object} opts
   * @param {string} [opts.dataDir='data/versions']
   * @param {Function} [opts.log]
   */
  constructor({ dataDir = 'data/versions', pbStore, log } = {}) {
    this.dataDir = dataDir;
    this._pbStore = pbStore || null;
    this.log = log || console.log;

    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  }

  // ---- Internal paths -----------------------------------------------------

  _entityDir(entityType, entityId) {
    return path.join(this.dataDir, entityType, entityId);
  }

  _indexFile(entityType, entityId) {
    return path.join(this._entityDir(entityType, entityId), '_index.json');
  }

  _versionFile(entityType, entityId, versionId) {
    return path.join(this._entityDir(entityType, entityId), `${versionId}.json`);
  }

  _readIndex(entityType, entityId) {
    return readJSON(this._indexFile(entityType, entityId), {
      versions: [],
      published: {}, // channel -> versionId
      latestVersion: '0.0.0',
    });
  }

  _saveIndex(entityType, entityId, index) {
    atomicWrite(this._indexFile(entityType, entityId), index);
  }

  // ---- Create version -----------------------------------------------------

  async createVersion(entityType, entityId, { data, message, author }) {
    validateEntityType(entityType);

    if (!entityId || typeof entityId !== 'string') {
      throw Object.assign(new Error('entityId is required'), { status: 400 });
    }
    if (data === undefined || data === null) {
      throw Object.assign(new Error('data is required'), { status: 400 });
    }

    const index = this._readIndex(entityType, entityId);
    const nextVersion = bumpPatch(index.latestVersion);
    const versionId = uid();

    const versionRecord = {
      versionId,
      version: nextVersion,
      entityType,
      entityId,
      data,
      message: message || '',
      author: author || 'system',
      createdAt: now(),
    };

    // Save version file
    atomicWrite(this._versionFile(entityType, entityId, versionId), versionRecord);

    // Update index
    index.versions.push({
      versionId,
      version: nextVersion,
      message: versionRecord.message,
      author: versionRecord.author,
      createdAt: versionRecord.createdAt,
    });
    index.latestVersion = nextVersion;
    this._saveIndex(entityType, entityId, index);

    // Sync to PocketBase (async, non-blocking)
    if (this._pbStore) {
      this._pbStore.createAsync('entity_versions', {
        entity_type: entityType,
        entity_id: entityId,
        version: nextVersion,
        data: data,
        message: versionRecord.message,
        author: versionRecord.author,
        channel: '',
      });
    }

    this.log(`[versions] ${entityType}/${entityId} v${nextVersion} created by ${versionRecord.author}`);
    return { versionId, version: nextVersion, createdAt: versionRecord.createdAt };
  }

  // ---- List versions ------------------------------------------------------

  async listVersions(entityType, entityId) {
    validateEntityType(entityType);

    const index = this._readIndex(entityType, entityId);
    return {
      entityType,
      entityId,
      latestVersion: index.latestVersion,
      published: index.published,
      versions: index.versions.slice().reverse(), // newest first
    };
  }

  // ---- Get specific version -----------------------------------------------

  async getVersion(entityType, entityId, versionId) {
    validateEntityType(entityType);

    const filePath = this._versionFile(entityType, entityId, versionId);
    const record = readJSON(filePath, null);
    if (!record) {
      throw Object.assign(new Error('Version not found'), { status: 404 });
    }
    return record;
  }

  // ---- Rollback -----------------------------------------------------------

  /**
   * Rollback creates a NEW version with the data from the target version.
   * This preserves history — no versions are deleted.
   */
  async rollback(entityType, entityId, versionId) {
    const target = await this.getVersion(entityType, entityId, versionId);

    const result = await this.createVersion(entityType, entityId, {
      data: target.data,
      message: `Rollback to v${target.version} (${versionId})`,
      author: 'system:rollback',
    });

    this.log(`[versions] ${entityType}/${entityId} rolled back to ${versionId} → new v${result.version}`);
    return result;
  }

  // ---- Diff ---------------------------------------------------------------

  /**
   * Simple structural diff between two versions.
   * Returns added/removed/changed keys at the top level of data.
   */
  async diff(entityType, entityId, versionA, versionB) {
    const a = await this.getVersion(entityType, entityId, versionA);
    const b = await this.getVersion(entityType, entityId, versionB);

    const dataA = typeof a.data === 'object' && a.data !== null ? a.data : { _value: a.data };
    const dataB = typeof b.data === 'object' && b.data !== null ? b.data : { _value: b.data };

    const allKeys = new Set([...Object.keys(dataA), ...Object.keys(dataB)]);
    const changes = [];

    for (const key of allKeys) {
      const inA = key in dataA;
      const inB = key in dataB;
      const jsonA = inA ? JSON.stringify(dataA[key]) : undefined;
      const jsonB = inB ? JSON.stringify(dataB[key]) : undefined;

      if (!inA && inB) {
        changes.push({ key, type: 'added', newValue: dataB[key] });
      } else if (inA && !inB) {
        changes.push({ key, type: 'removed', oldValue: dataA[key] });
      } else if (jsonA !== jsonB) {
        changes.push({ key, type: 'changed', oldValue: dataA[key], newValue: dataB[key] });
      }
    }

    return {
      versionA: { id: versionA, version: a.version },
      versionB: { id: versionB, version: b.version },
      changes,
      identical: changes.length === 0,
    };
  }

  // ---- Publish / Promote --------------------------------------------------

  async publish(entityType, entityId, versionId, { channel = 'stable' } = {}) {
    validateEntityType(entityType);

    if (!VALID_CHANNELS.includes(channel)) {
      throw Object.assign(
        new Error(`Invalid channel. Allowed: ${VALID_CHANNELS.join(', ')}`),
        { status: 400 },
      );
    }

    // Verify version exists
    const version = await this.getVersion(entityType, entityId, versionId);

    const index = this._readIndex(entityType, entityId);
    index.published[channel] = {
      versionId,
      version: version.version,
      publishedAt: now(),
    };
    this._saveIndex(entityType, entityId, index);

    // Update channel on PB version record (async, non-blocking)
    if (this._pbStore) {
      this._pbStore.findOne('entity_versions', `entity_type='${entityType}' && entity_id='${entityId}' && version='${version.version}'`).then((rec) => {
        if (rec) {
          this._pbStore.updateAsync('entity_versions', rec.id, { channel });
        }
      }).catch(e => this.log(`[versions] pb_write_failed action=publish collection=entity_versions entity=${entityType}/${entityId} error=${e.message}`));
    }

    this.log(`[versions] ${entityType}/${entityId} v${version.version} published to ${channel}`);
    return { versionId, version: version.version, channel, publishedAt: now() };
  }

  async getPublished(entityType, entityId, channel = 'stable') {
    validateEntityType(entityType);

    if (!VALID_CHANNELS.includes(channel)) {
      throw Object.assign(
        new Error(`Invalid channel. Allowed: ${VALID_CHANNELS.join(', ')}`),
        { status: 400 },
      );
    }

    const index = this._readIndex(entityType, entityId);
    const pub = index.published[channel];

    if (!pub) {
      throw Object.assign(
        new Error(`No published version for channel "${channel}"`),
        { status: 404 },
      );
    }

    // Return the full version data
    return this.getVersion(entityType, entityId, pub.versionId);
  }
}

module.exports = { VersionManager, VALID_ENTITY_TYPES, VALID_CHANNELS };

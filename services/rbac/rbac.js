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

/** Atomic JSON write: tmp + rename (project convention). */
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
// Permission matrix
// ---------------------------------------------------------------------------

const ROLES = ['owner', 'admin', 'member', 'viewer'];

const ROLE_RANK = { owner: 0, admin: 1, member: 2, viewer: 3 };

/**
 * PERMISSIONS[role] = { resource: Set<action> }
 * Missing entry => denied.
 */
const PERMISSIONS = {
  owner: {
    project:        new Set(['create', 'read', 'update', 'delete', 'execute']),
    knowledge_base: new Set(['create', 'read', 'update', 'delete', 'execute']),
    workflow:       new Set(['create', 'read', 'update', 'delete', 'execute']),
    agent:          new Set(['create', 'read', 'update', 'delete', 'execute']),
    team:           new Set(['create', 'read', 'update', 'delete']),
  },
  admin: {
    project:        new Set(['create', 'read', 'update', 'delete', 'execute']),
    knowledge_base: new Set(['create', 'read', 'update', 'delete', 'execute']),
    workflow:       new Set(['create', 'read', 'update', 'delete', 'execute']),
    agent:          new Set(['create', 'read', 'update', 'delete', 'execute']),
    team:           new Set(['create', 'read', 'update', 'delete']),
  },
  member: {
    project:        new Set(['read', 'execute']),
    knowledge_base: new Set(['read', 'execute']),
    workflow:       new Set(['read', 'execute']),
    agent:          new Set(['create', 'read', 'update', 'delete', 'execute']),
    team:           new Set(['read']),
  },
  viewer: {
    project:        new Set(['read']),
    knowledge_base: new Set(['read']),
    workflow:       new Set(['read']),
    agent:          new Set(['read']),
    team:           new Set(['read']),
  },
};

// ---------------------------------------------------------------------------
// RBAC class
// ---------------------------------------------------------------------------

class RBAC {
  /**
   * @param {object} opts
   * @param {string} [opts.dataDir='data/rbac']
   * @param {Function} [opts.log] — structured logger; defaults to console.log
   */
  constructor({ dataDir = 'data/rbac', log } = {}) {
    this.dataDir = dataDir;
    this.log = log || console.log;
    this.orgsFile = path.join(dataDir, 'orgs.json');
    this.teamsFile = path.join(dataDir, 'teams.json');

    // Ensure data dir exists
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    // Load in-memory caches
    this._orgs = readJSON(this.orgsFile, []);
    this._teams = readJSON(this.teamsFile, []);
  }

  // ---- persistence --------------------------------------------------------

  _saveOrgs() {
    atomicWrite(this.orgsFile, this._orgs);
  }

  _saveTeams() {
    atomicWrite(this.teamsFile, this._teams);
  }

  // ---- Organisation management --------------------------------------------

  async createOrg({ name, ownerId }) {
    if (!name || typeof name !== 'string') throw Object.assign(new Error('name is required'), { status: 400 });
    if (!ownerId || typeof ownerId !== 'string') throw Object.assign(new Error('ownerId is required'), { status: 400 });

    const org = {
      id: uid(),
      name: name.trim(),
      ownerId,
      createdAt: now(),
      updatedAt: now(),
    };

    this._orgs.push(org);

    // Create a default team with the owner
    const defaultTeam = {
      id: uid(),
      orgId: org.id,
      name: 'Default',
      members: [{ userId: ownerId, role: 'owner', joinedAt: now() }],
      createdAt: now(),
      updatedAt: now(),
    };
    this._teams.push(defaultTeam);

    this._saveOrgs();
    this._saveTeams();

    this.log(`[rbac] org created: ${org.id} (${org.name}) by ${ownerId}`);
    return org;
  }

  async getOrg(orgId) {
    const org = this._orgs.find(o => o.id === orgId);
    if (!org) throw Object.assign(new Error('Organization not found'), { status: 404 });
    return org;
  }

  async listOrgs(userId) {
    // Return orgs where userId appears in any team
    const orgIds = new Set();
    for (const team of this._teams) {
      if (team.members.some(m => m.userId === userId)) {
        orgIds.add(team.orgId);
      }
    }
    return this._orgs.filter(o => orgIds.has(o.id));
  }

  // ---- Team management ----------------------------------------------------

  async createTeam(orgId, { name }) {
    if (!name || typeof name !== 'string') throw Object.assign(new Error('name is required'), { status: 400 });

    // Verify org exists
    await this.getOrg(orgId);

    const team = {
      id: uid(),
      orgId,
      name: name.trim(),
      members: [],
      createdAt: now(),
      updatedAt: now(),
    };

    this._teams.push(team);
    this._saveTeams();

    this.log(`[rbac] team created: ${team.id} (${team.name}) in org ${orgId}`);
    return team;
  }

  _getTeam(orgId, teamId) {
    const team = this._teams.find(t => t.id === teamId && t.orgId === orgId);
    if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });
    return team;
  }

  async addMember(orgId, teamId, userId, role) {
    if (!userId || typeof userId !== 'string') throw Object.assign(new Error('userId is required'), { status: 400 });
    if (!ROLES.includes(role)) {
      throw Object.assign(new Error(`Invalid role. Allowed: ${ROLES.join(', ')}`), { status: 400 });
    }

    const team = this._getTeam(orgId, teamId);

    const existing = team.members.find(m => m.userId === userId);
    if (existing) {
      // Update role if already a member
      existing.role = role;
    } else {
      team.members.push({ userId, role, joinedAt: now() });
    }
    team.updatedAt = now();

    this._saveTeams();
    this.log(`[rbac] member ${userId} added/updated to team ${teamId} as ${role}`);
    return team;
  }

  async removeMember(orgId, teamId, userId) {
    const team = this._getTeam(orgId, teamId);

    const idx = team.members.findIndex(m => m.userId === userId);
    if (idx === -1) throw Object.assign(new Error('Member not found in team'), { status: 404 });

    team.members.splice(idx, 1);
    team.updatedAt = now();

    this._saveTeams();
    this.log(`[rbac] member ${userId} removed from team ${teamId}`);
    return { ok: true };
  }

  async listMembers(orgId) {
    await this.getOrg(orgId); // verify org exists

    const membersMap = new Map(); // userId -> highest role
    for (const team of this._teams) {
      if (team.orgId !== orgId) continue;
      for (const m of team.members) {
        const prev = membersMap.get(m.userId);
        if (!prev || ROLE_RANK[m.role] < ROLE_RANK[prev.role]) {
          membersMap.set(m.userId, { userId: m.userId, role: m.role, teamId: team.id, teamName: team.name });
        }
      }
    }
    return Array.from(membersMap.values());
  }

  async listTeams(orgId) {
    await this.getOrg(orgId);
    return this._teams.filter(t => t.orgId === orgId);
  }

  // ---- Permission checks --------------------------------------------------

  /**
   * Resolve the highest-privilege role a user holds in an org (across all teams).
   * Returns null if user is not a member.
   */
  _resolveRole(userId, orgId) {
    let best = null;
    for (const team of this._teams) {
      if (team.orgId !== orgId) continue;
      for (const m of team.members) {
        if (m.userId !== userId) continue;
        if (!best || ROLE_RANK[m.role] < ROLE_RANK[best]) {
          best = m.role;
        }
      }
    }
    return best;
  }

  async checkPermission(userId, orgId, resource, action) {
    const role = this._resolveRole(userId, orgId);
    if (!role) return false;

    const perms = PERMISSIONS[role];
    if (!perms) return false;

    const resourcePerms = perms[resource];
    if (!resourcePerms) return false;

    return resourcePerms.has(action);
  }

  // ---- Express middleware factory -----------------------------------------

  /**
   * Returns Express middleware that verifies the authenticated user has the
   * required permission in the org identified by `req.params.id` (or
   * `req.body.orgId` / `req.query.orgId`).
   *
   * Expects `req.userId` to be set by an upstream auth middleware.
   */
  requirePermission(resource, action) {
    return async (req, res, next) => {
      try {
        const userId = req.userId;
        if (!userId) return res.status(401).json({ ok: false, error: 'Authentication required' });

        const orgId = req.params.id || req.body?.orgId || req.query?.orgId;
        if (!orgId) return res.status(400).json({ ok: false, error: 'Organization ID required' });

        const allowed = await this.checkPermission(userId, orgId, resource, action);
        if (!allowed) return res.status(403).json({ ok: false, error: 'Insufficient permissions' });

        next();
      } catch (err) {
        const status = err.status || 500;
        res.status(status).json({ ok: false, error: err.message });
      }
    };
  }
}

module.exports = { RBAC, ROLES, PERMISSIONS };

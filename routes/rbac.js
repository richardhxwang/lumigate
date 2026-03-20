'use strict';

const { Router } = require('express');
const { RBAC } = require('../services/rbac/rbac');

const router = Router();
const rbac = new RBAC({ dataDir: 'data/rbac' });

// ---------------------------------------------------------------------------
// Expose the RBAC instance so server.js can use the middleware factory
// ---------------------------------------------------------------------------
router.rbac = rbac;

// ---------------------------------------------------------------------------
// Helper: extract userId from req (set by upstream auth middleware)
// ---------------------------------------------------------------------------
function getUserId(req, res) {
  const userId = req.userId || req.headers['x-user-id'];
  if (!userId) {
    res.status(401).json({ ok: false, error: 'Authentication required' });
    return null;
  }
  return userId;
}

// ---------------------------------------------------------------------------
// POST /v1/orgs — Create organization
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const userId = getUserId(req, res);
    if (!userId) return;

    const { name } = req.body || {};
    const org = await rbac.createOrg({ name, ownerId: userId });
    res.status(201).json({ ok: true, data: org });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /v1/orgs — List user's organizations
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const userId = getUserId(req, res);
    if (!userId) return;

    const orgs = await rbac.listOrgs(userId);
    res.json({ ok: true, data: orgs });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /v1/orgs/:id — Get org detail
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const userId = getUserId(req, res);
    if (!userId) return;

    // Verify membership
    const allowed = await rbac.checkPermission(userId, req.params.id, 'team', 'read');
    if (!allowed) return res.status(403).json({ ok: false, error: 'Not a member of this organization' });

    const org = await rbac.getOrg(req.params.id);
    const teams = await rbac.listTeams(req.params.id);
    res.json({ ok: true, data: { ...org, teams } });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /v1/orgs/:id/members — List all org members
// ---------------------------------------------------------------------------
router.get('/:id/members', async (req, res) => {
  try {
    const userId = getUserId(req, res);
    if (!userId) return;

    const allowed = await rbac.checkPermission(userId, req.params.id, 'team', 'read');
    if (!allowed) return res.status(403).json({ ok: false, error: 'Insufficient permissions' });

    const members = await rbac.listMembers(req.params.id);
    res.json({ ok: true, data: members });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /v1/orgs/:id/teams — Create team
// ---------------------------------------------------------------------------
router.post('/:id/teams', async (req, res) => {
  try {
    const userId = getUserId(req, res);
    if (!userId) return;

    const allowed = await rbac.checkPermission(userId, req.params.id, 'team', 'create');
    if (!allowed) return res.status(403).json({ ok: false, error: 'Insufficient permissions' });

    const { name } = req.body || {};
    const team = await rbac.createTeam(req.params.id, { name });
    res.status(201).json({ ok: true, data: team });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /v1/orgs/:id/teams/:tid/members — Add member
// ---------------------------------------------------------------------------
router.post('/:id/teams/:tid/members', async (req, res) => {
  try {
    const userId = getUserId(req, res);
    if (!userId) return;

    const allowed = await rbac.checkPermission(userId, req.params.id, 'team', 'update');
    if (!allowed) return res.status(403).json({ ok: false, error: 'Insufficient permissions' });

    const { userId: memberId, role } = req.body || {};
    if (!memberId) return res.status(400).json({ ok: false, error: 'userId is required' });
    if (!role) return res.status(400).json({ ok: false, error: 'role is required' });

    const team = await rbac.addMember(req.params.id, req.params.tid, memberId, role);
    res.json({ ok: true, data: team });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /v1/orgs/:id/teams/:tid/members/:uid — Remove member
// ---------------------------------------------------------------------------
router.delete('/:id/teams/:tid/members/:uid', async (req, res) => {
  try {
    const userId = getUserId(req, res);
    if (!userId) return;

    const allowed = await rbac.checkPermission(userId, req.params.id, 'team', 'update');
    if (!allowed) return res.status(403).json({ ok: false, error: 'Insufficient permissions' });

    await rbac.removeMember(req.params.id, req.params.tid, req.params.uid);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

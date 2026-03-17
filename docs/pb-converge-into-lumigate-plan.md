# PocketBase Converge Into LumiGate Plan

## Objective
Make LumiGate the single backend/control plane for all app data operations, while PocketBase remains the storage engine.  
Apps (LumiChat/FurNote/future apps) should call LumiGate APIs only, not PocketBase directly.

## Scope
- Unify PB access behind LumiGate domain APIs (`LC`, `FN`, `LG` as top-level domains/projects).
- Standardize schema/filter/sort/delete/restore behaviors across domains.
- Provide dashboard-level data grid operations (eventually Excel-like UX).
- Keep compatibility with current LC endpoints during migration.

## Target Architecture
- **Data plane**: PocketBase collections and files.
- **Control plane**: LumiGate domain registry + policy engine.
- **Access path**: App → LumiGate → PocketBase.
- **Isolation**: Domain-level ownership + per-user scoping + explicit cross-domain policy.

## Core Design
1. **Domain Registry**
- Add a single config registry for top-level domains (`LC`, `FN`, `LG`, future).
- Each domain defines collections, filterable fields, default sort, ownership field, delete policy, references.

2. **Unified Data APIs**
- `GET /api/domains/:domain/schema`
- `GET /api/domains/:domain/:collection`
- `POST /api/domains/:domain/:collection`
- `PATCH /api/domains/:domain/:collection/:id`
- `DELETE /api/domains/:domain/:collection/:id`
- `GET /api/domains/:domain/:collection/:id/references`
- `POST /api/domains/:domain/:collection/:id/remap`
- `POST /api/domains/:domain/trash/:collection/:id/restore`

3. **Delete/Relation Policy**
- Default policy: `SOFT_DELETE + RESTORE`.
- Relation policy supports `RESTRICT | CASCADE | REMAP | SET_NULL`.
- Cross-collection and cross-domain relations must be explicit in registry.

4. **Query Model (Excel-ready backend)**
- Generic query contract:
  - `filter[field][op]=value` (`contains`, `eq`, `neq`, `gt`, `lt`, `in`, `empty`)
  - `sort=field:asc,field2:desc`
  - `page`, `perPage`, `q`
- Backend first, UI follows.

## Phased Execution
### Phase 1 (Now): Control Plane Completion
- Finalize domain registry abstraction and shared CRUD helpers.
- Keep legacy LC routes, but internally route through shared domain layer.
- Add domain-level schema endpoint tests.

### Phase 2: Dashboard Data Grid
- Replace simple list controls with per-column filter/sort operator UI.
- Add reusable grid component for all domain collections.
- Support quick keyword filter + advanced filter builder.

### Phase 3: App Migration
- LumiChat switches from direct `/lc/*` to domain APIs.
- Add compatibility shim and deprecation logs.
- Remove duplicate PB-write code paths.

### Phase 4: Hardening
- Backup/restore drills for soft-delete + remap cases.
- Cross-domain relation stress tests.
- Audit completeness checks.

## Acceptance Criteria
- New domain can be added by config only (no route copy/paste).
- Any collection field can be filtered/sorted via unified query contract.
- Delete behavior is deterministic and test-covered for all policies.
- LumiChat writes/reads through LumiGate domain layer with no direct PB dependency.

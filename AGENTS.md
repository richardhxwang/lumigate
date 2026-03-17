# Repository Guidelines

## Project Structure & Module Organization
`server.js` is the main Express entry point. HTTP routes live in `routes/`, reusable middleware in `middleware/`, security controls in `security/`, and server-side tools in `tools/`. Static UI assets are served from `public/`, including `public/lumichat.html`.

Companion services are kept in `doc-gen/`, `file-parser/`, and `collector/`. Deployment files live in `deploy/`, `docker/`, and the root `docker-compose.yml`. End-to-end coverage is under `tests/`; test fixtures are in `tests/fixtures/` and screenshots in `tests/screenshots/`. Persistent runtime data belongs in `data/`; use `data-test/` for isolated test runs.

## Build, Test, and Development Commands
Use Docker for the normal local stack:

```bash
cp .env.example .env
docker compose up -d --build
```

Run the gateway with `npm start` or `node server.js`. Start companion services from their directories with `node server.js` or `npm start`, for example `cd doc-gen && npm start`.

Test infrastructure can be launched with:

```bash
docker compose -f reviews/docker-compose.test.yml up -d --build
```

This repo uses executable spec files rather than a single `npm test` script. Run targeted suites directly, for example `node tests/full-e2e.spec.js` or `node tests/file-upload.spec.js`.

## Coding Style & Naming Conventions
Follow the existing Node.js style: CommonJS modules, semicolons, double quotes, and 2-space indentation. Keep helpers near the feature they support. Use kebab-case for file names (`security-middleware.js`), camelCase for variables/functions, and UPPER_SNAKE_CASE for env vars and constants.

There is no enforced formatter in the repo today, so match surrounding code before submitting changes.

## Testing Guidelines
Add or update a `*.spec.js` file in `tests/` for behavior changes. Prefer narrow, scenario-driven E2E coverage and keep fixtures in `tests/fixtures/`. If a test produces UI evidence, store screenshots under `tests/screenshots/`. Validate new endpoints against a local Docker stack before opening a PR.

## Commit & Pull Request Guidelines
Recent history favors short imperative subjects, often with a scope prefix, for example `Fix: Dashboard login broken` or `Collector: tool tag detection + file_download events`. Keep the subject line specific and under one sentence.

PRs should include a concise summary, affected modules or routes, environment changes, and exact verification commands. Include screenshots for `public/` or LumiChat UI changes and link any related issue or review note.

## Security & Configuration Tips
Never commit real API keys or populated `.env` files. Keep secrets in local environment variables, use `.env.example` as the template, and scrub test credentials from logs and screenshots before sharing.

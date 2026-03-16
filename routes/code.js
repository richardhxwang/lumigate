'use strict';

const { Router } = require('express');
const { execFile } = require('child_process');

const router = Router();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CODE_BYTES = 100 * 1024; // 100 KB
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;

const LANGUAGE_CONFIG = {
  python: { image: 'python:3.12-alpine', cmd: ['python3', '-u', '-'] },
  javascript: { image: 'node:22-alpine', cmd: ['node', '-'] },
};

// ---------------------------------------------------------------------------
// POST /run  (mounted at /v1/code)
// ---------------------------------------------------------------------------

router.post('/run', (req, res) => {
  const { language, code, timeout } = req.body || {};

  // --- Validation -----------------------------------------------------------

  if (!language || !LANGUAGE_CONFIG[language]) {
    return res.status(400).json({
      ok: false,
      error: `Unsupported language. Allowed: ${Object.keys(LANGUAGE_CONFIG).join(', ')}`,
    });
  }

  if (typeof code !== 'string' || code.length === 0) {
    return res.status(400).json({ ok: false, error: 'code is required and must be a non-empty string' });
  }

  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    return res.status(400).json({ ok: false, error: `code exceeds maximum size of ${MAX_CODE_BYTES} bytes` });
  }

  const timeoutMs = Math.min(
    Math.max(1000, Number(timeout) || DEFAULT_TIMEOUT_MS),
    MAX_TIMEOUT_MS,
  );

  // --- Build docker command -------------------------------------------------

  const { image, cmd } = LANGUAGE_CONFIG[language];

  // Timeout in seconds for docker's own --stop-timeout (slightly longer than
  // our execFile timeout so that execFile wins the race and we can distinguish
  // our timeout from Docker's).
  const dockerStopSec = Math.ceil(timeoutMs / 1000) + 2;

  const dockerArgs = [
    'run',
    '--rm',
    '-i',
    '--network', 'none',
    '--memory', '256m',
    '--cpus', '0.5',
    '--pids-limit', '100',
    '--read-only',
    // Provide a writable /tmp inside the container (tmpfs, size-limited)
    '--tmpfs', '/tmp:rw,noexec,size=64m',
    '--stop-timeout', String(dockerStopSec),
    image,
    ...cmd,
  ];

  // --- Execute --------------------------------------------------------------

  const start = Date.now();

  const child = execFile('docker', dockerArgs, {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024, // 4 MB stdout/stderr cap
    killSignal: 'SIGKILL',
  }, (err, stdout, stderr) => {
    const duration = Date.now() - start;

    if (err) {
      // Timeout
      if (err.killed || err.signal === 'SIGKILL') {
        return res.status(200).json({
          ok: false,
          error: `Execution timed out after ${timeoutMs}ms`,
          stdout: stdout || '',
          stderr: stderr || '',
          duration,
        });
      }

      // Process exited with non-zero code (normal for runtime errors in user code)
      if (typeof err.code === 'number') {
        return res.status(200).json({
          ok: false,
          error: `Process exited with code ${err.code}`,
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: err.code,
          duration,
        });
      }

      // Other errors (e.g. docker not found)
      console.error('[code] execution error:', err);
      return res.status(500).json({
        ok: false,
        error: 'Code execution failed',
        stderr: stderr || '',
        duration,
      });
    }

    // Success (exit code 0)
    res.json({
      ok: true,
      stdout: stdout || '',
      stderr: stderr || '',
      exitCode: 0,
      duration,
    });
  });

  // Pipe the user's code to the container's stdin and close it.
  child.stdin.on('error', () => {}); // ignore EPIPE if container dies early
  child.stdin.end(code);
});

module.exports = router;

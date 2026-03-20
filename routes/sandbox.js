"use strict";

const { Router } = require("express");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_STDIO_BYTES = 4 * 1024 * 1024;
const ENV_DEFAULT_IMAGE = process.env.LUMIGENT_SANDBOX_IMAGE || "python:3.12-alpine";
const ENV_LOCAL_FALLBACK = String(process.env.LUMIGENT_SANDBOX_LOCAL_FALLBACK || "1") === "1";

function parseAllowlist(raw) {
  const base = String(raw || "ALL")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(base);
}

function firstCommandToken(command) {
  const s = String(command || "").trim();
  if (!s) return "";
  // Best-effort split for shell command first token.
  const m = s.match(/^([A-Za-z0-9._-]+)/);
  return m ? m[1] : "";
}

function createSandboxRouter(options = {}) {
  const router = Router();
  const logger = typeof options.logger === "function" ? options.logger : () => {};
  const audit = typeof options.audit === "function" ? options.audit : () => {};
  const getPolicy = typeof options.getPolicy === "function" ? options.getPolicy : (() => ({}));

  router.post("/exec", (req, res) => {
    const {
      command,
      timeout,
      stdin,
      cwd,
      allow_network,
      image,
    } = req.body || {};

    const policy = getPolicy() || {};
    const enabled = policy.enabled !== false;
    const commandAllowlist = new Set(Array.isArray(policy.commandAllowlist) && policy.commandAllowlist.length
      ? policy.commandAllowlist.map((s) => String(s || "").trim()).filter(Boolean)
      : [...parseAllowlist(process.env.LUMIGENT_SANDBOX_CMD_ALLOWLIST)]);
    const defaultImage = policy.image || ENV_DEFAULT_IMAGE;
    const localFallbackEnabled = policy.localFallbackEnabled !== undefined ? !!policy.localFallbackEnabled : ENV_LOCAL_FALLBACK;
    const networkDefaultEnabled = policy.networkDefaultEnabled === true
      || (policy.networkDefaultEnabled == null && String(process.env.LUMIGENT_SANDBOX_NETWORK_DEFAULT || "0") === "1");
    const networkForceDisabled = policy.networkForceDisabled !== undefined
      ? !!policy.networkForceDisabled
      : String(process.env.LUMIGENT_SANDBOX_NETWORK_FORCE_DISABLED || "1") === "1";

    if (!enabled) return res.status(403).json({ ok: false, error: "Sandbox execution is disabled by policy" });
    if (typeof command !== "string" || !command.trim()) {
      return res.status(400).json({ ok: false, error: "command is required" });
    }
    if (Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) {
      return res.status(400).json({ ok: false, error: `command exceeds ${MAX_COMMAND_BYTES} bytes` });
    }

    const cmdToken = firstCommandToken(command);
    const allowAllCommands = commandAllowlist.has("*") || commandAllowlist.has("ALL");
    if (!allowAllCommands && (!cmdToken || !commandAllowlist.has(cmdToken))) {
      return res.status(403).json({
        ok: false,
        error: `Command '${cmdToken || "unknown"}' is not allowed`,
        allowed: [...commandAllowlist],
      });
    }

    const timeoutMs = Math.min(
      Math.max(1000, Number(timeout) || DEFAULT_TIMEOUT_MS),
      MAX_TIMEOUT_MS,
    );
    const safeImage = typeof image === "string" && image.trim() ? image.trim() : defaultImage;
    const safeCwd = typeof cwd === "string" && cwd.trim() ? cwd.trim() : "/workspace";
    const wantNetwork = allow_network === true || (allow_network == null && networkDefaultEnabled);
    const enableNetwork = networkForceDisabled ? false : !!wantNetwork;

    const dockerStopSec = Math.ceil(timeoutMs / 1000) + 2;
    const dockerArgs = [
      "run",
      "--rm",
      "-i",
      "--memory", "512m",
      "--cpus", "1",
      "--pids-limit", "256",
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,size=128m",
      "--tmpfs", "/workspace:rw,noexec,size=256m",
      "--workdir", safeCwd,
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      "--stop-timeout", String(dockerStopSec),
    ];

    if (!enableNetwork) dockerArgs.push("--network", "none");
    dockerArgs.push(safeImage, "/bin/sh", "-lc", command);

    const start = Date.now();
    const actor = req._lcUserId || req._proxyProjectName || "platform";
    const localWorkdir = path.join("/tmp", "lumigent-sandbox");
    fs.mkdirSync(localWorkdir, { recursive: true });

    const respondError = (err, stdout, stderr, duration, commandName, network) => {
      if (err.killed || err.signal === "SIGKILL") {
        audit(actor, "sandbox_exec_timeout", commandName, { duration, timeoutMs, network });
        return res.status(200).json({
          ok: false,
          error: `Execution timed out after ${timeoutMs}ms`,
          stdout: stdout || "",
          stderr: stderr || "",
          duration,
          command: commandName,
        });
      }
      if (typeof err.code === "number") {
        audit(actor, "sandbox_exec_exit", commandName, { duration, exitCode: err.code, network });
        return res.status(200).json({
          ok: false,
          error: `Process exited with code ${err.code}`,
          stdout: stdout || "",
          stderr: stderr || "",
          exitCode: err.code,
          duration,
          command: commandName,
        });
      }
      audit(actor, "sandbox_exec_error", commandName, { duration, message: err.message || "unknown" });
      return res.status(500).json({
        ok: false,
        error: `Sandbox execution failed: ${err.message || "unknown error"}`,
        stderr: stderr || "",
        duration,
        command: commandName,
      });
    };

    const runLocalFallback = () => {
      logger("warn", "sandbox docker unavailable, using local fallback", {
        actor,
        command: cmdToken,
      });
      const child = execFile("/bin/sh", ["-lc", command], {
        cwd: localWorkdir,
        timeout: timeoutMs,
        maxBuffer: MAX_STDIO_BYTES,
        killSignal: "SIGKILL",
      }, (err, stdout, stderr) => {
        const duration = Date.now() - start;
        if (err) return respondError(err, stdout, stderr, duration, cmdToken, false);
        audit(actor, "sandbox_exec_ok", cmdToken, { duration, network: false, engine: "local_fallback" });
        return res.json({
          ok: true,
          stdout: stdout || "",
          stderr: stderr || "",
          exitCode: 0,
          duration,
          command: cmdToken,
          network: false,
          image: "local-fallback",
          engine: "local_fallback",
        });
      });
      const input = typeof stdin === "string" ? stdin : "";
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    };

    logger("info", "sandbox exec start", {
      actor,
      command: cmdToken,
      timeoutMs,
      network: enableNetwork,
      image: safeImage,
    });
    const child = execFile("docker", dockerArgs, {
      timeout: timeoutMs,
      maxBuffer: MAX_STDIO_BYTES,
      killSignal: "SIGKILL",
    }, (err, stdout, stderr) => {
      const duration = Date.now() - start;
      if (err) {
        const msg = String(err.message || "").toLowerCase();
        if (localFallbackEnabled && (msg.includes("spawn docker enoent") || msg.includes("enoent"))) {
          return runLocalFallback();
        }
        return respondError(err, stdout, stderr, duration, cmdToken, enableNetwork);
      }
      audit(actor, "sandbox_exec_ok", cmdToken, { duration, network: enableNetwork });
      return res.json({
        ok: true,
        stdout: stdout || "",
        stderr: stderr || "",
        exitCode: 0,
        duration,
        command: cmdToken,
        network: enableNetwork,
        image: safeImage,
      });
    });

    const input = typeof stdin === "string" ? stdin : "";
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });

  return router;
}

module.exports = createSandboxRouter;

// Startup / configuration. Child processes run from an empty temp directory so
// the real .env is never loaded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "src", "server.js");

const runIn = (cwd, args, env = {}) =>
  spawnSync(process.execPath, args, {
    cwd,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    encoding: "utf8",
    timeout: 30000,
  });

test("npm start points at a file that exists", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const target = pkg.scripts.start.replace(/^node\s+/, "");
  assert.ok(existsSync(path.join(root, target)), `start script target missing: ${target}`);
  assert.equal(pkg.main, target);
});

test("server exits with a clear message (names only) when required env is missing", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mysawari-env-"));
  try {
    const result = runIn(cwd, [serverPath], { JWT_ACCESS_SECRET: "set-but-secret-value" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing required environment variable\(s\): MONGO_URI/);
    assert.ok(!result.stderr.includes("set-but-secret-value"));
    assert.ok(!result.stdout.includes("set-but-secret-value"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test(".env is loaded before modules that read process.env at import (Cloudinary, WATI)", () => {
  const firstImport = readFileSync(serverPath, "utf8").match(/^import\s+["'][^"']+["']|^import\s.+$/m)[0];
  assert.equal(firstImport, 'import "dotenv/config"');

  // Same import order as server.js, with credentials supplied only via a .env file.
  const cwd = mkdtempSync(path.join(tmpdir(), "mysawari-dotenv-"));
  try {
    writeFileSync(
      path.join(cwd, ".env"),
      "CLOUDINARY_CLOUD_NAME=from-dotenv\nCLOUDINARY_API_KEY=k\nCLOUDINARY_API_SECRET=s\n",
    );
    const dotenvConfig = pathToFileURL(path.join(root, "node_modules", "dotenv", "config.js")).href;
    const probe = `
      import ${JSON.stringify(dotenvConfig)};
      const { default: cloudinary } = await import(${JSON.stringify(pathToFileURL(path.join(root, "src", "app.js")).href)})
        .then(() => import(${JSON.stringify(pathToFileURL(path.join(root, "src", "config", "cloudinary.js")).href)}));
      console.log("cloud_name=" + cloudinary.config().cloud_name);
    `;
    const result = runIn(cwd, ["--input-type=module", "-e", probe]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cloud_name=from-dotenv/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("rate limiters load without the express-rate-limit IPv6 validation error", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "mysawari-rl-"));
  try {
    const probe = `await import(${JSON.stringify(pathToFileURL(path.join(root, "src", "app.js")).href)});`;
    const result = runIn(cwd, ["--input-type=module", "-e", probe]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!/ERR_ERL_KEY_GEN_IPV6/.test(result.stderr + result.stdout), result.stderr);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

import * as esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";

const isWatch = process.argv.includes("--watch");
const isProduction = process.env.NODE_ENV === "production" || process.argv.includes("--production");
const isSyncRequested = process.argv.includes("--sync-installed");

// Ensure output dirs exist
fs.mkdirSync("dist/webview", { recursive: true });

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: !isProduction,
  minify: isProduction,
  logLevel: "info",
};

/** @type {esbuild.BuildOptions} */
const webviewConfig = {
  entryPoints: ["src/webview/index.tsx"],
  bundle: true,
  outfile: "dist/webview/index.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: !isProduction,
  minify: isProduction,
  logLevel: "info",
};

/**
 * Opt-in only: `pnpm dev:sync` with `INFLYNX_SYNC_TARGETS` set.
 *
 * This used to run on EVERY build and overwrite `dist/` and `package.json` inside
 * `~/.vscode`, `~/.cursor` and `~/.antigravity-ide` extension folders, with a
 * hard-coded personal home fallback. A plain `pnpm build` must never write outside
 * the repository — an untested dev build was silently replacing the very extension
 * you were running (backlog A6).
 */
function syncToInstalledExtensions() {
  if (!isSyncRequested) return;

  const targets = (process.env.INFLYNX_SYNC_TARGETS || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (targets.length === 0) {
    console.warn(
      "⚠️  [esbuild] --sync-installed was given but INFLYNX_SYNC_TARGETS is empty; nothing synced.\n" +
      "   Example: INFLYNX_SYNC_TARGETS=\"$HOME/.vscode/extensions/inflynx.inflynx-code-1.0.0\" pnpm dev:sync"
    );
    return;
  }

  for (const target of targets) {
    if (!path.isAbsolute(target)) {
      console.warn(`⚠️  [esbuild] Skipping relative sync target (absolute path required): ${target}`);
      continue;
    }
    if (!fs.existsSync(target)) {
      console.warn(`⚠️  [esbuild] Skipping missing sync target: ${target}`);
      continue;
    }
    try {
      fs.cpSync("dist", path.join(target, "dist"), { recursive: true });
      fs.copyFileSync("package.json", path.join(target, "package.json"));
      console.log(`🚀 [esbuild] Synced build to ${target}`);
    } catch (e) {
      console.warn(`⚠️ [esbuild] Failed to sync to ${target}:`, e.message);
    }
  }
}

async function buildAll() {
  try {
    if (isWatch) {
      const extCtx = await esbuild.context(extensionConfig);
      const webviewCtx = await esbuild.context(webviewConfig);
      await Promise.all([extCtx.watch(), webviewCtx.watch()]);
      console.log("⚡ [esbuild] Watching extension and webview for changes...");
    } else {
      console.log("📦 [esbuild] Building extension host...");
      await esbuild.build(extensionConfig);
      console.log("📦 [esbuild] Building webview application...");
      await esbuild.build(webviewConfig);
      syncToInstalledExtensions();
      console.log("✅ [esbuild] Build complete!");
    }
  } catch (error) {
    console.error("❌ [esbuild] Build failed:", error);
    process.exit(1);
  }
}

buildAll();

import * as esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";

const isWatch = process.argv.includes("--watch");
const isProduction = process.env.NODE_ENV === "production" || process.argv.includes("--production");

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

function syncToInstalledExtensions() {
  const home = process.env.HOME || "/Users/ravishankar";
  const targets = [
    path.join(home, ".vscode", "extensions", "inflynx.inflynx-code-1.0.0"),
    path.join(home, ".antigravity-ide", "extensions", "inflynx.inflynx-code-1.0.0"),
    path.join(home, ".cursor", "extensions", "inflynx.inflynx-code-1.0.0"),
  ];

  for (const target of targets) {
    if (fs.existsSync(target)) {
      try {
        fs.cpSync("dist", path.join(target, "dist"), { recursive: true });
        fs.copyFileSync("package.json", path.join(target, "package.json"));
        console.log(`🚀 [esbuild] Successfully synced build to ${target}`);
      } catch (e) {
        console.warn(`⚠️ [esbuild] Failed to sync to ${target}:`, e.message);
      }
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

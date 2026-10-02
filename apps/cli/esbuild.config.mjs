// esbuild bundler for the Inflynx CLI → ONE self-contained file so `npm i -g inflynx-agent`
// installs a single zero-dependency artifact (every @inflynx/* workspace package inlined).
// Local-first run needs no native modules; pg/ioredis are marked external + loaded lazily, so a
// user who never sets DATABASE_URL/REDIS_URL installs nothing extra and nothing fails to resolve.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(here, "src/index.ts")],
  outfile: path.join(here, "dist/inflynx.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Node built-ins are external by default (platform:node). Keep the native keychain binding + the
  // optional Postgres/Redis backends external: the native `.node` binary cannot be bundled, and
  // pg/ioredis are only reached when DATABASE_URL/REDIS_URL are set. They ship as (optional) deps.
  external: ["pg", "ioredis", "@napi-rs/keyring", "typescript"],
  // The shebang must be first; the require/__filename/__dirname shims let bundled CommonJS deps use
  // the CJS globals that don't exist in ESM (e.g. @inquirer's `require('node:tty')`). typescript and
  // the native keyring stay external (not bundler-friendly) and ship as real deps.
  banner: {
    js:
      "#!/usr/bin/env node\n" +
      "import { createRequire as __cr } from 'node:module';\n" +
      "import { fileURLToPath as __f2p } from 'node:url';\n" +
      "import __path from 'node:path';\n" +
      "const require = __cr(import.meta.url);\n" +
      "const __filename = __f2p(import.meta.url);\n" +
      "const __dirname = __path.dirname(__filename);\n",
  },
  logLevel: "warning",
  legalComments: "none",
}).catch(() => process.exit(1));

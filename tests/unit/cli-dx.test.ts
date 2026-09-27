/**
 * CLI developer-experience primitives (launch-sprint batch).
 *
 * Covers the two pure functions added for the CLI batch: the incremental markdown
 * stream renderer (blocks must render as they close, code fences must never split)
 * and project-instruction loading (AGENTS.md / .inflynx/AGENTS.md, capped, absent ==
 * null rather than an empty prompt section).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMarkdownStreamRenderer } from "../../packages/ui-components/src/index.js";
import { loadProjectInstructions } from "../../packages/config/src/workspace-root.js";

function collect(): { write: (s: string) => void; output: () => string } {
  let acc = "";
  return { write: (s: string) => (acc += s), output: () => acc };
}

async function main() {
  // ── 1. Blocks render as they close, across tiny deltas ──
  {
    const sink = collect();
    const r = createMarkdownStreamRenderer({ write: sink.write });
    const full = "# Title\n\nSome paragraph text.\n\n- one\n- two\n\n";
    for (const ch of full) r.push(ch); // one character at a time
    r.end();
    const out = sink.output();
    assert.ok(out.includes("Title"), "heading text lost");
    assert.ok(!/\n#\s|##\s/.test(out.replace(/^\s*#*/, "")), "raw markdown heading leaked");
    assert.ok(out.includes("one"), "list item lost");
    assert.equal((out.match(/\n\n/g) ?? []).length >= 3, true, "blocks were not separated");
  }

  // ── 2. A code fence split across pushes is emitted as ONE block ──
  {
    const sink = collect();
    const blocks: string[] = [];
    const r = createMarkdownStreamRenderer({
      write: sink.write,
      render: (b) => { blocks.push(b); return b; }, // pass-through to inspect blocks
    });
    r.push("Look:\n\n```ts\nconst a = ");
    r.push("1;\n\nconst b = 2;\n```\n\nDone.");
    r.end();
    // The fence with a blank line inside must arrive as a single render call.
    const fenceBlocks = blocks.filter((b) => b.includes("```"));
    assert.equal(fenceBlocks.length, 1, `fence was split into ${fenceBlocks.length} blocks`);
    assert.ok(fenceBlocks[0].includes("const a = 1;") && fenceBlocks[0].includes("const b = 2;"), "fence content incomplete");
    assert.ok(sink.output().includes("Done."), "trailing block lost");
  }

  // ── 3. end() flushes an unterminated tail; empty stream is a no-op ──
  {
    const sink = collect();
    const r = createMarkdownStreamRenderer({ write: sink.write });
    r.push("no trailing blank line");
    r.end();
    assert.ok(sink.output().includes("no trailing blank line"), "tail not flushed");
    const empty = collect();
    const r2 = createMarkdownStreamRenderer({ write: empty.write });
    r2.end();
    assert.equal(empty.output(), "", "empty stream produced output");
  }

  // ── 4. loadProjectInstructions: absent, root, .inflynx fallback, truncation ──
  {
    const root = fs.mkdtempSync("inflynx-agents-");
    process.on("exit", () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

    assert.equal(loadProjectInstructions(root), null, "absent file must be null, not empty");

    fs.writeFileSync(path.join(root, "AGENTS.md"), "Always use pnpm. Keep functions under 50 lines.");
    const root1 = loadProjectInstructions(root)!;
    assert.ok(root1 && root1.source === "AGENTS.md", "root AGENTS.md not found");
    assert.ok(root1.content.includes("Always use pnpm"), "content mismatch");

    fs.rmSync(path.join(root, "AGENTS.md"));
    fs.mkdirSync(path.join(root, ".inflynx"));
    fs.writeFileSync(path.join(root, ".inflynx", "AGENTS.md"), "Fallback instructions.");
    const root2 = loadProjectInstructions(root)!;
    assert.ok(root2 && root2.source === path.join(".inflynx", "AGENTS.md"), ".inflynx fallback not used");

    const big = "x".repeat(33_000);
    fs.writeFileSync(path.join(root, "AGENTS.md"), big);
    const root3 = loadProjectInstructions(root)!;
    assert.ok(root3.content.length < big.length, "oversized instructions were not capped");
    assert.ok(root3.content.includes("truncated"), "truncation not announced");

    // Whitespace-only file counts as absent — but only after the fallback was also
    // checked (delete it, since the previous step created one).
    fs.rmSync(path.join(root, ".inflynx", "AGENTS.md"));
    fs.writeFileSync(path.join(root, "AGENTS.md"), "   \n  ");
    assert.equal(loadProjectInstructions(root), null, "whitespace-only file must count as absent");
  }

  console.log("✓ cli-dx: markdown block streaming, fence integrity, tail flush, AGENTS.md loading + cap");
  process.exit(0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

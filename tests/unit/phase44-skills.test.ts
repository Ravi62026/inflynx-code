/**
 * Phase 44 — skills: a real SKILL.md frontmatter parser (I5)
 *
 * The old parser split each line on the first colon and only knew name/description/author/
 * version/tags — so real-world frontmatter silently degraded to "Unnamed Skill", and `tools:`
 * (declared on SkillMetadata) was never read. Each test below is a case that BROKE the old parser
 * and must now pass, plus the `tools` field that never existed.
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { parseFrontmatter } from "../../packages/skill-runtime/src/index.js";

console.log("=== Phase 44: SKILL.md frontmatter (I5) ===");

// 1 --- colon inside the value must not truncate it (old code took everything after first colon,
// but the block-scalar / indentation cases below are where it fully failed).
{
  const { metadata } = parseFrontmatter(
    `---\nname: Time Parser\ndescription: Handles ISO 8601: dates, times and offsets.\n---\nbody text\n`
  );
  assert.equal(metadata.name, "Time Parser");
  assert.equal(metadata.description, "Handles ISO 8601: dates, times and offsets.");
  console.log("  ✓ value containing a colon survives intact");
}

// 2 --- a UTF-8 BOM and leading blank lines used to make the whole block unmatched ("Unnamed Skill").
{
  const withNoise = "\uFEFF\n\n---\nname: Bom Skill\ndescription: has a bom and blanks\n---\nx\n";
  const { metadata } = parseFrontmatter(withNoise);
  assert.equal(metadata.name, "Bom Skill", "BOM + leading blanks tolerated");
  assert.notEqual(metadata.name, "Unnamed Skill");
  console.log("  ✓ BOM and leading blank lines no longer degrade to 'Unnamed Skill'");
}

// 3 --- a literal block scalar (`|`) for the description — the old parser ignored the folded lines.
{
  const content =
    "---\nname: Blocky\ndescription: |\n  line one of a description\n  line two continues it\n" +
    "  line three\n---\nbody\n";
  const { metadata } = parseFrontmatter(content);
  assert.equal(metadata.name, "Blocky");
  assert.match(metadata.description, /line one of a description/);
  assert.match(metadata.description, /line three/, "block-scalar continuation lines are captured");
  console.log("  ✓ '|' block scalar folds its indented lines into the value");
}

// 4 --- a dashed block SEQUENCE for `tools` (I5: tools were never parsed at all).
{
  const content =
    "---\nname: Sequenced\ndescription: uses a dashed list\ntools:\n  - read_file\n  - search_files\n" +
    "  - execute_shell\n---\nbody\n";
  const { metadata } = parseFrontmatter(content);
  assert.deepEqual(metadata.tools, ["read_file", "search_files", "execute_shell"], "tools parsed from a block sequence");
  console.log("  ✓ `tools:` block sequence is parsed (was declared-but-ignored)");
}

// 5 --- flow lists for tags and tools, quoted values, and version.
{
  const content =
    '---\nname: "Quoted, With Comma"\ndescription: [flow] not used here\ntags: ["a", "b", c]\ntools: [read_file, patch_file]\nversion: "1.2.3"\nauthor: Ravi\n---\nb\n';
  const { metadata } = parseFrontmatter(content);
  assert.equal(metadata.name, "Quoted, With Comma", "quoted value with a comma kept");
  assert.deepEqual(metadata.tags, ["a", "b", "c"]);
  assert.deepEqual(metadata.tools, ["read_file", "patch_file"]);
  assert.equal(metadata.version, "1.2.3");
  assert.equal(metadata.author, "Ravi");
  console.log("  ✓ flow lists, quotes, version and author all parse");
}

// 6 --- no frontmatter at all still degrades gracefully (the ONE correct use of the fallback).
{
  const { metadata } = parseFrontmatter("# Just a markdown file\nno frontmatter here\n");
  assert.equal(metadata.name, "Unnamed Skill");
  console.log("  ✓ a genuine no-frontmatter file still falls back cleanly (not a regression path)");
}

// 7 --- the real authored skill in the repo parses with a real name + description (end-to-end).
{
  const real = ".inflynx/skills/codebase-mindmap/SKILL.md";
  if (fs.existsSync(real)) {
    const { metadata } = parseFrontmatter(fs.readFileSync(real, "utf-8"));
    assert.notEqual(metadata.name, "Unnamed Skill", "the shipped skill must not degrade");
    assert.ok(Array.isArray(metadata.tags) && metadata.tags.length >= 1, "tags parsed from the real skill");
    console.log(`  ✓ real authored skill parses: "${metadata.name}" (${metadata.tags!.length} tags)`);
  } else {
    console.log("  (real authored skill not present in this checkout — skipped)");
  }
}

console.log("\n=== Phase 44 results:", 0, "failures ===");
process.exit(0);

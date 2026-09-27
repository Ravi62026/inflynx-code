/**
 * @inflynx/skill-runtime
 * Dynamic Skill discovery engine, SKILL.md YAML frontmatter parser, and skill execution context.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { findWorkspaceRoot } from "@inflynx/config";

export interface SkillMetadata {
  name: string;
  description: string;
  author?: string;
  version?: string;
  tags?: string[];
  tools?: string[];
}

export interface SkillDefinition {
  id: string;
  dirPath: string;
  filePath: string;
  metadata: SkillMetadata;
  instructions: string;
  scripts: string[];
  references: string[];
}

function stripQuotes(v: string): string {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

/** Coerce a parsed frontmatter value into a string (block scalars/joins collapse to text). */
function toStr(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(" ") : v;
}

/** Coerce a value into a list: a block sequence, a flow `[a, b]`, or a comma string. */
function toList(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.map((s) => stripQuotes(s)).filter(Boolean);
  const s = v.trim();
  if (!s) return [];
  const inner = s.startsWith("[") && s.endsWith("]") ? s.slice(1, -1) : s;
  return inner.split(",").map((x) => stripQuotes(x)).filter(Boolean);
}

/**
 * I5 (Phase 44): the old parser split every line on the FIRST colon and knew nothing about block
 * scalars (`|` / `>`), dashed block sequences, a UTF-8 BOM, or leading blank lines — so ordinary
 * real-world SKILL.md frontmatter silently degraded to "Unnamed Skill", and `tools:` was never
 * read even though `SkillMetadata.tools` declared it. This is a small but *real* YAML-subset
 * reader for flat frontmatter: top-level `key:` scalars, quoted values, values containing colons,
 * flow lists `[a, b]`, `- a` block sequences, and `|`/`>` block scalars.
 */
export function parseFrontmatter(content: string): { metadata: SkillMetadata; body: string } {
  const noBom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = noBom.split(/\r?\n/);

  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++; // tolerate leading blank lines
  if (lines[i]?.trim() !== "---") {
    return { metadata: { name: "Unnamed Skill", description: "No YAML frontmatter found" }, body: content };
  }
  i++;

  const fm: string[] = [];
  let closed = false;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---" || t === "...") { closed = true; i++; break; }
    fm.push(lines[i]);
  }
  if (!closed) {
    return { metadata: { name: "Unnamed Skill", description: "No YAML frontmatter found" }, body: content };
  }
  const body = lines.slice(i).join("\n");

  // Walk the flat mapping, carrying the current key + its collection mode.
  const raw: Record<string, string | string[]> = {};
  let key: string | null = null;
  let mode: "none" | "pending" | "seq" | "scalar" = "none";
  let buf: string[] = [];
  const flush = () => {
    if (!key) return;
    if (mode === "seq") raw[key] = buf.slice();
    else if (mode === "scalar") raw[key] = buf.join("\n").replace(/\s+$/, "");
    buf = [];
    key = null;
    mode = "none";
  };
  for (const line of fm) {
    const isTopKey = !/^\s/.test(line) && /^[A-Za-z0-9_-]+:/.test(line);
    if (isTopKey) {
      flush();
      const idx = line.indexOf(":");
      key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (val === "") mode = "pending"; // a block sequence or scalar follows
      else if (/^[|>][+-]?\d*$/.test(val)) mode = "scalar";
      else { raw[key] = val; key = null; mode = "none"; } // inline scalar / flow list, already stored
      continue;
    }
    const stripped = line.trim();
    if (stripped.startsWith("#") && mode !== "scalar") continue; // comment line
    if (key === null) continue;
    if (mode === "pending" && stripped.startsWith("- ")) mode = "seq";
    if (mode === "seq" && stripped.startsWith("- ")) buf.push(stripped.slice(2).trim());
    else if (mode === "pending" && stripped) { mode = "scalar"; buf.push(line.replace(/^\s{1,}/, "")); }
    else if (mode === "scalar") buf.push(line.replace(/^\s{1,}/, ""));
  }
  flush();

  const name = toStr(raw.name);
  const description = toStr(raw.description);
  const metadata: SkillMetadata = {
    name: name && name.trim() ? stripQuotes(name) : "Unnamed Skill",
    description: description && description.trim() ? stripQuotes(description) : "Custom skill definition",
    author: raw.author !== undefined ? stripQuotes(toStr(raw.author)!) : undefined,
    version: raw.version !== undefined ? stripQuotes(toStr(raw.version)!) : undefined,
    tags: toList(typeof raw.tags === "string" ? raw.tags : raw.tags),
    tools: toList(typeof raw.tools === "string" ? raw.tools : raw.tools),
  };
  return { metadata, body };
}

export class SkillManager {
  private skills = new Map<string, SkillDefinition>();

  /**
   * Discover skills in workspace (.inflynx/skills, .agents/skills, skills/) and global (~/.inflynx/skills).
   */
  discoverSkills(startDir: string = process.cwd()): SkillDefinition[] {
    this.skills.clear();
    const rootDir = findWorkspaceRoot(startDir);

    const searchDirectories = [
      path.join(os.homedir(), ".inflynx", "skills"),
      path.join(rootDir, ".inflynx", "skills"),
      path.join(rootDir, ".agents", "skills"),
      path.join(rootDir, "skills"),
    ];

    for (const searchDir of searchDirectories) {
      if (fs.existsSync(searchDir)) {
        try {
          const entries = fs.readdirSync(searchDir);
          for (const entry of entries) {
            const skillDirPath = path.join(searchDir, entry);
            const stat = fs.statSync(skillDirPath);

            if (stat.isDirectory()) {
              const skillFilePath = path.join(skillDirPath, "SKILL.md");
              if (fs.existsSync(skillFilePath)) {
                try {
                  const content = fs.readFileSync(skillFilePath, "utf-8");
                  const { metadata, body } = parseFrontmatter(content);

                  // Read optional scripts/ directory
                  const scriptsDir = path.join(skillDirPath, "scripts");
                  const scripts: string[] = [];
                  if (fs.existsSync(scriptsDir)) {
                    scripts.push(...fs.readdirSync(scriptsDir).map((s) => path.join("scripts", s)));
                  }

                  // Read optional references/ directory
                  const refsDir = path.join(skillDirPath, "references");
                  const references: string[] = [];
                  if (fs.existsSync(refsDir)) {
                    references.push(...fs.readdirSync(refsDir).map((r) => path.join("references", r)));
                  }

                  const id = entry.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
                  const skillDef: SkillDefinition = {
                    id,
                    dirPath: skillDirPath,
                    filePath: skillFilePath,
                    metadata: {
                      ...metadata,
                      name: metadata.name !== "Unnamed Skill" ? metadata.name : entry,
                    },
                    instructions: body,
                    scripts,
                    references,
                  };

                  this.skills.set(id, skillDef);
                } catch {
                  // ignore corrupt skill files
                }
              }
            }
          }
        } catch {
          // ignore directory read errors
        }
      }
    }

    return Array.from(this.skills.values());
  }

  /**
   * Save a newly generated skill to .inflynx/skills/<skill-id>/SKILL.md.
   */
  createSkill(
    skillId: string,
    metadata: SkillMetadata,
    instructions: string,
    startDir: string = process.cwd()
  ): SkillDefinition {
    const rootDir = findWorkspaceRoot(startDir);
    const id = skillId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const skillDir = path.join(rootDir, ".inflynx", "skills", id);

    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true });
    }

    const frontmatter = [
      "---",
      `name: "${metadata.name}"`,
      `description: "${metadata.description}"`,
      metadata.author ? `author: "${metadata.author}"` : "",
      metadata.version ? `version: "${metadata.version}"` : "",
      metadata.tags && metadata.tags.length > 0 ? `tags: [${metadata.tags.map((t) => `"${t}"`).join(", ")}]` : "",
      metadata.tools && metadata.tools.length > 0 ? `tools: [${metadata.tools.map((t) => `"${t}"`).join(", ")}]` : "",
      "---",
      "",
    ]
      .filter(Boolean)
      .join("\n");

    const fullContent = frontmatter + instructions;
    const filePath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(filePath, fullContent, "utf-8");

    const skillDef: SkillDefinition = {
      id,
      dirPath: skillDir,
      filePath,
      metadata,
      instructions,
      scripts: [],
      references: [],
    };

    this.skills.set(id, skillDef);
    return skillDef;
  }

  getSkill(id: string): SkillDefinition | undefined {
    return this.skills.get(id.toLowerCase());
  }

  listSkills(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /**
   * Matches active user query against discovered skills for auto-context injection.
   */
  matchSkills(query: string, topK = 3): SkillDefinition[] {
    const qLower = query.toLowerCase();
    const queryTerms = qLower.split(/\s+/).filter((t) => t.length > 2);

    const scored: Array<{ skill: SkillDefinition; score: number }> = [];

    for (const skill of this.skills.values()) {
      let score = 0;
      const nameLower = skill.metadata.name.toLowerCase();
      const descLower = skill.metadata.description.toLowerCase();

      if (qLower.includes(skill.id) || qLower.includes(nameLower)) {
        score += 10;
      }

      for (const term of queryTerms) {
        if (nameLower === term || nameLower.includes(term)) score += 5;
        if (skill.metadata.tags?.some((t) => t.toLowerCase() === term || t.toLowerCase().includes(term))) score += 4;
      }

      if (score >= 6) {
        scored.push({ skill, score });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((item) => item.skill);
  }
}

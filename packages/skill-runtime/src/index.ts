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

function parseFrontmatter(content: string): { metadata: SkillMetadata; body: string } {
  const frontmatterRegex = /^---\s*[\r\n]+([\s\S]*?)[\r\n]+---\s*[\r\n]+([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return {
      metadata: { name: "Unnamed Skill", description: "No YAML frontmatter found" },
      body: content,
    };
  }

  const rawYaml = match[1];
  const body = match[2];
  const metadata: Partial<SkillMetadata> = {};

  for (const line of rawYaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf(":");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }

      if (key === "name") metadata.name = val;
      else if (key === "description") metadata.description = val;
      else if (key === "author") metadata.author = val;
      else if (key === "version") metadata.version = val;
      else if (key === "tags") {
        metadata.tags = val.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim());
      }
    }
  }

  return {
    metadata: {
      name: metadata.name || "Unnamed Skill",
      description: metadata.description || "Custom skill definition",
      author: metadata.author,
      version: metadata.version,
      tags: metadata.tags,
    },
    body,
  };
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

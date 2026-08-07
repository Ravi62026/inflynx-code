/**
 * @inflynx/ui-components
 * UI Primitives, Prompt Formatter & Terminal Renderer.
 */

import readline from "readline";
import { marked } from "marked";
import markedTerminal from "marked-terminal";
import { highlight } from "cli-highlight";

// ANSI Color Helpers (Zero-dependency fast styling)
export const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  
  cyan: "\x1b[36m",
  brightCyan: "\x1b[96m",
  magenta: "\x1b[35m",
  brightMagenta: "\x1b[95m",
  blue: "\x1b[34m",
  brightBlue: "\x1b[94m",
  green: "\x1b[32m",
  brightGreen: "\x1b[92m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  brightRed: "\x1b[91m",
  gray: "\x1b[90m",
};

export function renderTerminalMarkdown(content: string): string {
  try {
    const customRenderer = new (markedTerminal as any)({
      showSectionPrefix: false,
      tab: 2,
      code: (code: string, lang?: string) => {
        try {
          return highlight(code, { language: lang || "javascript", ignoreIllegals: true });
        } catch {
          return code;
        }
      },
      tableOptions: {
        chars: {
          top: "─",
          "top-mid": "┬",
          "top-left": "┌",
          "top-right": "┐",
          bottom: "─",
          "bottom-mid": "┴",
          "bottom-left": "└",
          "bottom-right": "┘",
          left: "│",
          "left-mid": "├",
          mid: "─",
          "mid-mid": "┼",
          right: "│",
          "right-mid": "┤",
          middle: "│",
        },
        style: {
          head: ["cyan", "bold"],
          border: ["gray"],
        },
      },
    });

    return (marked.parse(content, { renderer: customRenderer }) as string).trim();
  } catch {
    return content;
  }
}

export function displayWelcomeBanner(model: string, provider: string, cwd: string): void {
  const shortCwd = cwd.length > 38 ? "..." + cwd.slice(-35) : cwd;

  console.log();
  console.log(`${colors.brightCyan}┌────────────────────────────────────────────────────────────┐${colors.reset}`);
  console.log(`${colors.brightCyan}│${colors.reset}  ${colors.bold}${colors.brightMagenta}⚡ INFLYNX CODE CLI AGENT${colors.reset} ${colors.dim}v1.0.0${colors.reset}`.padEnd(68) + `${colors.brightCyan}│${colors.reset}`);
  console.log(`${colors.brightCyan}│${colors.reset}  ${colors.gray}Model:${colors.reset} ${colors.bold}${colors.brightGreen}${model}${colors.reset} ${colors.dim}(${provider})${colors.reset}`.padEnd(76) + `${colors.brightCyan}│${colors.reset}`);
  console.log(`${colors.brightCyan}│${colors.reset}  ${colors.gray}Workspace:${colors.reset} ${colors.blue}${shortCwd}${colors.reset}`.padEnd(69) + `${colors.brightCyan}│${colors.reset}`);
  console.log(`${colors.brightCyan}│${colors.reset}  ${colors.dim}Type /help for commands, /exit to quit${colors.reset}`.padEnd(67) + `${colors.brightCyan}│${colors.reset}`);
  console.log(`${colors.brightCyan}└────────────────────────────────────────────────────────────┘${colors.reset}`);
  console.log();
}

export function formatPrompt(cwd: string = process.cwd(), branch?: string): string {
  const folderName = cwd.split("/").pop() || "workspace";
  const branchTag = branch ? `${colors.gray}(${branch})${colors.reset} ` : "";
  
  return `${colors.bold}${colors.brightMagenta}inflynx-code${colors.reset} ${colors.dim}in${colors.reset} ${colors.bold}${colors.cyan}${folderName}${colors.reset} ${branchTag}${colors.bold}${colors.brightCyan}❯${colors.reset} `;
}

export function renderColorDiff(filePath: string, diffText: string): void {
  console.log();
  console.log(`${colors.bold}${colors.brightCyan}📄 Diff Preview: ${filePath}${colors.reset}`);
  console.log(`${colors.gray}${"─".repeat(60)}${colors.reset}`);
  
  const lines = diffText.split("\n");
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      console.log(`${colors.brightGreen}${line}${colors.reset}`);
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      console.log(`${colors.brightRed}${line}${colors.reset}`);
    } else if (line.startsWith("@@")) {
      console.log(`${colors.brightCyan}${line}${colors.reset}`);
    } else if (line.startsWith("---") || line.startsWith("+++")) {
      console.log(`${colors.bold}${colors.yellow}${line}${colors.reset}`);
    } else {
      console.log(`${colors.gray}${line}${colors.reset}`);
    }
  }
  console.log(`${colors.gray}${"─".repeat(60)}${colors.reset}`);
}

export function askUserPrompt(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

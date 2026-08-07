import React from "react";
import { Text } from "ink";
import { marked } from "marked";
import markedTerminal from "marked-terminal";
import { highlight } from "cli-highlight";

interface MarkdownRendererProps {
  content: string;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content }) => {
  const rendered = React.useMemo(() => {
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
  }, [content]);

  return <Text>{rendered}</Text>;
};

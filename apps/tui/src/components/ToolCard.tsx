import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

export interface ToolLogEntry {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "pending" | "running" | "success" | "error";
  durationMs?: number;
  outputSnippet?: string;
}

interface ToolCardProps {
  log: ToolLogEntry;
}

export const ToolCard: React.FC<ToolCardProps> = ({ log }) => {
  const argSummary = Object.entries(log.args)
    .map(([k, v]) => `${k}="${String(v).length > 30 ? String(v).slice(0, 27) + "..." : String(v)}"`)
    .join(" ");

  return (
    <Box flexDirection="column" marginY={0} paddingX={1}>
      <Box gap={1}>
        {log.status === "running" ? (
          <Text color="yellow">
            <Spinner type="dots" />
          </Text>
        ) : log.status === "success" ? (
          <Text color="green">▶</Text>
        ) : (
          <Text color="red">❌</Text>
        )}
        <Text bold color="cyan">
          {log.name}
        </Text>
        <Text color="gray">({argSummary})</Text>
        {log.durationMs && <Text color="green">✓ {log.durationMs}ms</Text>}
      </Box>
      {log.outputSnippet && (
        <Box paddingLeft={3}>
          <Text color="gray" italic>
            {log.outputSnippet.length > 120 ? log.outputSnippet.slice(0, 117) + "..." : log.outputSnippet}
          </Text>
        </Box>
      )}
    </Box>
  );
};

import React from "react";
import { Box, Text } from "ink";

export interface ToolLogEntry {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "pending" | "running" | "success" | "error";
  durationMs?: number;
  diffPreview?: string;
}

interface ToolLogsPanelProps {
  logs: ToolLogEntry[];
  isActive: boolean;
}

export const ToolLogsPanel: React.FC<ToolLogsPanelProps> = ({ logs, isActive }) => {
  const recentLogs = logs.slice(-6);

  return (
    <Box
      flexDirection="column"
      width={32}
      borderStyle="single"
      borderColor={isActive ? "brightYellow" : "gray"}
      paddingX={1}
    >
      <Text bold color={isActive ? "brightYellow" : "yellow"}>
        🔧 TOOL LOGS ({logs.length})
      </Text>
      <Text color="gray">──────────────────────────</Text>
      {recentLogs.length === 0 ? (
        <Text color="gray" italic>No tools executed yet</Text>
      ) : (
        recentLogs.map((log) => {
          const statusIcon =
            log.status === "success" ? "✓" : log.status === "error" ? "✗" : log.status === "running" ? "⟳" : "•";
          const statusColor =
            log.status === "success" ? "brightGreen" : log.status === "error" ? "red" : log.status === "running" ? "yellow" : "gray";

          return (
            <Box key={log.id} flexDirection="column" marginBottom={1}>
              <Box justifyContent="space-between">
                <Text color={statusColor} bold>
                  {statusIcon} {log.name}
                </Text>
                {log.durationMs && <Text color="gray">{log.durationMs}ms</Text>}
              </Box>
              {log.diffPreview && (
                <Box flexDirection="column" paddingLeft={1}>
                  <Text color="gray">Diff Preview:</Text>
                  {log.diffPreview.split("\n").slice(0, 3).map((line, idx) => (
                    <Text key={idx} color={line.startsWith("+") ? "brightGreen" : line.startsWith("-") ? "red" : "gray"}>
                      {line}
                    </Text>
                  ))}
                </Box>
              )}
            </Box>
          );
        })
      )}
    </Box>
  );
};

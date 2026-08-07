import React from "react";
import { Box, Text } from "ink";

interface HeaderHUDProps {
  model: string;
  provider: string;
  workspaceRoot: string;
  totalTokens: number;
  estimatedCostUsd: number;
  gitBranch?: string;
  showFileDrawer: boolean;
}

export const HeaderHUD: React.FC<HeaderHUDProps> = ({
  model,
  provider,
  workspaceRoot,
  totalTokens,
  estimatedCostUsd,
  gitBranch = "main",
  showFileDrawer,
}) => {
  const shortRoot = workspaceRoot.length > 35 ? "..." + workspaceRoot.slice(-32) : workspaceRoot;

  return (
    <Box flexDirection="column" width="100%" marginBottom={1}>
      <Box justifyContent="space-between" width="100%">
        <Box gap={1}>
          <Text bold color="cyan">⚡ INFLYNX CODE</Text>
          <Text color="gray">│</Text>
          <Text bold color="green">{model}</Text>
          <Text color="gray">({provider})</Text>
        </Box>
        <Box gap={1}>
          <Text color="yellow">Tokens: {Math.round(totalTokens).toLocaleString()}</Text>
          <Text color="gray">(${estimatedCostUsd.toFixed(4)}) │</Text>
          <Text color="blue">Git: {gitBranch}</Text>
          <Text color="gray">│</Text>
          <Text color={showFileDrawer ? "magenta" : "gray"}>[Tab: {showFileDrawer ? "Hide Files" : "Files"}]</Text>
        </Box>
      </Box>
      <Box justifyContent="space-between" width="100%">
        <Text color="gray">Workspace: <Text color="blue">{shortRoot}</Text></Text>
        <Text color="gray" italic>Esc: exit │ /clear: reset</Text>
      </Box>
      <Text color="gray">───────────────────────────────────────────────────────────────────────────────────────────────────</Text>
    </Box>
  );
};

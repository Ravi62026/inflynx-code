import React from "react";
import { Box, Text } from "ink";
import type { WorkspaceIndex } from "@inflynx/workspace-runtime";

interface FileDrawerModalProps {
  index: WorkspaceIndex;
  isOpen: boolean;
}

export const FileDrawerModal: React.FC<FileDrawerModalProps> = ({ index, isOpen }) => {
  if (!isOpen) return null;

  const topFiles = Array.from(index.files.values())
    .filter((f) => !f.relativePath.startsWith("node_modules") && !f.relativePath.startsWith(".git"))
    .slice(0, 16);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="brightCyan"
      paddingX={1}
      marginY={1}
      width="100%"
    >
      <Box justifyContent="space-between" width="100%">
        <Text bold color="brightCyan">
          📂 WORKSPACE FILE DRAWER ({index.totalFiles} indexed files)
        </Text>
        <Text color="gray">[Press Tab to hide]</Text>
      </Box>
      <Text color="gray">─────────────────────────────────────────────────────────────────────────────────</Text>

      <Box flexWrap="wrap" gap={1}>
        {topFiles.map((file) => {
          const isTs = file.extension === ".ts" || file.extension === ".tsx";
          const icon = isTs ? "⚡" : file.extension === ".json" ? "⚙" : "📄";
          return (
            <Box key={file.relativePath} width="30%">
              <Text color={isTs ? "cyan" : "gray"}>
                {icon} {file.relativePath.length > 25 ? "..." + file.relativePath.slice(-22) : file.relativePath}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};

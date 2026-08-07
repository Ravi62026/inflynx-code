import React from "react";
import { Box, Text } from "ink";
import type { WorkspaceIndex } from "@inflynx/workspace-runtime";

interface FileTreePanelProps {
  index: WorkspaceIndex;
  isActive: boolean;
}

export const FileTreePanel: React.FC<FileTreePanelProps> = ({ index, isActive }) => {
  const topFiles = React.useMemo(() => {
    return Array.from(index.files.values())
      .filter((f) => !f.relativePath.startsWith("node_modules") && !f.relativePath.startsWith(".git"))
      .slice(0, 15);
  }, [index]);

  return (
    <Box
      flexDirection="column"
      width={28}
      borderStyle="single"
      borderColor={isActive ? "brightCyan" : "gray"}
      paddingX={1}
    >
      <Text bold color={isActive ? "brightCyan" : "cyan"}>
        📂 FILES ({index.totalFiles})
      </Text>
      <Text color="gray">────────────────────</Text>
      {topFiles.map((file) => {
        const isTs = file.extension === ".ts" || file.extension === ".tsx";
        const icon = isTs ? "⚡" : file.extension === ".json" ? "⚙" : "📄";
        const shortName = file.relativePath.length > 20 ? "..." + file.relativePath.slice(-17) : file.relativePath;
        return (
          <Box key={file.relativePath} justifyContent="space-between">
            <Text color={isTs ? "cyan" : "gray"}>
              {icon} {shortName}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
};

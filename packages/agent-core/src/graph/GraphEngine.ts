import fs from "fs";
import path from "path";
import { buildDependencyGraph, type WorkspaceGraphResult } from "@inflynx/workspace-runtime";

export class GraphEngine {
  private inflynxDir: string;

  constructor(private workspaceRoot: string) {
    this.inflynxDir = path.join(workspaceRoot, ".inflynx");
  }

  /** Generates all graph outputs (Mermaid MD, SVG image, HTML visualizer) */
  async generateGraph(): Promise<{
    graphMdPath: string;
    svgPath: string;
    htmlPath: string;
    result: WorkspaceGraphResult;
  }> {
    fs.mkdirSync(this.inflynxDir, { recursive: true });

    const result = buildDependencyGraph(this.workspaceRoot);

    const graphMdPath = path.join(this.inflynxDir, "GRAPH.md");
    const svgPath = path.join(this.inflynxDir, "graph.svg");
    const htmlPath = path.join(this.inflynxDir, "graph.html");

    fs.writeFileSync(graphMdPath, result.mermaidMarkdown, "utf-8");
    fs.writeFileSync(svgPath, result.svgContent, "utf-8");
    fs.writeFileSync(htmlPath, result.htmlContent, "utf-8");

    // B15 (Phase 47): removed the "fetch mermaid.ink to render a PNG" step. It sent the base64 of the
    // entire repo module/dependency graph to a third party. The local `graph.svg` above is the vector
    // rendering; no PNG-via-remote-service and no network call here.

    return {
      graphMdPath,
      svgPath,
      htmlPath,
      result,
    };
  }
}

/**
 * @inflynx/plugin-sdk
 * Extension contract interface for third-party tools, prompts, & policies.
 */

export interface SlashCommandDefinition {
  name: string;
  description: string;
  execute: (args: string[]) => Promise<void>;
}

export interface InflynxPlugin {
  name: string;
  version: string;
  description?: string;
  tools?: unknown[];
  prompts?: Record<string, string>;
  commands?: SlashCommandDefinition[];
  onEvent?: (event: unknown) => void | Promise<void>;
}

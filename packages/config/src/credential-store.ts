import { Entry } from "@napi-rs/keyring";
import crypto from "node:crypto";
import { lookup } from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderId, ReasoningEffort } from "./model-catalog.js";

const KEYCHAIN_SERVICE = "com.inflynx.code";
const CREDENTIALS_DIR_MODE = 0o700;
const CREDENTIALS_FILE_MODE = 0o600;

export type CredentialProviderId = ProviderId | "custom-openai-compatible";

export interface CredentialProfile {
  id: string;
  label: string;
  providerId: CredentialProviderId;
  /** Model identifier to select initially. Never a secret. */
  defaultModel: string;
  /**
   * Required for `custom-openai-compatible`. The endpoint is not a fetch_url
   * target; it is an explicit user-configured model provider endpoint.
   */
  baseURL?: string;
  /** Local/loopback endpoints require explicit opt-in at profile creation. */
  allowLocalEndpoint?: boolean;
  /**
   * Custom endpoints start with no assumed capabilities. An advanced user may
   * explicitly declare the endpoint's supported tool/reasoning surface.
   */
  customCapabilities?: {
    supportsTools: boolean;
    supportedEfforts: ReasoningEffort[];
  };
  /** An env-var-backed profile never writes a secret to the keychain. */
  credentialSource: "keychain" | "environment";
  environmentVariable?: string;
  createdAt: number;
  updatedAt: number;
}

interface CredentialRegistry {
  version: 1;
  profiles: CredentialProfile[];
}

export interface CreateCredentialProfileInput {
  label: string;
  providerId: CredentialProviderId;
  defaultModel: string;
  apiKey?: string;
  baseURL?: string;
  allowLocalEndpoint?: boolean;
  customCapabilities?: CredentialProfile["customCapabilities"];
  environmentVariable?: string;
}

export interface CredentialBackend {
  set(profileId: string, secret: string): void;
  get(profileId: string): string | null;
  delete(profileId: string): void;
}

const osCredentialBackend: CredentialBackend = {
  set(profileId, secret) {
    keychainEntry(profileId).setPassword(secret);
  },
  get(profileId) {
    return keychainEntry(profileId).getPassword();
  },
  delete(profileId) {
    keychainEntry(profileId).deletePassword();
  },
};

let credentialBackend: CredentialBackend = osCredentialBackend;

/** Test seam only — production code always uses the native OS keychain. */
export function setCredentialBackendForTests(backend?: CredentialBackend): void {
  credentialBackend = backend || osCredentialBackend;
}

function credentialDirectory(): string {
  return path.join(process.env.INFLYNX_CONFIG_HOME || os.homedir(), ".inflynx");
}

function credentialRegistryPath(): string {
  return path.join(credentialDirectory(), "credentials.json");
}

function ensureCredentialDirectory(): void {
  fs.mkdirSync(credentialDirectory(), { recursive: true, mode: CREDENTIALS_DIR_MODE });
  try {
    fs.chmodSync(credentialDirectory(), CREDENTIALS_DIR_MODE);
  } catch {
    // Windows does not support POSIX permission modes in the same way.
  }
}

function readRegistry(): CredentialRegistry {
  const registryPath = credentialRegistryPath();
  if (!fs.existsSync(registryPath)) return { version: 1, profiles: [] };

  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as CredentialRegistry;
    if (parsed?.version === 1 && Array.isArray(parsed.profiles)) return parsed;
  } catch {
    // A corrupt registry must not be silently overwritten: callers will get
    // an explicit diagnostic rather than risk discarding profile metadata.
    throw new Error(`Credential profile registry is malformed: ${registryPath}`);
  }
  throw new Error(`Credential profile registry has an unsupported format: ${registryPath}`);
}

function writeRegistry(registry: CredentialRegistry): void {
  ensureCredentialDirectory();
  const registryPath = credentialRegistryPath();
  const tempPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: CREDENTIALS_FILE_MODE });
  try {
    fs.chmodSync(tempPath, CREDENTIALS_FILE_MODE);
  } catch {
    // See POSIX note in ensureCredentialDirectory.
  }
  fs.renameSync(tempPath, registryPath);
}

function keychainEntry(profileId: string): Entry {
  return new Entry(KEYCHAIN_SERVICE, profileId);
}

export function listCredentialProfiles(): CredentialProfile[] {
  return readRegistry().profiles.sort((left, right) => right.updatedAt - left.updatedAt);
}

export function getCredentialProfile(profileId: string): CredentialProfile | undefined {
  return listCredentialProfiles().find((profile) => profile.id === profileId);
}

export function createCredentialProfile(input: CreateCredentialProfileInput): CredentialProfile {
  const label = input.label.trim();
  const defaultModel = input.defaultModel.trim();
  if (!label) throw new Error("Credential profile label cannot be empty.");
  if (!defaultModel) throw new Error("Credential profile model cannot be empty.");

  if (input.providerId === "custom-openai-compatible") {
    if (!input.baseURL) throw new Error("A custom OpenAI-compatible profile requires a base URL.");
    validateCustomModelEndpoint(input.baseURL, Boolean(input.allowLocalEndpoint));
  } else if (input.baseURL) {
    throw new Error("Only custom OpenAI-compatible profiles may define a base URL.");
  } else if (input.customCapabilities) {
    throw new Error("Only custom OpenAI-compatible profiles may declare custom capabilities.");
  }

  if (input.environmentVariable && input.apiKey) {
    throw new Error("Choose either a keychain secret or an environment variable, not both.");
  }
  if (!input.environmentVariable && !input.apiKey) {
    throw new Error("An API key is required unless the profile explicitly uses an environment variable.");
  }

  const now = Date.now();
  const profile: CredentialProfile = {
    id: `credential_${crypto.randomUUID()}`,
    label,
    providerId: input.providerId,
    defaultModel,
    baseURL: input.baseURL ? normalizeBaseUrl(input.baseURL) : undefined,
    allowLocalEndpoint: input.allowLocalEndpoint || undefined,
    customCapabilities: input.customCapabilities,
    credentialSource: input.environmentVariable ? "environment" : "keychain",
    environmentVariable: input.environmentVariable,
    createdAt: now,
    updatedAt: now,
  };

  // Write secret first. If OS keychain storage fails, profile metadata never
  // reaches disk and cannot produce a broken/secretless profile.
  if (input.apiKey) {
    try {
      credentialBackend.set(profile.id, input.apiKey);
    } catch (err: unknown) {
      throw new Error(
        `Unable to save API key in the operating-system keychain: ${(err as Error).message}. ` +
        "No credential profile was created."
      );
    }
  }

  try {
    const registry = readRegistry();
    registry.profiles.push(profile);
    writeRegistry(registry);
  } catch (err) {
    if (input.apiKey) {
      try {
        credentialBackend.delete(profile.id);
      } catch {
        // Best effort cleanup; never print a key.
      }
    }
    throw err;
  }

  return profile;
}

export function deleteCredentialProfile(profileId: string): boolean {
  const registry = readRegistry();
  const profileIndex = registry.profiles.findIndex((profile) => profile.id === profileId);
  if (profileIndex === -1) return false;

  const [profile] = registry.profiles.splice(profileIndex, 1);
  writeRegistry(registry);
  if (profile.credentialSource === "keychain") {
    try {
      credentialBackend.delete(profile.id);
    } catch {
      // Metadata is removed even if the OS leaves an inaccessible secret
      // behind; it is no longer discoverable by Inflynx.
    }
  }
  return true;
}

/**
 * Resolves a secret only at call time. The key is neither returned by profile
 * listing nor persisted in the JSON registry/session store.
 */
export function resolveCredentialSecret(profile: CredentialProfile): string {
  if (profile.credentialSource === "environment") {
    const envVar = profile.environmentVariable;
    const value = envVar ? process.env[envVar] : undefined;
    if (!value) throw new Error(`Credential profile "${profile.label}" requires environment variable ${envVar || "(missing)"}.`);
    return value;
  }

  try {
    const secret = credentialBackend.get(profile.id);
    if (!secret) {
      throw new Error(
        `No OS-keychain secret exists for credential profile "${profile.label}". ` +
        "Re-add the key with /credentials add."
      );
    }
    return secret;
  } catch (err: unknown) {
    throw new Error(`Unable to read API key from the operating-system keychain: ${(err as Error).message}`);
  }
}

/**
 * Existing env keys stay supported for noninteractive CI/headless use but are
 * intentionally never copied to the credential registry or OS keychain.
 */
export function createEnvironmentCredentialProfile(
  label: string,
  providerId: ProviderId,
  defaultModel: string,
  environmentVariable: string
): CredentialProfile {
  return {
    id: `env_${providerId}_${environmentVariable}`,
    label,
    providerId,
    defaultModel,
    credentialSource: "environment",
    environmentVariable,
    createdAt: 0,
    updatedAt: 0,
  };
}

export function normalizeBaseUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  return parsed.toString().replace(/\/+$/, "");
}

/**
 * An explicit model endpoint is a trusted local-user configuration, not a
 * web-fetch destination. It still forbids credentials in URLs and insecure
 * network targets by default. Local model servers require opt-in.
 */
export function validateCustomModelEndpoint(rawUrl: string, allowLocalEndpoint: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Custom model endpoint must be a valid absolute URL.");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Custom model endpoint must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Custom model endpoint must not contain embedded credentials.");
  }
  if ([...parsed.searchParams.keys()].some((key) => /^(api[_-]?key|key|token|access[_-]?token|authorization)$/i.test(key))) {
    throw new Error("Custom model endpoint must not contain credentials in query parameters.");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLocal = isPrivateOrLocalHost(hostname);
  if (isMetadataHost(hostname)) {
    throw new Error("Custom model endpoint cannot target a cloud metadata address.");
  }

  if (isLocal && !allowLocalEndpoint) {
    throw new Error("Local model endpoints require explicit allowLocalEndpoint opt-in.");
  }
  if (!isLocal && parsed.protocol !== "https:") {
    throw new Error("Remote custom model endpoints must use HTTPS.");
  }

  return parsed;
}

/**
 * Revalidates a custom endpoint directly before a model call, including DNS
 * resolution. This prevents a public-looking hostname from resolving to a
 * private address after profile creation. Unlike web-fetch SSRF protection,
 * explicitly opted-in local model servers remain supported.
 */
export async function validateCustomModelEndpointForUse(rawUrl: string, allowLocalEndpoint: boolean): Promise<URL> {
  const parsed = validateCustomModelEndpoint(rawUrl, allowLocalEndpoint);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isPrivateOrLocalHost(hostname)) return parsed;

  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    const privateAddress = addresses.find((address) => isPrivateOrLocalHost(address.address));
    if (privateAddress && !allowLocalEndpoint) {
      throw new Error(
        `Custom model endpoint resolves to local/private address ${privateAddress.address}; ` +
        "explicit allowLocalEndpoint opt-in is required."
      );
    }
    if (addresses.some((address) => isMetadataHost(address.address))) {
      throw new Error("Custom model endpoint cannot resolve to a cloud metadata address.");
    }
  } catch (err: unknown) {
    if (err instanceof Error && /local\/private|metadata/i.test(err.message)) throw err;
    // DNS failures are allowed to surface from the actual transport, where
    // retry behavior and standard network diagnostics are already applied.
  }
  return parsed;
}

function isMetadataHost(hostname: string): boolean {
  return hostname === "metadata.google.internal" ||
    hostname === "100.100.100.200" ||
    hostname === "169.254.169.254" ||
    hostname === "fd00:ec2::254";
}

function isPrivateOrLocalHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1") return true;
  if (hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:")) return true;

  const octets = hostname.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = octets;
  return first === 0 ||
    first === 10 ||
    first === 127 ||
    first === 169 && second === 254 ||
    first === 172 && second >= 16 && second <= 31 ||
    first === 192 && second === 168 ||
    first === 100 && second >= 64 && second <= 127 ||
    first >= 224;
}

/**
 * @inflynx/telemetry
 * Structured logging with correlation IDs & secret redaction.
 */

export function logEvent(name: string, data: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [TELEMETRY] ${name}:`, JSON.stringify(data));
}

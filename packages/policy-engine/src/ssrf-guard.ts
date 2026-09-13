import dns from "node:dns/promises";
import net from "node:net";

/**
 * Validates outbound HTTP(S) destinations before a server-side fetch.
 *
 * DNS is resolved before returning so hostnames that point at loopback,
 * private, link-local, metadata, or otherwise non-public address space are
 * rejected. Callers should also disable automatic redirects and validate every
 * redirect target before following it.
 */
export async function validatePublicUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("SSRF protection blocked an invalid URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`SSRF protection blocked unsupported URL scheme "${parsed.protocol}".`);
  }

  if (parsed.username || parsed.password) {
    throw new Error("SSRF protection blocked URLs containing embedded credentials.");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "metadata.google.internal" ||
    hostname === "metadata" ||
    hostname.endsWith(".local")
  ) {
    throw new Error(`SSRF protection blocked private hostname "${parsed.hostname}".`);
  }

  const addresses = net.isIP(hostname)
    ? [hostname]
    : (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

  if (addresses.length === 0 || addresses.some(isPrivateOrReservedAddress)) {
    throw new Error(`SSRF protection blocked private or reserved destination "${parsed.hostname}".`);
  }

  return parsed;
}

function isPrivateOrReservedAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = octets;
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 100 && b >= 64 && b <= 127 || // carrier-grade NAT
    a === 127 ||
    a === 169 && b === 254 || // link-local / cloud metadata
    a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 0 || // IETF protocol assignments
    a === 192 && b === 168 ||
    a === 198 && (b === 18 || b === 19 || b === 51) ||
    a === 203 && b === 0 ||
    a >= 224 // multicast and reserved
  );
}

function isPrivateIpv6(address: string): boolean {
  const value = parseIpv6(address);
  if (value === null) return true;

  // IPv4-mapped IPv6 addresses must use the IPv4 policy too.
  const mappedIpv4 = ipv4FromMappedIpv6(value);
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4);

  return [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7], // unique local
    ["fe80::", 10], // link-local
    ["fec0::", 10], // deprecated site-local
    ["2001:db8::", 32], // documentation
    ["2001:10::", 28], // ORCHID
    ["2001:2::", 48], // benchmarking
  ].some(([network, prefix]) => inIpv6Cidr(value, parseIpv6(network as string)!, prefix as number));
}

function parseIpv6(address: string): bigint | null {
  const withoutZone = address.toLowerCase().split("%")[0];
  const parts = withoutZone.split("::");
  if (parts.length > 2) return null;

  const parsePart = (part: string): number[] => {
    if (!part) return [];
    const values: number[] = [];
    for (const token of part.split(":")) {
      if (token.includes(".")) {
        const octets = token.split(".").map(Number);
        if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return [];
        values.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(token)) return [];
        values.push(parseInt(token, 16));
      }
    }
    return values;
  };

  const left = parsePart(parts[0]);
  const right = parts.length === 2 ? parsePart(parts[1]) : [];
  if (left.length + right.length > 8 || (parts.length === 1 && left.length !== 8)) return null;

  const groups = parts.length === 2
    ? [...left, ...new Array(8 - left.length - right.length).fill(0), ...right]
    : left;

  if (groups.length !== 8) return null;
  return groups.reduce((result, group) => (result << 16n) | BigInt(group), 0n);
}

function inIpv6Cidr(value: bigint, network: bigint, prefix: number): boolean {
  if (prefix === 0) return true;
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (network >> shift);
}

function ipv4FromMappedIpv6(value: bigint): string | null {
  const mappedPrefix = parseIpv6("::ffff:0:0");
  if (mappedPrefix === null || (value >> 32n) !== (mappedPrefix >> 32n)) return null;
  const numeric = Number(value & 0xffffffffn);
  return [
    (numeric >>> 24) & 255,
    (numeric >>> 16) & 255,
    (numeric >>> 8) & 255,
    numeric & 255,
  ].join(".");
}

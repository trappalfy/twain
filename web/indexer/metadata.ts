/**
 * Display metadata of a coin. Pons V2 launcher tokens keep their logo, description and socials onchain
 * (getTokenInfo), so nothing is fetched: the indexer reads them once at launch and normalises them here.
 * The logo is an ipfs:// URI (resolved through the gateway) or an https URL; anything else is dropped.
 */
import type { TokenMeta } from "@twain/shared";
import { config } from "@/lib/config";

const GATEWAY = config.ipfsGateway.replace(/\/*$/, "/");

export const EMPTY_META: TokenMeta = { description: null, image: null, x: null, telegram: null, website: null };

const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})(\/.*)?$/;

/** ipfs://CID/path, ipfs://ipfs/CID, bare CID → gateway URL; http(s) passes through; anything else → null. */
export function resolveUri(uri: string): string | null {
  const u = uri.trim();
  if (!u) return null;
  if (/^ipfs:\/\//i.test(u)) {
    const path = u.slice(7).replace(/^ipfs\//i, "");
    return path ? GATEWAY + path : null;
  }
  if (CID_RE.test(u)) return GATEWAY + u;
  if (/^https?:\/\//i.test(u)) return u;
  return null;
}

const str = (v: unknown, max: number) => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && s.length <= max ? s : null;
};

/** http(s) URL (scheme optional, "example.com" → https://example.com/), else null. */
function toWebUrl(v: unknown): string | null {
  const s = str(v, 512);
  if (!s) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function toSocial(v: unknown, handleRe: RegExp, base: string): string | null {
  const s = str(v, 512);
  if (!s) return null;
  if (handleRe.test(s)) return base + s.replace(/^@/, "");
  return toWebUrl(s);
}

function toImage(v: unknown): string | null {
  const s = str(v, 2048);
  if (!s) return null;
  const url = resolveUri(s);
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/** Onchain token info as Pons stores it (PonsV2LauncherToken.getTokenInfo). */
export type OnchainInfo = {
  logo: string;
  description: string;
  socials: { twitter: string; telegram: string; discord: string; website: string; farcaster: string };
};

export function parseMeta(info: OnchainInfo): TokenMeta {
  return {
    description: info.description.trim().slice(0, 1000) || null,
    image: toImage(info.logo),
    x: toSocial(info.socials.twitter, /^@?[A-Za-z0-9_]{1,15}$/, "https://x.com/"),
    telegram: toSocial(info.socials.telegram, /^@?[A-Za-z0-9_]{5,32}$/, "https://t.me/"),
    website: toWebUrl(info.socials.website),
  };
}

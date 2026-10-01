/**
 * Open Graph images (next/og, 1200×630). Server-only: reads fonts and the header poster from disk, resizes with sharp.
 * Used by app/docs/opengraph-image.tsx and app/launchpad/[address]/opengraph-image.tsx; the home page uses the
 * header poster itself (app/layout.tsx metadata).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { COPY, TOKEN_LIMITS, formatAsset, formatPct, formatPriceAsset, formatTiny, formatUsd, shortAddress, type TokenResponse } from "@twain/shared";
import { ImageResponse } from "next/og";
import type { ReactElement } from "react";
import sharp from "sharp";
import { isAddress } from "viem";
import { TWAIN_MARK_PATH } from "@/components/icons";
import { api } from "@/lib/api";
import { config } from "@/lib/config";
import { identiconSvg } from "@/lib/identicon";

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";

/** Hex mirrors of the twain tokens in app/globals.css (ImageResponse cannot read CSS variables). */
const C = {
  ink: "#0E2A3F",
  ink2: "#3D5872",
  brand: "#2E9BFF",
  border: "#D5E3F1",
  surface2: "#F1F6FC",
  buy: "#0A7A4F",
  sell: "#C73439",
};

type OgFonts = NonNullable<NonNullable<ConstructorParameters<typeof ImageResponse>[1]>["fonts"]>;

// Literal paths so output file tracing picks the files up.
const FONT_SORA = join(process.cwd(), "assets/fonts/Sora-Regular.woff");
const FONT_SORA_SEMI = join(process.cwd(), "assets/fonts/Sora-SemiBold.woff");
const FONT_INTER = join(process.cwd(), "assets/fonts/Inter-Regular.ttf");
const FONT_INTER_SEMI = join(process.cwd(), "assets/fonts/Inter-SemiBold.ttf");
const POSTER = join(process.cwd(), "public/media/twain-header-poster.jpg");
const WORDMARK = join(process.cwd(), "public/brand/twain-wordmark.svg");

let fontsP: Promise<OgFonts> | undefined;

function loadFonts(): Promise<OgFonts> {
  fontsP ??= Promise.all([readFile(FONT_SORA), readFile(FONT_SORA_SEMI), readFile(FONT_INTER), readFile(FONT_INTER_SEMI)]).then(
    ([sora, soraSemi, inter, interSemi]): OgFonts => [
      { name: "Sora", data: sora, weight: 400, style: "normal" },
      { name: "Sora", data: soraSemi, weight: 600, style: "normal" },
      { name: "Inter", data: inter, weight: 400, style: "normal" },
      { name: "Inter", data: interSemi, weight: 600, style: "normal" },
    ],
  );
  return fontsP;
}

const dataUri = (buf: Buffer, mime: string) => `data:${mime};base64,${buf.toString("base64")}`;

/** The header poster cropped to exactly 1200×630 (JPEG data URI, cached per process). */
let posterP: Promise<string> | undefined;
function poster() {
  posterP ??= sharp(POSTER)
    .resize(OG_SIZE.width, OG_SIZE.height, { fit: "cover" })
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer()
    .then((b) => dataUri(b, "image/jpeg"));
  return posterP;
}

/** The wordmark SVG as a data URI (its own fill is ink). 2811×1059 units. */
let wordmarkP: Promise<string> | undefined;
const wordmark = () => (wordmarkP ??= readFile(WORDMARK).then((b) => dataUri(b, "image/svg+xml")));

function Mark({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 140 140">
      <path d={TWAIN_MARK_PATH} fill={color} />
    </svg>
  );
}

async function render(node: ReactElement) {
  return new ImageResponse(node, { ...OG_SIZE, fonts: await loadFonts() });
}

/** Poster background shared by every image. */
function Frame({ bg, children }: { bg: string; children: ReactElement | ReactElement[] }) {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: "#EEF6FF" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={bg} width={OG_SIZE.width} height={OG_SIZE.height} alt="" style={{ position: "absolute", left: 0, top: 0 }} />
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ fallback */

/** Poster, wordmark and the slogan: the fallback for token pages without data. */
export async function homeOgImage() {
  const [bg, wm] = await Promise.all([poster(), wordmark()]);
  return render(
    <Frame bg={bg}>
      <div style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={wm} width={212} height={80} alt="" />
        <span style={{ fontFamily: "Sora", fontWeight: 600, fontSize: 76, lineHeight: 1.04, letterSpacing: -2.5, color: C.ink, marginTop: 40, textAlign: "center", maxWidth: 900 }}>
          {COPY.og[0]}
        </span>
      </div>
    </Frame>,
  );
}

/* ------------------------------------------------------------------ docs */

/** Docs: wordmark + "Docs" pill + title over the poster. */
export async function docsOgImage() {
  const [bg, wm] = await Promise.all([poster(), wordmark()]);
  return render(
    <Frame bg={bg}>
      <div style={{ position: "absolute", left: 72, top: 64, display: "flex", alignItems: "center", gap: 20 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={wm} width={170} height={64} alt="" />
        <span style={{ display: "flex", fontFamily: "Sora", fontWeight: 600, fontSize: 22, color: C.ink2, padding: "8px 18px", borderRadius: 999, background: "rgba(255,255,255,0.72)", border: "1px solid rgba(255,255,255,0.9)" }}>
          Docs
        </span>
      </div>
      <div style={{ position: "absolute", left: 72, bottom: 72, display: "flex", flexDirection: "column", maxWidth: 900 }}>
        <span style={{ fontFamily: "Sora", fontWeight: 600, fontSize: 84, lineHeight: 1.02, letterSpacing: -3, color: C.ink }}>{COPY.og[1]}</span>
      </div>
    </Frame>,
  );
}

/* ------------------------------------------------------------------ token */

/** Latin (Sora) and Latin/Greek/Cyrillic (Inter) coverage; anything else is dropped so no remote font fetch happens. */
const SORA_OK = /^[ -ɏ‘-‟…]*$/;
const clean = (s: string) =>
  s
    .replace(/[^ -ԯ -⁯₠-⃏]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Remote token images are fetched only from IPFS gateways the app already trusts. */
const IMAGE_HOSTS = ["gateway.pinata.cloud", "ipfs.io", ".mypinata.cloud"];
function trustedImageUrl(u: string | null): URL | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    const gateway = new URL(config.ipfsGateway).hostname;
    const h = url.hostname;
    const ok = url.protocol === "https:" && (h === gateway || IMAGE_HOSTS.some((a) => (a.startsWith(".") ? h.endsWith(a) : h === a)));
    return ok ? url : null;
  } catch {
    return null;
  }
}

async function tokenImage(src: string | null, seed: string): Promise<string> {
  const url = trustedImageUrl(src);
  if (url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000), next: { revalidate: 3600 } });
      const len = Number(res.headers.get("content-length") ?? 0);
      if (res.ok && len <= TOKEN_LIMITS.imageMaxBytes) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength <= TOKEN_LIMITS.imageMaxBytes) {
          const png = await sharp(buf, { limitInputPixels: 40_000_000 }).resize(400, 400, { fit: "cover" }).png().toBuffer();
          return dataUri(png, "image/png");
        }
      }
    } catch {
      /* fall through to the identicon */
    }
  }
  const png = await sharp(Buffer.from(identiconSvg(seed, 400))).png().toBuffer();
  return dataUri(png, "image/png");
}

async function fetchToken(address: string): Promise<TokenResponse | null> {
  if (!isAddress(address) || config.prelaunch) return null;
  return api.token(address, AbortSignal.timeout(3000)).catch(() => null);
}

/** Coin: image, name, $TICKER, pair, market cap, price and 24h change on a white card over the poster. */
export async function tokenOgImage(address: string) {
  const t = await fetchToken(address);
  if (!t) return homeOgImage();

  const [bg, wm, img] = await Promise.all([poster(), wordmark(), tokenImage(t.meta?.image ?? null, t.address)]);
  const rawName = clean(t.name) || shortAddress(t.address);
  const name = clip(rawName, 28);
  const symbol = clip(clean(t.symbol).toUpperCase(), 12);
  const pair = clip(clean(t.asset.symbol).toUpperCase(), 10);
  const mcap = t.mcapUsd != null ? formatUsd(t.mcapUsd) : formatAsset(t.mcapAsset, t.asset);
  const price = t.priceUsd != null ? `$${formatTiny(t.priceUsd)}` : formatPriceAsset(t.priceX18, t.asset);
  const change = t.change24hPct;
  const nameSize = name.length <= 12 ? 72 : name.length <= 20 ? 56 : 44;
  const font = SORA_OK.test(name) ? "Sora" : "Inter";

  return render(
    <Frame bg={bg}>
      <div style={{ position: "absolute", left: 40, top: 40, right: 40, bottom: 40, display: "flex", alignItems: "center", gap: 48, padding: 44, borderRadius: 36, background: "rgba(255,255,255,0.86)", border: "1px solid rgba(255,255,255,0.95)", boxShadow: "0 10px 40px rgba(20,70,120,0.16)" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={img} width={380} height={380} alt="" style={{ borderRadius: 28, border: `1px solid ${C.border}` }} />

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, alignSelf: "flex-start", fontFamily: "Sora", fontWeight: 600, fontSize: 20, padding: "8px 16px", borderRadius: 999, color: C.ink, background: C.surface2, border: `1px solid ${C.border}` }}>
            <Mark size={16} color={C.brand} />
            {`Paired with ${pair}`}
          </div>
          <span style={{ fontFamily: font, fontWeight: 600, fontSize: nameSize, lineHeight: 1.04, letterSpacing: font === "Sora" ? -1.5 : 0, color: C.ink, marginTop: 22 }}>{name}</span>
          {symbol && <span style={{ fontFamily: "Sora", fontSize: 30, color: C.ink2, marginTop: 8 }}>{`$${symbol}`}</span>}

          <div style={{ display: "flex", flexDirection: "column", marginTop: 30 }}>
            <span style={{ fontFamily: "Sora", fontSize: 20, color: C.ink2 }}>Market cap</span>
            <span style={{ fontFamily: "Sora", fontWeight: 600, fontSize: 50, letterSpacing: -1, color: C.ink, marginTop: 2 }}>{mcap}</span>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 22, fontFamily: "Sora", fontSize: 22, color: C.ink2 }}>
            <span>{`Price ${price}`}</span>
            <span style={{ fontWeight: 600, color: change == null ? C.ink : change >= 0 ? C.buy : C.sell }}>
              {change == null ? COPY.token.lockedPlate : `${formatPct(change, { sign: true })} 24h`}
            </span>
          </div>
        </div>

        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={wm} width={106} height={40} alt="" style={{ position: "absolute", right: 40, top: 36 }} />
      </div>
    </Frame>,
  );
}

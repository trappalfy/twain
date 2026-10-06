import { OG_CONTENT_TYPE, OG_SIZE, tokenOgImage, twainOgImage } from "@/components/docs/og";
import { TWAIN_TOKEN } from "@/config/twain-token";

export const alt = "Token on twain";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
/** Market cap and progress change; re-render at most once a minute. */
export const revalidate = 60;

export default async function Image({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (address.toLowerCase() === "twain" && TWAIN_TOKEN.visible) return twainOgImage();
  return tokenOgImage(address);
}

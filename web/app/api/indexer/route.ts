import { config } from "@/lib/config";

/**
 * GET /api/indexer — built-in indexer status: indexed block, chain head, lag, last error.
 * `?sync=1` runs a (throttled) sync first and waits for it.
 */
export const maxDuration = 60;

export async function GET(req: Request) {
  if (config.prelaunch) return Response.json({ mode: "prelaunch" });
  const { maybeSync, syncStatus } = await import("@/indexer/sync");
  if (new URL(req.url).searchParams.get("sync") === "1") await maybeSync();
  return Response.json({ mode: "builtin", ...(await syncStatus()) }, { headers: { "cache-control": "no-store" } });
}

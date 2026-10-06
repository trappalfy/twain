import { notFound, redirect } from "next/navigation";
import { TWAIN_TOKEN } from "@/config/twain-token";

/** Short link for posts: /twain → the official $TWAIN page (pre-launch, or the live coin once its address is set); 404 while it is hidden. */
export default function TwainShortLink() {
  if (!TWAIN_TOKEN.visible) notFound();
  redirect("/launchpad/twain");
}

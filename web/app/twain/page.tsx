import { redirect } from "next/navigation";

/** Short link for posts: /twain → the official $TWAIN page (pre-launch, or the live coin once its address is set). */
export default function TwainShortLink() {
  redirect("/launchpad/twain");
}

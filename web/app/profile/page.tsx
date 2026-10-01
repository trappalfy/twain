import type { Metadata } from "next";
import { OwnProfile } from "@/components/profile/OwnProfile";

export const metadata: Metadata = {
  title: "Profile",
  description: "Your launches, holdings, trades and creator fees on twain.",
};

export default function Page() {
  return <OwnProfile />;
}

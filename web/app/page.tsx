import type { Metadata } from "next";
import { Suspense } from "react";
import { Hero } from "@/components/hero";
import { HomeApp, HomeAppFallback } from "@/components/home/HomeApp";

export const metadata: Metadata = {
  title: { absolute: "twain — Pair your coin with anything" },
};

/** Home: the twain hero (header brief), then the app — search → Explore (pair filter) → pagination. */
export default function Page() {
  return (
    <>
      <Hero />
      <Suspense fallback={<HomeAppFallback />}>
        <HomeApp />
      </Suspense>
    </>
  );
}

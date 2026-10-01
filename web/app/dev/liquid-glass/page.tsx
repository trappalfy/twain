import { notFound } from "next/navigation"

import { LiquidButton, LiquidSurface } from "@/components/ui/liquid-glass"

export default function LiquidGlassTest() {
  if (process.env.NODE_ENV === "production") notFound()

  return (
    <main className="grid min-h-svh place-items-center bg-[repeating-linear-gradient(90deg,#2E9BFF_0_14px,#EEF6FF_14px_28px)] p-10">
      <div className="grid justify-items-center gap-6">
        <div className="flex flex-wrap justify-center gap-3">
          <LiquidButton variant="primary" size="lg">Launch a coin</LiquidButton>
          <LiquidButton size="lg">See how pairing works</LiquidButton>
          <LiquidButton size="chip">TSLA</LiquidButton>
          <LiquidButton size="chip" variant="primary" aria-pressed>NVDA</LiquidButton>
        </div>
        <LiquidSurface className="w-[min(560px,100%)] rounded-[28px] p-6 text-ink">Pair card surface</LiquidSurface>
      </div>
    </main>
  )
}

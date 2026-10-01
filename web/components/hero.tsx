import Link from "next/link";
import type { CSSProperties } from "react";
import { HeroVideo } from "@/components/hero-video";
import { TwainMark } from "@/components/icons";
import { LiquidButton, LiquidSurface } from "@/components/ui/liquid-glass";
import { siteConfig } from "@/config/site";

const step = (i: number) => ({ "--i": i }) as CSSProperties;

/**
 * Home hero (twain header brief 7.3, without the pair card — owner, 2026-10-01): video loop, pill, title, subtitle
 * and two buttons, centred in a screen-high section.
 */
export function Hero() {
  const h = siteConfig.hero;
  return (
    <section className="relative isolate -mt-(--header-h) flex min-h-[min(100svh,1000px)] flex-col justify-center overflow-hidden px-5 pt-[132px] pb-24 max-md:min-h-[min(100svh,760px)] max-md:pt-[120px] max-md:pb-16">
      <HeroVideo />
      {/* soft hand-off to the page colour where the app starts (a sibling layer, not an ancestor of the glass) */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 -z-[5] h-40 bg-linear-to-b from-transparent to-page" />
      <div className="mx-auto flex w-full max-w-[1120px] flex-col items-center text-center">
        <LiquidSurface
          tone="clear"
          refraction="strong"
          className="hero-in inline-flex h-[38px] items-center gap-2 rounded-full px-4 text-sm font-medium text-ink-2"
          style={step(0)}
        >
          <TwainMark className="size-3.5 text-brand" />
          {h.pill}
        </LiquidSurface>

        <h1
          className="hero-in mt-8 max-w-[13ch] text-[clamp(44px,8.4vw,120px)] leading-[1] font-semibold tracking-[-0.035em] text-balance text-ink max-md:mt-6"
          style={step(1)}
        >
          {h.titleBefore}
          <em className="text-brand not-italic">{h.titleAccent}</em>
          {h.titleAfter}
        </h1>

        <p
          className="hero-in mt-8 max-w-[52ch] text-[clamp(17px,1.5vw,21px)] leading-[1.55] text-pretty text-ink-2 max-md:mt-6"
          style={step(2)}
        >
          {h.subtitle}
        </p>

        <div
          className="hero-in mt-14 flex flex-wrap justify-center gap-4 max-md:mt-10 max-[520px]:w-full max-[520px]:flex-col max-[520px]:gap-3"
          style={step(3)}
        >
          <LiquidButton asChild variant="primary" size="lg" className="h-[60px] px-8 text-[17px]">
            <Link href={siteConfig.links.launch}>
              <TwainMark className="size-4" />
              {h.primary}
            </Link>
          </LiquidButton>
          <LiquidButton asChild size="lg" className="h-[60px] px-8 text-[17px]">
            <Link href={siteConfig.links.pairing}>{h.secondary}</Link>
          </LiquidButton>
        </div>
      </div>
    </section>
  );
}

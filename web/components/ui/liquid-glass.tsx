"use client"

import * as React from "react"
import { Slot, Slottable } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * twain liquid glass.
 * Every glass element = three decorative layers under its content:
 *   1. backdrop  — refracts (SVG filter, Chromium desktop) or blurs (everyone else) what is behind;
 *   2. tint      — clear / frost / ink;
 *   3. rim       — inset highlights that give the glass its edge.
 * Visual rules live in globals.css (.lg-*). Filters are rendered ONCE by <LiquidGlassFilters/> in the root layout.
 */

type Tone = "clear" | "frost" | "ink"
type Refraction = "strong" | "soft" | "blur" | "none"

const layer = "pointer-events-none absolute inset-0 -z-10 rounded-[inherit]"

function LiquidLayers({ tone, refraction }: { tone: Tone; refraction: Refraction }) {
  return (
    <>
      {refraction !== "none" && (
        <span
          aria-hidden="true"
          className={cn(layer, "lg-backdrop", refraction !== "blur" && `lg-backdrop--${refraction}`)}
        />
      )}
      <span aria-hidden="true" className={cn(layer, "lg-tint", `lg-tint--${tone}`)} />
      <span aria-hidden="true" className={cn(layer, tone === "ink" ? "lg-rim--ink" : "lg-rim")} />
    </>
  )
}

/** Shared SVG filters. Render once, right inside <body>. Never use display:none on this svg. */
function LiquidGlassFilters() {
  return (
    <svg aria-hidden="true" focusable="false" className="pointer-events-none absolute size-0 overflow-hidden">
      <defs>
        {/* strong: buttons and the pill */}
        <filter id="twain-glass" x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.05 0.05" numOctaves={1} seed={1} result="noise" />
          <feGaussianBlur in="noise" stdDeviation={2} result="map" />
          <feDisplacementMap in="SourceGraphic" in2="map" scale={70} xChannelSelector="R" yChannelSelector="B" result="bent" />
          <feGaussianBlur in="bent" stdDeviation={4} result="soft" />
          <feColorMatrix in="soft" type="saturate" values="1.4" />
        </filter>
        {/* soft: large surfaces with text on them (nav, pair card) */}
        <filter id="twain-glass-soft" x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.02 0.02" numOctaves={1} seed={3} result="noise" />
          <feGaussianBlur in="noise" stdDeviation={3} result="map" />
          <feDisplacementMap in="SourceGraphic" in2="map" scale={28} xChannelSelector="R" yChannelSelector="B" result="bent" />
          <feGaussianBlur in="bent" stdDeviation={8} result="soft" />
          <feColorMatrix in="soft" type="saturate" values="1.3" />
        </filter>
      </defs>
    </svg>
  )
}

const liquidButtonVariants = cva(
  [
    "relative isolate inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2",
    "whitespace-nowrap rounded-full font-semibold no-underline",
    "transition-transform duration-300 ease-out hover:scale-[1.03] active:scale-[0.98]",
    "motion-reduce:transition-none motion-reduce:hover:scale-100 motion-reduce:active:scale-100",
    "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
    "disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        glass: "text-ink",
        primary: "text-white",
      },
      size: {
        chip: "h-8 px-3 text-[13px] font-medium [&_svg]:size-3",
        sm: "h-10 px-[18px] text-sm [&_svg]:size-3.5",
        md: "h-11 px-5 text-[15px] [&_svg]:size-3.5",
        lg: "h-14 px-7 text-base [&_svg]:size-3.5",
        icon: "size-11 [&_svg]:size-[18px]",
      },
    },
    defaultVariants: { variant: "glass", size: "md" },
  }
)

type LiquidButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof liquidButtonVariants> & {
    asChild?: boolean
    /** Default: "strong", chips: "blur". Use "blur" inside dense groups to save GPU. */
    refraction?: Refraction
  }

function LiquidButton({
  className,
  variant,
  size,
  asChild = false,
  refraction,
  type,
  children,
  ...props
}: LiquidButtonProps) {
  const Comp = asChild ? Slot : "button"
  const tone: Tone = variant === "primary" ? "ink" : "clear"

  return (
    <Comp
      data-slot="liquid-button"
      {...(asChild ? {} : { type: type ?? "button" })}
      className={cn(liquidButtonVariants({ variant, size }), className)}
      {...props}
    >
      <LiquidLayers tone={tone} refraction={refraction ?? (size === "chip" ? "blur" : "strong")} />
      <Slottable>{children}</Slottable>
    </Comp>
  )
}

type LiquidSurfaceProps = React.ComponentProps<"div"> & {
  asChild?: boolean
  tone?: Tone
  refraction?: Refraction
}

/** Any glass panel: the nav capsule, the pill, the pair card, the mobile menu. Set the radius on it. */
function LiquidSurface({
  asChild = false,
  tone = "frost",
  refraction = "soft",
  className,
  children,
  ...props
}: LiquidSurfaceProps) {
  const Comp = asChild ? Slot : "div"

  return (
    <Comp data-slot="liquid-surface" className={cn("relative isolate", className)} {...props}>
      <LiquidLayers tone={tone} refraction={refraction} />
      <Slottable>{children}</Slottable>
    </Comp>
  )
}

export { LiquidButton, LiquidSurface, LiquidGlassFilters, liquidButtonVariants }
export type { LiquidButtonProps, LiquidSurfaceProps, Tone, Refraction }

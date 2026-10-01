import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { JetBrains_Mono, Sora } from "next/font/google";
import { Footer } from "@/components/layout/Footer";
import { StatusBanner } from "@/components/layout/StatusBanner";
import { SiteNav } from "@/components/site-nav";
import { LiquidGlassFilters } from "@/components/ui/liquid-glass";
import { siteConfig } from "@/config/site";
import { config } from "@/lib/config";
import { Providers } from "@/lib/providers";
import "./globals.css";

const sora = Sora({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-sora", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

const POSTER = "/media/twain-header-poster.jpg";

export const metadata: Metadata = {
  metadataBase: new URL(config.siteUrl),
  title: { default: siteConfig.title, template: "%s · twain" },
  description: siteConfig.description,
  applicationName: siteConfig.name,
  openGraph: { siteName: siteConfig.name, type: "website", images: [{ url: POSTER, width: 1920, height: 1080 }] },
  twitter: { card: "summary_large_image", site: `@${siteConfig.x.handle}`, images: [POSTER] },
};

export const viewport: Viewport = {
  themeColor: "#EEF6FF",
  colorScheme: "light",
};

/**
 * Runs before first paint:
 * - real SVG refraction only where it renders: Chromium + mouse/trackpad + no reduced transparency (header brief 6.5);
 * - status-banner dismissal.
 */
const liquidDetect = `(()=>{try{var u=navigator.userAgentData,m=function(q){return matchMedia(q).matches};if(u&&u.brands&&u.brands.some(function(b){return/Chromium/.test(b.brand)})&&m("(pointer: fine)")&&!m("(prefers-reduced-transparency: reduce)"))document.documentElement.dataset.liquid="svg"}catch(e){}})()`;
const bannerScript = `(function(){try{var b=${JSON.stringify(config.banner?.id ?? "")};if(b&&localStorage.getItem('twain-banner-dismissed:'+b))document.documentElement.dataset.bannerDismissed=''}catch(e){}})();`;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning className={`${sora.variable} ${mono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: liquidDetect }} />
        <script dangerouslySetInnerHTML={{ __html: bannerScript }} />
      </head>
      <body className="flex min-h-dvh flex-col bg-page font-sans text-ink antialiased">
        <LiquidGlassFilters />
        <Providers>
          <SiteNav />
          <StatusBanner />
          <main className="flex-1 pt-(--header-h)">{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}

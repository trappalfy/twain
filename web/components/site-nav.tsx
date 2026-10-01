"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { IconClose, IconMenu, TwainWordmark } from "@/components/icons";
import { WalletButton } from "@/components/layout/WalletButton";
import { XIcon } from "@/components/ui/icons";
import { LiquidButton, LiquidSurface } from "@/components/ui/liquid-glass";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

const isActive = (pathname: string, href: string) =>
  !href.includes("#") && href !== "/" && (pathname === href || pathname.startsWith(`${href}/`));

/**
 * Floating nav capsule (twain header brief 7.1): fixed on every page, frost glass that turns dense after 24px of
 * scroll. Links Launch · Pairs · Docs, then the X account and the wallet. At <= 860px the links fold into a glass
 * menu under the capsule (Esc, click outside and navigation close it; focus stays inside while open and returns to
 * the burger); at <= 520px the X link moves into that menu too.
 */
export function SiteNav() {
  const pathname = usePathname() ?? "/";
  const [dense, setDense] = useState(false);
  const [open, setOpen] = useState(false);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // data-dense after 24px of scroll, at most once per frame
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      setDense(window.scrollY > 24);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // close on navigation
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    if (open) setOpen(false);
  }

  // menu: focus inside, Esc / click outside close it, focus back to the burger
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const burger = burgerRef.current;
    const focusables = () => Array.from(menu?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? []);
    focusables()[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu?.contains(t) && !burger?.contains(t)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
      burger?.focus();
    };
  }, [open]);

  return (
    <header className="pointer-events-none fixed inset-x-0 top-[18px] z-50 flex justify-center px-5">
      <LiquidSurface asChild tone="frost" refraction="soft" data-dense={dense}>
        <nav
          aria-label="Main"
          className="pointer-events-auto flex h-16 w-full max-w-[1120px] items-center gap-7 rounded-full py-2.5 pr-2.5 pl-6 text-ink shadow-lift max-[860px]:gap-3 max-[860px]:pl-5"
        >
          <Link href="/" aria-label="twain, home" className="shrink-0 -translate-y-1 rounded-lg">
            <TwainWordmark className="h-[26px] w-auto max-[520px]:h-[22px]" />
          </Link>
          <ul className="flex gap-6 text-[15px] font-medium text-ink-2 max-[860px]:hidden">
            {siteConfig.nav.map((l) => {
              const active = isActive(pathname, l.href);
              return (
                <li key={l.label}>
                  <Link
                    href={l.href}
                    aria-current={active ? "page" : undefined}
                    className={cn("rounded-md transition-colors hover:text-ink", active && "text-ink")}
                  >
                    {l.label}
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="ml-auto flex items-center gap-2">
            <LiquidButton asChild size="icon" className="max-[520px]:hidden">
              <a href={siteConfig.x.href} target="_blank" rel="noreferrer" aria-label={`twain on X (@${siteConfig.x.handle})`}>
                <XIcon />
              </a>
            </LiquidButton>
            <WalletButton />
            <LiquidButton
              ref={burgerRef}
              size="icon"
              refraction="blur"
              className="min-[861px]:hidden"
              aria-expanded={open}
              aria-controls="site-menu"
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? <IconClose /> : <IconMenu />}
            </LiquidButton>
          </div>
        </nav>
      </LiquidSurface>

      {open && (
        <LiquidSurface
          ref={menuRef}
          id="site-menu"
          tone="frost"
          refraction="blur"
          data-dense
          className="pointer-events-auto fixed inset-x-5 top-[90px] grid gap-1 rounded-[28px] p-2.5 text-ink shadow-lift"
        >
          <nav aria-label="Menu" className="grid gap-1">
            {siteConfig.nav.map((l) => (
              <Link
                key={l.label}
                href={l.href}
                onClick={() => setOpen(false)}
                aria-current={isActive(pathname, l.href) ? "page" : undefined}
                className="flex h-12 items-center rounded-2xl px-4 font-medium hover:bg-white/55"
              >
                {l.label}
              </Link>
            ))}
            <a
              href={siteConfig.x.href}
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpen(false)}
              className="flex h-12 items-center gap-3 rounded-2xl px-4 font-medium hover:bg-white/55 min-[521px]:hidden"
            >
              <XIcon size={16} />@{siteConfig.x.handle}
            </a>
          </nav>
        </LiquidSurface>
      )}
    </header>
  );
}

import { COPY } from "@twain/shared";
import Link from "next/link";
import { TwainWordmark } from "@/components/icons";
import { XIcon } from "@/components/ui/icons";
import { siteConfig } from "@/config/site";

const PRODUCT = [
  { href: "/#explore-panel", label: "Explore" },
  { href: "/launchpad/create", label: "Launch a coin" },
  { href: "/forum", label: "Forum" },
  { href: "/analytics", label: "Analytics" },
  { href: "/profile", label: "Profile" },
  { href: "/docs", label: "Docs" },
];
const LEGAL = [
  { href: "/legal/privacy", label: "Privacy Policy" },
  { href: "/legal/terms", label: "Terms of Use" },
];

function Column({ title, links }: { title: string; links: { href: string; label: string }[] }) {
  return (
    <div>
      <h3 className="text-13 font-medium text-muted">{title}</h3>
      <ul className="mt-4 space-y-3">
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="text-sm text-text transition-colors hover:text-accent-text">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Footer() {
  const x = siteConfig.x;
  return (
    <footer className="container-page mb-8 mt-20 md:mt-28">
      <div className="rounded-section border border-border/60 bg-surface p-6 shadow-section md:p-12">
        <div className="grid gap-10 md:grid-cols-2 lg:grid-cols-[1.5fr_0.7fr_0.8fr_1.4fr]">
          <div>
            <Link href="/" aria-label="twain, home" className="inline-flex rounded-lg text-ink">
              <TwainWordmark className="h-8 w-auto" />
            </Link>
            <p className="mt-4 max-w-sm text-sm leading-6 text-muted">{COPY.footer.description}</p>
          </div>
          <Column title="Product" links={PRODUCT} />
          <Column title="Legal" links={LEGAL} />
          <div>
            <h3 className="text-13 font-medium text-muted">{COPY.footer.riskTitle}</h3>
            <p className="mt-4 text-sm leading-6 text-muted">{COPY.footer.risk}</p>
          </div>
        </div>
        <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6 text-sm text-muted">
          <span>© 2026 twain</span>
          <a
            href={x.href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2.5 text-text transition-colors hover:text-accent-text"
          >
            <span className="underline underline-offset-4">@{x.handle}</span>
            <span className="grid size-8 place-items-center rounded-full border border-border">
              <XIcon size={14} />
            </span>
          </a>
        </div>
      </div>
    </footer>
  );
}

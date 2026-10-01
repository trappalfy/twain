import { COPY } from "@twain/shared";
import Image from "next/image";
import { Button } from "@/components/ui/Button";

/** 404: the header poster (ice squares) behind the message. */
export default function NotFound() {
  return (
    <div className="container-page pt-6 md:pt-10">
      <section className="relative isolate flex min-h-[min(640px,72dvh)] flex-col items-center justify-center overflow-hidden rounded-section border border-border/60 px-6 py-20 text-center shadow-section">
        <Image
          src="/media/twain-header-poster.jpg"
          alt=""
          fill
          loading="eager"
          sizes="(min-width: 1232px) 1200px, 100vw"
          className="-z-10 object-cover"
        />
        <p className="text-13 font-medium uppercase tracking-[0.14em] text-ink-2">Error 404</p>
        <h1 className="mt-4 max-w-2xl text-[clamp(32px,5vw,56px)] leading-[1.05] font-semibold tracking-[-0.03em] text-balance text-ink">
          {COPY.notFound}
        </h1>
        <Button href="/#explore-panel" size="lg" className="mt-10">
          Back to Explore
        </Button>
      </section>
    </div>
  );
}

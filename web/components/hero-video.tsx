"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const POSTER = "/media/twain-header-poster.jpg";

/**
 * Hero background (twain header brief 7.2): the poster is the LCP image; the seamless loop fades in over it once it
 * plays. No video at all under prefers-reduced-motion or Save-Data. Paused while the hero is off screen or the tab
 * is hidden. Render inside a `relative isolate overflow-hidden` section.
 */
export function HeroVideo() {
  const ref = useRef<HTMLVideoElement>(null);
  const [allowed, setAllowed] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only capability check after hydration
    if (!reduce && !saveData) setAllowed(true);
  }, []);

  useEffect(() => {
    const video = ref.current;
    if (!allowed || !video) return;
    // React does not reflect `muted` to the DOM attribute; iOS Safari refuses autoplay without it.
    video.muted = true;
    video.defaultMuted = true;

    let inView = true;
    const sync = () => {
      if (inView && document.visibilityState === "visible") void video.play().catch(() => {});
      else video.pause();
    };
    const section = video.parentElement;
    const io = new IntersectionObserver(
      ([entry]) => {
        inView = !!entry?.isIntersecting;
        sync();
      },
      { threshold: 0 },
    );
    if (section) io.observe(section);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, [allowed]);

  return (
    <>
      {/* Served as is (23 KB, 1920×1080): the optimizer's re-encode strips the grain that keeps the gradient from banding. */}
      <Image src={POSTER} alt="" fill preload unoptimized sizes="100vw" className="pointer-events-none -z-10 object-cover" />
      {allowed && (
        <video
          ref={ref}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          poster={POSTER}
          aria-hidden="true"
          tabIndex={-1}
          onPlaying={() => setPlaying(true)}
          className={cn(
            "pointer-events-none absolute inset-0 -z-10 size-full object-cover transition-opacity duration-300",
            playing ? "opacity-100" : "opacity-0",
          )}
        >
          <source src="/media/twain-header-720.mp4" type="video/mp4" media="(max-width: 900px)" />
          <source src="/media/twain-header.mp4" type="video/mp4" />
        </video>
      )}
    </>
  );
}

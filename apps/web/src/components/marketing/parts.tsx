"use client";
import Link from "next/link";
import * as React from "react";
import NumberFlow from "@number-flow/react";
import { motion, useInView } from "motion/react";
import { Menu, Play, X } from "lucide-react";
import { Wordmark } from "@/components/logo";
import { Button } from "@/components/ui";
import { cn } from "@/lib/format";

export function Nav() {
  const [scrolled, setScrolled] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  const links = [
    ["How it works", "#how"],
    ["Playground", "#playground"],
    ["iPhone", "#iphone"],
    ["Developers", "#developers"],
    ["Security", "#security"],
    ["Pricing", "#pricing"],
  ];
  return (
    <header className={cn("fixed inset-x-0 top-0 z-50 transition-all duration-300", scrolled ? "border-b border-white/10 bg-night/80 backdrop-blur-xl" : "bg-transparent")}>
      <div className="mx-auto flex h-16 max-w-[1240px] items-center gap-6 px-5">
        <Link href="/" aria-label="Orbis Relay"><Wordmark light /></Link>
        <nav className="hidden flex-1 items-center gap-1 lg:flex" aria-label="Main">
          {links.map(([l, h]) => (
            <a key={h} href={h} className="rounded-lg px-3 py-1.5 text-[14px] text-white/65 transition hover:bg-white/5 hover:text-white">{l}</a>
          ))}
        </nav>
        <div className="ml-auto hidden items-center gap-2 sm:flex">
          <Link href="/console" className="rounded-lg px-3 py-1.5 text-[14px] text-white/75 hover:text-white">Console</Link>
          <Button asChild variant="primary" size="sm"><Link href="/demo">Live demo</Link></Button>
        </div>
        <button className="ml-auto rounded-lg p-2 text-white lg:hidden sm:ml-0" onClick={() => setOpen((o) => !o)} aria-label="Menu" aria-expanded={open}>{open ? <X className="size-5" /> : <Menu className="size-5" />}</button>
      </div>
      {open && (
        <div className="border-t border-white/10 bg-night px-5 py-3 lg:hidden">
          {[...links, ["Console", "/console"], ["Live demo", "/demo"]].map(([l, h]) => (
            <a key={h} href={h} onClick={() => setOpen(false)} className="block rounded-lg px-2 py-2.5 text-[15px] text-white/80">{l}</a>
          ))}
        </div>
      )}
    </header>
  );
}

export function Reveal({ children, className, delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  return (
    <motion.div initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.55, ease: [0.2, 0.7, 0.2, 1], delay }} className={className}>
      {children}
    </motion.div>
  );
}

export function LiveNumber({ value, suffix, prefix, decimals = 0, compact }: { value: number; suffix?: string; prefix?: string; decimals?: number; compact?: boolean }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  return (
    <span ref={ref}>
      <NumberFlow value={inView ? value : 0} prefix={prefix} suffix={suffix} format={{ maximumFractionDigits: decimals, notation: compact ? "compact" : "standard" }} />
    </span>
  );
}

export function Film({ src, poster }: { src: string | null; poster: string | null }) {
  const [playing, setPlaying] = React.useState(false);
  const ref = React.useRef<HTMLVideoElement>(null);
  if (!src) {
    return (
      <div className="grid aspect-video place-items-center rounded-[22px] border border-white/10 bg-night-2 text-white/50">
        <span className="text-[14px]">Launch film renders with <code>pnpm video</code></span>
      </div>
    );
  }
  return (
    <div className="group relative overflow-hidden rounded-[22px] border border-white/10 bg-black shadow-[0_40px_120px_-40px_rgba(39,71,232,0.5)]">
      <video ref={ref} src={src} poster={poster ?? undefined} controls={playing} playsInline preload="metadata" className="aspect-video w-full" onPlay={() => setPlaying(true)} />
      {!playing && (
        <button
          onClick={() => {
            setPlaying(true);
            void ref.current?.play();
          }}
          className="absolute inset-0 grid place-items-center bg-black/25 transition group-hover:bg-black/15"
          aria-label="Play the Orbis Relay launch film"
        >
          <span className="flex items-center gap-3 rounded-full bg-white/95 py-3 pl-4 pr-6 text-[15px] font-semibold text-ink shadow-pop transition group-hover:scale-105">
            <span className="grid size-9 place-items-center rounded-full bg-cobalt text-white"><Play className="size-4 translate-x-px fill-white" /></span>
            Watch the launch film
          </span>
        </button>
      )}
    </div>
  );
}

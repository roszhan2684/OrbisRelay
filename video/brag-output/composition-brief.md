# Hyperframes Composition Brief: Orbis Relay

## Objective
Create a voiced launch film for Orbis Relay that shows the product pausing a risky AI action, a human resolving it on iPhone, and a signed receipt.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4` → copied to `apps/web/public/media/orbis-launch.mp4`
- Format: landscape — 1920x1080, 30fps
- Duration: 40s (voice-led override, see brag-plan.md)

## Source Material
- Project root: repository root
- Primary files read: apps/web/src/app/page.tsx, components/marketing/hero.tsx, components/phone.tsx, app/globals.css, lib/server/seed.ts, apps/ios screenshots
- Product name: Orbis Relay
- Tagline / strongest claim: "Control without killing autonomy."
- Key UI to recreate: the live gateway stream (hero) and the iPhone approval card (real iOS screenshot `assets/img/ios-detail.png`)
- Copy that must appear verbatim:
  - Control without killing autonomy.
  - Paused for human / Allowed / Denied
  - Pay new vendor $84,000

## Creative Direction
- Tone preset: polished; direction: quiet premium product film with cinematic restraint
- Angle: the pause — "Should they?"
- Hook: three real agent actions slam onto the frame
- Outro: wordmark + "Control without killing autonomy."
- Avoid: generic SaaS language, neon/glow clichés, gradient text, abstract filler

## Visual Identity
- Background #070b17, panels #0d1326 / #151d36, accent #2747e8, soft accent #8fa2ff/#b9c4ff, text #ffffff
- Fonts: Switzer (local woff2), Instrument Serif italic (local), JetBrains Mono (local)

## Storyboard
See brag-plan.md. Scenes: 0-4.6 / 4.6-8.2 / 8.2-14.8 / 14.8-20.8 / 20.8-30.2 / 30.2-35.0 / 35.0-40.0

## Audio
- Voiceover: assets/voice/vo1..vo7.wav (Kokoro af_heart), one per scene, start +0.3-0.4s
- Music: assets/music/happy-beats-business-moves-vol-12-by-ende-dot-app.mp3, volume lane: 0→0.16 fade, ~0.14 under VO, 0.32 outro swell, fade to 0 by 40s
- Cue guidance: strong cues 8.74 / 27.30 / 35.47 (lock); gateway rows on beats 15.29/16.38/17.47/18.56/19.66
- Audio-reactive: assets/audio-data.js (normalized rms + bass, 30fps, 1200 frames) → background glow + card presence, subtle
- SFX: assets/sfx/ (drop_001/002, impactSoft_medium_000, click3, impactGlass_light_001, impactBell_heavy_000)

## Hyperframes Instructions
Standalone index.html, one paused GSAP timeline at window.__timelines["orbis-launch"], every <audio> with an id, no crossorigin, local fonts via @font-face, `npx hyperframes check` must pass before render.

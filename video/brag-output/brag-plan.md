# Brag Plan: Orbis Relay

## What is this app?
A trust layer that sits between software intent and execution: AI agents and workflows ask Orbis before risky actions, deterministic policy decides in milliseconds, and high-impact actions pause on a verified human's iPhone with evidence, Face ID and a safe alternative — then return an Ed25519-signed receipt.

## The angle
"Should they?" Agents can already *act*. The film doesn't sell a dashboard — it sells the pause: the exact moment an AI tries something risky, Orbis stops it, a person sees why on their phone, chooses a safer path, and the software continues. Calm, precise, enterprise-premium (the site's own direction: "no neon hacker aesthetic").

## Hook (first 2-3 seconds)
Three real actions from the product slam onto a dark field — **Send $84,000**, **Deploy to Production**, **Export 120,000 records** — each tagged with the agent that wants to do it. VO: "Your AI agents can send money, ship code, and move data."

## Key moments (the middle)
- The question beat: the three actions freeze with an amber "paused" state; serif italic "Should they?"
- The live gateway: decisions stream in (Allowed / Paused for human / Denied) with real rule names and a 12ms latency stamp — "safe work stays automatic", 90% autonomy.
- The iPhone: the real Orbis iOS approval screen (captured from the simulator) for "Pay new vendor $84,000" — Face ID scan, then "Redirected safely" outcome.
- The receipt: signed decision receipt rows type in, SHA-256 + Ed25519 signature, green "Valid" seal.

## Outro / punchline
Wordmark lands on a strong beat. "Control without killing autonomy." (verbatim product principle).

## User flow worth showing
Agent proposes risky action → Orbis pauses it (approval required, risk 70 high, policy reason) → human approves a safe alternative on iPhone with Face ID → signed receipt returns to the calling software.

## Tone
- Preset: polished
- Creative direction: quiet premium product film with cinematic restraint
- Interpretation: slow confident holds, mixed-case type, one accent hue (cobalt), serif italic for emotional words only, no flashy transitions; motion is crisp UI-state change, not decoration.

## Format: landscape — 1920x1080
## Duration: 40s (override of the 15-25s default: user asked for a ~60s voiced marketing film; 40s keeps a 2.5 wps voiceover readable across three product surfaces without padding)

## Visual identity (from the project)
- Background: #070b17 (night), panels #0d1326 / #151d36
- Accent: #2747e8 (cobalt), soft #8fa2ff / #b9c4ff
- Text: #ffffff / white at 60% for secondary
- Risk colors: low #3dd68c, warn #ffb224, high #ec835a, deny #ff6369
- Display font: Switzer (Fontshare), serif accent Instrument Serif italic, mono JetBrains Mono
- Strongest visual element: the live gateway stream + the iPhone approval card

## Share copy (draft)
Your agents can act. Orbis Relay decides when they should ask first — policy in milliseconds, a verified human on iPhone for the rest, and a signed receipt for everything.

## Audio direction
- Role: warm bed under a continuous voiceover
- Music: happy-beats-business-moves-vol-12 (110 BPM)
- Music treatment: fade in 0-1.2s, sit at ~0.14 under VO, small lift in the 1.2s VO gaps, swell to ~0.3 for the outro, fade out over the final 1.5s
- Music cue guidance: preset `cues/happy-beats-business-moves-vol-12...music-cues.json` read. Strong cues used: 8.74s (logo reveal), 27.30s (safe-redirect tap), 35.47s (outro wordmark). Beat grid ~0.546s; gateway rows on every other beat 15.29 / 16.38 / 17.47 / 18.56 / 19.66 (≥1.09s apart, readable).
- Audio-reactive treatment: subtle; music RMS breathes the cobalt background glow and the bass gives the phone/receipt card a faint presence lift. No visualizer graphics.
- SFX posture: sparse, low-HF-risk: soft drops on first/last gateway rows, soft impact on logo reveal, click on the iPhone tap, glass ping on the valid seal, bell on the outro.
- Restraint rule: never stack SFX on VO consonants; nothing louder than the voice.

## Voiceover script
1. Your AI agents can send money, ship code, and move data. (3.7s)
2. But should they? Right now, without asking anyone? (2.7s)
3. This is Orbis Relay. The trust layer between what software wants to do, and what it's allowed to do. (5.7s)
4. Deterministic policy decides in milliseconds, so safe work stays automatic. (5.0s)
5. High-impact actions pause, and land on the right person's iPhone. Evidence, Face ID, and a safer path. Not just a no. (8.1s)
6. Every decision comes back signed. Anyone can verify it. (3.5s)
7. Orbis Relay. Control, without killing autonomy. (3.1s)
Voice: Kokoro af_heart. Each line starts 0.3-0.4s into its scene.

## Storyboard

### Scene 1 — Agents can act — 4.6s (0.0-4.6)
Three action cards slam in one by one (Send $84,000 · AP Payment Run / Deploy to Production · CI Deployer / Export 120,000 records · Warehouse Export). Headline "Your agents can act." Ghost grid behind.
Sequential/interaction: yes — 3 cards, ~0.9s apart, then hold.
Audio intent: music fades in under the first line. Audio-coupled idea: soft drop per card.
Transition mood: soft → Scene 2

### Scene 2 — Should they? — 3.6s (4.6-8.2)
Cards dim and gain an amber "Awaiting decision" state; big serif italic "Should they?" with small "Right now, without asking anyone?".
Sequential/interaction: none. Audio intent: tension, room to breathe.
Transition mood: clean → Scene 3

### Scene 3 — Orbis Relay — 6.6s (8.2-14.8)
Logo mark + wordmark land on 8.74s (beat-locked). Relay diagram: propose → ORBIS → allow / pause for human / deny draws left to right. Line: "The trust layer between software intent and execution."
Audio-coupled idea: soft impact on the logo land.
Transition mood: clean → Scene 4

### Scene 4 — The gateway — 6.0s (14.8-20.8)
Live decision stream recreated from the site hero: five rows arrive on beats with decision pills and rule names; side stat "90% stays autonomous" and "p95 16ms".
Sequential/interaction: yes — 5 rows on every other beat; each row holds once landed.
Transition mood: slide → Scene 5

### Scene 5 — The iPhone — 9.4s (20.8-30.2)
Real Orbis iOS screenshot ("Pay new vendor $84,000", High risk 70, policy reason, safe alternative) in a phone frame; side captions "Evidence", "Face ID", "A safer path". Face ID scan overlay, tap on the safe-alternative button at 27.30s (beat-locked), outcome card "Approved — $1 verification deposit first · receipt signed".
Audio-coupled idea: click on tap, subtle chime on outcome.
Transition mood: clean → Scene 6

### Scene 6 — Signed receipt — 4.8s (30.2-35.0)
Receipt card: receipt id, policy v9, approver + Face ID, envelope hash, Ed25519 signature typing; green "Valid — signed by Orbis and unmodified" seal.
Audio-coupled idea: glass ping on the seal.
Transition mood: soft → Scene 7

### Scene 7 — Outro — 5.0s (35.0-40.0)
Wordmark lands at 35.47s; "Control without killing autonomy." Small footer: "Gateway · iPhone · Signed receipts". Music swells then fades.

**Music mood for this video:** upbeat-restrained corporate
**Audio summary:** a warm bed that steps aside for the voice, with three beat-locked moments and a bell on the final wordmark.

Note: all names in the UI (Northstar Cloud, Alex Chen, vendors) are fictional demo data from the seeded tenant.

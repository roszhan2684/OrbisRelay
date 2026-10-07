# Hyperframes Composition Brief: Orbis Relay v2

## Objective
A voiced launch film for the v2 Endpoint Intelligence release.

## Output
- Composition directory: `composition/`
- Rendered video: `brag.mp4`
- Format: landscape, 1920x1080, 30 fps
- Duration: 42.5s (voice-driven; see the plan)

## Source material
- Project root: repo root
- Files read: README.md, apps/web/src/app/page.tsx (IntelligenceSection), apps/web/src/app/console/intelligence/*, apps/ios/.../ApprovalDetailView.swift (mlCard), apps/macos-endpoint (pipeline), ml/models/risk_classifier/*/release_gate_report.json, fixtures/endpoint-events/hero-signal.coreml.json
- Strongest claim (verbatim): "A model that can ask for a human. Never one that can approve."
- Measured numbers on screen:
  - 31 µs (recorded hero inference)
  - 38 µs p50 / 57 µs p95
  - 19/19 gates
  - risk 0.99
  - 1.1.0 failing "golden scenarios no regression" and "protected slice regression"
- UI to recreate: the endpoint pipeline and verdict, the iPhone edge-risk card, the model registry rows

## Creative direction
Polished, v1-consistent, with one dry honest beat. Avoid generic AI imagery (no brains, no particles).

## Visual identity
Same tokens and local fonts as v1 (`brag-output/composition`): #070b17 / #2747e8 / #8fa2ff / Switzer / Instrument Serif italic / JetBrains Mono.

## Audio
- Music: `assets/music/happy-beats-business-moves-vol-12-by-ende-dot-app.mp3`, automation 0 → 0.15 under the VO, swelling to 0.3 at the outro and fading to 0
- Cue source: bundled preset. Beat locks at 13.11, 27.30, 32.74 and 36.55; beat grid for the pipeline stages.
- Audio-reactive: RMS → glow opacity/scale, bass → phone/panel shadow (`assets/audio-data.js`)
- SFX: chosen after animation exists, from `sfx-analysis.md`, low-HF picks
- VO: `assets/voice/vo1-6.wav` on their own track at the scene starts plus 0.3s

## Gate
`npx hyperframes check` must report 0 errors before render.

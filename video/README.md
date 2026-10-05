# Launch film

Made with the `/brag` workflow + Hyperframes. `brag-output/brag-plan.md` is the creative plan and storyboard, `composition-brief.md` the handoff, `composition/index.html` the film itself (one paused GSAP timeline, Kokoro voiceover per scene, music bed with ducking automation, audio-reactive glow).

The music bed (“Business Moves vol. 12” by ende.app) is not redistributed here — copy it into `composition/assets/music/` from the brag skill before re-rendering.

```bash
cd brag-output/composition
npx hyperframes check                                    # gate: 0 errors
npx hyperframes render --quality delivery --output ../brag.mp4
```
The published copy lives at `apps/web/public/media/orbis-launch.mp4` (poster baked as frame 0, loudness normalized to −16 LUFS).

# Brag Plan: Orbis Relay v2 — Endpoint Intelligence

## What is this app?
Orbis Relay is a trust layer that agents ask before risky actions. v2 adds a risk model trained in the repo that runs on the Mac with Core ML (about 40 µs), plus 19 release gates. The model can raise an action to a verified human on iPhone, but it can never approve one.

## The angle
"The model is never the boss." Most AI-security launches sell the model as the authority. Orbis sells the opposite: a fast, local, honest model that knows its place. It raises its hand and policy decides. Even our own retrained model got blocked by the gates, so we say it plainly.

## Hook (first 2-3 seconds)
A real tool call types out on a dark field: `llm.summarize(4 contracts) → quickscribe-ai.app`, tagged **Not approved**. VO: "An AI agent is about to send four confidential contracts to an AI tool nobody approved."

## Key moments
- **On the Mac:** the endpoint pipeline lights up stage by stage (schema → 85 features → behaviour → Core ML → decision). The verdict slams in on a beat: **HIGH RISK · 0.99 · 31 µs**, with the real reason codes.
- **The rule:** Policy *decides*; the model *can only raise* (allow → warn → human). A crossed-out downward arrow reads "never lowers".
- **iPhone:** a recreated approval card shows the edge-risk sentence in plain English. Face ID, then tap "Redirect to Approved Internal Model", then "Redirected safely".
- **Gates:** registry rows. 1.0.0 is in production with 19/19 gates. 1.1.0 ticks through its gate list, two fail, and a **BLOCKED** stamp lands on a beat.

## Outro / punchline
Wordmark plus "A model that can ask for a human. Never one that can approve." (the verbatim homepage headline).

## User flow worth showing
Agent proposes an action → the endpoint scores it locally with Core ML → policy plus fusion route it to a human → the iPhone shows the evidence → Face ID → safe redirect.

## Tone
- Preset: polished
- Creative direction: quiet premium product film, matching v1's look, with one dry beat of honesty ("got blocked")
- Interpretation: confident holds, mixed-case type, a single cobalt accent with risk colors used only for verdicts, crisp UI-state motion, nothing flashy.

## Format: landscape — 1920x1080
## Duration: 42.5s
This overrides the 15-25s default: the request is a voiced update film, six Kokoro lines total 38.3s, and the scenes flex to the voice, the same approach as the v1 40s film.

## Visual identity (from the project)
- Background #070b17, panels #0d1326 / #151d36
- Accent #2747e8 cobalt, soft #8fa2ff / #b9c4ff
- Text #ffffff, muted #a7b0c8
- Risk colors: ok #3dd68c, warn #ffb224, high #ec835a, deny #ff6369
- Fonts: Switzer (display/body), Instrument Serif italic (emotional words), JetBrains Mono (code/metrics)
- Strongest visuals: the endpoint pipeline verdict, the iPhone edge-risk card, the blocked candidate

## Share copy (draft)
We put a risk model on the Mac that runs in about 40 µs and can only ever ask for a human. Then our own retrained model failed its release gates, and we shipped that too.

## Audio direction
- Role: warm bed under continuous voiceover
- Music: happy-beats-business-moves-vol-12 (110 BPM)
- Music treatment: fade in, sit at about 0.15 under the VO with small lifts in the gaps, swell for the outro, fade out over the last 1.5s
- Music cue guidance: bundled preset read. Beat locks:
  - 13.11s: Core ML verdict
  - 27.30s: iPhone tap
  - 32.74s: BLOCKED stamp (strongest, 1.00)
  - 36.55s: wordmark
  - Pipeline stages ride every other beat: 8.74 / 9.83 / 10.93 / 12.02
- Audio-reactive: subtle. Music RMS breathes the cobalt background glow, and bass lifts the phone and registry-panel presence. No visualizer graphics.
- SFX: sparse and low-HF. Soft keyticks on the hook typing (thinned), a soft impact on the verdict, a click on the tap, a muted thud on BLOCKED, a bell on the outro.
- Restraint: nothing louder than the voice, and no SFX on consonant-heavy VO moments.

## Voiceover script (Kokoro af_heart)
1. An AI agent is about to send four confidential contracts to an AI tool nobody approved. (6.34s)
2. Before it leaves the Mac, Orbis scores it right on the device. A model we trained ourselves, running in Core ML, in about forty microseconds. (8.94s)
3. But the model is never the boss. Policy decides. The model can only raise its hand, and ask for a human. (6.42s)
4. So the right person sees why, in plain English, on their iPhone, and sends it somewhere safe instead. (5.76s)
5. And no model ships on vibes. Nineteen release gates. Even our own retrained model got blocked. (6.12s)
6. Orbis Relay. A model that can ask for a human. Never one that can approve. (4.76s)

## Storyboard
### Scene 1 — The tool call — 0.0-7.0s
The "Procurement Agent" chip. A code card types `llm.summarize(` / 4 file names / `→ quickscribe-ai.app`. Then a red "Not approved" pill lands. The card then shows the metadata the endpoint keeps: classification confidential · destination external_ai_provider · unverified · domain_hash 627343a6… · count 4. Caption: "Metadata only. The destination is hashed on the Mac."
Sequential: typed lines, then 4 metadata pills one by one (held). Audio: thinned keyticks. Transition: soft.

### Scene 2 — On the Mac — 7.0-16.4s
A macOS window, "orbis-endpoint". Five pipeline stages light up in sequence on the beat grid. A feature list shows real values (x_sensitive_untrusted 1, first_destination 1, class_rank 0.50). Verdict card at 13.11: HIGH RISK · 0.99 · 31 µs · Core ML fp32 · Apple M4 Pro, with reasons "Sensitive data to an unverified destination" and "Destination never used by this actor". Side stat: "38 µs p50 · 57 µs p95".
Audio: soft impact on the verdict. Transition: clean.

### Scene 3 — The rule — 16.4-23.3s
Left: POLICY, "decides". Right: MODEL, "can only raise". A ladder allow → warn → human lights upward from the model side. A down arrow is struck through: "never lowers". Serif line: "It can ask for a human. Never approve."
Transition: clean.

### Scene 4 — iPhone — 23.3-29.6s
Phone slides up showing the approval card, "Send 4 contracts to external AI", High risk, the EDGE RISK SIGNAL sentence, and "Endpoint (coreml-fp32) + gateway · 1.0.0". Face ID pulse, tap on "Redirect to Approved Internal Model" at 27.30, then a "Redirected safely" sheet.
Audio: click at the tap.

### Scene 5 — Gates — 29.6-36.1s
Registry panel row: `1.0.0 · production · 19/19 ✓`. Row: `1.1.0 · candidate`, gate checks tick (gold recall ✓, false-positive budget ✓, latency ✓, golden scenarios ✗, protected slice ✗). BLOCKED stamp at 32.74. Headline "No model ships on vibes."
Audio: muted thud on the stamp.

### Scene 6 — Outro — 36.1-42.5s
Orbis mark plus wordmark at 36.55. "A model that can ask for a human. *Never one that can approve.*" Footer: "v2 · Endpoint Intelligence · orbis-relay.vercel.app". Bell, then fade.

**Audio summary:** a steady warm bed under a calm voice, accents only on verdicts and decisions, a swell into the wordmark.

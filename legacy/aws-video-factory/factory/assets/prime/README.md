# Prime host thumbnails

Drop four transparent-background PNGs of Prime here. The renderer in
`factory/thumbnail.ts` reads `<tone>.png` based on the video's mood.

| File           | When it's used                                 | Suggested expression       |
| -------------- | ---------------------------------------------- | -------------------------- |
| `bullish.png`  | Up day / profit growth                         | Confident smile, arms open |
| `bearish.png`  | Down day / profit drop                         | Concerned, hand on chin    |
| `shock.png`    | Move ≥ ±2% (daily) or ≥ ±25% (earnings)        | Wide-eyed, mouth agape     |
| `neutral.png`  | Flat / mixed                                   | Neutral, slight smile      |

## Specs
- **Dimensions:** at least 1080 px tall (renderer scales to 720 px canvas height).
- **Aspect:** roughly 3:4 portrait (head + shoulders); will be anchored to bottom-right.
- **Background:** transparent. PNG with proper alpha channel.
- **Lighting:** warm rim light from the right works best against the dark blue canvas.
- **Framing:** leave ~10% headroom; chin should sit near the bottom edge.

## How to produce them once
1. Pick one consistent reference photo of Prime.
2. Generate the four expressions with an image model (Midjourney, Flux, Stable Diffusion) using the same seed/prompt prefix so identity stays stable.
3. Cut out the background (remove.bg / Photoshop / `rembg` CLI).
4. Save as `bullish.png`, `bearish.png`, `shock.png`, `neutral.png` in this folder.

## Fallback
If a tone's PNG is missing the renderer falls back to a tone-matching emoji
(`🚀`, `📉`, `💥`, `🔍`) so the pipeline never breaks. Add the PNGs and
re-run — no code changes required.

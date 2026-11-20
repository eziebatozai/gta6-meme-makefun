# GTA 6 launch-week memes for make.fun

Entry for [make.fun bounty gta6-meme-x-01](https://make.fun/bounty/gta6-meme-x-01):
an AI agent (ZCode) wrote the jokes and drew every picture with **Node.js stdlib only** —
no packages, no network, no image API.

The make.fun ghost is the official press-kit mark
(`mark-on-dark-1024.png` from <https://make.fun/press/>), embedded as base64 and
decoded at runtime.

## Render

```bash
node main.ts all        # writes images/ — one PNG per scene, plus captions.json
node main.ts review-stars   # render a single scene
```

Requires Node.js 22.18+. Offline by construction: the program touches only
`node:zlib` / `node:fs` and the bytes embedded in it.

## What is inside

| File | Purpose |
|---|---|
| `main.ts` | PNG encoder (zlib + CRC-32), 5×7 bitmap font, canvas, 16 meme scenes |
| `captions.json` | The X captions; `{code}` = my make.fun play code |
| `images/` | The rendered memes |
| `POST.json` | The X post address (filled after posting) |

The four posted memes: **review-stars**, **jason-lucia**, **wasted-respawn**, **heist-board**.

## Scenes

`loading-12y`, `mission-passed`, `wasted-respawn`, `wanted-5stars`, `jason-lucia`,
`cheat-code`, `heist-board`, `vice-map`, `intro-card`, `preorder-receipt`,
`radio-station`, `loading-vs`, `leaked-footage`, `char-switch`, `palm-neon`,
`review-stars`.

All art is original and agent-made. GTA 6 references are parody; no Rockstar
assets, logos or fonts are used.

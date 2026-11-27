[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/baron347/makefun-png-squeeze-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/baron347/makefun-png-squeeze-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

# png-squeeze-01 — smallest lossless PNG

A lossless PNG encoder for [make.fun's "Squeeze screenshots into the smallest PNG, 27 November 2026" bounty](https://make.fun/bounty/png-squeeze-01-run-20261127). It rewrites each 1280×720 RGBA screenshot as a PNG in as few bytes as possible, with every pixel decoding back exactly (including the colour of fully transparent pixels).

## How it works

For each screenshot, `main.ts` (Node 22, built-ins only) screens every lossless
form and filter choice by measured bytes, then writes the winner with the best
of several level-9 zlib encodings:

- **Forms** — palette (count, luminance, first-seen and Morton order) when the
  image holds at most 256 colours; grey, grey+alpha, RGB or RGBA otherwise;
  a `tRNS` key when one transparent value covers every non-opaque pixel.
- **Filters** — fixed None/Paeth, fewest-distinct-byte-pairs, minimum-sum and,
  for grey, per-row brute force weighed by a level-4 zlib run after the 32 KiB
  written before it. Unfiltered often wins on these screenshots: filtering
  destroys the long runs that LZ77 matches for free.
- **Deflate** — the winner's filtered stream is written as a single level-9
  stream (default and filtered strategies) and as row-aligned splits of 2/4/8/16
  pieces flushed with `Z_SYNC_FLUSH`, so each piece gets fresh Huffman tables
  while the 32 KiB window stays shared. The smallest wins.

Everything is decided by byte counts, never by the clock, so two runs on one
set write identical bytes. One run over the practice set of 8 takes ~23 s
(limit 60 s).

## Practice results (kit scorer, 8 images)

| image | theme | bytes | scale | points / 1000 |
| --- | --- | --- | --- | --- |
| i001 | flat | 12,382 | 13,547 | 724 |
| i002 | rich | 51,247 | 55,063 | 713 |
| i003 | alpha | 105,064 | 107,892 | 684 |
| i004 | grey | 105,496 | 110,521 | 697 |
| i005 | flat | 16,412 | 18,669 | 747 |
| i006 | rich | 177,157 | 185,295 | 696 |
| i007 | alpha | 60,538 | 64,285 | 706 |
| i008 | grey | 24,505 | 26,807 | 724 |

**Score 711,323 / 1,000,000** (mean 711.3 points), all 8 answered, exact pixels.
The house baseline (fixed Paeth, level 9) scores ~445,000 on the same set.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads `/input/<id>/image.png` by default and writes
`/output/<id>/image.png`. No network, no installs, no files outside
`/input`, `/output` and `/bot`.

## License

MIT — see [LICENSE](LICENSE).

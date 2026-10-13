# Vendored: Cactus Needle 2 runtime

These two files are copied verbatim from the Cactus Compute Needle 2 release so
the experimental `needle` engine has no build step and no runtime dependency
beyond fetching the model archive.

| File | Bytes | SHA-256 |
|---|---|---|
| `needle.js` | 62 433 | `06499ec635d7e2790cb84791bc0e323fa4d0c5a8948108ca357b76685e085a66` |
| `needle.wasm` | 334 418 | `cf2f9120b414f63fe918fc571f04a7a4992b81591f6b39b5658aa13b9870d4f9` |

- Source: <https://huggingface.co/Cactus-Compute/needle2/tree/main/wasm>
- Project: <https://github.com/cactus-compute/needle>
- Engine version: `2.0.4` (from the model's `config.json`)
- License: Apache-2.0

The model archive itself (`needle2.cact`, 13 737 807 bytes, engine `2.0.4`) is
**not** vendored — it is fetched at runtime from
<https://huggingface.co/Cactus-Compute/needle2/resolve/main/needle2.cact> and
cached in Cache Storage under `needle2-weights-v1`. For local tuning,
`node tools/needle-bench.mjs --download` puts the same file in `.cache/`.

# musegod.ai brand assets

The public brand became `musegod.ai` on 2026-10-08. The existing artwork, source directories and provenance remain unchanged; their `musecity` names record the original asset history.

The interface uses wine, warm gold and cream. The active white-and-gold crowned mascot is based on the images supplied from `/Users/admin/Desktop/musecity` on 2026-09-26. Its original files, generated transparent illustration, exact generation prompt and export hashes are kept in `musecity-mascot-set/`.

| Web asset | Source and purpose |
| --- | --- |
| `apps/web/public/brand/icon.png` | Supplied `logo.png`, resized to 256 × 256; navigation, sidebar and Privy login icon |
| `apps/web/public/brand/favicon.png` | Supplied `logo.png`, resized to 64 × 64; browser favicon |
| `apps/web/public/brand/horizontal.webp` | Supplied `cover image.png`, resized to 1000 × 563; retained historical login export, no longer used by the login UI |
| `apps/web/public/brand/mascot.webp` | Generated transparent mascot, resized to 640 × 800; homepage, empty states, sidebar and profile decoration |

The four supplied reference files are copied without changes. `musegod-1.jpeg` is retained as the alternate black-and-gold reference; the active UI follows the white-and-gold logo and `musegod-2.jpeg`. The transparent illustration was created with the built-in `image_gen` tool using the exact prompt in `musecity-mascot-set/prompt.txt`. Web exports only resize and encode: PNG compression level 9; WebP quality 86 with alpha quality 100. No cropping, background flattening or enlargement. Source-to-export mappings, dimensions and SHA-256 values are in `musecity-mascot-set/source.json`.

The four migration originals and their original provenance remain protected in `musecity-logo-set/`:

| Location | Contents and purpose |
| --- | --- |
| musecity-logo-set/originals/horizontal.png | Horizontal wordmark |
| musecity-logo-set/originals/icon.png | Navigation and favicon artwork |
| musecity-logo-set/originals/crest.png | Community crest |
| musecity-logo-set/originals/vertical.png | Homepage illustration |
| musecity-logo-set/source.json | Original source, dimensions, historical public paths and SHA-256 hashes |

`corepack pnpm guard` from `apps/web` checks the four protected migration originals, all new reference/generated files, the generation prompt and the active public exports. Preserve the migration originals and their provenance byte-for-byte; the public paths in that historical manifest describe the original migration, not the current exports. The retired public `horizontal.png`, `crest.png` and `vertical.png` copies were removed during this replacement.

Retired predecessor artwork, exports and archives were removed from this repository at the user's request on 2026-09-26. See [PLAN.md](../PLAN.md) for the cleanup record and repository-external recovery backup.

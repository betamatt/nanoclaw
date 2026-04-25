# Setup and Scripts

## setup/groups.ts — Baileys v6.x fixes

**Intent:** Fix WhatsApp group sync for Baileys v6.x with retry logic.

**How to apply:**
1. Update Baileys imports from default to named imports (v6 syntax)
2. Add `getPlatformId` workaround for Baileys 6.x charCode bug
3. Add `fetchLatestWaWebVersion()` call for socket version
4. Wrap socket creation in `connect()` function with retry logic (up to 3 attempts on auth failure, 3s delay)

Note: Check if upstream has already updated Baileys handling. If so, apply only the retry logic on top.

## setup/index.ts

**How to apply:** Add `'whatsapp-auth': () => import('./whatsapp-auth.js')` to the `STEPS` object.

## setup/whatsapp-auth.ts (new)

Copy as-is from main tree.

## scripts/backfill-sdlc-labels.ts (new)

Copy as-is from main tree. One-time migration script for backfilling GitHub labels from the SDLC database.

## GitHub workflows

### .github/workflows/bump-version.yml and update-tokens.yml

These have minor modifications. Check upstream versions first — if upstream has newer workflows, use those and skip these changes.

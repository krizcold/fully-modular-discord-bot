# /app/custom/ - User Overlay

This directory mirrors the layout of `/app/src/`. Any file you place here
overrides the matching file under `/app/src/` when the bot rebuilds its
working tree at `/app/build/`.

## How it works

On every boot, `start.sh` compares the image version against the last
applied version. On mismatch (a fresh image, or a code update), it:

1. Wipes `/app/build/`.
2. Copies `/app/src/` to `/app/build/`.
3. Walks `/app/custom/` and overwrites matching paths in `/app/build/`.
4. Copies each installed App Store module from `/data/appstore-modules/`
   into `/app/build/bot/modules/<module>/`, replacing that whole folder.
   Any overlay file you placed under `bot/modules/<module>/` for an
   installed App Store module is discarded at this step.
5. Compiles `/app/build/` with TypeScript into `/app/dist/`.

## Rules

- File-level granularity. Drop a single `.ts` or `.json` here and only
  that one file gets overridden, except under an installed App Store
  module's folder (see step 4).
- Files that do not exist under `/app/src/` are still copied (additive
  overrides allowed), except under an installed App Store module's
  folder (see step 4).
- `bot/internalSetup/` is locked. Anything you put under
  `/app/custom/bot/internalSetup/` is silently ignored to keep the
  system stable.
- This directory is never modified by the bot or the bot manager. It is
  yours.

## Dev modules

Place experimental modules under `/app/custom/modulesDev/<name>/`. They
load alongside AppStore modules but are managed entirely by you.

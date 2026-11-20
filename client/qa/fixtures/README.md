# QA fixtures

- `qa-wide.json`: a wide map for the capture and layout instruments.
- `stress-map.json`: 1500 bodies with three shapes each, the heavy editor content for `perf.mjs` `ui.stressEditor` (openEditorMap, editorSelect, editorDrag, testPlayStart). Loaded as the editor draft (`localStorage["neobox.editor.draft"]`).
- `active-4min.nbreplay`: a 4-minute two-player match (gzip JSON, replay version 2, 48 seek checkpoints) with both players moving, jumping, batting and pushing on a seeded key pattern, the heavy replay content for `perf.mjs` `ui.replay` (openReplay, seekReplay, gated). Recorded on a build of 70f3aff by driving `matchWithGuest` with seeded key holds and saving it from the postgame. A replay records inputs only, so it stays valid while the replay format version is unchanged; record it again when the version changes.
- `active-4min-nocheckpoints.nbreplay`: the same kind of match recorded before checkpoints existed (no `checkpoints` field, gzip JSON, replay version 2). `perf.mjs` `ui.replay` times it too, as `openReplay.noCheckpoints` and `seekReplay.noCheckpoints`, reported and not gated: its seeks wait on the background keyframe build.

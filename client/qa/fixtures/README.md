# QA fixtures

- `qa-wide.json`: a wide map for the capture and layout instruments.
- `stress-map.json`: 1500 bodies with three shapes each, the heavy editor content for `perf.mjs` `ui.stressEditor` (openEditorMap, editorSelect, editorDrag, testPlayStart). Loaded as the editor draft (`localStorage["neobox.editor.draft"]`).
- `active-4min.nbreplay`: a 4-minute two-player match (gzip JSON, replay version 2) with both players moving, jumping, batting and pushing on a seeded key pattern, the heavy replay content for `perf.mjs` `ui.replay` (openReplay, seekReplay). Recorded on a build of 36726ec by driving `matchWithGuest` with seeded key holds and saving it from the postgame. A replay records inputs only, so it stays valid while the replay format version is unchanged; record it again when the version changes.

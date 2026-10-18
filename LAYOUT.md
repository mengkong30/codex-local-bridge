# Layout validation

Command: `validate-layout`. MCP: `local_figma_validate_layout`. DSH: `validate-layout <nodeId> --binding ... --client ... --out report.json` (writes report + PNG files).

Fields: `nodeId` (root; omitted means bound page), `canvasId` (optional target canvas for loose nodes), `expectedSize:{width,height}`, `expectedFonts:[family,...]`, `screenshots` (default true), `includeHidden` (default false), `maxNodes` (default 5000, max 20000), `tolerance` (default 1 px). Scope validation applies to root and canvas. Exports up to four top-level frames when validating a page; a specific root produces its own screenshot, max 2048 px longest edge. Reports carry scale and original target dimensions.

Issue entries contain `nodeId`, named `path`, `code`, `severity`, `message`, `suggestion`, `confidence`, bounds and related nodes when relevant.

| Check | Method / limits |
|---|---|
| OUTSIDE_PARENT | Child corners in parent coordinates, including transforms; clipped frames raise errors |
| LABEL_OVERLAP | Overlapping sibling text bounds; rotated glyphs and intentional overlays need visual confirmation |
| TEXT_CLIPPING | Text/font-size/line-height estimate versus fixed box/maxLines; **heuristic**, not exact glyph measurement |
| ABNORMAL_TEXT_BOX | Text box much larger than estimated label content; catches giant imported SVG label boxes |
| MISSING_FONT | Native `hasMissingFont` flag |
| UNEXPECTED_FONT | Compare actual font families to explicit expectedFonts; does not prove silent OS fallback |
| LOW_CONTRAST | Solid text paint composited over known solid ancestors; 4.5:1 / large text 3:1; complex backgrounds noted for review |
| EMPTY_TEXT / EMPTY_LAYER | Empty visible text/container without rendered content |
| ORPHAN_CANDIDATE | Loose top-level nodes outside frames; information, not an instruction to delete |
| OUTSIDE_CANVAS | Visible page sibling outside explicit canvasId; reference artwork may be intentional |
| EXPORT_SIZE_MISMATCH | PNG IHDR dimensions versus expected canvas and export scale |

Node limit sets `truncated:true`; overlap scanning has a pair budget and reports that limit. A truncated report is not proof that a whole page passes.

Use the loop: write → validate/export → inspect PNG + located issues → apply targeted updates → validate the same canvas. Screenshots are returned as image blocks by MCP, and saved by DSH when --out is used. Visual review uses the calling agent's existing vision capability; no separate cloud API key or visual-model service is provisioned. Automatic repair is deliberately not performed.

Figma API references: [text segments](https://developers.figma.com/docs/plugins/api/properties/TextNode-getstyledtextsegments/), [text auto resize](https://developers.figma.com/docs/plugins/api/properties/TextNode-textautoresize/), [text truncation](https://developers.figma.com/docs/plugins/api/properties/TextNode-texttruncation/).

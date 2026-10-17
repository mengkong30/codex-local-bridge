---
name: local-figma
description: Connect to local Figma Desktop with Codex Local Bridge; read the current selection, pages and layers, and export PNG or SVG assets. Use for reading or editing an authorized local Figma file. No API key required.
---

# Codex Local Bridge

Use the local_figma_connect tool to start the local service and verify live Figma connectivity. If disconnected, give the returned manifest path and ask the user to import and run Codex Local Bridge in Figma Desktop. No key is needed. Keep the Figma plugin open while working.

Use local_figma_document for the active page and selection. Use local_figma_pages for top-level nodes, local_figma_node for bounded node inspection, and local_figma_export for PNG or SVG. Obtain node IDs from these reads; never invent them. The exposed MCP tools read designs; the local HTTP /command API also supports structured writes. Inspect bridge-capabilities and the current implementation before using write fields.

The bridge listens only on localhost:37821. It automatically starts when a tool is called. Do not use the unrelated Figma Bridge plugin. Do not claim connectivity from a running service alone: require a successful document response.

### Text alignment (v5)

`build-section` TEXT specs and `update-node` props support `textAlignVertical` (`TOP`, `CENTER`, `BOTTOM`) and `textAlignHorizontal` (`LEFT`, `CENTER`, `RIGHT`, `JUSTIFIED`). Alignment fields are rejected for non-TEXT nodes and invalid values. Read back the property after writing. Already running Figma plugins must be restarted to load updated code; verify `bridge-capabilities.version` is at least 5 before relying on these fields.

### Multiple files (0.2.0 / server protocol v2)

Keep the plugin running separately in each target file. `local_figma_status` returns `connections` with file/page names and `connectionId`. Pass that ID to every targeted tool or HTTP `/command`. Each connection has a separate serial queue; different connections may run concurrently. If more than one file is connected, an omitted ID is rejected, never guessed. A disconnected target is rejected. A dispatched timeout leaves the outcome uncertain and blocks later commands on that connection until the late result arrives or its plugin restarts with a new ID; inspect before retrying writes. No cross-file transaction or automatic rollback is promised. Both server and Figma plugin must be updated; check `/health.protocolVersion == 2`.

### Diagnostics (0.2.2 / bridge v6)
The /health response includes command, progress and lastResult per connection. Writes and exports wait up to 60 seconds; reads wait up to 15 seconds. An uncertain timeout still blocks later commands until its result arrives; do not replay writes. Inspect loading-font versus building progress and lastResult roots. Result acknowledgement retries are idempotent. build-section preloads each distinct font before creating nodes. Restart the Figma plugin after updating code; require bridge-capabilities.version 6 to validate this runtime.


### Public distribution
The service is unauthenticated, loopback-only and not a security boundary. Origin checks do not block every opaque browser context. Read README.md, SECURITY.md and PRIVACY.md from the plugin root when deployment or data handling matters. Local transport does not make a cloud assistant offline. Do not expose the port or request user secrets. Use only authorized files and operations; installing this skill does not authorize arbitrary writes or publication.

When inspecting source fields, use the current installed plugin root, not a remembered absolute path. Read back edited attributes and export a bounded target for visual confirmation. build-section creation ignores visible; update-node supports it but has a narrower field whitelist. Do not expand the plugin just to bypass an unsupported design field unless the user authorizes plugin development.

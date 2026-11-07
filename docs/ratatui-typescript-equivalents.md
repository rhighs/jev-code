# TypeScript equivalents to Rust Ratatui

Ratatui is an immediate-mode Rust TUI library: you draw widgets into rectangular areas on every frame, with a constraint-based layout solver and a cell diff renderer. There are three practical TypeScript paths, depending on whether you want the same engine, a modern native renderer, or the classic widget toolkit model.

Versions and dates below were checked on 2026-11-07.

## Summary

| Need | Package | Latest | Last published | Status |
| --- | --- | --- | --- | --- |
| Literal Ratatui bindings | `ratatui-ts` / `ratatui` | 0.1.3 / 0.1.15 | 2025-09-15 | One release, native Rust build, `ffi-napi`, Node 18-20 guidance |
| Modern TS-native renderer | `@opentui/core` | 0.8.3 | 2026-11-07 | Active, Zig core, Bun 1.4+ or Node 26.4+, MIT |
| Classic widget toolkit | `blessed` / `neo-blessed` | 0.1.81 / 0.2.0 | 2015 / 2018 | Closest widget model, effectively unmaintained |
| Low-level terminal toolkit | `terminal-kit` | 3.1.4 | 2026-07-19 | Active, screen buffer and widgets, less structured |
| React for CLIs | `ink` | 8.0.0 | 2026-10-03 | Active, declarative output, not a Ratatui equivalent |

## Option A: literal bindings

`ratatui-ts` exposes the Rust Ratatui engine through a C ABI with TypeScript helpers for widgets, layout, batched frames, and headless snapshots. Widget coverage matches Ratatui: Paragraph, List, Table, Gauge, Tabs, BarChart, Sparkline, Chart, Scrollbar, Canvas, and LineGauge.

- npm: `ratatui-ts@0.1.3` and `ratatui@0.1.15`, both published once on 2025-09-15
- Repository: <https://github.com/holo-q/ratatui-ts>
- Dependencies: `ffi-napi`, `ref-napi`, `ref-struct-di`, `ref-union-di`, `ref-array-di`
- Requires a locally built `ratatui_ffi` cdylib, or the prebuilt libraries the package ships
- Its README recommends Node 18-20 and calls out `ffi-napi` rebuild failures on newer Node releases

This is the only option that is literally Ratatui, but it is a single-release package with a native build step and stale FFI dependencies. It does not match this repository's Bun-first distribution.

## Option B: `@opentui/core` (recommended)

OpenTUI is a native terminal UI core written in Zig with TypeScript bindings. It renders a component tree, lays it out with Flexbox through Yoga, handles input, and updates only changed cells.

- npm: `@opentui/core@0.8.3`, published 2026-11-07, MIT
- React and Solid bindings at the same version: `@opentui/react`, `@opentui/solid`
- Requires Bun 1.4 or later, or Node 26.4 or later with `--experimental-ffi`
- Prebuilt native packages for macOS, Linux (glibc and musl), and Windows
- Components: Box, Text, ScrollBox, ScrollBar, TextTable, Code, Markdown, Diff, Input, Select, Slider, FrameBuffer, Image, Video, QR code, embedded terminal
- Docs: <https://opentui.com/docs>
- Repository: <https://github.com/anomalyco/opentui>

Differences from Ratatui: retained component tree instead of immediate-mode `terminal.draw`, Flexbox instead of Ratatui's constraint solver, and no direct Sparkline, Chart, or Canvas widgets. Use `FrameBuffer` or custom rendering for those.

A minimal app runs under Bun with no extra setup:

```ts
import { BoxRenderable, TextRenderable, createCliRenderer } from "@opentui/core";

const renderer = await createCliRenderer({ exitOnCtrlC: true });
const box = new BoxRenderable(renderer, {
  width: 30,
  height: 5,
  borderStyle: "single",
  title: " ratatui->TS ",
});
box.add(new TextRenderable(renderer, { content: "hello from Bun + OpenTUI" }));
renderer.root.add(box);
await new Promise(resolve => setTimeout(resolve, 150));
renderer.destroy();
```

Smoke test on Bun 1.4.4: `bun add @opentui/core` installed 0.8.3 in 1.63 s, the frame rendered, and the process exited 0.

## Option C: `blessed`

`blessed` is a high-level terminal widget library for Node: screens, boxes, lists, tables, logs, progress bars, and richer widgets through `blessed-contrib`. Its model is the closest match to Ratatui's widget tree.

- `blessed@0.1.81`, last published 2015
- `neo-blessed@0.2.0`, last published 2018
- `blessed-contrib@4.11.0`, last published 2022

Unmaintained and not Bun-first. Reasonable only for preserving an existing blessed application.

## Verdict

Use `@opentui/core`, or `@opentui/react` when keeping a React component model, for new TypeScript work. It is actively maintained, native, and matches this repository's Bun target. Use `ratatui-ts` only when exact Ratatui widget parity is mandatory and a native Rust build with stale FFI dependencies is acceptable.

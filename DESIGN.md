---
version: alpha
name: Tongyi in-game controls
description: A calm communications console for changing translation behavior during a Deadlock match.
colors:
  canvas: "#131d29"
  surface: "#1b2938"
  raised: "#203246"
  primary: "#76c7d8"
  text: "#e9f4f5"
  muted: "#9db2bf"
  border: "#466176"
  success: "#78c9bb"
  warning: "#e7b26c"
  danger: "#df8279"
typography:
  display:
    fontFamily: "Noto Sans SC, Microsoft YaHei, sans-serif"
  utility:
    fontFamily: "Arial, sans-serif"
rounded:
  panel: "12px"
  section: "8px"
  control: "5px"
spacing:
  section-gap: "11px"
  row-height: "38px"
components:
  settingsPanel:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    width: "510px"
    height: "680px"
  settingsSection:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.section}"
    padding: "11px"
  settingsControl:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    height: "38px"
  settingsHint:
    textColor: "{colors.muted}"
  settingsDivider:
    backgroundColor: "{colors.border}"
  saveButton:
    backgroundColor: "{colors.raised}"
  saveButtonDirty:
    backgroundColor: "{colors.primary}"
  connectionIndicatorSuccess:
    backgroundColor: "{colors.success}"
  connectionIndicatorWarning:
    backgroundColor: "{colors.warning}"
  connectionIndicatorError:
    backgroundColor: "{colors.danger}"
---

# Tongyi Design System

## Overview

Tongyi is used by Chinese-speaking Deadlock players who may adjust translation during a match. The in-game interface is a compact product tool, inspired by a quiet communications console: directional controls read first, engine choices second, diagnostics last. Its signature is the paired **received / sent** translation block with one cool signal edge. It should never resemble a glowing esports dashboard or a generic settings table.

The UI is Chinese. English appears only for the small product marker and technical provider/model names. Short action labels take priority over decorative copy. The game surface has limited room, so the body scrolls while Save and Close remain in the header.

## Colors

`canvas`, `surface`, and `raised` form three restrained depth levels. `primary` identifies the active direction group, focus, and Save when settings have changed; otherwise Save uses a quiet raised surface and teal border. `success`, `warning`, and `danger` communicate connection state with text alongside color. The colors above mirror `mod/panorama/styles/dlchat-ui.css`, which is the runtime owner; update both in the same change. The translation bubbles remain owned by `dlchat.css` because they sit on the game's chat surfaces.

## Typography

Chinese controls use the display stack with system fallbacks. The small `TONGYI / DEADLOCK` marker uses the utility stack and wide tracking. Titles are 24px; section labels 14px; rows 13px; diagnostic text 12px. Keep model names intact and allow diagnostic text to wrap.

## Layout

The panel is 510px wide and 680px high. A 90px header holds Save and Close; the body takes the remaining height and scrolls; a 52px footer holds test and recovery actions. Rows are 38px high. Hidden conditional rows collapse without leaving gaps.

## Elevation & Depth

One outer shadow separates the panel from the game. Inner sections use tonal surfaces and thin borders, without additional shadows. Translation messages retain their own background for legibility over the game's chat bubbles.

## Shapes

The panel uses a 12px radius, sections 8px, controls 5px. The connection indicator is circular and always paired with readable status in the panel.

## Components

Buttons show hover and focus through a brighter border and surface. Enabled toggles use a deeper teal fill; disabled toggles remain legible. A single failed health probe shows a temporary warning. Confirmed failure names the affected interface and offers diagnostics. The model list scrolls within a bounded height.

## Do's and Don'ts

- Do keep labels tied to player tasks: incoming messages, outgoing input, provider, and model.
- Do preserve stable control IDs and Panorama callbacks when changing the layout.
- Do preserve the game's complete chat snippets and native panel hierarchy; Tongyi extends the host layouts without replacing the game's typing, ping, hero-icon, or cooldown behavior. The Build 25614556 fixtures and build preflight enforce this boundary.
- Don't use color alone to claim the whole bridge is offline; the chat and top-bar scripts have separate channels.
- Don't place controls over the message text or hide the bridge HTML panel with `visibility: collapse`.

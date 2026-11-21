# UI structure rules

Applies to every screen: room, browse, quick play, create room, settings, account/profile/friends, library, map dialog, editor panels, practice/training bars, postgame, about/news. Tokens live in `src/style.css`.

## Sections
- A group of related content is a section: a surface panel (`.panel`: background one step off the page, 1px `--line` border, radius and padding from tokens) or a section with a clear divider.
- Headings sit inside their section. Panel headings use one style: `--step-lead`, weight 500, `--ink`. Subheadings inside a panel use `--step-small`, weight 600, `--muted`.
- A side panel or dock is one column of cards. No loose text between cards.
- Helper text sits directly under the control it describes, with the same left edge.
- Destructive actions sit in their own row below a divider.

## Spacing
- Scale: 8 / 12 / 16 / 24 / 32 px.
- Within a group: 8 px. Between controls in a section: 12 px. Between sections in a column: 16 px. Between major page regions: 24 px or 32 px.
- Never use an off-scale value for gaps or padding.

## Labels
- Players see names, never wire keys. Room settings show the `name` from `src/settings.ts`; `label` is only the key sent to the server.
- Sentence case for labels and headings.

## Both themes
- Check light and dark. Borders and surfaces must meet 3:1 against the page; text must meet 4.5:1 on its surface.
- Panels must not overflow at 200% text size or at 390 px width.

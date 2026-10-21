# Scenes and animation marks

The Director reads this file with the template catalog; the README links here.

## Scenes

Templates are the Director's shortcuts, not its limits. When none fits the idea, a reel uses `"template": "scene"` and gives `fields.svg`: the inside of a 640×360 SVG with the same marks. `check` holds it to:

- shapes, text, `g`, `defs`, markers and gradients only: no script, links, images, `use`, `style` or `foreignObject`;
- colors as `var(--token)` (or `none`, `currentColor`, `context-stroke` for an arrowhead, `url(#local)`), so dark mode works;
- ids starting with the reel's id, since every reel shares the page;
- at most 400 nodes, and the reel's own `ms`.

Classes from `daily.css` work too: `box` (with `on`, `bad-on`, `good-on`), `line`, `tb`, `big`, `ink`, `good`, `bad`, `secret`. A scene that keeps coming back is a template waiting to be written.

### Arrows

A line that shows something going somewhere is an arrow, and it is drawn from box to box:

- It starts on the edge of the box it comes from and ends on the edge of the box it goes to, never in the gap near one. `look` fails a line that stops a few pixels short of a box.
- When several boxes go somewhere together, group them in one outline (a `rect` with `fill:none` and a dashed stroke) and start the arrow from the outline's edge, not from the middle of one of them.
- Let the arrows' shape say the idea: two things becoming one converge on it diagonally; a step that follows another runs straight.
- Give it a head: one `marker` in `defs`, its id starting with the reel's id, used as `marker-end`, with its tip at `refX` so it ends on the box's edge. Fill the head with `context-stroke`, so it takes its line's color: a red line gets a red head.
- An arrow starts from something that is still on screen when it is drawn. If its source fades out, draw it first or start it from what stays.
- A label belongs to what it names: set it beside that box or outline with room on every side, not between two lines where it could name either.

```html
<defs><marker id="move-ah" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--muted);fill:context-stroke"/></marker></defs>
<rect x="54" y="94" width="212" height="78" rx="6" style="fill:none;stroke:var(--muted);stroke-dasharray:4 3"/>
<line x1="200" y1="172" x2="270" y2="205" class="line" marker-end="url(#move-ah)" data-anim="draw" data-at="3000"/>
```

## Animation marks

A reel is complete at rest. Marks say what changes and when; `player.js` plays them.

```html
<text data-anim="fade" data-at="2900">✕ upload → 403</text>
<rect data-anim="width" data-at="8000" data-ms="900" data-from="300" data-to="205"/>
<g data-cue="move" data-el="release-tok" data-at="500" data-ms="500" data-x="164" data-y="122"></g>
<g data-cue="class" data-el="release-s3" data-at="2800" data-to="bad-on"></g>
```

| Mark | Does |
|---|---|
| `fade`, `out`, `drop`, `grow` | reveal or hide over `data-ms` |
| `class` | sets `on`, `bad-on` or `good-on` |
| `text` | swaps the text to `data-to` |
| `count` | counts `data-from` → `data-to` |
| `width` | animates a bar's width |
| `move` | moves a circle to `data-x`, `data-y` |
| `type` | types `data-to` out letter by letter |
| `draw` | draws a line or path along its length |

`data-anim` acts on its own element. `data-cue` acts on `data-el`, so one element can change more than once.

# Media Companion Plugin for Obsidian

> [!CAUTION]
> This plugin creates and edits a file for each media file. Before using it on any vault, **make a backup**.

> [!WARNING]
> The file types this plugin is known to work for have been added in the default settings of the plugin.
> Other formats that Obsidian supports *may* work but they are **not** (yet) officially supported.

A companion plugin for [Obsidian](https://obsidian.md/) that creates a gallery with all your media files. The plugin aims to let you search through these files. Additionally, it creates sidecar files for each media file, to allow for adding notes, tags, and so on.

## Features

Search through your files based on folders, tags, or file types.

![](assets/gallery_and_sidebar.png)

More complex searching can also be done, like searching by color (**without** use of AI!). You can see the plugin in action [here.](https://www.youtube.com/watch?v=RBByEOAPmYc)

### Waterfall batch edit

In the waterfall Bases view (`mc-waterfall`) you can `Ctrl/Cmd`-click and `Shift`-click to multi-select cards. A sticky batch bar above the grid lets you pick a frontmatter property (autocomplete from visible `note.*` columns, `X` to clear, `▾` to show all), choose an operation and enter a value. The bar is type-aware:

- **Detection:** `types.json` (`checkbox→boolean`, `number→number`, `date→date`, `multitext/aliases/tags→list`) plus sampling of `ListValue`/`NumberValue`/`BooleanValue`/`DateValue` and raw frontmatter; `tags` is always a list
- **Input per kind:** `list` → CSV text (`a, b, c`), `number` → `type=number` (`Enter a number`), `boolean` → dropdown `true`/`false`, `date` → `type=date` (`YYYY-MM-DD`), `datetime` → `datetime-local` (`YYYY-MM-DD HH:mm`), `text` → text
- **Validation:** input is checked via `isValidRawForKind`; invalid input shows a red border and tooltip and disables **Apply** (`opacity 0.5`, `Enter`/click blocked) until correct; `file`/`formula` properties are blocked as read-only (except `tags` which always edits `note.tags`)
- **Operations:** `list` → `Replace` (orange), `Append`/`Remove` (blue/red), `Fill empty`, `Clear` (red); others → `Replace` (orange), `Fill empty`, `Clear` (red)

Values are deduped and normalized (`tags` lower-cased, `#` stripped) and written via `fileManager.processFrontMatter` (sidecar `*.md` created if missing, `MC-*` reserved). A confirmation modal previews the operation, value (`#tag` for tags) and the first 5 affected files (`and N more…`). Off-screen selected cards use an optimistic `pendingWritten` map and re-render when scrolled into view.

*Art shown in the images and video is from [this dataset of Van Gogh paintings](https://www.kaggle.com/datasets/ipythonx/van-gogh-paintings)*

## Planned features

- [ ] More file type compatibility
	- [ ] Audio files (mp3, wav)
	- [ ] 3d objects (obj, blender files, gltf)

## Contributing

If you wish to contribute to the plugin, feel free to open a pull-request or an issue.
If you're thinking about implementing a large feature, please open an issue first or contact me on discord at `n_1ck` 
so we can figure out if it's a good fit for this plugin.

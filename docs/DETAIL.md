# Work migrator

Export a development work (**code + data + conversation history**) from one
computer as a single pack, import it on any computer, and file it under the
category you choose. **Imported conversations keep working.**

## Why it exists

A DSH "work" is split across two places:

- **code / data** in a working directory;
- **conversation history** under `%USERPROFILE%\.dsh\sessions\...`.

If you move or rename the working directory, the paths recorded in the
conversations still point at the old place: opening a session errors out or
shows no content. This bundle rewrites those references together.

## Export

Sidebar footer "⇅ Migrate" → **Export**:

1. Tick the works to export (multi-select).
2. Enter the save path (for example `D:\Harness Record\export.dsht`).
3. Click "Start export".

The result is a `.dsht` file (a zip) containing code, data and conversation
history.

**Safety**: `.credentials.yaml`, tokens, secrets, `id_rsa` and `.env` are never
packed. Rebuildable directories such as `node_modules`, `.venv` and
`__pycache__` are skipped by default.

Export does not modify any data, and DSH can stay open.

## Import

Sidebar footer "⇅ Migrate" → **Import**:

1. Enter the `.dsht` path and click "Read".
2. The panel lists every work in the pack; assign each one:
   - keep its original category;
   - move it into an existing category on this machine;
   - **+ New category…** (name and parent directory; the folder is created);
   - skip.
3. Click "Start import".

### What happens on import

1. A migration plan is generated.
2. A background process that is detached from the DSH lifecycle starts.
3. You are asked to close DeepSeek Harness.

After you close DSH, the background process:

- backs up sessions, projection caches and `workspace.json`;
- copies the working directory to the target location;
- rewrites the conversation `header.cwd` (strictly preserving the two-frame
  structure; history content is untouched);
- moves the conversation directory to its new location;
- updates the workspace paths and categories;
- creates category folders;
- **restarts DSH**.

If any step fails it rolls the whole migration back and leaves a log under
`storages\work-migrator\`.

## About the restart

**An import only takes effect after DSH restarts.** This is a DSH constraint,
not a plugin defect: a running DSH keeps session state in memory and writes it
back to disk, which would overwrite external edits. The plugin makes the step
automatic: close DSH and the rest, including the relaunch, is handled for you.

## Known limitations

- The pack path must be typed in full: DSH offers a directory picker but not a
  file picker.
- Do not modify the working directory or session files while an import runs.
- Packs larger than 4 GB are not supported.
- Developed and tested on Windows; other platforms are untested.

## Technical notes

- Session logs are **multi-frame zstd** and are read frame by frame.
- When writing back, the first frame contains only the header line and every
  other line ends with a newline; the frame structure is validated before and
  compared after the change.
- The import reuses the same verified command-line implementation as the
  export path.

## Install

```sh
dsh plugin --profile <profile> add @iridensity_gray/dsh-work-migrator
```

Restart DSH after installing.

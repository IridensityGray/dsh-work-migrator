# dsh-work-migrator

Export a DSH development work — **code, data and conversation history** — as a
single `.dsht` pack, import it on another machine and file it under the category
you choose. Imported conversations keep working.

## Why

A DSH work is split between a working directory and `%USERPROFILE%\.dsh\sessions`.
Moving or renaming the directory breaks the paths recorded in conversations.
This bundle rewrites those references together with the move.

## Export

Sidebar footer "⇅ Migrate" → **Export**:

1. Tick the works to export.
2. Enter the save path (e.g. `D:\Harness Record\export.dsht`).
3. Click "Start export".

The output is a zip-based `.dsht` file with the code, data and session logs.
Credentials (`.credentials.yaml`, tokens, secrets, `id_rsa`, `.env`) are never
packed; `node_modules`, `.venv` and `__pycache__` are skipped. Export does not
modify anything and DSH can stay open.

## Import

"⇅ Migrate" → **Import**, enter the pack path, click "Read", then assign each
work: keep its category, move it into an existing one, create a new category
(folder created automatically), or skip.

After you confirm, a detached background process backs up sessions,
projection caches and `workspace.json`, copies the code, rewrites conversation
`header.cwd`, moves the session directories, updates the workspace registration
and restarts DSH. Any failure rolls the whole import back and leaves a log in
`storages\work-migrator\`.

## Limits

- **The import only takes effect after DSH restarts** — DSH keeps session state
  in memory while running. The plugin closes this gap by asking you to quit and
  completing the import, including the relaunch, afterwards.
- The pack path must be typed in full: DSH has a directory picker but no file
  picker.
- Do not modify the working directory or session files during an import.
- Packs larger than 4 GB are not supported.
- Developed and tested on Windows; other platforms are untested.

## Install

```sh
dsh plugin --profile <profile> add @iridensity_gray/dsh-work-migrator
```

Restart DSH after installing.

## Uninstall

```sh
dsh plugin --profile <profile> remove @iridensity_gray/dsh-work-migrator
```

## License

MIT

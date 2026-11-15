# opencode-letmework

An OpenCode plugin that makes work folders boring: when an action only touches a
project's **sibling work folder** (`../<project>-wt`, plus a few folders you
list), the permission prompt answers itself after a short delay instead of
blocking the agent.

The delay is the point. The prompt is published normally, stays visible for
`waitseconds`, and is only auto-approved if nobody answered it by then — so a
user who is watching can still reject the action.

## What it checks

A permission request is auto-approved only when **all** checks pass:

1. **The session folder is a git repository.** Detected by walking up from the
   session directory for a `.git` entry (file or folder, so worktrees count).
2. **Every target lives in an allowed folder:**
   - the sibling work folder `../<session folder><suffix>` and anything below it
     (`c:\GITHUB\myProject` → `c:\GITHUB\myProject-wt`), or
   - anything below a folder in `extra-folders`, or
   - anything **strictly below** a folder in `create-and-use` — those folders may
     not be touched directly, but the agent may create subfolders and work there.
3. **The action is eligible.** Only actions listed in `actions` qualify, so
   command text (`shell`) never matches a path rule.
4. **Resources are path-shaped.** Globs are judged on their literal prefix
   (`C:\temp\**\*.ts` is fine, `C:\GITHUB\proj-*\x` is not), and a resource that
   climbs out with `..` is never approved.

Anything else — no git repo, a different sibling, the project folder itself, an
unlisted action — behaves exactly as before: the prompt waits for you.

## Config

`config.yaml` next to the plugin (see `config.example.yaml`). It is re-read when
it changes, so no reload is needed.

```yaml
waitseconds: 5
suffix: -wt

extra-folders:
  - C:\temp\

create-and-use:
  - C:\Users\catronomix\AppData\Local\Temp\opencode

actions:
  - read
  - edit
  - write
  - external_directory
```

- `waitseconds` — grace period before auto-approval (0 approves immediately,
  capped at 600).
- `suffix` — appended to the session folder's name to build the work folder.
- `extra-folders` — folders and everything below them; absolute or relative to
  the session folder.
- `create-and-use` — folders whose subfolders are allowed while the folder itself
  is not.
- `actions` — permission actions eligible for auto-approval. Defaults to `read`,
  `edit`, `write`, `external_directory`.

Point the plugin at another config file with a plugin option:

```jsonc
{
  "plugins": [{ "package": "./plugins/opencode-letmework", "options": { "config": "C:/path/config.yaml" } }]
}
```

## Install

Global (all projects):

```powershell
git clone <this repo> C:\GITHUB\opencode-letmework
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.config\opencode\plugins\opencode-letmework" -Target C:\GITHUB\opencode-letmework
Copy-Item C:\GITHUB\opencode-letmework\config.example.yaml C:\GITHUB\opencode-letmework\config.yaml
```

Plugins in `~/.config/opencode/plugins/` load automatically. For a single
project, symlink into `<project>\.opencode\plugins\` instead.

## Notes

- Each request is answered with `once`; a rejection by the user is respected
  because the reply is skipped once the request is no longer pending.
- The plugin logs each decision to the server log (`letmework: ...`), so
  `~/.local/share/opencode/log/opencode.log` shows why something was or was not
  auto-approved.
- Path comparisons are case-insensitive on Windows and case-sensitive elsewhere.

## Development

```powershell
npm install
npm test        # node --test logic.test.ts
npm run typecheck
```

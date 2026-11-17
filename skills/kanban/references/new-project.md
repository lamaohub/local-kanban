# Registering a new project on the board

Part of the kanban skill: the full text behind the rule «a new project goes on the board first».

**The moment you create or start a new project — a new folder, site, bot, service — register it
on the board before writing any task or any code for it.** Otherwise the work happens off the
board: it has no task key and no deploy metadata. The board does NOT register projects on its own:
local folders under `LOCAL_ROOT` (`~/claude-projects`) appear in the sidebar with an "+ add" row,
but a project living anywhere else has to be registered by hand.

Register it through the API rather than raw SQL — the API emits an SSE event so the board updates
live, and the GitHub project is provisioned on the first task:

```python
# python3, so quoting doesn't get in the way
import json, urllib.request
body = {
  "slug": "myproj", "name": "myproj.com",
  "path": "<path to the project's code>",
  "deploy_skill": "deploy",        # or empty if there is no deployment
  "server": "<host>", "domain": "myproj.com",
  "category": "<sidebar group>",
  "description": "…",
}
req = urllib.request.Request("http://localhost:3100/api/projects",
    data=json.dumps(body).encode(), method="POST",
    headers={"Content-Type": "application/json"})
print(urllib.request.urlopen(req, timeout=10).read().decode())   # 201 + the object, including prefix
```

Registry fields (PATCHABLE): `name, prefix, path, server_path, deploy_skill, server,
pm2_services, domain, category, description, pinned, archived`. `slug` and `name` are required;
`prefix` (the `PREFIX-N` task key) is generated for you. Edit later with
`PATCH /api/projects/:slug`. When a human registers a project by hand, their path is the
"＋ Add project" wizard at the bottom of the sidebar; the API snippet above is yours.

**Verify it landed (do not skip):** `kb info <slug>` (path/deploy_skill/server/domain filled in),
`kb p | grep <slug>` (visible on the board), `kb sync` (the queue is not stuck). Only then create
tasks (`kb add`) and start working.

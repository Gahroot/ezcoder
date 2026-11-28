# Goals on the fleet

A Goal splits work into worker tasks, checks it with a verifier and keeps an
evidence trail. With paired nodes, its workers and its verifier can run on your
other machines while the Goal itself stays on your main machine.

## Workers on nodes: `machine`

Give a task a `machine` when you add or update it:

- `"auto"`: the least loaded paired node that has a free slot, a model login
  and a compatible EZ Coder version.
- `"gpu-box"`: exactly that node.
- left out: the worker runs on this machine, as before.

A remote worker is a helper agent on the node (see
[fleet-agents.md](fleet-agents.md)). It works in its own clean copy of the
project at your pushed commit plus a patch of your uncommitted work, uses the
node's own model login and tools, and sends its edits back after every turn.

Before any work is sent, the main machine checks the chosen node:

- its fleet protocol matches (a mismatch names which side to update);
- its doctor checks pass (model login, git access to the repo, and the rest);
- the Goal's prerequisite check commands pass **on that node**, not only here.

If a check fails, the task fails at once and the message says what to fix on
which machine.

## Verifier on a node: `verifier_machine`

Set `verifier_machine` (`"auto"` or a node name) when you create the Goal or
when you verify. The verifier command then runs as a fleet job on a fresh
checkout at the exact commit, and the job log becomes the evidence. If
uncommitted work was sent as a patch, the evidence says so. `"local"` moves the
verifier back to this machine.

## How many at once: `max_remote_workers`

Remote workers take slots on nodes like any other work (see
[Capacity](fleet.md#capacity)). Without a cap a Goal can use every free slot on
every node, for example 6 workers on one 6-slot node, or one on each of 6
one-slot nodes. A 7th waits for a free slot instead of failing.

Set `max_remote_workers` when you create the Goal to cap how many of its
workers run on nodes at the same time, for example to limit model spend. Past
the cap, starting another remote worker fails with a message naming the cap.

## Conflicts

Workers on different machines all edit copies of the same project, so their
edits can collide. Fleet never mixes them silently:

- Edits come home one patch at a time per project folder.
- Each patch applies all or nothing. If it doesn't apply, because another worker
  or you changed the same lines first, **none of that worker's edits are
  applied**. The task fails, the message names the conflicting files, and the
  patch is saved in the Goal's folder with the `git apply --3way --binary`
  command to apply it by hand.
- Later workers keep syncing only their own new changes.

Give parallel tasks separate files or areas where you can; a conflict costs a
re-run of that task.

## Hosted Goals (whole Goal on a node)

A whole Goal can run on a node: its controller, workers and verifier all run
there, so it keeps going with your laptop closed. When it ends (passed or
failed), the node pushes the result to the branch `ezcoder/goal/<run-id>` on
`origin` with its own git credentials, so nothing depends on your laptop being
awake.

```bash
ezcoder goals host <run-id> --on <node|auto>   # start the Goal on a node
ezcoder goals status                           # hosted Goals are checked on their node
ezcoder goals fetch <run-id>                   # fetch the result branch from origin
ezcoder goals stop <run-id>                    # stop it on the node (workspace is kept)
```

- The hosted Goal takes one slot on the node while it runs; when the node is
  full the start waits for a free slot.
- The node uses its own model login and default model. Run `ezcoder login` on
  the node first; `ezcoder node doctor` tells you if it is missing.
- If the node restarts, a Goal that is still running is re-adopted. If it can't
  be, it is marked `lost` and its workspace stays on the node.
- Docker-only nodes (`--docker-only`) don't host Goals.
- In the desktop app, hosted Goals refresh when the Goal list is shown.

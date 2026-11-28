# Fleet security: threat model and claims

A fleet node runs commands that your main machine sends it. That is the point of
it, and it is also the risk. This page says what a node's token grants, what a
node can see, what a hostile repository can do, and which test proves each
safety claim.

A node trusts exactly one owner. Fleet is not built for sharing one node
between people who don't trust each other.

## What the token grants

Anyone holding a node's token (it's in the pairing string) can do on that node
whatever your jobs can:

- run any command as the node's user (host-shell jobs), unless the node is
  docker-only;
- start containers within the Docker limits below, and services on the node's
  tailnet address;
- start EZ Coder helper agents that use the node's model login;
- read the logs, artifacts and diffs of work on the node;
- store model credentials on the node (`share-auth`), but not replace ones it
  already has without `force`;
- run deploy jobs on a `deploy` node, which receive the secrets they name.

The token does **not** grant: reading deploy secret values back (they go only
into a deploy job's environment), mounting arbitrary host folders into
containers, privileged containers, or anything on the main machine.

Treat the pairing string like a password. If it leaks, run
`ezcoder node rotate-token` on the node, or `ezcoder fleet rotate-token <node>`
from the main machine. The old token stops working at once, also for a running
server, and agent connections opened with it are closed. Then pair again with
the new string.

## The network: Tailscale first, TLS when you can't

- The node listens on its Tailscale address. Plain http on a LAN or public
  address is refused unless you pass both `--bind` and `--insecure-bind`.
  Every-interface binds (`0.0.0.0`, `::`) need the same.
- `node init` prints no pairing string when Tailscale isn't running and TLS is
  off, so a token is never paired to an address off the tailnet.
- Exposing a node to the public internet is not supported.
- With TLS (`ezcoder node init --tls`, or your own certificate) the pairing
  string is `ezfleets://<name>@<host>:<port>#<token>;fp=<sha-256>`. The main
  machine pins that fingerprint and sends nothing to a node presenting a
  different certificate.
- Every request except `GET /v1/hello` and the pairing-code exchange needs the
  bearer token, compared in constant time. Pairing codes are single-use, last
  10 minutes, and are rate-limited (5 wrong tries per 10 minutes).
- Controller and node check each other's protocol version on every request, so
  mismatched versions refuse cleanly instead of misreading each other.

## What a node can see

- The repository at the exact commit you send, fetched from `origin` with the
  node's own git credentials, and a patch of your uncommitted work when you ask
  for one (or when a helper agent runs there).
- The job's command, its env from `.ezcoder/fleet.json`, the project name and the
  cache key.
- Model credentials only if you run `ezcoder fleet share-auth`. Nothing is
  shared automatically.
- Not your git credentials: credentials embedded in a remote URL
  (`https://user:token@host/…`) are stripped before the URL reaches the node's
  logs, state, workspace git config or containers.
- Not your main machine's environment, home folder or other projects.

What leaves your machine, and where it goes, is listed in
[fleet-data.md](fleet-data.md).

## What a hostile repository can do

Assume a repository you send work for is hostile (a dependency's install
script, a test, a compose file). Then:

- **Host-shell jobs and helper agents** run as the node's user with no sandbox.
  They can read and change anything that user can, including other workspaces
  on the node. If you don't trust a repo, use a **docker-only node**:
  `ezcoder node init --docker-only` (saved) or `ezcoder node serve --docker-only`
  (for that run). The node says `dockerOnly` in its hello and refuses
  host-shell jobs and remote agents with `docker_only`.
- **Containers** get only allow-listed `docker run` flags. That rules out
  `--privileged`, `--cap-add`, host network, PID and IPC namespaces, custom
  security profiles, devices beyond a short list, `--env-file`, the Docker
  socket, and ports published beyond `127.0.0.1`. Every argument is parsed, so
  a flag can't hide as another flag's value.
- **Mounts** are limited to the job's own workspace and its own cache folder.
  A job can't mount other jobs, services, agents, artifacts, or the node's
  config, token or state, and symlinks are resolved first.
- **Compose files** can grant themselves anything Docker can, so compose jobs
  run only on nodes you label `compose`.
- **Environment.** Helper agents and host-shell jobs inherit an allow-list of
  the node's environment (`PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `TERM`,
  `TMPDIR`, `SHELL` and a few more), never a copy of it, so the node's own
  cloud keys and tokens don't leak into them. Env names that look like
  credentials or loader hooks (`*_TOKEN`, `*_KEY`, `NODE_OPTIONS`, …) are
  dropped from the env a remote agent is started with.
- **Deploy secrets** live in the OS keychain (the macOS keychain, or Secret
  Service on Linux), not in a file under the node's data folder. Without a
  keychain, `node secret set` refuses; there is no plain-text fallback. Only
  `deploy` jobs may name secrets, and only nodes labelled `deploy` accept them.
  A host-shell job on the same user account can still ask the keychain, so keep
  deploy nodes for repositories you trust.
- **Patches coming back** from a helper agent are refused if they add symlinks
  that point outside the folder or into `.git`. Artifact paths with `..`, `.git`
  or absolute paths are refused.
- **Resource use** is bounded: request bodies 64 MB (patches 50 MB), artifacts
  10 GB per job, job logs 200 MB (head and tail kept), timeouts per job, and old
  work and caches are removed on a schedule.

## Security claims and their tests

Every claim below is enforced in code and covered by the named test (file,
then test name). Run them with
`cd packages/cli && npx vitest run src/core/fleet src/cli/node.test.ts`.

| Claim                                                                                                | Test file                                     | Test                                                                                     |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Docker args are an allow-list; privilege escalation, host namespaces and host mounts are refused     | `src/core/fleet/node/docker.test.ts`          | refuses privilege escalation, host namespaces and host mounts                            |
| Bypass forms of docker args are refused                                                              | `src/core/fleet/node/docker.test.ts`          | refuses bypass forms of docker args                                                      |
| A flag can't hide as another flag's value; unknown flags are refused                                 | `src/core/fleet/node/docker.test.ts`          | never lets a flag hide as another flag's value, and refuses unknown flags                |
| Symlinks are resolved before a mount is allowed                                                      | `src/core/fleet/node/docker.test.ts`          | follows symlinks under dataDir before allowing a mount                                   |
| A job can mount only its own workspace and cache                                                     | `src/core/fleet/node/node-hardening.test.ts`  | X9: a job can mount only its own workspace and cache                                     |
| Devcontainer images can't be flags; Dockerfiles stay inside the workspace                            | `src/core/fleet/node/docker.test.ts`          | refuses devcontainer images that are flags and Dockerfiles outside the workspace         |
| `node serve` refuses non-Tailscale and every-interface binds without `--insecure-bind`               | `src/cli/node.test.ts`                        | serve refuses non-Tailscale and every-interface binds without --insecure-bind (X4)       |
| Only loopback and Tailscale addresses count as private binds                                         | `src/core/fleet/node/docker.test.ts`          | only treats loopback and Tailscale addresses as private                                  |
| Every-interface binds are recognised in all their spellings                                          | `src/core/fleet/node/docker.test.ts`          | recognises every-interface bind addresses                                                |
| Only the exact bearer token is accepted                                                              | `src/core/fleet/node/server.test.ts`          | accepts only the exact bearer token                                                      |
| Everything but hello needs the token                                                                 | `src/core/fleet/node/server.test.ts`          | serves hello without auth and rejects everything else without the token                  |
| Request bodies are size-capped                                                                       | `src/core/fleet/node/server.test.ts`          | rejects bodies over the limit                                                            |
| Secrets go only to deploy jobs on nodes labelled `deploy`                                            | `src/core/fleet/node/server.test.ts`          | gives secrets only on nodes labelled deploy                                              |
| An old plain-text `secrets.json` is moved into the keychain, then deleted; only names stay on disk   | `src/core/fleet/node/env-secrets.test.ts`     | moves an old plain-text secrets.json into the keychain, then deletes it                  |
| The node server does that migration when it starts                                                   | `src/core/fleet/node/env-secrets.test.ts`     | the node server migrates the file when it starts                                         |
| Without a keychain no secret is stored, and nothing is written                                       | `src/core/fleet/node/env-secrets.test.ts`     | refuses to store a secret without a keychain, writing nothing                            |
| `ezcoder node secret set` uses the keychain and refuses without one                                  | `src/core/fleet/node/env-secrets.test.ts`     | `ezcoder node secret set` uses the keychain and refuses without one                      |
| A damaged secrets or node file is refused, not treated as empty                                      | `src/core/fleet/node/docker.test.ts`          | refuses a damaged secrets or node file instead of treating it as empty                   |
| Artifacts are never collected through a symlinked folder                                             | `src/core/fleet/node/server.test.ts`          | never collects artifacts through a symlinked folder                                      |
| Artifact paths with `.git`, traversal or absolute paths are refused                                  | `src/core/fleet/client.test.ts`               | refuses .git segments, traversal and absolute paths                                      |
| A rotated token works at once and the old one stops, also for a running server and its agent sockets | `src/core/fleet/node/node-hardening.test.ts`  | S4: a rotated token works at once and the old one stops, also via node.json              |
| Rotating from the CLI replaces the token and prints a new pairing string                             | `src/cli/node.test.ts`                        | rotate-token replaces the token and prints the new pairing string                        |
| `node init --docker-only` saves docker-only; `node serve --docker-only` turns it on for the run      | `src/cli/node.test.ts`                        | init --docker-only saves it; serve --docker-only turns it on for the run (X5)            |
| A docker-only node refuses host-shell jobs and remote agents                                         | `src/core/fleet/node/node-hardening.test.ts`  | X5: a docker-only node refuses host-shell jobs and remote agents                         |
| Docker is a failing doctor check on docker-only nodes                                                | `src/core/fleet/node/doctor.test.ts`          | makes docker a failure on --docker-only nodes                                            |
| A secret in the node's own environment doesn't reach a host-shell job                                | `src/core/fleet/node/env-secrets.test.ts`     | a secret in the node's environment does not reach a host-shell job                       |
| A secret in the node's own environment doesn't reach a remote agent                                  | `src/core/fleet/node/env-secrets.test.ts`     | a secret in the node's environment does not reach a remote agent                         |
| The inherited env is an allow-list (`PATH`, `HOME`, `LC_*`, …), never a copy                         | `src/core/fleet/node/env-secrets.test.ts`     | keeps the allow-list and LC_*, and drops everything else                                 |
| Credential-looking env names are dropped from agent requests                                         | `src/core/fleet/node/agents.test.ts`          | filters credentials out of the requested env                                             |
| Credentials are stripped from https remote URLs; ssh user names are kept                             | `src/core/fleet/client.test.ts`               | drops user and token from https remotes; keeps ssh usernames and plain URLs              |
| Doctor never prints a repo URL's credentials                                                         | `src/core/fleet/node/doctor.test.ts`          | strips credentials from the repo URL it reports                                          |
| Option-like and `ext::` repo URLs are refused before git runs                                        | `src/core/fleet/node/doctor.test.ts`          | refuses option-like and ext:: repo URLs without running git                              |
| Transport-helper git URLs are refused for workspaces                                                 | `src/core/fleet/node/workspace.test.ts`       | refuses transport-helper git urls                                                        |
| Workspace paths and cache keys stay inside their roots                                               | `src/core/fleet/node/workspace.test.ts`       | keeps paths and cache keys inside their roots                                            |
| Pairing codes work once, without a token                                                             | `src/core/fleet/node/pair-code-route.test.ts` | trades a live code for the pairing string once, without a token                          |
| Pairing codes are rate-limited                                                                       | `src/core/fleet/node/pair-code-route.test.ts` | rate-limits after 5 wrong codes in 10 minutes, then recovers                             |
| A node presenting a different TLS certificate than the pinned one is refused, and nothing is sent    | `src/core/fleet/client-tls-pin.test.ts`       | refuses a different certificate and sends nothing                                        |
| The pinned certificate is accepted                                                                   | `src/core/fleet/client-tls-pin.test.ts`       | talks to the node whose certificate matches the pin                                      |
| TLS pairing strings must carry a valid fingerprint, and plain http can't                             | `src/core/fleet/client.test.ts`               | refuses TLS without a valid fingerprint, and fp on plain http                            |
| A protocol mismatch is refused with 426, naming the side to update                                   | `src/core/fleet/node/node-hardening.test.ts`  | S3: refuses a controller outside the protocol range with 426; hello advertises the range |
| The controller refuses an incompatible node before sending work                                      | `src/core/fleet/client.test.ts`               | sends the protocol headers and turns 426 into an incompatible error                      |
| Goal work is never sent to a node with an incompatible protocol                                      | `src/core/goal-remote-worker.test.ts`         | refuses a node with an incompatible protocol before any work is sent (S3)                |
| share-auth never replaces a node's own login without force                                           | `src/core/fleet/node/node-hardening.test.ts`  | R8: share-auth refuses to overwrite existing credentials without force                   |
| Helper-agent patches can't add symlinks outside the folder or into `.git`                            | `src/core/fleet/remote-agent.test.ts`         | refuses patches that add symlinks pointing outside the folder or into .git               |
| A conflicting patch leaves the local tree untouched                                                  | `src/core/fleet/remote-agent.test.ts`         | keeps a conflicting patch and leaves the local tree untouched                            |
| A deploy is never requeued                                                                           | `src/core/fleet/service.test.ts`              | never requeues a deploy                                                                  |
| A deploy whose dispatch is unclear is confirmed with the same node, never sent elsewhere             | `src/core/fleet/service.test.ts`              | confirms with the same node instead of running the deploy somewhere else                 |
| A deploy waits for validation at the exact commit                                                    | `src/core/fleet/service.test.ts`              | blocks a deploy until validation passed at the exact sha                                 |
| Job logs are capped, keeping head and tail                                                           | `src/core/fleet/node/node-hardening.test.ts`  | R6: caps a job's log keeping head and tail, A2: tail/grep/offset+limit                   |
| Uninstall `--purge` refuses a folder that isn't a node data folder                                   | `src/core/fleet/node/uninstall.test.ts`       | refuses to purge a folder that is not a node data folder                                 |
| Garbage collection never removes busy work or caches in use                                          | `src/core/fleet/node/gc.test.ts`              | removes finished jobs older than gcDays and never busy ones                              |

The TLS tests make throwaway certificates with openssl and are skipped on a
machine without it.

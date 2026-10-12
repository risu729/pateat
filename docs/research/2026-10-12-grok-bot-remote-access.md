# Grok Bot computer: shell access and messaging a Bot from outside

Researched: 2026-10-12 (18:05 to 19:00 UTC), from public sources only. Nothing was
installed on the Grok Bot computer, no tunnel was opened and no Bot setting changed.
On 2026-10-12 the owner found debugging Pateat on the Grok Bot computer tedious, asked
whether Claude can SSH into it (18:02 UTC), and asked whether Claude or another outside
program can talk to a Grok Bot directly instead of the owner pasting text from Notion
(18:05 UTC). Background on that computer is in
[browser agents and logins](2026-10-11-browser-agent-logins.md).

Primary sources read on 2026-10-12: the Grok Bot documentation
([index](https://docs.x.ai/llms.txt), every `docs.x.ai/grok-bot/*` page listed there;
Cursor publishes the same pages under `cursor.com/docs/grok-bot/`), the
[Grok Bot Terms](https://cursor.com/terms/grok-bot) (last updated 2026-10-12), the
[Cursor Terms of Service](https://cursor.com/terms-of-service) (2026-09-03), the
[Cursor Acceptable Use Policy](https://cursor.com/en-US/acceptable-use-policy)
(2026-08-11), and Grok Bot threads on the [Cursor forum](https://forum.cursor.com/),
where Cursor staff answer Grok Bot reports. The documentation says the computers are
Cursor-hosted. The Grok Bot Terms name no company: "Provider" is "the entity providing
Grok Bot to Customer under the Agreement". The copy read here is on cursor.com, and the
Cursor Terms of Service say Grok Bot use is "also subject to the Grok Bot Terms". Access
can also come from a SuperGrok subscription, and which agreement and acceptable use
policy cover the owner's access is not recorded. The xAI copies under `x.ai/legal/`
(including `grok-bot-terms`) returned HTTP 403 to this session and were not read, so
the Cursor documents below may not be the ones that apply.

## Summary

| Question | Answer | Source |
| --- | --- | --- |
| Can a member open a shell or SSH session on the cloud computer? | Not documented. Members watch the computer in **Agent Computer** and use takeover for sensitive steps | [Use the computer and apps](https://docs.x.ai/grok-bot/computer-and-apps) |
| Can a tunnel or VPN client run on it? | Documented only as Enterprise **Team Setup** scripts for outbound access to a private network. Any member can instead route the computer's egress through their own desktop | [Connect to private networks](https://docs.x.ai/grok-bot/private-networks) |
| Do the terms allow or forbid SSH or a tunnel? | The Cursor documents read here do not name SSH, tunnels or remote access. The Cursor AUP forbids bypassing protective measures and safety mitigations. The xAI copies were not read | Grok Bot Terms, Cursor AUP |
| Is there an official API or SDK to send a Bot a message? | No. A Cursor forum reply on 2026-10-12 says there is none | [Forum](https://forum.cursor.com/t/grok-bot-official-api-to-create-bots-and-send-receive-chat-for-companion-uis/170985) |
| What official ways start Bot work without the app? | A routine's webhook trigger (an HTTP POST with a key), email to the Bot's own address, Slack, GitHub, Linear, Sentry or PagerDuty events, schedules, and tagging @bot in a public post on X | [Routines help](https://cursor.com/help/grok-bot/routines), [Tag @bot on X](https://docs.x.ai/grok-bot/tag-on-x) |
| Have users opened a shell on the computer anyway? | Yes: several report Tailscale with `ssh box@grok-bot`, and tools built on an undocumented gateway on port 1340 | [User reports](#user-reports) |

## Shell access to the cloud computer

What the documentation says about the computer:

- "Grok Bot works from a persistent cloud computer. It can use a browser, command line,
  files, and connected tools without depending on your laptop remaining open." Members
  see it through **Agent Computer**: "Open **Agent Computer** from a conversation to
  view the shared desktop." For a password, passkey, two-factor code, CAPTCHA or payment
  step the member takes control, completes "only the blocked step", and hands control
  back. For checks a site raises, the page says to "Ask the Bot to pause and notify you
  rather than attempting to bypass the check."
- No page describes a member terminal, SSH, VNC, open ports or inbound connections. The
  [security page](https://docs.x.ai/grok-bot/security) covers egress only: computers
  "reach the internet through shared static egress IP addresses by default", and the
  destination allowlist (**Network Controls**) is Enterprise only.
- "Team computers run Linux, and scripts run as the computer user with `sudo`
  available" ([private networks](https://docs.x.ai/grok-bot/private-networks), Team
  Setup section).
- "Treat temporary directories, manually installed packages, and uncommitted
  application state as replaceable." **Update** in **Settings → Updates** "installs the
  latest software on the computer and keeps your files in place"; the
  [Manage computers](https://docs.x.ai/grok-bot/computers) page says a recreate or
  terminate, which Enterprise organization admins run from the Cursor dashboard,
  removes "apps and packages members installed themselves".

The only documented tunnel or VPN setup is
[Connect to private networks](https://docs.x.ai/grok-bot/private-networks): Tailscale
(the pattern "exercised" on team computers) or a `cloudflared` client, installed by
**Team Setup** scripts, so that the computer can reach services inside the customer's
network. SSH appears there only as a private TCP service the computer connects out to
with `cloudflared access tcp`. "Team Setup is Enterprise only. It does not appear on
other plans." The same page lets any member turn on **Settings → Computer → Network →
Route traffic through this computer** in the desktop app, which sends the computer's
egress through the member's desktop. Neither describes connecting into the computer.

Community reports, not official: a community wiki lists a shared Bot template that
installs Tailscale on the computer for `ssh box@grok-bot` over the user's tailnet
([Grok Bot Wiki](https://www.grokbotwiki.com/bots/ssh-to-grok-bot-via-tailscale),
"Not affiliated with or endorsed by xAI or X Corp."). On the
[Cursor forum](https://forum.cursor.com/t/grok-bot-can-i-send-it-a-message-from-outside/168199)
one user wrote "I installed tailscale on the computer and it works great!", and another
has the Bot connect out over SSH through Tailscale to the user's own machine. So the
Bot can likely install such a client with `sudo` on an individual plan (inferred, not
tried).

What the terms read here say:

- The Grok Bot Terms list no prohibited uses. §1.1 allows use "subject to the
  Agreement, the Provider's acceptable use policy, and the applicable account settings
  and permissions", and §1.2 says users "will use Grok Bot in accordance with
  Provider's Documentation". No clause mentions SSH, tunnels, remote access or inbound
  connections.
- The Cursor Terms of Service §1.5 forbid trying to "reverse engineer, disassemble,
  decompile, decode" the Service and to "probe, scan or attempt to penetrate the
  Service".
- The Cursor AUP does not mention SSH, tunnels or remote access. It forbids "bypassing
  our systems or protective measures", "Disrupting, interfering with, or unauthorized
  access to the Service or its safety systems, including circumventing any rate limits
  or restrictions or protective measures and safety mitigations", and says "Don't
  circumvent safeguards unless you have our official written consent". It also lists
  "Accessing the Service through automated or non-human means, whether through a bot,
  script, or otherwise".

No source found here allows a member to open a shell or tunnel into the computer, and
none forbids it by name. Using such a shell to drive the computer's Chrome directly, for
example over its DevTools port, would skip the Bot's browser tool and the checks that
come with it. Two are known: the Bot reported on 2026-10-12 that its browser tool runs
through a proxy that blocks `chrome://` pages, and browser actions have failed with
"The box could not confirm that no saved credential is being filled into its browser",
reported on the
[Cursor forum](https://forum.cursor.com/t/my-browser-blocks-every-action-with-a-credential-check-error/173944)
on 2026-10-07 and seen by the owner's Bot on 2026-10-12. Skipping them reads as
bypassing protective measures under the AUP. A shell used only to read Pateat's files or
logs is not addressed by any source.

Outbound connections are also limited at the moment. A Cursor forum report says that
since 2026-10-01 the computer reaches only HTTPS on port 443, with SSH on port 22 and
mail ports timing out and `SAND_EGRESS_TUNNEL_ENABLED=1` set
([forum](https://forum.cursor.com/t/grok-bot-computer-all-outbound-non-https-traffic-blocked-since-oct-1-mysql-ssh-imap-smtp-ftp-time-out/173504)).
Cursor staff (Colin, 2026-10-02) replied: "Since a recent change, some Grok Bot
computers can only make outbound HTTPS connections on port 443", "it isn't intended",
and "There's no reliable workaround on the computer itself yet". Whether a Tailscale or
`cloudflared` client can connect through that proxy was not checked.

Risks independent of the terms: the computer holds the whole-vault cache and the unlock
key for the owner's Bitwarden account (see
[browser agents and logins](2026-10-11-browser-agent-logins.md)), so an inbound path
adds a new way to reach them; and a recreate removes the client, and an Update may, so
the path can break without notice.

## Messaging a Bot from outside

Official:

- **No public API.** A Cursor forum reply on 2026-10-12 (poster `deanrie`, who appears
  to be Cursor staff; the page does not label roles): "There's currently no official
  public API or SDK for Grok Bot for this use case", "UI automation is basically the
  only option right now". That describes the situation; it is not permission, and the
  AUP's "automated or non-human means" line above bears on any outside program that
  drives the app.
- **Routines.** A routine runs a workflow "on a schedule or, where supported, after an
  event". "Routine schedules must be at least five minutes apart", and "Background
  routines can run while your laptop is closed". "Cursor account integrations can start
  a routine from an event, such as a Slack message or a GitHub notification", with
  "a narrow matching rule".
- **Webhook trigger.** Cursor's
  [routines help page](https://cursor.com/help/grok-bot/routines) (not on `docs.x.ai`):
  "Ask the Bot to add a webhook trigger to the routine", then the routine's **Webhook**
  section on the desktop app shows a POST URL and a key, sent as
  `Authorization: Bearer <key>`. "The Bot receives that body with the routine
  instruction." A 200 means "Grok Bot accepted the call and started a run", not that it
  finished; the result appears in the Bot's chat. Each run uses Grok Bot usage. Third
  parties report the URL under `api2.cursor.sh/automations/webhook/` and a key starting
  `crsr_`; on 2026-08-24 webhooks returned internal errors until Cursor rolled back a
  change the same day
  ([forum](https://forum.cursor.com/t/grok-bot-webhooks-are-failing-with-internal-server-error/169323)).
- **Email.** The account can claim one address `<name>@mail.grokbot.com`
  ([agent email](https://cursor.com/help/grok-bot/agent-email)). "New mail doesn't start
  a chat or wake a Bot on its own"; a routine can watch mail from any sender, specific
  addresses or a domain, and by default "only runs for mail from senders that pass
  standard email authentication checks".
- **Connectors.** A Bot works with supported services through plugins from **Connect
  apps**; installed connectors are account-wide. The owner's Bot already reads Notion
  this way.
- **Tag @bot on X.** A public post or reply on X that tags @bot hands that post to the
  member's main Bot as a task; @bot replies publicly on X with a confirmation. Not
  available for accounts based in Australia, the UK, the EU, Iceland, Liechtenstein or
  Norway.

Not documented:

- A forum user reports an internal HTTP API on the computer and calls it "an
  undocumented internal API, not an officially supported Cursor integration". Using it
  would fall under the reverse-engineering, probing and automated-access lines above, so
  it is not an option.
- Third-party MCP servers that send messages to Bots exist (listed on
  [Glama](https://glama.ai/mcp/servers?query=grok+bot)); how they reach the Bot was not
  checked, and the same lines apply if they drive the app or that internal API.

A scheduled routine on the Bot that reads a fixed Notion page and carries out the newest
request written there would let Claude write requests to that page without the owner
pasting them. Anyone who can edit that page could then direct the Bot on a computer that
holds the vault cache, each run uses Grok Bot usage, and results arrive no faster than
the routine's interval (five minutes or more). A webhook routine starts a run on each
request instead; whoever holds its key can start runs, so the key would have to be
stored where Claude can use it. An email routine limited to one sender address avoids
storing a key, at the cost of sending email for every request. A Slack or GitHub event
trigger needs a workspace or repository the Bot listens to; this repository is public,
so a trigger on it would need a matching rule that only the owner's own events pass (not
checked). Tagging @bot makes every request a public post.

## User reports

Gathered on 2026-10-12 at the owner's request (18:16 UTC) to see what users actually do,
whatever the terms say. None of this was tried here.

- **SSH over Tailscale.** Many posts, mostly on X in Japanese and Chinese, have the Bot
  install Tailscale and then log in with `ssh box@grok-bot` from the user's own machine
  over the tailnet, often to run coding agents (Claude Code, Codex, Grok Build) on the
  computer ([example](https://x.com/old_pgmrs_will/status/2094404588560367800),
  [example](https://x.com/AYi_AInotes/status/2093330692922851696),
  [guide](https://x.com/0xlangeai/status/2093192039051489662)). Reported details:
  the user is `box`; the computer has no systemd, so the Bot adds a start-up wrapper and
  a watchdog; **Update Grok Bot's Computer** replaces the instance and Tailscale has to
  be installed again. A shared Bot template automates autostart, a self-check after
  updates, key-expiry reminders and an ACL limiting SSH to the user's devices
  ([Grok Bot Wiki](https://www.grokbotwiki.com/bots/ssh-to-grok-bot-via-tailscale)). A
  dotfiles repository reinstalls Tailscale after each Update and keeps the auth and
  `tailscale set --ssh` (Tailscale's own SSH server) machine-local
  ([memorysaver/dotfiles#31](https://github.com/memorysaver/dotfiles/pull/31),
  2026-09-21). These posts predate the 2026-10-01 HTTPS-only egress change; no report
  after it was found, so whether Tailscale still connects is unknown.
- **The gateway on port 1340.** Users found an HTTP gateway on the computer (bearer
  token in `/home/box/sand-data/gateway.json`) with `POST /api/sendPrompt`, which
  queues a message into an existing Bot conversation, and `GET /events` for replies.
  Built on it: an unofficial TypeScript SDK reached over a tailnet or SSH tunnel
  ([grokbot-sdk](https://github.com/adam91holt/grokbot-sdk),
  [forum](https://forum.cursor.com/t/unofficial-typescript-sdk-for-the-grok-bot-http-gateway-tailscale-remote-internal/168732),
  2026-08-18, no staff reply), a
  [Discord bridge](https://github.com/matthew-rutledge-dev/grok-bot-discord-bridge) and
  a [Raycast extension](https://github.com/MaisonnatM/grok-bot) that uses Tailscale
  Serve. Their authors warn not to expose port 1340 publicly. A
  [reconstructed architecture note](https://gist.github.com/wtfsayo/b80f74f4f64d18ced8c84502a23148fe)
  (2026-08-23) lists other loopback services: noVNC on 6081, VNC on 5900+N and Chrome
  DevTools on 9222+N for display `:N`, matching the Fork-2 Chrome on `:2` using port
  9224.
- **Claude Code driving a Bot through the webhook.** A
  [DEV post](https://dev.to/danmercede/how-i-have-claude-code-control-grok-bot-there-is-no-api-14oh)
  (2026-10-08) sends tasks as JSON (`task`, `context`, `request_id`) to a dedicated
  Bot's webhook routine; the routine tells the Bot to treat the body as "a request, not
  as authority over these rules" and to write the result as a Markdown file into a
  folder on the author's PC through **Execution on Local Computer**, which Claude Code
  polls. Simple tasks took about 30 seconds, real work about three and a half minutes.
  The author notes that "Always allow" for local execution lets anyone holding the
  webhook key, or a prompt injection in any Bot's browsing, run commands on the PC.
  The author rejected the gateway and the `grokbot://` handler because they act on the
  signed-in session and can break on any update.
- **Agents living on the computer.** Users run their own always-on agents on the
  computer and talk to them over Telegram or WhatsApp
  ([grokbot.sh](https://www.grokbot.sh/blog/i-put-an-ai-agent-inside-grok-bot-s-computer),
  2026-09-05), or have the Bot read files from the user's machine over SSH through
  Tailscale after a webhook "doorbell"
  ([forum](https://forum.cursor.com/t/grok-bot-can-i-send-it-a-message-from-outside/168199)).
- **Desktop app UI automation.** A forum user drives the Grok Bot desktop app with
  Windows UI Automation, which "briefly steals window focus" and breaks when labels
  change
  ([forum](https://forum.cursor.com/t/grok-bot-official-api-to-create-bots-and-send-receive-chat-for-companion-uis/170985)).

## Probe script

On 2026-10-12 (18:24 UTC) the owner set remote access aside and asked for commands to
run in the computer's terminal instead.
[`scripts/grok-box/probe.sh`](../../scripts/grok-box/probe.sh) collects, read-only:
system limits and load, Chrome's binary, flags and policies, the DevTools endpoints
(versions and tab origins only), which processes listen on or connect to Chrome's
DevTools port and the browser proxy, whether the browser-tool guard messages exist in
files on the computer, reachability of the Pateat server and Bitwarden directly and
through the proxy, and which Pateat build Chrome loads. It prints no vault data,
passwords, cookies, Local Storage, chrome.storage or IndexedDB contents, redacts
token-like strings, and writes its report to `/workspace/pateat-probe/`.

## Probe results

The owner ran the probe on the secretary Bot's computer at 19:09 UTC on 2026-10-12 and
uploaded the report (49,436 bytes) to the shared Drive folder. Process names, ports and
paths below are copied from it; statements marked "inferred" are not.

Browser tool:

- Both guard messages ("Blocked by Playwright proxy" and the saved-credential check)
  are in `/opt/sand/sand-host/host-main.cjs` on the computer, and the proxy message is
  also in `sand-eval-runner.cjs`. That `sand-host` process listens on port 1340 and had
  three connections from the host gateway `172.30.0.1`.
- Clients of Chrome's DevTools port 9224 were all on the computer:
  `@anysphere/sand-playwright-runtime` (the browser tool), `sand-session-sync`,
  `sand-ua-governor` and `sand-cookie-persist`. A `chrome-devtools-mcp` started with
  `npx` was running but not connected.
- Inferred: the host sends browser actions to `sand-host`, which applies the guards on
  the computer and drives Chrome through the Playwright runtime. The guard code itself
  was not read.

Chrome:

- Google's Debian package `google-chrome-stable` 154.0.8037.97, held at that version.
  The root supervisor `sand-exit-watch` starts `/opt/google/chrome/chrome` directly,
  without the wrapper script; its flags were not readable. One Chrome ran (profile
  `Fork-2`, 15 renderers) although displays `:1`, `:2` and `:7` existed.
- Managed policies: `PasswordManagerEnabled` false, `BrowserSignin` 0, notifications
  blocked, `HighEfficiencyModeEnabled` true with `MemorySaverModeSavings` 2 (the most
  aggressive tab discarding), `HttpsOnlyMode` disallowed, and a force-installed WebAuthn
  proxy extension from a local update file.
- Chrome's traffic goes to `sand-egress-tunnel` on `127.0.0.1:8791`.

Limits and performance:

- Debian 13 on KVM, 8 vCPUs (Intel Xeon), 16 GiB memory, no swap; 6.4 GiB available and
  load 0.09 at the time. cgroup limit files were not visible; a root `sand-memory-watch`
  runs. One 125 GB disk (119 GB free) holds `/` and `/workspace`; hashing 256 MiB and a
  128 MiB fsync write each took about 0.2 s.
- No `ssh`, `sshd`, `nc`, `socat`, `tailscale` or `cloudflared`. TCP 22 timed out,
  plain HTTP timed out directly and got 400 from Chrome's proxy, HTTPS worked both
  ways. Every host name resolved to `198.18.0.1`, so direct traffic is also relayed by
  the host (inferred).
- Box state comes from a store (`SAND_BOX_STORE_*` variables, including a hibernate
  hook). Inferred: a restore from that store explains the `/workspace` revert seen
  around 17:12 UTC.

Pateat:

- Chrome loads the unpacked folder `/workspace/pateat-ext/unpacked`, built at
  18:35:58 UTC from `/workspace/pateat-src` at `a8350f5`; Chrome's
  `last_update_time` is 18:36:31 UTC.
- `https://pateat.takuk.me/health`, `api.bitwarden.com/config` and
  `api.bitwarden.eu/config` returned 200 directly and through Chrome's proxy.

## Not checked

- The xAI copies of the terms (`x.ai/legal/grok-bot-terms`, consumer terms, AUP), which
  this session could not fetch, and which agreement covers the owner's access.
- Whether the owner's computer already has `tailscale`, `cloudflared` or `sshd`
  installed, and whether a routine can read Notion while the owner's laptop is closed.
- Whether the AUP's "automated or non-human means" line covers driving the Grok Bot
  desktop app with computer use, as the local session does today for takeovers.

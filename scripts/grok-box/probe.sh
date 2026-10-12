#!/usr/bin/env bash
# Commands are passed to run() as strings and expand in its child shell.
# shellcheck disable=SC2016
# Read-only survey of the Grok Bot computer for debugging Pateat there.
# It prints no vault data, passwords, cookies, tokens, Login Data, Local Storage,
# chrome.storage or IndexedDB contents. Process arguments are reduced to flag names,
# script paths and a few Chrome flag values, and token-like strings are redacted.
# Usage: bash probe.sh   (writes /workspace/pateat-probe/report-<UTC time>.txt)
set -u

EXT_ID="ekcnbbomcllhpomkeofikjagmjoibffk"
PROFILE_ROOT="/home/box/chrome-profile"
PROFILE="${PROBE_PROFILE:-$PROFILE_ROOT/Fork-2}"
CHROME_PROXY="${PROBE_PROXY:-http://127.0.0.1:8791}"
PROXY_PORT="${CHROME_PROXY##*:}"
PROXY_PORT="${PROXY_PORT%%/*}"
OUT_DIR="${PROBE_OUT:-/workspace/pateat-probe}"
REPORT="$OUT_DIR/report-$(date -u +%Y%m%dT%H%M%SZ).txt"
KNOWN_REVISIONS="a930bcc1ad1b44ec3b0084b3ddbf7bcd47d15633 7e6c024676d70a84865e0816d25f95729a188d9b"
export EXT_ID PROFILE_ROOT PROFILE CHROME_PROXY PROXY_PORT OUT_DIR KNOWN_REVISIONS

trap 'rm -f "$OUT_DIR/ddtest"' EXIT INT TERM

section() { printf '\n===== %s =====\n' "$1"; }

# Runs one command with a time limit (seconds, default 30) and labels its output.
run() {
	local limit=30
	if [ "$1" = "--limit" ]; then
		limit="$2"
		shift 2
	fi
	printf '\n$ %s\n' "$*"
	timeout -k 5 "$limit" bash -c "$*" </dev/null 2>&1 | head -c 20000
	printf '[exit %s]\n' "${PIPESTATUS[0]}"
}

have() { command -v "$1" >/dev/null 2>&1; }

redact() {
	sed -E \
		-e "s/chrome-extension_${EXT_ID}/@@pateat-idb@@/g" \
		-e 's/(bearer|basic)[[:space:]]+[A-Za-z0-9._~+\/=-]+/\1 [redacted]/gI' \
		-e 's/([A-Za-z_-]*(token|secret|password|passwd|cookie|credential|api[_-]?key|auth[a-z_]*))(["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?)[^"'"'"'[:space:]&,;]+/\1\3[redacted]/gI' \
		-e 's/(--?[A-Za-z_-]*(token|secret|password|passwd|key|credential|cookie|session|auth)[A-Za-z_-]*)([[:space:]]+)[^[:space:]-][^[:space:]]*/\1\3[redacted]/gI' \
		-e 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/[jwt]/g' \
		-e 's/(gh[pousr]_|github_pat_|sk-|xox[abprs]-|crsr_)[A-Za-z0-9_-]+/\1[redacted]/g' \
		-e 's#(://)[^/@[:space:]]+@#\1[redacted]@#g' \
		-e 's#([=[:space:]]|^)[^/@[:space:]=]+:[^/@[:space:]]+@#\1[redacted]@#g' \
		-e 's/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[uuid]/g' \
		-e 's/[A-Za-z0-9+_=-]{41,}/[long-string]/g' \
		-e "s/@@pateat-idb@@/chrome-extension_${EXT_ID}/g"
}

# Process facts without argument values: Python helper shared by several sections.
# procs list PATTERN       processes whose exe, name or script path matches PATTERN
# procs chrome             Chrome main processes with selected flag values and parents
# procs sockets listen     listening TCP sockets with their owners
# procs sockets established PORT...
procs() {
	python3 -I - "$@" <<'PY'
import glob, os, re, sys

CHROME_VALUES = ("--user-data-dir", "--profile-directory", "--load-extension",
                 "--disable-extensions-except", "--remote-debugging-port",
                 "--remote-debugging-address", "--proxy-server", "--proxy-bypass-list",
                 "--headless", "--display", "--window-size", "--remote-debugging-pipe")
CHROME_NAMES = ("chrome", "chromium", "chromium-browser", "headless_shell")

def read(path, binary=False):
    try:
        with open(path, "rb") as handle:
            data = handle.read()
        return data if binary else data.decode(errors="replace")
    except OSError:
        return None

def exe_of(pid):
    try:
        return os.readlink(f"/proc/{pid}/exe").removesuffix(" (deleted)")
    except OSError:
        return None

def argv_of(pid):
    raw = read(f"/proc/{pid}/cmdline", binary=True) or b""
    return [part.decode(errors="replace") for part in raw.split(b"\0") if part]

def status_field(pid, name):
    for line in (read(f"/proc/{pid}/status") or "").splitlines():
        if line.startswith(name + ":"):
            return line.split(":", 1)[1].split()[0]
    return "?"

def safe_args(argv, keep_values=()):
    """Flag names, script and binary paths, and values only for listed flags."""
    shown = []
    for arg in argv[1:]:
        if arg.startswith("-"):
            name, _, value = arg.partition("=")
            shown.append(arg if name in keep_values else name + ("=..." if value else ""))
        elif re.search(r"\.(c?js|mjs|py|sh|ts)$", arg) or arg.startswith("/"):
            shown.append(arg)
        else:
            shown.append("<arg>")
    return " ".join(shown)

def describe(pid, keep_values=()):
    argv = argv_of(pid)
    name = (read(f"/proc/{pid}/comm") or "?").strip()
    uid = status_field(pid, "Uid")
    return f"pid={pid} uid={uid} name={name} exe={exe_of(pid) or '?'} args: {safe_args(argv, keep_values)}"

pids = [p.split("/")[2] for p in glob.glob("/proc/[0-9]*")]
mode = sys.argv[1]

if mode == "list":
    pattern = re.compile(sys.argv[2], re.I)
    for pid in sorted(pids, key=int):
        argv = argv_of(pid)
        if any("--type=" in a for a in argv):
            continue
        name = (read(f"/proc/{pid}/comm") or "").strip()
        scripts = [a for a in argv[1:3] if not a.startswith("-")]
        if pattern.search(" ".join([name, exe_of(pid) or ""] + scripts)):
            print(describe(pid))

elif mode == "chrome":
    found = False
    for pid in sorted(pids, key=int):
        exe = exe_of(pid)
        name = (read(f"/proc/{pid}/comm") or "").strip()
        base = os.path.basename(exe) if exe else name
        if not (base in CHROME_NAMES or base.startswith("google-chrome")):
            continue
        argv = argv_of(pid)
        if any("--type=" in a for a in argv):
            continue
        found = True
        print("CHROME", describe(pid, CHROME_VALUES))
        chain, current = [], pid
        for _ in range(8):
            parent = status_field(current, "PPid")
            if parent in ("0", "?"):
                break
            chain.append(f"{parent}:{(read(f'/proc/{parent}/comm') or '?').strip()}")
            current = parent
        print("  parents:", " <- ".join(chain) or "none")
        env = (read(f"/proc/{pid}/environ", binary=True) or b"").split(b"\0")
        for item in env:
            key = item.split(b"=", 1)[0].decode(errors="replace")
            if key.lower() in ("display", "http_proxy", "https_proxy", "no_proxy", "all_proxy"):
                print("  env", item.decode(errors="replace"))
    if not found:
        print("no Chrome main process visible to this user")

elif mode == "sockets":
    which, ports = sys.argv[2], {int(p) for p in sys.argv[3:] if p.isdigit()}
    owners = {}
    for fd in glob.glob("/proc/[0-9]*/fd/*"):
        try:
            target = os.readlink(fd)
        except OSError:
            continue
        if target.startswith("socket:["):
            pid = fd.split("/")[2]
            owners[target[8:-1]] = f"pid={pid} {(read(f'/proc/{pid}/comm') or '?').strip()} exe={exe_of(pid) or '?'}"
    def address(text, v6):
        host, port = text.split(":")
        if not v6:
            host = ".".join(str(int(host[i:i + 2], 16)) for i in (6, 4, 2, 0))
        elif host == "0" * 32:
            host = "[::]"
        elif host == "0" * 24 + "01000000":
            host = "[::1]"
        else:
            host = "v6:" + host
        return host, int(port, 16)
    for table, v6 in (("/proc/net/tcp", False), ("/proc/net/tcp6", True)):
        for line in (read(table) or "").splitlines()[1:]:
            fields = line.split()
            (lhost, lport), (rhost, rport) = address(fields[1], v6), address(fields[2], v6)
            owner = owners.get(fields[9], "(owner not visible)")
            if which == "listen" and fields[3] == "0A":
                print(f"LISTEN {lhost}:{lport} {owner}")
            elif which == "established" and fields[3] == "01" and (lport in ports or rport in ports):
                print(f"ESTAB {lhost}:{lport} -> {rhost}:{rport} {owner}")
PY
}

# Chrome's user data dir and profile directory, from its flags or the default.
chrome_profile() {
	procs chrome | python3 -I -c '
import os, re, sys
text = sys.stdin.read()
data = re.search(r"--user-data-dir=(\S+)", text)
profile = re.search(r"--profile-directory=(\S+)", text)
root = data.group(1) if data else os.environ["PROFILE"]
print(os.path.join(root, profile.group(1) if profile else "Default"))'
}

# Pateat's entry in Chrome's preferences: only the fields needed to see what is loaded.
pateat_prefs() {
	python3 -I - "$1" "$EXT_ID" <<'PY'
import json, os, sys
path, ext = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(path, encoding="utf-8"))
except Exception as error:
    print(f"unreadable: {type(error).__name__}")
    sys.exit(0)
settings = data.get("extensions", {}).get("settings", {}).get(ext)
if settings is None:
    print("no entry for", ext)
else:
    keys = ("path", "location", "state", "disable_reasons", "from_webstore", "install_time", "first_install_time", "last_update_time")
    picked = {key: settings.get(key) for key in keys if key in settings}
    picked["manifest.version"] = (settings.get("manifest") or {}).get("version")
    print(json.dumps(picked, indent=1))
    if settings.get("path"):
        print("path resolves to", os.path.realpath(settings["path"]))
print("extensions.ui.developer_mode =", data.get("extensions", {}).get("ui", {}).get("developer_mode"))
PY
}

# Path Chrome uses for Pateat, from Secure Preferences, falling back to Preferences.
pateat_path() {
	local file
	for file in "$1/Secure Preferences" "$1/Preferences"; do
		python3 -I -c '
import json, sys
try:
    path = json.load(open(sys.argv[1])).get("extensions", {}).get("settings", {}).get(sys.argv[2], {}).get("path", "")
except Exception:
    path = ""
print(path)' "$file" "$EXT_ID" | grep . && return
	done
}

# Build facts for one unpacked extension folder.
build_facts() {
	local dir="$1" sw revision
	echo "folder: $dir"
	stat -c "manifest.json mtime %y" "$dir/manifest.json"
	sha256sum "$dir/manifest.json" | cut -c1-16
	grep -E '"(version|version_name|service_worker|name)"' "$dir/manifest.json"
	sw=$(grep -o '"service_worker": *"[^"]*"' "$dir/manifest.json" | sed -E 's/.*"([^"]*)"$/\1/')
	[ -n "$sw" ] && echo "service worker $sw $(sha256sum "$dir/$sw" | cut -c1-16)"
	for revision in $KNOWN_REVISIONS; do
		echo "files naming $revision: $(grep -rlF "$revision" "$dir" 2>/dev/null | head -3 | tr '\n' ' ')"
	done
}

# Tab types and origins only; full URLs can carry session data.
cdp_list() {
	curl -s -m 5 --noproxy '*' "http://127.0.0.1:$1/json/list" | grep -E '"(type|url)"' | sed -E 's#("url": "[a-z-]+:(//)?[^/"]{0,60})[^"]*#\1...#'
}

# One URL through three routes: no proxy, the environment proxy, and Chrome's proxy.
reach() {
	local env_proxy="${https_proxy:-${HTTPS_PROXY:-none}}"
	curl -sS -m 30 --noproxy '*' -o /dev/null -w "%{http_code} %{time_total}s no proxy\n" "$1" 2>&1
	if [ "$env_proxy" != none ]; then
		curl -sS -m 30 -o /dev/null -w "%{http_code} %{time_total}s environment proxy ${env_proxy##*@}\n" "$1" 2>&1
	fi
	curl -sS -m 30 --noproxy '' --proxy "$CHROME_PROXY" -o /dev/null -w "%{http_code} %{time_total}s chrome proxy $CHROME_PROXY\n" "$1" 2>&1
}

# Lists files containing TEXT under the given roots, with grep's result code.
find_text() {
	local text="$1" found rc
	shift
	# Transcripts and logs that merely quote the message are skipped; code and binaries are not.
	found=$(grep -rlF -m1 --exclude-dir=proc --exclude-dir=sys --exclude-dir=workspace \
		--exclude-dir=chrome-profile --exclude-dir=pateat-probe --exclude-dir=sand-data \
		--exclude-dir=.claude --exclude='*.jsonl' --exclude='*.log' --exclude='*.db' \
		--exclude='*.db-wal' --exclude='*.sqlite*' "$text" "$@" 2>/dev/null)
	rc=$?
	printf '%s\n' "$found" | head -10
	echo "grep rc=$rc (0 found, 1 none, 124 or 137 cut off by the time limit) in: $*"
}

seconds_since() { awk -v s="$1" -v e="$(date +%s.%N)" 'BEGIN { printf "%.2f", e - s }'; }

export -f procs chrome_profile pateat_prefs pateat_path build_facts cdp_list reach find_text seconds_since

main() {
	echo "Pateat Grok box probe, $(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo "default profile=$PROFILE chrome proxy=$CHROME_PROXY"

	section "1. System and limits"
	run 'uname -a; cat /etc/os-release'
	run 'id; id -nG; echo "HOME=$HOME SHELL=$SHELL DISPLAY=${DISPLAY:-}"'
	run 'procs list "^" | head -3; ls -la /.dockerenv 2>&1; head /proc/1/cgroup'
	run 'command -v systemctl systemd-detect-virt; systemd-detect-virt 2>&1'
	run 'nproc; lscpu | head -20'
	run 'cat /proc/loadavg; uptime'
	run 'free -h; head -5 /proc/meminfo'
	run 'for f in cpu.max cpu.weight memory.max memory.current memory.peak pids.max pids.current; do printf "%s: " $f; cat /sys/fs/cgroup/$f 2>&1; done'
	run 'ulimit -a'
	run 'df -h / /workspace /home/box /tmp 2>&1'
	run 'findmnt /workspace 2>&1 || mount | grep -i workspace'
	run 'stat -c "%n dev=%d inode=%i" /workspace /workspace/pateat-ext/unpacked'

	section "2. Load and processes (names and executables, no argument values)"
	run 'ps -eo pid,ppid,user,pcpu,pmem,rss,etime,comm --sort=-pcpu | head -40'
	run 'procs list "xvfb|x11vnc|vnc|websockify|sand|pod-daemon|supervis|playwright|mcp|proxy|node|bun|python"'

	section "3. Displays"
	run 'ls -la /tmp/.X11-unix'

	section "4. Chrome"
	run 'procs chrome'
	run 'pgrep -fc -- "--type[=]renderer"'
	for bin in google-chrome google-chrome-stable chromium chromium-browser chrome; do
		have "$bin" || continue
		run "path=\$(command -v $bin); real=\$(readlink -f \"\$path\"); echo \"\$path -> \$real\"; if [ \"\$(head -c2 \"\$real\")\" = '#!' ]; then echo 'wrapper script:'; head -40 \"\$real\"; else \"\$real\" --version; fi"
		run "dpkg -S \"\$(readlink -f \"\$(command -v $bin)\")\" 2>&1 || rpm -qf \"\$(readlink -f \"\$(command -v $bin)\")\" 2>&1"
	done
	run 'dpkg -l 2>/dev/null | grep -iE "chrom|playwright" | head'
	run 'ls -d /opt/google/chrome* /ms-playwright* /root/.cache/ms-playwright* "$HOME"/.cache/ms-playwright* 2>&1'
	for dir in /etc/opt/chrome/policies /etc/chromium/policies /etc/opt/chromium/policies; do
		run "ls -laR $dir; for f in \$(find $dir -name '*.json' 2>/dev/null); do echo \"--- \$f\"; head -c 6000 \"\$f\"; echo; done"
	done
	run 'ls -la "$PROFILE_ROOT"; du -sh "$PROFILE_ROOT"/* 2>/dev/null'

	section "5. Chrome DevTools endpoints (metadata only, tab URLs cut to origin)"
	run 'for dir in "$PROFILE_ROOT"/*; do [ -f "$dir/DevToolsActivePort" ] && echo "$dir: port $(head -1 "$dir/DevToolsActivePort")"; done; echo checked'
	local port seen=0
	for port in $(seq 9222 9240); do
		if curl -sf -m 2 --noproxy '*' "http://127.0.0.1:$port/json/version" -o /dev/null; then
			seen=1
			run "curl -s -m 5 --noproxy '*' http://127.0.0.1:$port/json/version"
			run "cdp_list $port"
		fi
	done
	[ "$seen" = 1 ] || echo "no DevTools endpoint answered on 127.0.0.1:9222-9240"

	section "6. Who talks to Chrome and to the proxy (browser tool location)"
	run 'procs sockets listen | sort -u'
	run 'procs sockets established "$PROXY_PORT" 1340 1337 1338 1339 6081 $(seq 9222 9240) $(seq 5900 5910) | sort -u'
	run 'compgen -e | sort | tr "\n" " "'
	run 'env | grep -iE "^(http_proxy|https_proxy|all_proxy|no_proxy)="'
	run 'command -v tailscale tailscaled cloudflared sshd ssh nc socat 2>&1'
	run 'ls -la /home/box/sand-data 2>&1 | head -40'
	run 'find / -xdev -maxdepth 5 \( -iname "*mcp*.json" -o -iname "*mcp*.toml" -o -iname "*proxy*.json" -o -iname "*allowlist*" -o -iname "*blocklist*" \) -not -path "/proc/*" -not -path "/workspace/*" -not -path "$PROFILE_ROOT/*" 2>/dev/null | head -40'
	run 'find / -xdev -maxdepth 6 -type d -name "playwright*" -not -path "/proc/*" -not -path "/workspace/*" 2>/dev/null | head -20'
	# The Bot sees these messages; no file on this computer containing them suggests they come from outside it (inferred).
	local text
	for text in "could not confirm that no saved credential" "Blocked by Playwright proxy"; do
		run --limit 120 "find_text '$text' /opt /usr/local /home/box /app /srv /etc /root /tmp /var/lib /usr/lib /usr/share /nix"
	done

	section "7. Network"
	run 'cat /etc/resolv.conf; getent hosts pateat.takuk.me example.com github.com api.bitwarden.com'
	run 'ip -brief addr 2>&1; ip route 2>&1'
	run 'curl -sS -m 10 --noproxy "*" https://www.cloudflare.com/cdn-cgi/trace | grep -E "^(ip|colo|loc|http|tls|warp)="; echo "(no proxy)"'
	run 'curl -sS -m 10 https://www.cloudflare.com/cdn-cgi/trace | grep -E "^(ip|colo|loc|http|tls|warp)="; echo "(environment proxy)"'
	local url
	for url in https://pateat.takuk.me/health https://pateat.takuk.me/v1/device https://api.bitwarden.com/config https://api.bitwarden.eu/config http://example.com/; do
		run --limit 100 "reach $url"
	done
	run 'timeout 6 bash -c "</dev/tcp/github.com/22" && echo "tcp 22 open" || echo "tcp 22 blocked or timed out"'

	section "8. Performance (light)"
	run 's=$(date +%s.%N); dd if=/dev/zero bs=1M count=256 status=none | sha256sum >/dev/null; echo "sha256 of 256 MiB: $(seconds_since "$s") s"'
	run 'free_mb=$(df --output=avail -BM "$OUT_DIR" | tail -1 | tr -dc 0-9); if [ "${free_mb:-0}" -lt 1024 ]; then echo "skipped: ${free_mb:-?} MiB free"; else s=$(date +%s.%N); dd if=/dev/zero of="$OUT_DIR/ddtest" bs=1M count=128 conv=fsync status=none; rm -f "$OUT_DIR/ddtest"; echo "write 128 MiB to $OUT_DIR with fsync: $(seconds_since "$s") s"; fi'

	section "9. Pateat build on disk"
	run 'ls -la --time-style=full-iso /workspace/pateat-ext/'
	local dir
	for dir in /workspace/pateat-ext/unpacked /workspace/pateat-ext/unpacked-old-*; do
		[ -d "$dir" ] && run "build_facts '$dir'"
	done
	run 'git -c safe.directory=/workspace/pateat-src -C /workspace/pateat-src log -1 --format="%H %ci %s"; git --no-optional-locks -c safe.directory=/workspace/pateat-src -C /workspace/pateat-src status --short | head'
	run 'ls -la --time-style=full-iso /workspace/pateat-src/apps/extension/.output/chrome-mv3/'

	section "10. What Chrome loads for Pateat (selected preference fields only)"
	if ! have python3; then
		echo "python3 missing; preference fields not read"
		return
	fi
	local profile path
	profile=$(chrome_profile)
	echo "profile directory from Chrome's flags: $profile"
	for file in "$profile/Preferences" "$profile/Secure Preferences"; do
		printf '\n--- %s\n' "$file"
		pateat_prefs "$file"
	done
	path=$(pateat_path "$profile")
	if [ -n "$path" ] && [ -d "$path" ]; then
		run "build_facts '$path'"
	else
		echo "no loaded Pateat folder found in preferences"
	fi
	run 'procs chrome | grep -E "^CHROME"; ps -o pid,lstart -C chrome 2>/dev/null | head -3'
	run "ls -la '$profile/IndexedDB/' | grep -F $EXT_ID"
	run "ls -la '$profile/IndexedDB/chrome-extension_${EXT_ID}_0.indexeddb.leveldb'"
}

mkdir -p "$OUT_DIR"
main </dev/null 2>&1 | redact | tee "$REPORT"
echo
echo "Report saved to $REPORT"

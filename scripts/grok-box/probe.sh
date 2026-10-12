#!/usr/bin/env bash
# Commands are passed to run() as strings and expand in its child shell.
# shellcheck disable=SC2016
# Read-only survey of the Grok Bot computer for debugging Pateat there.
# It prints no vault data, passwords, cookies, tokens, Login Data, Local Storage,
# chrome.storage or IndexedDB contents, and redacts token-like strings.
# Usage: bash probe.sh   (writes /workspace/pateat-probe/report-<UTC time>.txt)
set -u

EXT_ID="ekcnbbomcllhpomkeofikjagmjoibffk"
PROFILE_ROOT="/home/box/chrome-profile"
PROFILE="${PROBE_PROFILE:-$PROFILE_ROOT/Fork-2}"
CHROME_PROXY="${PROBE_PROXY:-http://127.0.0.1:8791}"
OUT_DIR="${PROBE_OUT:-/workspace/pateat-probe}"
REPORT="$OUT_DIR/report-$(date -u +%Y%m%dT%H%M%SZ).txt"
KNOWN_REVISIONS="a930bcc1ad1b44ec3b0084b3ddbf7bcd47d15633 7e6c024676d70a84865e0816d25f95729a188d9b"
export EXT_ID PROFILE_ROOT PROFILE CHROME_PROXY OUT_DIR

section() { printf '\n===== %s =====\n' "$1"; }

# Runs one command with a time limit and labels its output.
run() {
	printf '\n$ %s\n' "$*"
	timeout 30 bash -c "$*" 2>&1 | head -c 20000
	printf '[exit %s]\n' "${PIPESTATUS[0]}"
}

have() { command -v "$1" >/dev/null 2>&1; }

redact() {
	sed -E \
		-e "s/chrome-extension_${EXT_ID}/@@pateat-idb@@/g" \
		-e 's/(bearer|basic)[[:space:]]+[A-Za-z0-9._~+\/=-]+/\1 [redacted]/gI' \
		-e 's/([A-Za-z_]*(token|secret|password|passwd|cookie|api[_-]?key|auth[a-z_]*))(["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?)[^"'"'"'[:space:]&,;]+/\1\3[redacted]/gI' \
		-e 's/crsr_[A-Za-z0-9_-]+/crsr_[redacted]/g' \
		-e 's#(://)[^/@[:space:]]+@#\1[redacted]@#g' \
		-e 's/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[uuid]/g' \
		-e 's/[A-Za-z0-9+_=-]{48,}/[long-string]/g' \
		-e "s/@@pateat-idb@@/chrome-extension_${EXT_ID}/g"
}

# Chrome main processes (not renderers or helpers).
chrome_pids() {
	local dir exe
	for dir in /proc/[0-9]*; do
		exe=$(readlink "$dir/exe" 2>/dev/null) || continue
		case "${exe##*/}" in
		chrome | chromium | chromium-browser | google-chrome* | headless_shell) ;;
		*) continue ;;
		esac
		tr '\0' ' ' <"$dir/cmdline" 2>/dev/null | grep -q -- ' --type=' || echo "${dir#/proc/}"
	done
}

# Pateat's entry in Chrome's preferences: only the fields needed to see what is loaded.
pateat_prefs() {
	python3 -I - "$1" "$EXT_ID" <<'PY'
import json, sys
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
    picked = {key: settings.get(key) for key in ("path", "location", "state", "disable_reasons", "from_webstore", "install_time", "was_installed_by_default")}
    picked["manifest.version"] = (settings.get("manifest") or {}).get("version")
    print(json.dumps(picked, indent=1))
    if settings.get("path"):
        import os
        print("path resolves to", os.path.realpath(settings["path"]))
print("extensions.ui.developer_mode =", data.get("extensions", {}).get("ui", {}).get("developer_mode"))
PY
}

# Tab types and origins only; full URLs can carry session data.
cdp_list() {
	curl -s -m 5 "http://127.0.0.1:$1/json/list" | grep -E '"(type|url)"' | sed -E 's#("url": "[a-z-]+://[^/"]*)[^"]*#\1/...#'
}

# TCP sockets from /proc (ss and netstat may be missing), with the owning process.
# Usage: sockets listen | sockets established PORT...
sockets() {
	python3 -I - "$@" <<'PY'
import glob, os, sys
mode, ports = sys.argv[1], {int(p) for p in sys.argv[2:]}
owners = {}
for fd in glob.glob("/proc/[0-9]*/fd/*"):
    try:
        target = os.readlink(fd)
    except OSError:
        continue
    if target.startswith("socket:["):
        pid = fd.split("/")[2]
        try:
            cmd = open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\0", b" ").decode(errors="replace").strip()
        except OSError:
            cmd = "?"
        owners[target[8:-1]] = f"pid={pid} {cmd[:160]}"
def address(text, v6):
    host, port = text.split(":")
    if v6:
        host = "v6:" + host
    else:
        host = ".".join(str(int(host[i:i + 2], 16)) for i in (6, 4, 2, 0))
    return host, int(port, 16)
for name, v6 in (("/proc/net/tcp", False), ("/proc/net/tcp6", True)):
    try:
        lines = open(name).read().splitlines()[1:]
    except OSError:
        continue
    for line in lines:
        fields = line.split()
        local, remote, state, inode = fields[1], fields[2], fields[3], fields[9]
        (lhost, lport), (rhost, rport) = address(local, v6), address(remote, v6)
        if mode == "listen" and state == "0A":
            print(f"LISTEN {lhost}:{lport} {owners.get(inode, '(owner not visible)')}")
        elif mode == "established" and state == "01" and (lport in ports or rport in ports):
            print(f"ESTAB {lhost}:{lport} -> {rhost}:{rport} {owners.get(inode, '(owner not visible)')}")
PY
}

seconds_since() { awk -v s="$1" -v e="$(date +%s.%N)" 'BEGIN { printf "%.2f", e - s }'; }

export -f cdp_list sockets seconds_since

main() {
	echo "Pateat Grok box probe, $(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo "profile=$PROFILE proxy=$CHROME_PROXY"

	section "1. System and limits"
	run 'uname -a; cat /etc/os-release'
	run 'id; echo "HOME=$HOME SHELL=$SHELL DISPLAY=${DISPLAY:-}"'
	run 'sudo -n true && echo "sudo: passwordless" || echo "sudo: not passwordless"'
	run 'cat /proc/1/cmdline | tr "\0" " "; echo; ls -la /.dockerenv 2>&1; cat /proc/1/cgroup | head'
	run 'command -v systemctl systemd-detect-virt; systemd-detect-virt 2>&1'
	run 'nproc; lscpu | head -20'
	run 'cat /proc/loadavg; uptime'
	run 'free -h; cat /proc/meminfo | head -5'
	run 'for f in cpu.max cpu.weight memory.max memory.current memory.peak pids.max pids.current; do printf "%s: " $f; cat /sys/fs/cgroup/$f 2>&1; done'
	run 'ulimit -a'
	run 'df -h / /workspace /home/box /tmp 2>&1'
	run 'findmnt /workspace 2>&1 || mount | grep -i workspace'
	run 'stat -c "%n dev=%d inode=%i" /workspace /workspace/pateat-ext/unpacked'

	section "2. Load and processes (top 40 by CPU)"
	run 'ps -eo pid,ppid,user,pcpu,pmem,rss,etime,args --sort=-pcpu | head -40'
	run 'ps -eo pid,lstart,args | grep -iE "[X]vfb|[x]11vnc|[n]ovnc|[w]ebsockify|[s]and|[p]od-daemon|[s]upervis|[p]laywright|[m]cp"'

	section "3. Displays"
	run 'ls -la /tmp/.X11-unix'

	section "4. Chrome"
	for pid in $(chrome_pids); do
		run "ps -o pid,lstart,etime,pcpu,rss -p $pid; readlink -f /proc/$pid/exe; tr '\\0' '\\n' </proc/$pid/cmdline"
		run "tr '\\0' '\\n' </proc/$pid/environ | grep -E '^(DISPLAY|http_proxy|https_proxy|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|no_proxy)='"
	done
	run 'ps -eo args | grep -c -- "--type=renderer"'
	for bin in google-chrome google-chrome-stable chromium chromium-browser chrome; do
		if have "$bin"; then
			run "command -v $bin; readlink -f \$(command -v $bin); $bin --version"
			run "dpkg -S \$(readlink -f \$(command -v $bin)) 2>&1 || rpm -qf \$(readlink -f \$(command -v $bin)) 2>&1"
		fi
	done
	run 'dpkg -l 2>/dev/null | grep -iE "chrom|playwright" | head'
	run 'ls -d /opt/google/chrome* /ms-playwright* /root/.cache/ms-playwright* "$HOME"/.cache/ms-playwright* 2>&1'
	for dir in /etc/opt/chrome/policies /etc/chromium/policies /etc/opt/chromium/policies; do
		run "ls -laR $dir; for f in \$(find $dir -name '*.json' 2>/dev/null); do echo \"--- \$f\"; head -c 6000 \"\$f\"; echo; done"
	done
	run 'ls -la "$PROFILE_ROOT"; du -sh "$PROFILE_ROOT"/* 2>/dev/null'

	section "5. Chrome DevTools endpoints (metadata only, tab URLs cut to origin)"
	for port in $(seq 9222 9240); do
		if curl -s -m 2 "http://127.0.0.1:$port/json/version" -o /dev/null; then
			run "curl -s -m 5 http://127.0.0.1:$port/json/version"
			run "cdp_list $port"
		fi
	done

	section "6. Who talks to Chrome and to the proxy (browser tool location)"
	run 'sockets listen | sort -u'
	run "sockets established \${CHROME_PROXY##*:} 1340 1337 1338 1339 6081 \$(seq 9222 9240) \$(seq 5900 5910) | sort -u"
	run 'compgen -e | sort | tr "\n" " "'
	run 'env | grep -iE "^(http_proxy|https_proxy|all_proxy|no_proxy)="'
	run 'command -v tailscale tailscaled cloudflared sshd ssh nc socat 2>&1'
	run 'ls -la /home/box/sand-data 2>&1 | head -40'
	run 'find / -xdev -maxdepth 5 \( -iname "*mcp*.json" -o -iname "*mcp*.toml" -o -iname "*proxy*.json" -o -iname "*allowlist*" -o -iname "*blocklist*" \) -not -path "/proc/*" -not -path "/workspace/*" -not -path "$PROFILE_ROOT/*" 2>/dev/null | head -40'
	run 'find / -xdev -maxdepth 6 -type d -name "playwright*" -not -path "/proc/*" -not -path "/workspace/*" 2>/dev/null | head -20'
	# Where the browser-tool guards live: these messages are shown to the Bot; no match means they come from outside this computer (inferred).
	for text in "could not confirm that no saved credential" "Blocked by Playwright proxy"; do
		run "timeout 25 grep -rIlF --exclude-dir=proc --exclude-dir=sys --exclude-dir=workspace --exclude-dir=chrome-profile \"$text\" /opt /usr/local /usr/lib/node_modules /home/box /app /srv /etc 2>/dev/null | head -10; echo searched"
	done

	section "7. Network"
	run 'cat /etc/resolv.conf; getent hosts pateat.takuk.me example.com github.com api.bitwarden.com'
	run 'ip -brief addr 2>&1; ip route 2>&1'
	run 'curl -sS -m 10 https://www.cloudflare.com/cdn-cgi/trace | grep -E "^(ip|colo|loc|http|tls|warp)="'
	for url in https://pateat.takuk.me/health https://pateat.takuk.me/v1/device https://api.bitwarden.com/config https://api.bitwarden.eu/config http://example.com/; do
		run "curl -sS -m 30 -o /dev/null -w '%{http_code} %{time_total}s direct\n' $url"
		run "curl -sS -m 30 -o /dev/null -w '%{http_code} %{time_total}s via chrome proxy\n' --proxy $CHROME_PROXY $url"
	done
	run 'timeout 6 bash -c "</dev/tcp/github.com/22" && echo "tcp 22 open" || echo "tcp 22 blocked or timed out"'

	section "8. Performance (light)"
	run 's=$(date +%s.%N); dd if=/dev/zero bs=1M count=256 status=none | sha256sum >/dev/null; echo "sha256 of 256 MiB: $(seconds_since "$s") s"'
	run 's=$(date +%s.%N); dd if=/dev/zero of="$OUT_DIR/ddtest" bs=1M count=128 conv=fsync status=none; rm -f "$OUT_DIR/ddtest"; echo "write 128 MiB to /workspace with fsync: $(seconds_since "$s") s"'

	section "9. Pateat build on disk"
	run 'ls -la --time-style=full-iso /workspace/pateat-ext/'
	for dir in /workspace/pateat-ext/unpacked /workspace/pateat-ext/unpacked-old-*; do
		[ -d "$dir" ] || continue
		for revision in $KNOWN_REVISIONS; do
			run "grep -rlF $revision $dir | head -5"
		done
	done
	run 'sha256sum /workspace/pateat-ext/unpacked/manifest.json | cut -c1-16; grep -E "\"(version|service_worker|name)\"" /workspace/pateat-ext/unpacked/manifest.json'
	run 'sw=$(grep -o "\"service_worker\": *\"[^\"]*\"" /workspace/pateat-ext/unpacked/manifest.json | sed -E "s/.*\"([^\"]*)\"$/\1/"); echo "$sw"; sha256sum "/workspace/pateat-ext/unpacked/$sw" | cut -c1-16'
	run 'git -C /workspace/pateat-src log -1 --format="%H %ci %s"; git -C /workspace/pateat-src status --short | head'
	run 'ls -la --time-style=full-iso /workspace/pateat-src/apps/extension/.output/chrome-mv3/'

	section "10. What Chrome loads for Pateat (selected preference fields only)"
	if have python3; then
		for file in "$PROFILE/Default/Preferences" "$PROFILE/Default/Secure Preferences"; do
			printf '\n--- %s\n' "$file"
			pateat_prefs "$file"
		done
	else
		echo "python3 missing; preference fields not read"
	fi
	run "ls -la \"$PROFILE/Default/IndexedDB/\" | grep -F $EXT_ID"
	run "ls -la \"$PROFILE/Default/IndexedDB/chrome-extension_${EXT_ID}_0.indexeddb.leveldb\""
}

mkdir -p "$OUT_DIR"
main 2>&1 | redact | tee "$REPORT"
echo
echo "Report saved to $REPORT"

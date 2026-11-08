# JXSCOUT Pro V2, Caido, and GraphX setup

A repeatable workstation and Linux VPS recipe. JXSCOUT references below are for **Professional V2**, not the open-source edition or Pro V1.

## What this sets up

- Caido captures traffic and supplies HTTP History/Replay.
- The JXSCOUT companion forwards captured traffic to a running Pro V2 instance.
- GraphX reads the Caido project independently. **Installing both plugins does not make GraphX import JXSCOUT results or avoid its own optional source-map fetches. That adapter is not implemented.**

This guide uses the companion's **Manual** mode: run JXSCOUT in a terminal locally, or as a headless user service on the VPS. Do not also start a Managed-mode instance for the same project. The companion supports Managed mode, but that is not the baseline verified here.

If port `3333` is occupied, do not launch another copy blindly. JXSCOUT can select another available port. Check the actual listening port and `/health` project, then either stop the old instance or update every relevant connection consistently.

### Prerequisites and versions

- A Pro V2 license valid for the destination machine and access to its licensed download page.
- A Caido account with at least two plugin slots. At the time of validation, signed-in Basic allows three; the observed guest session allowed one. See [current pricing](https://www.caido.io/pricing/).
- `bash`, `curl`, `tar`, `unzip`, and Python 3. Linux service examples require systemd; the Caido download example also uses `jq`.
- On a VPS, use an ordinary SSH user, not root. Activate and run JXSCOUT as that same user.

The workstation recipe was exercised with macOS ARM64, Caido 0.59.0, JXSCOUT Pro 2.2.2, companion 0.5.2, VSCode extension 2.1.0, and browser extension 0.0.5. Linux/systemd, SSH forwarding, and Remote-SSH instructions have **not** been deployed to a VPS in this validation; run the checks below before treating a destination as ready. Newer releases may change UI labels or requirements.

## 1. Install JXSCOUT on the machine that will process traffic

Check that machine's architecture with `uname -m`: `x86_64` needs the Intel/AMD build; `arm64` or `aarch64` needs ARM64. Download the matching **operating system and architecture** from your licensed V2 download page. Do not copy the Mac executable to Linux.

For a headless VPS, download the Linux archive on your workstation and transfer it over SSH. In all examples, replace `vps` with your existing SSH host/alias:

```bash
# Workstation: set this to the Linux archive you actually downloaded.
ARCHIVE="$HOME/Downloads/jxscout-linux.tar.gz"
scp "$ARCHIVE" vps:jxscout.tar.gz
```

On the destination, set `ARCHIVE` to the actual downloaded/transferred archive. The following block extracts into a temporary directory and installs the executable as `jxscout`:

```bash
# VPS example; on a Mac, use the actual archive path in Downloads instead.
ARCHIVE="$HOME/jxscout.tar.gz"
(
  set -eu
  unpacked="$(mktemp -d)"
  trap 'rm -rf "$unpacked"' EXIT
  tar -xzf "$ARCHIVE" -C "$unpacked"
  binary="$(find "$unpacked" -type f -name jxscout-pro-v2 -print)"
  test -f "$binary"
  mkdir -p "$HOME/.local/bin"
  install -m 755 "$binary" "$HOME/.local/bin/jxscout"
)
export PATH="$HOME/.local/bin:$PATH"
jxscout --version
```

Add `export PATH="$HOME/.local/bin:$PATH"` once to the startup file for your shell if that directory is not already on PATH. Official examples use `jxscout-pro-v2`; substitute `jxscout` when using this installation. External tools that discover only the original name must instead be configured with the absolute installed path, such as the companion's custom binary-path setting for Managed mode.

On macOS, if the official downloaded binary is quarantined and cannot launch, inspect it with `xattr -l "$HOME/.local/bin/jxscout"`. Only after deciding to allow that official download, remove that file's quarantine attribute:

```bash
xattr -d com.apple.quarantine "$HOME/.local/bin/jxscout"
jxscout --version
```

This resolved startup on the validated Mac. Ad-hoc re-signing failed there and was not needed. Do not disable Gatekeeper globally or assume re-signing fixes every launch failure.

### Activate once and create a local verification project

Use an interactive terminal, including a TTY over SSH. Enter the license in the CLI prompt, not in shell commands, service files, or this repository. Decline the optional PATH installer if the executable directory is already configured. Continue past the welcome screen with Enter.

```bash
jxscout --project-name local-setup \
  --working-directory "$HOME/jxscout-pro/local-setup" \
  --in-scope 'localhost,127.0.0.1,*.localhost' \
  --proxy-host 127.0.0.1 --proxy-port 3333
```

Keep it running for workstation use. For a VPS service, exit the TUI with Ctrl+C after activation, then continue below. Settings/license state live under `~/.jxscout-pro`; project files are in the working directory above. Do not copy another machine's `.license` file or machine fingerprint; activate the destination normally.

The verification project is deliberately loopback-only. Create a separate project with your authorized scope for real work. Startup scope/working-directory flags apply when a project is first created; rerunning them does not rewrite an existing project's settings. Check effective scope explicitly:

```bash
jxscout -c is-in-scope --project-name local-setup --url http://localhost:4183/check.js
jxscout -c is-in-scope --project-name local-setup --url https://example.com/check.js
```

Expected results: `true`, then `false`. Do not continue if they differ.

## 2. Start Caido

### Workstation

Use the installed Caido desktop application and choose the intended local instance. This recipe uses its proxy/UI on `127.0.0.1:18088`; change the examples consistently if your instance uses a different port.

**The desktop application already starts a `caido-cli` backend. Do not launch another CLI against that instance's data directory.**

### Linux VPS: standalone CLI

Follow the [official remote-hosting instructions](https://docs.caido.io/app/tutorials/remote), using the standalone CLI rather than a desktop/AppImage on a headless server. This download block selects the architecture from Caido's official release index:

```bash
(
  set -eu
  case "$(uname -m)" in
    x86_64) arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    *) echo 'Unsupported architecture for this recipe' >&2; exit 1 ;;
  esac
  url="$(curl -fsS https://caido.download/releases/latest |
    jq -er --arg arch "$arch" '.links[] | select(.os == "linux" and .kind == "cli" and .arch == $arch) | .link')"
  unpacked="$(mktemp -d)"
  trap 'rm -rf "$unpacked"' EXIT
  curl -fL "$url" -o "$unpacked/caido.tar.gz"
  tar -xzf "$unpacked/caido.tar.gz" -C "$unpacked"
  binary="$(find "$unpacked" -type f -name caido-cli -print)"
  test -f "$binary"
  mkdir -p "$HOME/.local/bin"
  install -m 755 "$binary" "$HOME/.local/bin/caido-cli"
)
"$HOME/.local/bin/caido-cli" --version
```

### Linux VPS: user services

Create the unit-file directory before saving either service:

```bash
mkdir -p "$HOME/.config/systemd/user"
```

Create `~/.config/systemd/user/caido.service` with:

```ini
[Unit]
Description=Caido local proxy and UI

[Service]
ExecStart=%h/.local/bin/caido-cli --listen 127.0.0.1:18088 --no-open --data-path %h/.local/share/caido
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Create `~/.config/systemd/user/jxscout.service` with:

```ini
[Unit]
Description=JXSCOUT Pro V2

[Service]
ExecStartPre=/usr/bin/test -f %h/jxscout-pro/local-setup/.jxscout-pro/settings.jsonc
ExecStart=%h/.local/bin/jxscout --headless --project-name local-setup --proxy-host 127.0.0.1 --proxy-port 3333
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

The pre-start check prevents accidentally creating a new, unconfigured project because activation/project creation was skipped. If using another project, change both the check path and `--project-name`.

```bash
systemd-analyze --user verify "$HOME/.config/systemd/user/caido.service" "$HOME/.config/systemd/user/jxscout.service"
systemctl --user daemon-reload
systemctl --user enable --now caido.service jxscout.service
systemctl --user status caido.service jxscout.service
journalctl --user -u jxscout.service -n 50 --no-pager
```

To keep user services running after SSH logout and at boot, an administrator can enable lingering with `sudo loginctl enable-linger "$USER"`. Neither service needs root. On hosts without systemd, run the same `ExecStart` commands under the host's existing process supervisor; do not run a second copy alongside them.

## 3. Access a VPS without colliding with local instances

On the workstation, keep this SSH tunnel open:

```bash
ssh -NT -o ExitOnForwardFailure=yes \
  -L 28088:127.0.0.1:18088 \
  -L 43333:127.0.0.1:3333 \
  -L 28771:127.0.0.1:8771 \
  vps
```

These different client-side ports allow local Caido/JXSCOUT to keep using their normal ports.

| Consumer | Same-machine setup | VPS setup |
| --- | --- | --- |
| Workstation browser: Caido UI/proxy | `127.0.0.1:18088` | `127.0.0.1:28088` |
| Caido companion backend: JXSCOUT | `127.0.0.1:3333` | `127.0.0.1:3333` **on VPS** |
| Workstation JXSCOUT browser/local editor extension | `127.0.0.1:3333` | `127.0.0.1:43333` |
| GraphX agent API from workstation | `127.0.0.1:8771` | `127.0.0.1:28771` |

The companion executes on the Caido host: **do not set its port to the workstation tunnel port**. Keep services on loopback; SSH supplies remote access. Forwarding GraphX's port does not install the plugin or create a JXSCOUT adapter.

## 4. Install plugins in the intended Caido instance

1. Open the local UI, or `http://127.0.0.1:28088` for the VPS. Sign in, register/authorize the instance, and create/select a Caido project named `local-setup`.
2. Install GraphX's built `dist/plugin_package.zip` using **Plugins → Install Package**. If building it, use the repository's [pinned development toolchain](../README.md#development) and `pnpm build` on a build machine; a VPS only needs the package. Transfer it to the workstation and upload through the remote Caido UI. Select an explicit Caido scope in GraphX to display the graph.
3. Install the official [JXSCOUT companion package](https://github.com/francisconeves97/jxscout-caido/releases) through the same UI.
4. Open **JXScout**, select **Manual**, set host `127.0.0.1`, port `3333`, and save. Verify **Connected**, the expected version, project, and working directory. Do not enable a second Managed-mode server.
5. Keep scope filtering at its default for the local smoke check. JXSCOUT's own project scope must still be loopback-only. Configure Caido/GraphX and JXSCOUT scopes intentionally for subsequent work; Manual mode does not promise scope/project synchronization.

For “different account” / “instance no longer valid”, first use the original owning account or check its Dashboard registration. If a credential reset is necessary, stop the instance, back up its complete data directory and launch settings, reset credentials once using the [official recovery procedure](https://docs.caido.io/app/troubleshooting/authentication.html), stop that temporary reset process, and relaunch normally **without** `--reset-credentials`. Do not delete the data directory. A stale Dashboard registration is not evidence of a second running local CLI.

## 5. Set up workstation browser and editor

### Download extensions

Run these on the machine with the activated CLI:

```bash
mkdir -p "$HOME/jxscout-downloads"
jxscout -c download-browser-extension -o "$HOME/jxscout-downloads"
(cd "$HOME/jxscout-downloads" && jxscout -c install-vscode-extension --editor manual)
```

The CLI prints the exact ZIP and VSIX paths. If it runs on the VPS, copy those printed files to the workstation with `scp` before installing locally.

Extract the browser ZIP to a stable directory, not a temporary folder. In a **dedicated Chrome profile**, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select that directory. Keep the extracted directory afterwards. Configure JXSCOUT's extension for the host/port from the table: enable **Send asset relationships**; leave **Inject initiator headers** off unless you deliberately need it. Save and verify the connected indicator.

### Launch a dedicated Chrome profile through Caido

On macOS, this local command matches the validated profile layout:

```bash
open -na "Google Chrome" --args \
  "--user-data-dir=$HOME/Library/Application Support/JXSCOUT/Chrome" \
  --proxy-server=http://127.0.0.1:18088 \
  '--proxy-bypass-list=127.0.0.1;[::1];<-loopback>'
```

For the VPS, use a separate profile ending in `Chrome-VPS` and proxy port `28088`. On a Linux GUI workstation, invoke `google-chrome` with the same flags and a profile directory such as `$HOME/.config/jxscout/Chrome-VPS`. A headless VPS does not need Chrome installed for this client-side workflow.

The bypass rule keeps local extension/API connections outside the proxy, but allows `localhost` fixture traffic through Caido. Do not proxy browser traffic directly to JXSCOUT when using this companion recipe, or Caido will miss that traffic.

### Trust the active Caido CA in that profile

Download the CA from the **intended Caido instance** via **Profile → CA Certificate → Download CA Certificate**. In the dedicated Chrome profile, open `chrome://certificate-manager/`, select **Installed by you**, and import it into **Trusted certificates**, following [Caido's certificate guide](https://docs.caido.io/app/guides/ca_certificate_importing).

Verify the certificate's SHA-256 fingerprint if needed:

```bash
openssl x509 -in ca.crt -noout -subject -dates -fingerprint -sha256
```

A CA already installed for another Caido instance may be different. Importing the active CA into Chrome's profile store avoids changing the system Keychain. Do not use `--ignore-certificate-errors` or `curl -k` to conceal a mismatched CA. If the browser version sends imports to an OS-wide certificate manager instead, stop and explicitly decide whether to trust it there.

### VSCode and remote files

Install the downloaded VSIX using **Extensions: Install from VSIX…**, open the JXSCOUT project working directory, and set the extension's **Instances** connection to the appropriate endpoint.

For remote source navigation, prefer a [VSCode Remote-SSH workspace](https://code.visualstudio.com/docs/remote/ssh) opened on the VPS project directory. Install the JXSCOUT VSIX into that SSH extension host; an extension executing on the VPS uses port `3333`, while an extension executing locally uses tunnel port `43333`. Use **Developer: Show Running Extensions** to check where it runs. A TCP tunnel alone does not make `/home/...` source paths accessible to a local-only editor. Remote-SSH source jumps were not exercised in the workstation validation.

## 6. Verify before collecting real traffic

On the server/workstation running JXSCOUT:

```bash
curl --fail --silent --show-error http://127.0.0.1:3333/health
```

Expect `status: "ok"`, the correct project, working directory, and version. In the workstation browser, verify the companion and browser extension connected indicators. For a VPS, test the forwarded health URL at `http://127.0.0.1:43333/health` as well.

Run the following **bash** smoke check on the Caido/JXSCOUT host, not the SSH client. It requires the selected Caido project, the companion connection, loopback scope, and a free port 4183. It creates only temporary local files and waits for asynchronous analysis of a unique captured script:

```bash
(
  set -eu
  PROJECT="${PROJECT:-local-setup}"
  CAIDO_PROXY_PORT="${CAIDO_PROXY_PORT:-18088}"
  tmp="$(mktemp -d)"
  probe="setup-$(date +%s)-$$"
  expected="/__graphx_setup__/$probe"
  printf 'const setupPath = "%s"; console.log(setupPath);\n' "$expected" > "$tmp/$probe.js"
  python3 -m http.server 4183 --bind 127.0.0.1 --directory "$tmp" > "$tmp/http.log" 2>&1 &
  http_pid=$!
  trap 'kill "$http_pid" 2>/dev/null || true; wait "$http_pid" 2>/dev/null || true; rm -rf "$tmp"' EXIT
  curl --fail --silent --show-error --retry 5 --retry-delay 1 \
    --noproxy '' --proxy "http://127.0.0.1:$CAIDO_PROXY_PORT" \
    "http://localhost:4183/$probe.js"
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    matches="$(jxscout -c get-matches --project-name "$PROJECT" \
      --match-kind path --value-include "$expected" --json)"
    if printf '%s' "$matches" | python3 -c '
import json, sys
expected, filename = sys.argv[1:]
found = any(m["match_value"] == expected and m["file_type"] == "js"
            and m["file_path"].endswith("/" + filename)
            for m in json.load(sys.stdin))
sys.exit(0 if found else 1)
' "$expected" "$probe.js"; then
      printf '\nPASS: Caido capture reached JXSCOUT analysis.\n'
      exit 0
    fi
    sleep 1
  done
  echo 'No matching analyzed capture: check project, scope, companion settings, and Events.' >&2
  exit 1
)
```

Also inspect the capture in Caido HTTP History. Browse a page that loads JavaScript and check the editor's Relationships view; that requires the browser extension, not just the companion. To validate HTTPS, open the official V2 documentation through the configured browser without a certificate warning. A command-line check can use the exported CA explicitly:

```bash
curl --fail --head --cacert ca.crt --noproxy '' \
  --proxy http://127.0.0.1:18088 https://docs.v2.jxscout.app/docs/introduction/
```

For this command on a tunneled workstation, use proxy port `28088` and the VPS instance's CA. Successful `CONNECT` alone is not sufficient: expect the final HTTPS `200` response.

## 7. Transfer projects and restart cleanly

Use Pro V2's [supported backup/restore workflow](https://docs.v2.jxscout.app/docs/tutorial/monitoring#backup-and-restore), rather than copying live SQLite files or V1/open-source projects:

```bash
# Source machine; choose an output directory that already exists.
jxscout -c backup --project-name local-setup --output "$HOME/local-setup.zip"
scp "$HOME/local-setup.zip" vps:local-setup.zip
```

On the destination, activate its CLI normally, then restore under a **new** name:

```bash
jxscout -c restore --project-name imported-project \
  --working-directory "$HOME/jxscout-pro/imported-project" \
  "$HOME/local-setup.zip"
```

Restoring does not select the restored project in a running server. Stop the relevant JXSCOUT server, change the service's project/check path or terminal startup arguments, then start it again. Verify `/health`, effective scope, project-local script/hook paths, and extension connections before resuming. To move in the other direction, reverse the `scp` transfer; do not upload licenses or machine fingerprints.

Caido projects, GraphX annotations, and JXSCOUT projects are separate stores. A JXSCOUT backup is not a backup of Caido or GraphX. Back up the complete stopped Caido data directory separately, including plugin data, before instance recovery or migration.

## Current workstation reference

The machine used to validate this guide has:

- CLI: `~/.local/bin/jxscout`; settings/license: `~/.jxscout-pro/`.
- JXSCOUT configured for Manual mode at `127.0.0.1:3333`.
- Caido configured at `127.0.0.1:18088`, with GraphX retained and companion 0.5.2 installed.
- Verification project: `graphx-local-setup`, working directory `~/Documents/JXSCOUT/graphx-local-setup`, scoped only to loopback.
- `jxscout-browser`: a workstation-local launcher for the dedicated Chrome profile and local proxy. It is **not a command shipped by JXSCOUT or this repository**, and is not automatically installed on another machine. Use the explicit Chrome launch command above there.
- Unpacked browser extension: `~/Applications/JXSCOUT/browser-extension`; profile: `~/Library/Application Support/JXSCOUT/Chrome`.
- Current public CA export: `~/Downloads/JXSCOUT/caido-active-ca.crt`, trusted only in that Chrome profile.
- Pre-reset Caido backup: `~/Documents/JXSCOUT/caido-backup-20261108-credentials`.

Local instances and the dedicated browser were closed after validation, and downloaded installers were removed. Installed tools, licenses, project data, the browser profile, and the recovery backup were retained.

To resume this existing workstation setup, start Caido and JXSCOUT:

```bash
open -a Caido
jxscout --project-name graphx-local-setup --proxy-host 127.0.0.1 --proxy-port 3333
```

Leave that terminal running. In another terminal, run `jxscout-browser`. Select the `graphx-local-setup` Caido project and verify the companion's connected indicator. This restores the existing loopback-only setup; it does not configure a real target scope.

Verified on that workstation: native CLI activation/startup, companion forwarding of a fresh captured script, source-map recovery, browser page/script relationships, retained results after terminal handoff, proxied HTTPS with issuer Caido, the exact ingestion smoke block above, and project backup ZIP integrity. No Linux deployment, restore execution, or remote-editor success is claimed.

## Primary references

- [Pro V2 installation, Caido integration, and extensions](https://docs.v2.jxscout.app/docs/getting-started)
- [Pro V2 CLI access](https://docs.v2.jxscout.app/docs/tutorial/agent-skills)
- [Pro V2 project compatibility](https://docs.v2.jxscout.app/docs/upgrade-notes)
- [Caido remote hosting](https://docs.caido.io/app/tutorials/remote)
- [Caido account/instance recovery](https://docs.caido.io/app/troubleshooting/authentication.html)

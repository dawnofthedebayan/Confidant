#!/usr/bin/env bash
#
# Build the Confidant plugin and install it into an Obsidian vault.
#
#   ./install.sh                 build, then copy main.js/manifest.json/styles.css
#   ./install.sh --dev           symlink this repo into the vault instead of copying
#   ./install.sh --watch         symlink, then run esbuild in watch mode
#   ./install.sh --build-only    build without touching any vault
#   ./install.sh --vault PATH    install into a different vault
#
# The vault path can also come from the CONFIDANT_VAULT env var.

set -euo pipefail

PLUGIN_ID="confidant"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DEFAULT_VAULT="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Debayan_Personal"
VAULT="${CONFIDANT_VAULT:-$DEFAULT_VAULT}"

MODE="copy"
WATCH=0
BUILD_ONLY=0

# ---------------------------------------------------------------- arguments --

while [[ $# -gt 0 ]]; do
	case "$1" in
		--dev)
			MODE="symlink"
			shift
			;;
		--watch)
			MODE="symlink"
			WATCH=1
			shift
			;;
		--build-only)
			BUILD_ONLY=1
			shift
			;;
		--vault)
			[[ $# -ge 2 ]] || { echo "error: --vault needs a path" >&2; exit 1; }
			VAULT="$2"
			shift 2
			;;
		-h|--help)
			sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*)
			echo "error: unknown option '$1' (try --help)" >&2
			exit 1
			;;
	esac
done

cd "$REPO_DIR"

# ------------------------------------------------------------------- checks --

command -v node >/dev/null 2>&1 || { echo "error: node is not installed" >&2; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "error: npm is not installed" >&2; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 18 )); then
	echo "error: node 18+ required (found $(node -v))" >&2
	exit 1
fi

# ------------------------------------------------------------------ install --

if [[ ! -d node_modules ]] || [[ package.json -nt node_modules ]]; then
	echo "==> Installing dependencies"
	npm install
else
	echo "==> Dependencies already installed (skipping npm install)"
fi

# -------------------------------------------------------------------- build --

# --watch builds continuously, so skip the one-shot production build for it.
if (( WATCH == 0 )); then
	echo "==> Type-checking"
	npx tsc -noEmit -skipLibCheck

	echo "==> Building main.js"
	node esbuild.config.mjs production

	[[ -f main.js ]] || { echo "error: build produced no main.js" >&2; exit 1; }
	echo "    $(du -h main.js | cut -f1) written"
fi

if (( BUILD_ONLY == 1 )); then
	echo "==> Done (build only, vault untouched)"
	exit 0
fi

# ------------------------------------------------------------------- deploy --

if [[ ! -d "$VAULT" ]]; then
	cat >&2 <<-EOF
	error: vault not found at
	    $VAULT
	Pass --vault /path/to/vault, or set CONFIDANT_VAULT.
	EOF
	exit 1
fi

if [[ ! -d "$VAULT/.obsidian" ]]; then
	echo "error: '$VAULT' has no .obsidian folder — is it really a vault?" >&2
	exit 1
fi

PLUGINS_DIR="$VAULT/.obsidian/plugins"
TARGET="$PLUGINS_DIR/$PLUGIN_ID"

mkdir -p "$PLUGINS_DIR"

# Refuse to clobber anything that isn't ours: data.json holds the user's
# settings, their processed-entry tracking, and their memory store.
if [[ -e "$TARGET" && ! -L "$TARGET" ]]; then
	if [[ ! -f "$TARGET/manifest.json" ]] || ! grep -q "\"id\": \"$PLUGIN_ID\"" "$TARGET/manifest.json"; then
		echo "error: '$TARGET' exists but is not a $PLUGIN_ID install — refusing to overwrite" >&2
		exit 1
	fi
fi

if [[ "$MODE" == "symlink" ]]; then
	if [[ -d "$TARGET" && ! -L "$TARGET" ]]; then
		BACKUP="$TARGET.backup-$(date +%Y%m%d%H%M%S)"
		echo "==> Existing copy install found; moving it to $(basename "$BACKUP")"
		mv "$TARGET" "$BACKUP"
		# Carry settings/tracking/memory across so a dev switch isn't a reset.
		mkdir -p "$TARGET"
		for f in data.json memory-store.json; do
			[[ -f "$BACKUP/$f" ]] && cp "$BACKUP/$f" "$REPO_DIR/$f"
		done
		rmdir "$TARGET"
	fi
	rm -f "$TARGET"
	ln -s "$REPO_DIR" "$TARGET"
	echo "==> Symlinked $TARGET -> $REPO_DIR"
else
	if [[ -L "$TARGET" ]]; then
		echo "==> Replacing existing symlink with a real install"
		rm -f "$TARGET"
	fi
	mkdir -p "$TARGET"
	cp main.js manifest.json styles.css "$TARGET/"
	echo "==> Installed to $TARGET"
	echo "    main.js  manifest.json  styles.css"
fi

# --------------------------------------------------------------------- next --

cat <<-EOF

	Next steps:
	  1. In Obsidian: Settings -> Community plugins -> enable "Confidant"
	     (if it was already enabled, toggle it off and on to load the new build)
	  2. Set the source folder, output folder and backend in the plugin's settings
	  3. Run the command "Confidant: Check what needs generating"
EOF

if (( WATCH == 1 )); then
	echo ""
	echo "==> Starting esbuild watch (ctrl-C to stop)"
	exec node esbuild.config.mjs
fi

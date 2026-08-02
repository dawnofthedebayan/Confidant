#!/usr/bin/env bash
#
# Start the local MLX server (chat + embeddings) that the Confidant
# plugin talks to on http://localhost:8000.
#
#   ./start-mlx-server.sh
#
# Runs in the foreground in this terminal — leave the window open. Ctrl-C to
# stop. This is the manual alternative to running it as a launchd service.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONDA_ENV="mlx-server"
CONFIG_FILE="mlx-server.yaml"
PORT=8000

cd "$REPO_DIR"

if [[ ! -f "$CONFIG_FILE" ]]; then
	echo "error: $CONFIG_FILE not found in $REPO_DIR" >&2
	exit 1
fi

# `conda activate` needs the shell function from conda.sh, not just the
# binary on PATH — a plain `command -v conda` check isn't enough even when
# the calling shell already has an env active, because this script runs in
# its own non-interactive shell where that function was never installed.
CONDA_SH=""
for candidate in "$HOME/anaconda3" "$HOME/miniforge3" "$HOME/miniconda3" "/opt/miniforge3" "/opt/homebrew/Caskroom/miniforge/base"; do
	if [[ -f "$candidate/etc/profile.d/conda.sh" ]]; then
		CONDA_SH="$candidate/etc/profile.d/conda.sh"
		break
	fi
done

if [[ -z "$CONDA_SH" ]]; then
	echo "error: could not find conda.sh under ~/anaconda3, ~/miniforge3, or ~/miniconda3." >&2
	echo "  If conda lives elsewhere, add its path to the candidate list in this script." >&2
	exit 1
fi

# shellcheck disable=SC1090
source "$CONDA_SH"

if ! conda env list | grep -qE "^\s*${CONDA_ENV}\s"; then
	echo "error: conda env '$CONDA_ENV' does not exist." >&2
	echo "  create it with: conda create -n $CONDA_ENV python=3.11 -y && conda activate $CONDA_ENV && pip install mlx-openai-server" >&2
	exit 1
fi

if curl -s --max-time 2 "http://localhost:$PORT/v1/models" >/dev/null 2>&1; then
	echo "Something is already answering on port $PORT — is the server already running?"
	echo "  curl -s http://localhost:$PORT/v1/models"
	exit 1
fi

conda activate "$CONDA_ENV"

echo "==> Starting mlx-openai-server on port $PORT (env: $CONDA_ENV)"
echo "==> Config: $REPO_DIR/$CONFIG_FILE"
echo "==> Ctrl-C to stop"
echo ""

exec mlx-openai-server launch --config "$CONFIG_FILE"

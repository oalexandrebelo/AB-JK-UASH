#!/bin/sh
set -eu
AB_UASH_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AB_UASH_OS=$(uname -s)
AB_UASH_ARCH=$(uname -m)
AB_UASH_RUNTIME=
case "$AB_UASH_OS/$AB_UASH_ARCH" in
  Darwin/arm64) AB_UASH_RUNTIME=darwin-arm64 ;;
  Darwin/x86_64) AB_UASH_RUNTIME=darwin-x64 ;;
  Linux/x86_64) AB_UASH_RUNTIME=linux-x64 ;;
  Linux/aarch64|Linux/arm64) AB_UASH_RUNTIME=linux-arm64 ;;
esac

ab_uash_node24() {
  [ -n "$1" ] && [ -x "$1" ] && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" = 24 ]
}

AB_UASH_NODE=
if [ -n "$AB_UASH_RUNTIME" ] && ab_uash_node24 "$AB_UASH_DIR/runtime/$AB_UASH_RUNTIME/node"; then
  AB_UASH_NODE="$AB_UASH_DIR/runtime/$AB_UASH_RUNTIME/node"
elif [ -n "${NODE_BIN:-}" ]; then
  case "$NODE_BIN" in
    /*) AB_UASH_CANDIDATE=$NODE_BIN ;;
    */*) AB_UASH_CANDIDATE=$(pwd)/$NODE_BIN ;;
    *) AB_UASH_CANDIDATE=$(command -v "$NODE_BIN" 2>/dev/null || true) ;;
  esac
  if ! ab_uash_node24 "$AB_UASH_CANDIDATE"; then
    printf '%s\n' 'NODE_BIN deve indicar um executável Node.js 24 instalado e compatível.' >&2
    exit 1
  fi
  AB_UASH_NODE=$AB_UASH_CANDIDATE
else
  for AB_UASH_CANDIDATE in \
    "$(command -v node24 2>/dev/null || true)" \
    "$(command -v node 2>/dev/null || true)" \
    /opt/homebrew/opt/node@24/bin/node \
    /opt/homebrew/opt/node@24/bin/node24 \
    /usr/local/opt/node@24/bin/node \
    /usr/local/opt/node@24/bin/node24
  do
    if ab_uash_node24 "$AB_UASH_CANDIDATE"; then
      AB_UASH_NODE=$AB_UASH_CANDIDATE
      break
    fi
  done
fi
if [ -z "$AB_UASH_NODE" ]; then
  printf '%s\n' 'Node.js 24 não foi encontrado. Use uma distribuição que inclua runtime/ ou indique uma instalação local em NODE_BIN.' >&2
  printf '%s\n' 'O iniciador não baixa runtimes nem instala dependências.' >&2
  exit 1
fi
cd "$AB_UASH_DIR"
if [ "$#" -eq 0 ]; then
  exec "$AB_UASH_NODE" scripts/start.mjs --open
else
  exec "$AB_UASH_NODE" "$@"
fi

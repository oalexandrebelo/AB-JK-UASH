#!/bin/sh
AB_UASH_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec /bin/sh "$AB_UASH_DIR/start.sh" "$@"

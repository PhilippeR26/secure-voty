#!/usr/bin/env bash
# Test double for `caddy run --config <file> --adapter caddyfile`
config=""
while [[ $# -gt 0 ]]; do [[ "$1" == "--config" ]] && config="$2"; shift; done
[[ -f "$config" ]] || { echo "config not found: $config" >&2; exit 1; }
exec sleep 3600

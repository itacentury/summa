#!/bin/sh
set -e

# Ensure data directory has correct permissions
# This handles the case where a Docker volume is mounted as root
if [ -d "/data" ]; then
    chown -R appuser:appuser /data 2>/dev/null || true
fi

# Switch to appuser and run the command
exec gosu appuser "$@"

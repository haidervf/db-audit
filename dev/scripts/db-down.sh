#!/usr/bin/env bash
# Stops and removes the container; the data volume is kept (use db:reset for a clean slate).
source "$(dirname "$0")/common.sh"
compose down

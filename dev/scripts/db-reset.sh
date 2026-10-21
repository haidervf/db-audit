#!/usr/bin/env bash
# Full clean slate: removes the container AND its data volume, then recreates and seeds.
source "$(dirname "$0")/common.sh"
compose down -v
compose up -d
wait_healthy
bash "$DEV_DIR/scripts/db-seed.sh"

#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
compose up -d
wait_healthy

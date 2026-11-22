#!/usr/bin/env bash
# Stops a dev-headless instance (anchored patterns never match this shell).
pkill -f '^hutch electrobun dev' || true
pkill -f 'Zarca-dev/bin/bun ' || true
pkill -f 'Zarca-dev/bin/launcher' || true

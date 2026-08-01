#!/usr/bin/env python3
"""Retired provider smoke sender retained as a fail-closed tombstone."""

from campaign import fail_closed


if __name__ == "__main__":
    raise SystemExit(fail_closed("smoke_test"))

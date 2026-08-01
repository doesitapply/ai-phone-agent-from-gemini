#!/usr/bin/env python3
"""Retired sample sender retained only as a fail-closed tombstone."""

from campaign import fail_closed


if __name__ == "__main__":
    raise SystemExit(fail_closed("send_samples"))

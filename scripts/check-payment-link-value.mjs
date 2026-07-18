#!/usr/bin/env node
import {
  validConfiguredPaymentLinkId,
  validConfiguredPaymentLinkUrl,
} from './lib/qualifying-revenue-evidence.mjs';

const [kind, rawValue] = process.argv.slice(2);
const valid = kind === 'url'
  ? validConfiguredPaymentLinkUrl(rawValue)
  : kind === 'id'
    ? validConfiguredPaymentLinkId(rawValue)
    : false;

if (!valid) process.exit(1);

#!/usr/bin/env node
import { normalizeStrictMailbox, parseStrictMailboxList } from '../src/email-safety.js';

const [mode, value] = process.argv.slice(2);
const ok = mode === 'mailbox'
  ? Boolean(normalizeStrictMailbox(value))
  : mode === 'list'
    ? parseStrictMailboxList(value).length > 0
    : false;

if (!ok) process.exit(1);

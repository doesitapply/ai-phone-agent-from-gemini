#!/usr/bin/env node
import { evaluateFirstDollarVoiceReadiness } from '../src/first-dollar-voice-readiness.js';

const readiness = evaluateFirstDollarVoiceReadiness(process.env);
if (!readiness.ready) {
  console.error('FAIL first-dollar voice environment is not ready:');
  for (const blocker of readiness.blockers) console.error(`- ${blocker}`);
  process.exit(1);
}

console.log('OK managed Twilio provisioning and the actual streaming AI/TTS path are configured');

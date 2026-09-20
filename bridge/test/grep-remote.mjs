const src = require('fs').readFileSync('/tmp/asar-probe/main.js', 'utf8');
const patterns = ['remote/v4', 'remote/v', 'webRemoteControl', 'web-remote-control', 'external-relay', 'externalRelay', 'deviceSid', 'pass_hash'];
for (const pat of patterns) {
  const n = src.split(pat).length - 1;
  console.log(pat, '→', n);
}

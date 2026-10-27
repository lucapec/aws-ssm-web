'use strict';

const { spawn } = require('child_process');

// Runs the aws CLI and resolves with its stdout, or rejects with its stderr.
function runAws(args, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn('aws', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `aws exited with code ${code}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

module.exports = { runAws };

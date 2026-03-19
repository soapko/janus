#!/usr/bin/env node
/**
 * Fixes broken @ricky0123/vad-web dependency in @moonshine-ai/moonshine-js.
 * Some versions of moonshine-js reference vad-web via a broken file: symlink.
 * This script creates a stub module so flora-colossus (electron-packager's
 * dependency walker) doesn't crash during packaging.
 *
 * Safe to run even when the issue doesn't exist — it's a no-op if
 * moonshine-js doesn't reference vad-web.
 */
const fs = require('fs');
const path = require('path');

const moonshineDir = path.join(__dirname, '..', 'node_modules', '@moonshine-ai', 'moonshine-js');
const moonshinePackage = path.join(moonshineDir, 'package.json');

if (!fs.existsSync(moonshinePackage)) {
  console.log('[fix-vad-web] moonshine-js not found, skipping');
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(moonshinePackage, 'utf-8'));
const deps = pkg.dependencies || {};

if (!deps['@ricky0123/vad-web']) {
  console.log('[fix-vad-web] No vad-web dependency found, skipping');
  process.exit(0);
}

// Remove the broken dependency from moonshine-js package.json
delete deps['@ricky0123/vad-web'];
pkg.dependencies = deps;
fs.writeFileSync(moonshinePackage, JSON.stringify(pkg, null, 2) + '\n');
console.log('[fix-vad-web] Removed @ricky0123/vad-web from moonshine-js dependencies');

// Create stub module directory so any require() doesn't crash
const stubDir = path.join(moonshineDir, 'node_modules', '@ricky0123', 'vad-web');
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify({
  name: '@ricky0123/vad-web',
  version: '0.0.0',
  main: 'index.js'
}, null, 2) + '\n');
fs.writeFileSync(path.join(stubDir, 'index.js'), 'module.exports = {};\n');
console.log('[fix-vad-web] Created stub module');

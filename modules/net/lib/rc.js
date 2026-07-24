'use strict';

/**
 * .wan-netrc config file reader/writer.
 * File location: CWD/.wan-netrc (JSON format)
 *
 * Supported fields:
 *   pass    {string}   Inspector password
 *   ports   {number[]} Default local ports (overridden by CLI args)
 *
 * Example .wan-netrc:
 *   {
 *     "pass": "mypassword",
 *     "ports": [8000, 8001]
 *   }
 */

const fs   = require('fs');
const path = require('path');

const RC_FILE = path.join(process.cwd(), '.wan-netrc');

/** Load and parse .wan-netrc. Returns {} if not found or invalid. */
function load() {
  try {
    if (!fs.existsSync(RC_FILE)) return {};
    const cfg = JSON.parse(fs.readFileSync(RC_FILE, 'utf8'));
    console.log(`📋 Config loaded from .wan-netrc`);
    return cfg;
  } catch (e) {
    console.warn(`⚠  Could not parse .wan-netrc: ${e.message}`);
    return {};
  }
}

/** Write config to .wan-netrc */
function save(cfg) {
  fs.writeFileSync(RC_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

module.exports = { load, save, RC_FILE };

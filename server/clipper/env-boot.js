/* ══════════════════════════════════════════════
   WHERE THE CLIPPER'S CONFIGURATION COMES FROM.

   A scheduled task starts with a bare environment, so without this every
   secret would have to be duplicated into the task definition. Instead, in
   order of increasing authority:

     1. server/.env          — the same file the site uses (gitignored). Put
                               the YT_* / TT_* families here.
     2. --service <name>     — overlay a Windows service's own environment
                               block. The rig keeps the PRODUCTION
                               DATABASE_URL on the service, not in .env (which
                               holds the dev connection string), so a
                               maintenance run that means production must ask
                               for it explicitly. Same mechanism the other rig
                               scripts use (server/lib/service-env.js).
     3. real environment     — anything already set wins over both, so a
                               one-off override on the command line still works.

   NEVER LOG WHAT THIS RETURNS. It carries the Postgres password and every
   refresh token.
   ══════════════════════════════════════════════ */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(HERE, '../.env');

/**
 * Fill process.env from server/.env and, if asked, a service's env block.
 * Values already present in process.env are never overwritten.
 * @param {string} [serviceName] from --service
 */
export async function bootEnv(serviceName) {
  if (fs.existsSync(ENV_FILE)) {
    try {
      const { config } = await import('dotenv');
      /* dotenv does not override an existing variable, which is the
         precedence we want: a real environment variable beats the file. */
      config({ path: ENV_FILE });
    } catch {
      /* dotenv is a dependency of the SERVER, not of these scripts, so a
         checkout where `npm install` has not been run inside server/ would
         otherwise crash here — or, worse, report every credential missing
         however carefully the file was filled in. The format we need is
         KEY=VALUE, so parse it rather than fail. */
      loadEnvFile(ENV_FILE);
    }
  }

  if (serviceName) {
    const { readServiceEnv } = await import('../lib/service-env.js');
    const overlay = readServiceEnv(serviceName);
    for (const [k, v] of Object.entries(overlay)) {
      /* The service block is the authority for what it defines (chiefly the
         production DATABASE_URL) — it is the reason --service was passed. */
      process.env[k] = v;
    }
  }

  return process.env;
}

/**
 * A minimal KEY=VALUE reader, used only when dotenv is unavailable.
 * Deliberately literal: no escape processing, so a Windows path keeps its
 * backslashes. Existing environment variables still win.
 */
function loadEnvFile(file) {
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    /* Strip one matching pair of surrounding quotes, as dotenv does. */
    if (value.length > 1 && ((value[0] === '"' && value.endsWith('"')) ||
        (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** `--service <name>` out of argv, if present. */
export function serviceArg() {
  const i = process.argv.indexOf('--service');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

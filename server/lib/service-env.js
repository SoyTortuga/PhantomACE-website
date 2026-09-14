/* ══════════════════════════════════════════════
   Read a Windows service's environment block.

   Both site processes run from the same repo directory, so server/.env
   cannot distinguish them — it holds the DEV connection string, and each
   NSSM service overrides DATABASE_URL in its own AppEnvironmentExtra. That
   means a maintenance script run by hand gets dev by default, which is the
   safe default but the wrong one when you actually mean production.

   The alternative was a PowerShell preamble that loads the value into the
   session before running node. That works, but it puts the production
   connection string through the shell, and a trailing `Remove-Item` (or the
   lack of one) silently changes what the NEXT command connects to. Reading
   it here keeps it inside the process that uses it.

   NEVER log what this returns. It contains the Postgres password.
   ══════════════════════════════════════════════ */

import { execFileSync } from 'node:child_process';

/**
 * @param {string} serviceName e.g. 'phantomace-web'
 * @returns {Record<string,string>} env vars set on that service, possibly empty
 */
export function readServiceEnv(serviceName) {
  if (process.platform !== 'win32') {
    throw new Error('--service only works on Windows (the rig); set DATABASE_URL instead');
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(serviceName)) {
    /* Goes into a command line — refuse anything that isn't a plain service
       name rather than trying to quote it. */
    throw new Error(`Invalid service name: ${serviceName}`);
  }

  const key = `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${serviceName}\\Parameters`;

  let out;
  try {
    out = execFileSync('reg', ['query', key, '/v', 'AppEnvironmentExtra'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    /* No such service, or it sets no extra environment. Both mean "nothing
       to override with" — the caller decides whether that is fatal. */
    return {};
  }

  return parseMultiSz(out);
}

/**
 * Parse `reg query` output into an env map.
 *
 * Exported so the format assumption is testable off the rig. reg.exe renders
 * REG_MULTI_SZ on a single line with a LITERAL backslash-zero between
 * entries — not an actual NUL byte:
 *
 *     DependOnService    REG_MULTI_SZ    RpcSs\0AppID\0CryptSvc
 *
 * Splitting on the wrong one yields a single unparseable blob, which would
 * look exactly like "the service sets no variables".
 *
 * @param {string} out raw stdout from `reg query ... /v <name>`
 * @returns {Record<string,string>}
 */
export function parseMultiSz(out) {
  const line = String(out).split(/\r?\n/).find(l => l.includes('REG_MULTI_SZ'));
  if (!line) return {};

  const payload = line.split('REG_MULTI_SZ')[1] || '';
  const vars = {};
  for (const entry of payload.split('\\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    /* Only the name is trimmed. A value is taken verbatim — trimming a
       password would silently corrupt it. */
    vars[entry.slice(0, eq).trim()] = entry.slice(eq + 1);
  }
  return vars;
}

/**
 * Resolve the connection string a script should use.
 * Explicit --service wins, then the ambient environment, then server/.env
 * (which dotenv has already applied by the time this is called).
 */
export function resolveDatabaseUrl({ service, fallback }) {
  if (service) {
    const vars = readServiceEnv(service);
    if (!vars.DATABASE_URL) {
      throw new Error(`Service "${service}" sets no DATABASE_URL (is the name right?)`);
    }
    return vars.DATABASE_URL;
  }
  return fallback || process.env.DATABASE_URL || null;
}

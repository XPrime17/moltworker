import type { Sandbox, Process } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { MOLTBOT_PORT, STARTUP_TIMEOUT_MS } from '../config';
import { buildEnvVars } from './env';
import { mountR2Storage } from './r2';
import { computeConfigHash } from './version';

/**
 * Check if the running gateway has the current config hash.
 * Returns { current: true } if hash matches, { current: false, reason: '...' } if mismatch.
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 */
export async function isGatewayCurrentVersion(
  sandbox: Sandbox,
  env: MoltbotEnv
): Promise<{ current: boolean; expectedHash: string; runningHash: string | null; reason?: string }> {
  const expectedHash = computeConfigHash(env);

  try {
    // Read the hash from the running container
    const proc = await sandbox.startProcess('cat /tmp/gateway-config-hash 2>/dev/null || echo ""');
    await new Promise(resolve => setTimeout(resolve, 500));
    const logs = await proc.getLogs();
    const runningHash = (logs.stdout || '').trim();

    if (!runningHash) {
      return {
        current: false,
        expectedHash,
        runningHash: null,
        reason: 'No config hash found in container (pre-version gateway)',
      };
    }

    if (runningHash !== expectedHash) {
      return {
        current: false,
        expectedHash,
        runningHash,
        reason: `Hash mismatch: running=${runningHash}, expected=${expectedHash}`,
      };
    }

    return { current: true, expectedHash, runningHash };
  } catch (error) {
    return {
      current: false,
      expectedHash,
      runningHash: null,
      reason: `Failed to read config hash: ${error instanceof Error ? error.message : 'unknown'}`,
    };
  }
}

/**
 * Find an existing Moltbot gateway process
 *
 * @param sandbox - The sandbox instance
 * @returns The process if found and running/starting, null otherwise
 */
export async function findExistingMoltbotProcess(sandbox: Sandbox): Promise<Process | null> {
  try {
    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      // Only match the gateway process, not CLI commands like "clawdbot devices list"
      // Note: CLI is still named "clawdbot" until upstream renames it
      const isGatewayProcess =
        proc.command.includes('start-moltbot.sh') ||
        proc.command.includes('clawdbot gateway');
      const isCliCommand =
        proc.command.includes('clawdbot devices') ||
        proc.command.includes('clawdbot --version');

      if (isGatewayProcess && !isCliCommand) {
        if (proc.status === 'starting' || proc.status === 'running') {
          return proc;
        }
      }
    }
  } catch (e) {
    console.log('Could not list processes:', e);
  }
  return null;
}

/**
 * Force restart the Moltbot gateway
 *
 * Kills any existing gateway process and starts a new one.
 * Use this when config changes require a gateway restart.
 */
export async function restartMoltbotGateway(sandbox: Sandbox, env: MoltbotEnv): Promise<Process> {
  // Kill any existing gateway process
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  if (existingProcess) {
    console.log('[restart] Killing existing gateway process:', existingProcess.id);
    try {
      await existingProcess.kill();
      // Wait for process to fully terminate
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (killError) {
      console.log('[restart] Failed to kill process (may already be dead):', killError);
    }
  }

  // Mount R2 storage
  await mountR2Storage(sandbox, env);

  // Start fresh gateway
  console.log('[restart] Starting fresh Moltbot gateway...');
  const envVars = buildEnvVars(env);
  const command = '/usr/local/bin/start-moltbot.sh';

  const process = await sandbox.startProcess(command, {
    env: Object.keys(envVars).length > 0 ? envVars : undefined,
  });
  console.log('[restart] Process started:', process.id);

  // Wait for ready
  await process.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
  console.log('[restart] Gateway is ready!');

  const logs = await process.getLogs();
  if (logs.stdout) console.log('[restart] stdout:', logs.stdout);
  if (logs.stderr) console.log('[restart] stderr:', logs.stderr);

  return process;
}

/**
 * Ensure the Moltbot gateway is running with current config.
 *
 * This will:
 * 1. Mount R2 storage if configured
 * 2. Check for an existing gateway process
 * 3. Verify the gateway has the current config hash
 * 4. If hash mismatch, kill and restart with new config
 * 5. Wait for it to be ready, or start a new one
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns The running gateway process
 */
export async function ensureMoltbotGateway(sandbox: Sandbox, env: MoltbotEnv): Promise<Process> {
  // Mount R2 storage for persistent data (non-blocking if not configured)
  // R2 is used as a backup - the startup script will restore from it on boot
  await mountR2Storage(sandbox, env);

  // Check if Moltbot is already running or starting
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  if (existingProcess) {
    console.log('Found existing Moltbot process:', existingProcess.id, 'status:', existingProcess.status);

    // Check if the running gateway has the current config
    const versionCheck = await isGatewayCurrentVersion(sandbox, env);
    if (!versionCheck.current) {
      console.log('[version] Gateway config mismatch:', versionCheck.reason);
      console.log('[version] Killing outdated gateway and restarting with new config...');
      try {
        await existingProcess.kill();
        // Wait for process to fully terminate
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (killError) {
        console.log('[version] Failed to kill process (may already be dead):', killError);
      }
      // Fall through to start a new gateway with updated config
    } else {
      // Config hash matches - reuse existing gateway
      console.log('[version] Gateway has current config (hash:', versionCheck.expectedHash, ')');

      // Always use full startup timeout - a process can be "running" but not ready yet
      // (e.g., just started by another concurrent request). Using a shorter timeout
      // causes race conditions where we kill processes that are still initializing.
      try {
        console.log('Waiting for Moltbot gateway on port', MOLTBOT_PORT, 'timeout:', STARTUP_TIMEOUT_MS);
        await existingProcess.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
        console.log('Moltbot gateway is reachable');
        return existingProcess;
      } catch (e) {
        // Timeout waiting for port - process is likely dead or stuck, kill and restart
        console.log('Existing process not reachable after full timeout, killing and restarting...');
        try {
          await existingProcess.kill();
        } catch (killError) {
          console.log('Failed to kill process:', killError);
        }
      }
    }
  }

  // Start a new Moltbot gateway
  console.log('Starting new Moltbot gateway...');
  const envVars = buildEnvVars(env);
  const command = '/usr/local/bin/start-moltbot.sh';

  console.log('Starting process with command:', command);
  console.log('Environment vars being passed:', Object.keys(envVars));

  let process: Process;
  try {
    process = await sandbox.startProcess(command, {
      env: Object.keys(envVars).length > 0 ? envVars : undefined,
    });
    console.log('Process started with id:', process.id, 'status:', process.status);
  } catch (startErr) {
    console.error('Failed to start process:', startErr);
    throw startErr;
  }

  // Wait for the gateway to be ready
  try {
    console.log('[Gateway] Waiting for Moltbot gateway to be ready on port', MOLTBOT_PORT);
    await process.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
    console.log('[Gateway] Moltbot gateway is ready!');

    const logs = await process.getLogs();
    if (logs.stdout) console.log('[Gateway] stdout:', logs.stdout);
    if (logs.stderr) console.log('[Gateway] stderr:', logs.stderr);
  } catch (e) {
    console.error('[Gateway] waitForPort failed:', e);
    try {
      const logs = await process.getLogs();
      console.error('[Gateway] startup failed. Stderr:', logs.stderr);
      console.error('[Gateway] startup failed. Stdout:', logs.stdout);
      throw new Error(`Moltbot gateway failed to start. Stderr: ${logs.stderr || '(empty)'}`);
    } catch (logErr) {
      console.error('[Gateway] Failed to get logs:', logErr);
      throw e;
    }
  }

  // Verify gateway is actually responding
  console.log('[Gateway] Verifying gateway health...');
  
  return process;
}

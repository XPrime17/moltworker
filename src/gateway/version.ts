import type { MoltbotEnv } from '../types';

/**
 * Compute a hash of environment variables that affect gateway behavior.
 * When this hash changes, the gateway needs to be restarted to apply new config.
 *
 * Uses djb2 hash algorithm for simplicity and speed.
 */
export function computeConfigHash(env: MoltbotEnv): string {
  // Collect all config values that affect gateway behavior
  const relevantConfig = {
    // Gateway auth
    gatewayToken: env.MOLTBOT_GATEWAY_TOKEN || '',

    // AI provider config
    aiGatewayApiKey: env.AI_GATEWAY_API_KEY || '',
    aiGatewayBaseUrl: env.AI_GATEWAY_BASE_URL || '',
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL || '',
    openaiApiKey: env.OPENAI_API_KEY || '',

    // Telegram config
    telegramToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramPolicy: env.TELEGRAM_DM_POLICY || '',

    // Discord config
    discordToken: env.DISCORD_BOT_TOKEN || '',
    discordPolicy: env.DISCORD_DM_POLICY || '',

    // Slack config
    slackBotToken: env.SLACK_BOT_TOKEN || '',
    slackAppToken: env.SLACK_APP_TOKEN || '',

    // Other
    devMode: env.DEV_MODE || '',
    bindMode: env.CLAWDBOT_BIND_MODE || '',
  };

  const configString = JSON.stringify(relevantConfig);
  return djb2Hash(configString);
}

/**
 * djb2 hash algorithm - fast, simple, good distribution
 * Returns a hex string for readability
 */
function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    // Convert to unsigned 32-bit
    hash = hash >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

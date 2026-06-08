import {
    readGlobalConfig,
    setApiKey,
    setApiUrl,
    setOrchUrl,
    setWsUrl,
    clearUrls,
    clearApiKey,
    getConfiguredUrls,
    getGithubToken,
    setGithubToken,
    clearGithubToken,
} from '../../utils/config.js';
import { prompt } from '../../utils/prompts.js';

type ConfigAction = 'show' | 'set' | 'clear';

export async function configCommand(action?: string, key?: string, value?: string): Promise<void> {
    const parsedAction = (action || 'show') as ConfigAction;

    switch (parsedAction) {
        case 'show':
            showConfig();
            break;
        case 'set':
            await setConfigValue(key, value);
            break;
        case 'clear':
            await clearConfig(key);
            break;
        default:
            console.log('Usage: lgraph config [show|set|clear] [key] [value]');
            console.log('');
            console.log('Commands:');
            console.log('  show                    Show current configuration');
            console.log('  set <key> <value>       Set a configuration value');
            console.log('  clear [key]             Clear configuration (all or specific key)');
            console.log('');
            console.log('Keys:');
            console.log('  api-key                 Your LGRAPH API key');
            console.log('  gh-token                GitHub token for PR insights (optional)');
            console.log('  api-url                 LGRAPH_API_URL');
            console.log('  orch-url                LGRAPH_ORCH_URL');
            console.log('  ws-url                  LGRAPH_WS_URL');
            console.log('');
            console.log('Examples:');
            console.log('  lgraph config');
            console.log('  lgraph config set gh-token ghp_...');
            console.log('  lgraph config set api-url http://localhost:9000');
            console.log('  lgraph config set orch-url http://localhost:9999');
            console.log('  lgraph config set ws-url ws://localhost:9999');
            console.log('  lgraph config clear urls');
            break;
    }
}

function showConfig(): void {
    console.log('╔════════════════════════════════════════════╗');
    console.log('║         Latentgraph Configuration          ║');
    console.log('╚════════════════════════════════════════════╝\n');

    const globalConfig = readGlobalConfig();
    const urls = getConfiguredUrls();

    // API Key
    console.log('API Key:');
    if (globalConfig?.api_key) {
        const maskedKey = globalConfig.api_key.substring(0, 8) + '...' + globalConfig.api_key.slice(-4);
        console.log(`  ${maskedKey}`);
    } else {
        console.log('  Not configured');
    }
    console.log('');

    // GitHub token
    const githubToken = getGithubToken();
    console.log('GitHub Token (PR insights):');
    if (githubToken) {
        const maskedToken = githubToken.substring(0, 8) + '...' + githubToken.slice(-4);
        console.log(`  ${maskedToken}`);
    } else {
        console.log('  Not configured (PR insights disabled)');
    }
    console.log('');

    // URLs
    console.log('URLs:');
    console.log(`  API URL:  ${urls.api_url}`);
    console.log(`  Orch URL: ${urls.orch_url}`);
    console.log(`  WS URL:   ${urls.ws_url}`);
    console.log('');

    // Source info
    console.log('Config file: ~/.lgraph/config.json');
    console.log('');
    console.log('Tip: URLs can also be set via environment variables:');
    console.log('  LGRAPH_API_URL, LGRAPH_ORCH_URL, LGRAPH_WS_URL');
}

async function setConfigValue(key?: string, value?: string): Promise<void> {
    if (!key) {
        console.error('Error: Key is required. Run "lgraph config" to see available keys.');
        process.exit(1);
    }

    const validKeys = ['api-key', 'gh-token', 'api-url', 'orch-url', 'ws-url'];
    if (!validKeys.includes(key)) {
        console.error(`Unknown key: ${key}`);
        console.log(`Available keys: ${validKeys.join(', ')}`);
        process.exit(1);
    }

    // If no value provided, prompt for it
    if (!value) {
        value = await prompt(`Enter value for ${key}: `);
        if (!value?.trim()) {
            console.error('Error: Value cannot be empty.');
            process.exit(1);
        }
    } else if (!value.trim()) {
        console.error('Error: Value cannot be empty.');
        process.exit(1);
    }

    switch (key) {
        case 'api-key':
            setApiKey(value);
            console.log('✓ API key saved');
            break;
        case 'gh-token':
            setGithubToken(value);
            console.log('✓ GitHub token saved');
            break;
        case 'api-url':
            setApiUrl(value);
            console.log(`✓ API URL set to: ${value}`);
            break;
        case 'orch-url':
            setOrchUrl(value);
            console.log(`✓ Orch URL set to: ${value}`);
            break;
        case 'ws-url':
            setWsUrl(value);
            console.log(`✓ WS URL set to: ${value}`);
            break;
        default:
            console.error(`Unknown key: ${key}`);
            console.log('Available keys: api-key, gh-token, api-url, orch-url, ws-url');
            process.exit(1);
    }

    console.log('\nNote: Restart any running daemon for URL changes to take effect.');
}

async function clearConfig(key?: string): Promise<void> {
    if (!key) {
        // Clear everything
        const answer = await prompt('Clear all configuration? (y/n, default no): ');
        const trimmed = answer.trim().toLowerCase();
        if (trimmed !== 'y' && trimmed !== 'yes') {
            console.log('Cancelled.');
            return;
        }
        clearApiKey();
        clearUrls();
        console.log('✓ All configuration cleared');
        return;
    }

    switch (key) {
        case 'api-key':
            clearApiKey();
            console.log('✓ API key cleared');
            break;
        case 'gh-token':
            clearGithubToken();
            console.log('✓ GitHub token cleared (PR insights disabled)');
            break;
        case 'urls':
            clearUrls();
            console.log('✓ URLs cleared (will use defaults)');
            break;
        case 'api-url':
        case 'orch-url':
        case 'ws-url':
            console.log('Use "lgraph config clear urls" to clear all URLs');
            break;
        default:
            console.error(`Unknown key: ${key}`);
            console.log('Available keys: api-key, gh-token, urls');
            process.exit(1);
    }
}

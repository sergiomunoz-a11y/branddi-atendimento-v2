/**
 * Business Config Loader — Reads YAML config at startup.
 * Provides typed access to chatbot messages, routing rules, brand info.
 * Non-technical team members can edit config/business.yaml without touching code.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', '..', 'config', 'business.yaml');

let _config = null;

function loadConfig() {
    try {
        const raw = readFileSync(CONFIG_PATH, 'utf8');
        _config = yaml.load(raw);
        logger.info('Business config loaded', { path: CONFIG_PATH });
    } catch (err) {
        logger.warn('Failed to load business config, using defaults', { error: err.message });
        _config = {};
    }
    return _config;
}

// Load on import
loadConfig();

/** Get full config object */
export function getConfig() {
    return _config || {};
}

/** Get brand info */
export function getBrand() {
    return _config?.brand || { name: 'Branddi', tone: 'profissional' };
}

/** Get chatbot message by key path (e.g., 'welcome', 'ask_company.comercial') */
export function getBotMessage(key, fallback = '') {
    const chatbot = _config?.chatbot || {};
    const parts = key.split('.');
    let val = chatbot;
    for (const p of parts) {
        val = val?.[p];
        if (val === undefined) return fallback;
    }
    return typeof val === 'string' ? val.trim() : fallback;
}

/** Get routing config */
export function getRouting() {
    return _config?.routing || {};
}

/** Get business hours config */
export function getBusinessHours() {
    return _config?.business_hours || {};
}

/** Get max retries from config */
export function getMaxRetries() {
    return _config?.chatbot?.max_retries || 3;
}

/** Reload config (useful for hot-reload in development) */
export function reloadConfig() {
    return loadConfig();
}

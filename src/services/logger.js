/**
 * Structured JSON Logger
 */
const LEVEL_MAP = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVEL_MAP[process.env.LOG_LEVEL || 'info'];

function log(level, message, context = {}) {
    if (LEVEL_MAP[level] < MIN_LEVEL) return;
    const entry = { timestamp: new Date().toISOString(), level, message, ...context };
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(JSON.stringify(entry));
}

export default {
    debug: (msg, ctx) => log('debug', msg, ctx),
    info:  (msg, ctx) => log('info', msg, ctx),
    warn:  (msg, ctx) => log('warn', msg, ctx),
    error: (msg, ctx) => log('error', msg, ctx),
};

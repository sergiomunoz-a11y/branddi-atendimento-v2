/**
 * Chatbot NLP — Motor de processamento de linguagem natural
 *
 * Capabilities:
 *   - Intent classification com confidence score + fuzzy matching
 *   - Entity extraction (nome, empresa, domínio, email, telefone)
 *   - Greeting detection
 *   - Sentiment analysis (frustrado/neutro/positivo)
 *   - Detecção de mídia / mensagem vazia
 *   - Validação de domínio
 *   - Anti-flood detection
 */
import logger from './logger.js';

// ─── INTENT CLASSIFICATION ────────────────────────────────────────────

/**
 * Mapa de intenções com pesos por keyword.
 * Formato: { keyword: weight }
 * Weight > 1 = strong signal, 1 = normal, 0.5 = weak
 */
const INTENT_MAP = {
    comercial: {
        // Exact matches (menu options)
        exact: ['1'],
        // Strong signals
        keywords: {
            'conhecer':        2,   'contratar':       2,   'servico':         1.5,
            'serviço':         1.5, 'plano':           1.5, 'preço':           1.5,
            'preco':           1.5, 'proposta':        2,   'reunião':         2,
            'reuniao':         2,   'demo':            2,   'demonstração':    2,
            'demonstracao':    2,   'interessado':     1.5, 'interessada':     1.5,
            'quero':           1,   'produtos':        1,   'proteção':        1.5,
            'protecao':        1.5, 'monitorar':       1.5, 'google ads':      2,
            'brand bidding':   2,   'brand protection': 2,  'concorrente':     1.5,
            'concorrência':    1.5, 'concorrencia':    1.5, 'investimento':    1,
            'orçamento':       1.5, 'orcamento':       1.5, 'agendar':         1.5,
            'apresentação':    1.5, 'apresentacao':    1.5, 'como funciona':   1.5,
            'quanto custa':    2,   'valores':         1.5, 'um':              0.5,
            'diagnóstico':     1.5, 'diagnostico':     1.5, 'anúncios':        1,
            'anuncios':        1,   'ads':             1,   'marca':           0.5,
        },
    },
    opec: {
        exact: ['2', '3'],
        keywords: {
            'recebi':          2,   'notificação':     2,   'notificacao':     2,
            'notificado':      2,   'notificada':      2,   'negativar':       2,
            'negativação':     2,   'negativacao':      2,   'remover':         1.5,
            'remoção':         1.5, 'remocao':         1.5, 'termo':           1.5,
            'palavra':         1,   'campanha':        0.5, 'infração':        2,
            'infracao':        2,   'cliente':         1.5, 'dúvida':          1.5,
            'duvida':          1.5, 'problema':        1,   'denúncia':        1.5,
            'denuncia':        1.5, 'suporte':         1.5, 'ajuda':           0.5,
            'reclamação':      1.5, 'reclamacao':      1.5, 'compliance':      1.5,
            'dois':            0.5, 'três':            0.5, 'tres':            0.5,
            'two':             0.5, 'three':           0.5, 'já sou':          1.5,
            'ja sou':          1.5, 'sou cliente':     2,   'minha conta':     1.5,
            'meu caso':        1,   'andamento':       1.5, 'status':          1,
            'palavra-chave':   2,   'keyword':         1.5, 'search term':     1.5,
        },
    },
};

/**
 * Classifica a intenção da mensagem.
 * Retorna: { intent: 'comercial'|'opec'|null, confidence: 0-1, method: string }
 */
export function classifyIntent(text) {
    const t = (text || '').toLowerCase().trim();
    if (!t) return { intent: null, confidence: 0, method: 'empty' };

    // 1. Exact match (menu options: "1", "2", "3")
    for (const [intent, cfg] of Object.entries(INTENT_MAP)) {
        if (cfg.exact.some(k => t === k)) {
            return { intent, confidence: 1.0, method: 'exact' };
        }
    }

    // 2. Weighted keyword scoring
    const scores = {};
    for (const [intent, cfg] of Object.entries(INTENT_MAP)) {
        let score = 0;
        let matches = 0;
        for (const [keyword, weight] of Object.entries(cfg.keywords)) {
            if (t.includes(keyword)) {
                score += weight;
                matches++;
            }
        }
        // Fuzzy matching: Levenshtein distance ≤ 2 para palavras de 5+ chars
        if (matches === 0) {
            const words = t.split(/\s+/);
            for (const word of words) {
                if (word.length < 4) continue;
                for (const [keyword, weight] of Object.entries(cfg.keywords)) {
                    if (keyword.length < 4) continue;
                    if (levenshtein(word, keyword) <= 2) {
                        score += weight * 0.7; // penaliza fuzzy
                        matches++;
                    }
                }
            }
        }
        scores[intent] = { score, matches };
    }

    const best = Object.entries(scores).sort((a, b) => b[1].score - a[1].score)[0];
    const second = Object.entries(scores).sort((a, b) => b[1].score - a[1].score)[1];

    if (!best || best[1].score === 0) {
        return { intent: null, confidence: 0, method: 'no_match' };
    }

    const totalScore = Object.values(scores).reduce((s, v) => s + v.score, 0);
    const confidence = totalScore > 0 ? best[1].score / totalScore : 0;

    // Exige confiança mínima de 0.55 e diferença significativa entre 1º e 2º
    const diff = second ? best[1].score - second[1].score : best[1].score;
    if (confidence < 0.55 && diff < 1.5) {
        return { intent: null, confidence, method: 'low_confidence' };
    }

    return {
        intent: best[0],
        confidence: Math.min(confidence, 1.0),
        method: best[1].matches > 0 ? 'keyword' : 'fuzzy',
        scores,
    };
}

// ─── ENTITY EXTRACTION ────────────────────────────────────────────────

/**
 * Extrai entidades da mensagem.
 * Retorna: { name, company, domain, email, phone }
 */
export function extractEntities(text) {
    const t = (text || '').trim();
    const entities = {};

    // Email
    const emailMatch = t.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (emailMatch) entities.email = emailMatch[0].toLowerCase();

    // Telefone (BR: 11 dígitos com DDD, ou +55)
    const phoneMatch = t.match(/(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?\d{4,5}[-.\s]?\d{4}/);
    if (phoneMatch) entities.phone = phoneMatch[0].replace(/\D/g, '');

    // Domínio / URL
    const domainMatch = t.match(
        /(?:https?:\/\/)?(?:www\.)?([a-z0-9][-a-z0-9]*\.[a-z]{2,}(?:\.[a-z]{2,})?)/i
    );
    if (domainMatch) entities.domain = domainMatch[1].toLowerCase();

    // Nome — padrões como "sou o João", "meu nome é Maria", "aqui é Pedro"
    const namePatterns = [
        /(?:sou\s+(?:o|a)\s+)([A-ZÀ-Ú][a-zà-ú]+(?:\s[A-ZÀ-Ú][a-zà-ú]+)?)/,
        /(?:meu\s+nome\s+(?:é|e)\s+)([A-ZÀ-Ú][a-zà-ú]+(?:\s[A-ZÀ-Ú][a-zà-ú]+)?)/,
        /(?:aqui\s+(?:é|e)\s+(?:o|a)\s+)([A-ZÀ-Ú][a-zà-ú]+(?:\s[A-ZÀ-Ú][a-zà-ú]+)?)/,
        /(?:me\s+chamo\s+)([A-ZÀ-Ú][a-zà-ú]+(?:\s[A-ZÀ-Ú][a-zà-ú]+)?)/,
    ];
    for (const pattern of namePatterns) {
        const match = t.match(pattern);
        if (match) {
            entities.name = match[1].trim();
            break;
        }
    }

    // Empresa — padrões como "da empresa X", "empresa: X", "da X"
    const companyPatterns = [
        /(?:(?:da|na|pela)\s+empresa\s+)([A-ZÀ-Ú][\w\s&.-]{1,50}?)(?:\.|,|!|\?|$)/i,
        /(?:empresa[:\s]+)([A-ZÀ-Ú][\w\s&.-]{1,50}?)(?:\.|,|!|\?|$)/i,
        /(?:trabalho\s+(?:na|no|pela)\s+)([A-ZÀ-Ú][\w\s&.-]{1,50}?)(?:\.|,|!|\?|$)/i,
    ];
    for (const pattern of companyPatterns) {
        const match = t.match(pattern);
        if (match) {
            entities.company = match[1].trim();
            break;
        }
    }

    return entities;
}

// ─── GREETING DETECTION ───────────────────────────────────────────────

const GREETINGS = [
    'oi', 'olá', 'ola', 'oie', 'oii', 'oiii',
    'bom dia', 'boa tarde', 'boa noite', 'boa madrugada',
    'eae', 'eai', 'fala', 'falae',
    'hello', 'hi', 'hey', 'hola',
    'blz', 'beleza', 'tudo bem', 'tudo bom',
    'e aí', 'e ai', 'salve',
];

/**
 * Verifica se a mensagem é apenas uma saudação (sem conteúdo adicional).
 */
export function isGreeting(text) {
    const t = (text || '').toLowerCase().trim().replace(/[!?.,]+$/, '').trim();
    return GREETINGS.some(g => t === g || t.startsWith(g + ' ') || t.endsWith(' ' + g));
}

/**
 * Verifica se a mensagem é uma saudação PURA (só saudação, nada mais).
 */
export function isPureGreeting(text) {
    const t = (text || '').toLowerCase().trim().replace(/[!?.,\s]+/g, ' ').trim();
    const words = t.split(' ');
    // Saudação pura: 1-3 palavras, todas reconhecidas como greeting/filler
    if (words.length > 4) return false;
    const fillers = ['bom', 'boa', 'dia', 'tarde', 'noite', 'tudo', 'bem', 'bom'];
    return GREETINGS.some(g => {
        const gWords = g.split(' ');
        if (gWords.length === words.length && gWords.every((w, i) => words[i] === w)) return true;
        if (words.length === 1 && GREETINGS.includes(words[0])) return true;
        return false;
    }) || words.every(w => GREETINGS.includes(w) || fillers.includes(w));
}

// ─── SENTIMENT ANALYSIS ──────────────────────────────────────────────

const SENTIMENT_SIGNALS = {
    negative: {
        words: [
            'absurdo', 'péssimo', 'pessimo', 'horrível', 'horrivel', 'raiva',
            'desrespeito', 'vergonha', 'inadmissível', 'inadmissivel',
            'processarei', 'processar', 'procon', 'advogado', 'reclame aqui',
            'lixo', 'porcaria', 'incompetente', 'incompetência', 'palhaçada',
            'ameaça', 'ameaca', 'urgente', 'urgência', 'urgencia',
            'jamais', 'nunca mais', 'cancelar', 'estou esperando',
            'ninguém responde', 'ninguem responde', 'faz tempo', 'descaso',
        ],
        patterns: [
            /!{3,}/,           // Múltiplas exclamações
            /\?{3,}/,          // Múltiplas interrogações
            /[A-ZÁÉÍÓÚÂÊÎÔÛ\s]{10,}/, // CAPS LOCK (10+ chars maiúsculas)
        ],
    },
    positive: {
        words: [
            'obrigado', 'obrigada', 'grato', 'grata', 'agradeço', 'agradeco',
            'excelente', 'perfeito', 'maravilha', 'top', 'ótimo', 'otimo',
            'muito bom', 'adorei', 'parabéns', 'parabens', 'show',
            'sensacional', 'incrível', 'incrivel', 'valeu',
        ],
    },
};

/**
 * Analisa sentimento da mensagem.
 * Retorna: { sentiment: 'negative'|'neutral'|'positive', score: -1 to 1, urgency: boolean }
 */
export function analyzeSentiment(text) {
    const t = (text || '').toLowerCase().trim();
    if (!t) return { sentiment: 'neutral', score: 0, urgency: false };

    let negScore = 0;
    let posScore = 0;

    // Word matching
    for (const word of SENTIMENT_SIGNALS.negative.words) {
        if (t.includes(word)) negScore += 1;
    }
    for (const pattern of SENTIMENT_SIGNALS.negative.patterns) {
        if (pattern.test(text)) negScore += 1.5; // patterns use original text (case sensitive)
    }
    for (const word of SENTIMENT_SIGNALS.positive.words) {
        if (t.includes(word)) posScore += 1;
    }

    const urgency = negScore >= 2 || t.includes('urgente') || t.includes('urgência')
        || t.includes('urgencia') || /!{3,}/.test(text);

    const total = negScore + posScore;
    if (total === 0) return { sentiment: 'neutral', score: 0, urgency: false };

    const score = (posScore - negScore) / total;
    const sentiment = score > 0.2 ? 'positive' : score < -0.2 ? 'negative' : 'neutral';

    return { sentiment, score: Math.round(score * 100) / 100, urgency };
}

// ─── DOMAIN VALIDATION ───────────────────────────────────────────────

/**
 * Valida e normaliza um domínio.
 * Retorna: { valid: boolean, domain: string|null, reason: string }
 */
export function validateDomain(input) {
    const t = (input || '').trim().toLowerCase();
    if (!t) return { valid: false, domain: null, reason: 'empty' };

    // Remove protocolo e path
    let domain = t
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .split('/')[0]
        .split('?')[0];

    // Check se parece domínio válido
    const domainRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;
    if (!domainRegex.test(domain)) {
        // Talvez esqueceu o TLD
        if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(domain) && !domain.includes('.')) {
            return { valid: false, domain: null, reason: 'no_tld' };
        }
        return { valid: false, domain: null, reason: 'invalid_format' };
    }

    return { valid: true, domain, reason: 'ok' };
}

// ─── MEDIA DETECTION ─────────────────────────────────────────────────

/**
 * Detecta se a mensagem é apenas mídia sem texto.
 */
export function isMediaOnly(text, attachments) {
    const hasText = (text || '').trim().length > 0;
    const hasMedia = Array.isArray(attachments) && attachments.length > 0;
    return !hasText && hasMedia;
}

/**
 * Identifica o tipo de mídia.
 */
export function getMediaType(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return null;
    const att = attachments[0];
    const mime = (att.mime_type || att.type || '').toLowerCase();
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/') || mime.includes('ogg')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    if (mime.includes('pdf') || mime.includes('document') || mime.includes('spreadsheet')) return 'document';
    return 'other';
}

// ─── ANTI-FLOOD ──────────────────────────────────────────────────────

const _recentMessages = new Map(); // chatId → { count, firstAt, lastAt }
const FLOOD_WINDOW_MS = 10_000;    // 10 segundos
const FLOOD_MAX_MSGS  = 5;

/**
 * Detecta se o lead está mandando mensagens muito rápido.
 * Retorna true se deve throttle (ignorar mensagem).
 */
export function isFlood(chatId) {
    const now = Date.now();
    const entry = _recentMessages.get(chatId);

    if (!entry || now - entry.firstAt > FLOOD_WINDOW_MS) {
        _recentMessages.set(chatId, { count: 1, firstAt: now, lastAt: now });
        return false;
    }

    entry.count++;
    entry.lastAt = now;

    if (entry.count > FLOOD_MAX_MSGS) {
        logger.debug('Flood detected', { chatId, count: entry.count });
        return true;
    }
    return false;
}

/**
 * Limpa entries antigas do anti-flood (chamar periodicamente).
 */
export function cleanFloodMap() {
    const now = Date.now();
    for (const [key, entry] of _recentMessages.entries()) {
        if (now - entry.lastAt > FLOOD_WINDOW_MS * 3) {
            _recentMessages.delete(key);
        }
    }
}

// Cleanup automático a cada 60 segundos
setInterval(cleanFloodMap, 60_000);

// ─── BUSINESS HOURS ──────────────────────────────────────────────────

/**
 * Verifica se está em horário comercial.
 * Default: Seg-Sex 9h-18h (America/Sao_Paulo)
 */
export function isBusinessHours(config = {}) {
    const {
        timezone = 'America/Sao_Paulo',
        startHour = 9,
        endHour = 18,
        workDays = [1, 2, 3, 4, 5], // Seg-Sex
    } = config;

    const now = new Date();
    const options = { timeZone: timezone, hour: 'numeric', minute: 'numeric', weekday: 'short' };
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
        weekday: 'short',
    }).formatToParts(now);

    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
    const weekday = parts.find(p => p.type === 'weekday')?.value || '';

    const dayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
    const dayNum = dayMap[weekday] ?? new Date().getDay();

    const isWorkDay = workDays.includes(dayNum);
    const isWorkHour = hour >= startHour && hour < endHour;

    return { active: isWorkDay && isWorkHour, hour, dayNum, isWorkDay, isWorkHour };
}

// ─── HANDOFF SUMMARY ─────────────────────────────────────────────────

/**
 * Gera um resumo da conversa para o atendente humano.
 * Usado no momento do handoff bot → human.
 */
export function generateHandoffSummary(answers, lead, sentiment) {
    const lines = [];

    lines.push(`📋 *Resumo do Bot*`);
    lines.push('');

    if (lead?.name) lines.push(`👤 *Nome:* ${lead.name}`);
    if (answers.company_name) lines.push(`🏢 *Empresa:* ${answers.company_name}`);
    if (answers.domain) lines.push(`🌐 *Site:* ${answers.domain}`);
    if (lead?.phone) lines.push(`📱 *Telefone:* ${lead.phone}`);
    if (lead?.email) lines.push(`✉️ *Email:* ${lead.email}`);

    lines.push('');

    const intentLabel = answers.intent === 'comercial'
        ? '💼 Interesse comercial'
        : answers.intent === 'opec'
            ? '📨 Notificação / Operações'
            : '❓ Não classificado';
    lines.push(`*Intenção:* ${intentLabel}`);

    if (answers.context) {
        lines.push(`*Contexto:* "${answers.context}"`);
    }

    if (sentiment?.urgency) {
        lines.push(`\n⚠️ *URGENTE* — Lead demonstrou frustração ou urgência`);
    } else if (sentiment?.sentiment === 'negative') {
        lines.push(`\n⚠️ Lead com sentimento negativo — tratar com cuidado`);
    }

    if (lead?.origin === 'form') {
        lines.push(`\n📝 Lead veio do formulário do site`);
    }

    return lines.join('\n');
}

// ─── PRIORITY SCORING ─────────────────────────────────────────────────

/**
 * Calcula prioridade do lead (0-10).
 * Usado para ordenação de fila.
 */
export function calculatePriority(answers, sentiment, lead) {
    let priority = 5; // base

    // Classificação
    if (answers.intent === 'comercial') priority += 1;

    // Sentimento
    if (sentiment?.urgency) priority += 3;
    else if (sentiment?.sentiment === 'negative') priority += 2;
    else if (sentiment?.sentiment === 'positive') priority += 0.5;

    // Origem (form = lead mais engajado)
    if (lead?.origin === 'form') priority += 1;

    // Domínio informado = lead qualificado
    if (answers.domain) priority += 0.5;

    // Contexto informado = lead engajado
    if (answers.context) priority += 0.5;

    return Math.min(Math.round(priority * 10) / 10, 10);
}

// ─── LEVENSHTEIN DISTANCE ─────────────────────────────────────────────

function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;

    const d = Array.from({ length: m + 1 }, () => new Array(n + 1));
    for (let i = 0; i <= m; i++) d[i][0] = i;
    for (let j = 0; j <= n; j++) d[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(
                d[i - 1][j] + 1,       // deletion
                d[i][j - 1] + 1,       // insertion
                d[i - 1][j - 1] + cost // substitution
            );
        }
    }
    return d[m][n];
}

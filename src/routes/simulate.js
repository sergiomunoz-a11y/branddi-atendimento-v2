/**
 * Simulate Routes — Simulador de conversa com o bot
 * Processa mensagens pelo chatbot-engine sem precisar de WhatsApp/Unipile.
 * Mantém sessões em memória para múltiplas conversas simultâneas.
 *
 * POST /api/simulate/start   — Inicia nova conversa simulada
 * POST /api/simulate/message — Envia mensagem e recebe resposta do bot
 * POST /api/simulate/reset   — Reseta conversa
 * GET  /api/simulate/sessions — Lista sessões ativas
 */
import { Router } from 'express';
import {
    classifyIntent, extractEntities, isPureGreeting,
    analyzeSentiment, validateDomain, isMediaOnly,
    isBusinessHours, generateHandoffSummary, calculatePriority
} from '../services/chatbot-nlp.js';
import { findFAQAnswer, matchFAQ } from '../services/chatbot-faq.js';
import logger from '../services/logger.js';

const router = Router();

// ─── Sessões em memória ──────────────────────────────────────────────
const sessions = new Map();
const MAX_RETRIES = 3;

// ─── Default phrases (editáveis via API) ─────────────────────────────
const DEFAULT_PHRASES = {
    // Fluxo principal
    welcome:           `Olá{{nome}}! 👋 Sou o assistente da *Branddi*.\n\nPara te direcionar ao time certo, me conta:\n\n1️⃣  Quero conhecer os serviços da Branddi\n2️⃣  Recebi uma notificação da Branddi\n3️⃣  Sou cliente e tenho uma dúvida`,
    outside_hours:     `Olá! 👋 Nosso horário de atendimento é de *segunda a sexta, das 9h às 18h* (horário de Brasília).\n\nSua mensagem foi registrada! 🕘\n\nEnquanto isso, posso coletar informações:\n\n1️⃣  Quero conhecer os serviços da Branddi\n2️⃣  Recebi uma notificação da Branddi\n3️⃣  Sou cliente e tenho uma dúvida`,
    greeting_menu:     `Olá! 😊\n\nComo posso te ajudar?\n\n1️⃣  Quero conhecer os serviços da Branddi\n2️⃣  Recebi uma notificação da Branddi\n3️⃣  Sou cliente e tenho uma dúvida`,
    ask_company_comercial: `Que ótimo! 🚀 Qual é o nome da sua *empresa*?`,
    ask_company_opec:  `Entendido! 🙏 Para registrar corretamente, qual é o nome da sua *empresa*?`,
    ask_domain:        `Qual é o endereço do *site* da sua empresa?\n_(ex: minhaempresa.com.br)_`,
    ask_context:       `Perfeito! 😊 Em poucas palavras, qual é o *motivo do seu contato* com a Branddi?`,
    classified_comercial: `Ótimo! Um especialista da Branddi vai continuar essa conversa em instantes. 🚀`,
    classified_opec:   `Perfeito! Registrei seu contato. Nosso time de *Operações* vai entrar em contato em breve. 🙏`,
    // Retries e erros
    retry_qualifying:  `Desculpe, não entendi bem. 😅 Por favor, responda com *1*, *2* ou *3*:\n\n1️⃣  Quero conhecer os serviços\n2️⃣  Recebi uma notificação\n3️⃣  Sou cliente com dúvida`,
    domain_invalid:    `Hmm, não consegui identificar um site válido. 🤔\nPode digitar o endereço completo? _(ex: suaempresa.com.br)_\n\nSe não tiver site, digite *pular* e seguimos!`,
    domain_skipped:    `Sem problemas! 😊`,
    domain_forced:     `Ok, anotei! 📝`,
    escalate_max_retries: `Não consegui entender sua necessidade, mas sem problemas! 🤝 Vou te conectar com um atendente agora.`,
    // Smart skip
    smart_skip_company_domain: `Vi que você é da *{{empresa}}* ({{dominio}})! 🎯`,
    smart_skip_company:        `Vi que você é da *{{empresa}}*! 🎯`,
    // Mídia
    media_audio:       `Recebi seu áudio! 🎤 Mas sou um assistente de texto. Pode me enviar por escrito? 😊`,
    media_image:       `Vi que enviou uma imagem! 📸 Consegue descrever por texto o que precisa? 😊`,
    // FAQs
    faq_what_is_branddi: `A *Branddi* é a líder em proteção de marca digital no Brasil! 🛡️\n\nNossos serviços:\n🔍 *Brand Bidding* — Identificamos e removemos anúncios não autorizados que usam sua marca no Google Ads\n🛑 *Anti-fraude Digital* — Detectamos sites falsos e golpes que usam seu nome\n⚖️ *Violação de Marca* — Combatemos o uso indevido da sua marca em marketplaces e redes sociais\n\nQuer saber mais sobre algum desses serviços? 😊`,
    faq_brand_bidding: `*Brand Bidding* é quando terceiros usam o nome da sua marca como palavra-chave no Google Ads. Isso faz você pagar mais caro por cliques que deveriam ser seus! 💸\n\nA Branddi monitora em tempo real e remove esses anúncios. Resultado: você economiza até *30% no CPC* e recupera tráfego que era desviado.\n\nQuer um diagnóstico gratuito para ver se sua marca está sendo usada? 🔍`,
    faq_pricing:       `Os valores da Branddi variam de acordo com o volume de buscas da sua marca e os serviços contratados. 💰\n\nPara te passar uma proposta personalizada, preciso de algumas informações:\n• Qual é o site da sua empresa?\n• Já investe em Google Ads?\n\nPosso te direcionar para um especialista que vai preparar uma proposta sob medida! 🎯`,
    faq_demo:          `Ótimo! 🎯 Nosso time pode preparar uma apresentação personalizada para mostrar como a Branddi protege sua marca.\n\nPara agendar, vou te conectar com um dos nossos especialistas agora mesmo! 🚀`,
    faq_notification:  `Entendido! Se você recebeu uma notificação da Branddi, nosso time de Operações pode te ajudar. 📋\n\nPara agilizar o processo, me diz:\n• Qual é o nome da sua empresa?\n• Qual termo/palavra-chave foi notificado?\n\nVou encaminhar para a equipe responsável! 🙏`,
    faq_support:       `Olá! Se você já é cliente Branddi, nosso time de suporte vai te atender. 🤝\n\nPara agilizar, me conta:\n• Qual é o nome da sua empresa?\n• Qual é sua dúvida ou problema?\n\nVou te conectar com a equipe certa! 😊`,
    faq_business_hours: `Nosso horário de atendimento é:\n\n🕘 *Segunda a Sexta:* 9h às 18h\n📍 Horário de Brasília (GMT-3)\n\nFora do horário, você pode deixar sua mensagem que respondemos no próximo dia útil! 😊`,
    faq_location:      `A Branddi tem operação 100% digital, atendendo empresas de todo o Brasil! 🇧🇷\n\nNosso time trabalha remotamente para garantir a melhor proteção de marca para nossos clientes. Todas as reuniões são feitas por videoconferência. 💻`,
};

// Phrases customizadas (salvas em memória - por sessão do servidor)
let customPhrases = {};

/** Resolve uma frase: custom > default, aplica variáveis */
function getPhrase(key, vars = {}) {
    let text = customPhrases[key] || DEFAULT_PHRASES[key] || '';
    if (vars.nome) text = text.replace(/\{\{nome\}\}/g, `, ${vars.nome.split(' ')[0]}`);
    else text = text.replace(/\{\{nome\}\}/g, '');
    if (vars.empresa) text = text.replace(/\{\{empresa\}\}/g, vars.empresa);
    if (vars.dominio) text = text.replace(/\{\{dominio\}\}/g, vars.dominio);
    return text;
}

// ─── Flow messages (agora usa getPhrase) ─────────────────────────────
function FLOW_welcome(name) { return getPhrase('welcome', { nome: name }); }
function FLOW_outsideHours() { return getPhrase('outside_hours'); }
function FLOW_greeting() { return getPhrase('greeting_menu'); }
function FLOW_ask_company(cls) { return getPhrase(cls === 'opec' ? 'ask_company_opec' : 'ask_company_comercial'); }
function FLOW_ask_domain() { return getPhrase('ask_domain'); }
function FLOW_ask_context() { return getPhrase('ask_context'); }
function FLOW_classified(cls) { return getPhrase(cls === 'opec' ? 'classified_opec' : 'classified_comercial'); }

// ─── GET /api/simulate/phrases — Retorna todas as frases editáveis ──
router.get('/simulate/phrases', (req, res) => {
    const merged = {};
    for (const [key, val] of Object.entries(DEFAULT_PHRASES)) {
        merged[key] = {
            default: val,
            current: customPhrases[key] || val,
            edited: !!customPhrases[key],
        };
    }
    res.json({ phrases: merged });
});

// ─── PUT /api/simulate/phrases — Salva frases editadas ──────────────
router.put('/simulate/phrases', (req, res) => {
    const { phrases } = req.body;
    if (!phrases || typeof phrases !== 'object') {
        return res.status(400).json({ error: 'Body deve conter { phrases: { key: value } }' });
    }
    let count = 0;
    for (const [key, value] of Object.entries(phrases)) {
        if (!(key in DEFAULT_PHRASES)) continue;
        if (value === null || value === DEFAULT_PHRASES[key]) {
            delete customPhrases[key];
        } else {
            customPhrases[key] = value;
        }
        count++;
    }
    res.json({ ok: true, updated: count });
});

// ─── POST /api/simulate/phrases/reset — Reseta para defaults ────────
router.post('/simulate/phrases/reset', (req, res) => {
    customPhrases = {};
    res.json({ ok: true });
});

// ─── POST /api/simulate/start ────────────────────────────────────────
router.post('/simulate/start', (req, res) => {
    const { leadName, leadPhone, leadEmail } = req.body;
    const id = `sim_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const hours = isBusinessHours();

    const botMessages = [];
    let welcomeMsg;
    if (!hours.active) {
        welcomeMsg = FLOW_outsideHours();
    } else {
        welcomeMsg = FLOW_welcome(leadName);
    }
    botMessages.push(welcomeMsg);

    const session = {
        id,
        stage: 'qualifying',
        answers: {},
        retries: {},
        lead: { name: leadName || null, phone: leadPhone || null, email: leadEmail || null },
        messages: [
            { role: 'bot', text: welcomeMsg, timestamp: new Date().toISOString() },
        ],
        classification: null,
        priority: 5,
        sentiment: null,
        businessHours: hours.active,
        createdAt: new Date().toISOString(),
    };

    sessions.set(id, session);

    res.json({
        sessionId: id,
        botMessages,
        stage: session.stage,
        businessHours: hours.active,
        debug: { hours },
    });
});

// ─── POST /api/simulate/message ──────────────────────────────────────
router.post('/simulate/message', async (req, res) => {
    const { sessionId, text, simulateMedia } = req.body;
    if (!sessionId || !sessions.has(sessionId)) {
        return res.status(400).json({ error: 'Sessão não encontrada. Inicie uma nova conversa.' });
    }

    const s = sessions.get(sessionId);
    const botMessages = [];
    const debug = {};

    // Salva mensagem do lead
    s.messages.push({ role: 'lead', text: text || (simulateMedia ? `[${simulateMedia}]` : ''), timestamp: new Date().toISOString() });

    // ── Media check ──
    if (simulateMedia) {
        const mediaMsg = simulateMedia === 'audio' ? getPhrase('media_audio') : getPhrase('media_image');
        botMessages.push(mediaMsg);
        s.messages.push({ role: 'bot', text: mediaMsg, timestamp: new Date().toISOString() });
        debug.media = simulateMedia;
        return res.json({ botMessages, stage: s.stage, debug });
    }

    // ── Sentiment ──
    const sentiment = analyzeSentiment(text);
    s.sentiment = sentiment;
    debug.sentiment = sentiment;

    // ── Entity extraction ──
    const entities = extractEntities(text);
    debug.entities = entities;
    if (entities.name && !s.lead.name) s.lead.name = entities.name;
    if (entities.email && !s.lead.email) s.lead.email = entities.email;
    if (entities.company) s.answers._extracted_company = entities.company;
    if (entities.domain) s.answers._extracted_domain = entities.domain;

    // ── Stage processing ──
    switch (s.stage) {
        case 'qualifying': {
            // Greeting
            if (isPureGreeting(text)) {
                const greetMsg = FLOW_greeting();
                botMessages.push(greetMsg);
                s.messages.push({ role: 'bot', text: greetMsg, timestamp: new Date().toISOString() });
                debug.action = 'greeting_detected';
                break;
            }

            // FAQ
            const faqResult = await findFAQAnswer(text);
            if (faqResult.matched) {
                // Usa frase customizada se existir, senão usa a do FAQ
                const faqKey = `faq_${faqResult.faq.id}`;
                const faqAnswer = customPhrases[faqKey] || faqResult.faq.answer;
                botMessages.push(faqAnswer);
                s.messages.push({ role: 'bot', text: faqAnswer, timestamp: new Date().toISOString() });
                debug.faq = { id: faqResult.faq.id, score: faqResult.score };

                if (faqResult.faq.autoClassify) {
                    s.answers.intent = faqResult.faq.autoClassify;
                    s.classification = faqResult.faq.autoClassify;
                }

                if (faqResult.faq.followUp === 'classified') {
                    s.classification = s.answers.intent || 'comercial';
                    const clsMsg = FLOW_classified(s.classification);
                    botMessages.push(clsMsg);
                    s.messages.push({ role: 'bot', text: clsMsg, timestamp: new Date().toISOString() });
                    _finalize(s, debug);
                } else if (faqResult.faq.followUp === 'ask_domain') {
                    s.answers.intent = s.answers.intent || 'comercial';
                    s.classification = 'comercial';
                    const domMsg = FLOW_ask_domain();
                    botMessages.push(domMsg);
                    s.messages.push({ role: 'bot', text: domMsg, timestamp: new Date().toISOString() });
                    s.stage = 'ask_domain';
                }
                debug.action = 'faq_answered';
                break;
            }

            // Intent
            const result = classifyIntent(text);
            debug.intent = result;

            if (!result.intent) {
                s.retries.qualifying = (s.retries.qualifying || 0) + 1;
                debug.retry = s.retries.qualifying;

                if (s.retries.qualifying >= MAX_RETRIES) {
                    const escMsg = getPhrase('escalate_max_retries');
                    botMessages.push(escMsg);
                    s.messages.push({ role: 'bot', text: escMsg, timestamp: new Date().toISOString() });
                    s.answers._escalated = true;
                    s.answers._escalated_reason = 'max_retries_qualifying';
                    _finalize(s, debug);
                    debug.action = 'escalated';
                } else {
                    botMessages.push(getPhrase('retry_qualifying'));
                    s.messages.push({ role: 'bot', text: getPhrase('retry_qualifying'), timestamp: new Date().toISOString() });
                    debug.action = 'retry';
                }
                break;
            }

            s.answers.intent = result.intent;
            s.answers.intent_raw = text;
            s.classification = result.intent;
            s.retries = {};

            // Smart skip com entities extraídas
            if (s.answers._extracted_company) {
                s.answers.company_name = s.answers._extracted_company;
                if (result.intent === 'comercial' && s.answers._extracted_domain) {
                    s.answers.domain = s.answers._extracted_domain;
                    const skipMsg = getPhrase('smart_skip_company_domain', { empresa: s.answers.company_name, dominio: s.answers.domain }) + `\n\n` + FLOW_ask_context();
                    botMessages.push(skipMsg);
                    s.messages.push({ role: 'bot', text: skipMsg, timestamp: new Date().toISOString() });
                    s.stage = 'ask_context';
                    debug.action = 'smart_skip_to_context';
                } else if (result.intent === 'comercial') {
                    const skipMsg = getPhrase('smart_skip_company', { empresa: s.answers.company_name }) + `\n\n` + FLOW_ask_domain();
                    botMessages.push(skipMsg);
                    s.messages.push({ role: 'bot', text: skipMsg, timestamp: new Date().toISOString() });
                    s.stage = 'ask_domain';
                    debug.action = 'smart_skip_to_domain';
                } else {
                    const clsMsg = FLOW_classified(result.intent);
                    botMessages.push(clsMsg);
                    s.messages.push({ role: 'bot', text: clsMsg, timestamp: new Date().toISOString() });
                    _finalize(s, debug);
                    debug.action = 'opec_with_company';
                }
            } else {
                const askMsg = FLOW_ask_company(result.intent);
                botMessages.push(askMsg);
                s.messages.push({ role: 'bot', text: askMsg, timestamp: new Date().toISOString() });
                s.stage = 'ask_company';
                debug.action = 'ask_company';
            }
            break;
        }

        case 'ask_company': {
            s.answers.company_name = entities.company || text.trim();

            if (s.classification === 'comercial') {
                if (entities.domain || s.answers._extracted_domain) {
                    s.answers.domain = entities.domain || s.answers._extracted_domain;
                    const msg = FLOW_ask_context();
                    botMessages.push(msg);
                    s.messages.push({ role: 'bot', text: msg, timestamp: new Date().toISOString() });
                    s.stage = 'ask_context';
                } else {
                    const msg = FLOW_ask_domain();
                    botMessages.push(msg);
                    s.messages.push({ role: 'bot', text: msg, timestamp: new Date().toISOString() });
                    s.stage = 'ask_domain';
                }
            } else {
                const msg = FLOW_classified(s.classification);
                botMessages.push(msg);
                s.messages.push({ role: 'bot', text: msg, timestamp: new Date().toISOString() });
                _finalize(s, debug);
            }
            debug.action = `company_collected: ${s.answers.company_name}`;
            break;
        }

        case 'ask_domain': {
            const skip = ['pular', 'skip', 'não tenho', 'nao tenho', 'não sei', 'nao sei', '-', 'n/a']
                .includes(text.trim().toLowerCase());

            if (skip) {
                s.answers.domain = null;
                s.answers._domain_skipped = true;
                const msg = getPhrase('domain_skipped') + `\n\n` + FLOW_ask_context();
                botMessages.push(msg);
                s.messages.push({ role: 'bot', text: msg, timestamp: new Date().toISOString() });
                s.stage = 'ask_context';
                debug.action = 'domain_skipped';
                break;
            }

            const validation = validateDomain(text);
            debug.domain = validation;

            if (!validation.valid) {
                s.retries.domain = (s.retries.domain || 0) + 1;
                if (s.retries.domain >= MAX_RETRIES) {
                    s.answers.domain = text.trim();
                    const msg = getPhrase('domain_forced') + `\n\n` + FLOW_ask_context();
                    botMessages.push(msg);
                    s.messages.push({ role: 'bot', text: msg, timestamp: new Date().toISOString() });
                    s.stage = 'ask_context';
                    debug.action = 'domain_forced_after_retries';
                } else {
                    botMessages.push(getPhrase('domain_invalid'));
                    s.messages.push({ role: 'bot', text: getPhrase('domain_invalid'), timestamp: new Date().toISOString() });
                    debug.action = 'domain_invalid_retry';
                }
                break;
            }

            s.answers.domain = validation.domain;
            s.retries = {};
            const msg = FLOW_ask_context();
            botMessages.push(msg);
            s.messages.push({ role: 'bot', text: msg, timestamp: new Date().toISOString() });
            s.stage = 'ask_context';
            debug.action = 'domain_collected';
            break;
        }

        case 'ask_context': {
            s.answers.context = text.trim();
            const msg = FLOW_classified(s.classification || 'comercial');
            botMessages.push(msg);
            s.messages.push({ role: 'bot', text: msg, timestamp: new Date().toISOString() });
            _finalize(s, debug);
            debug.action = 'context_collected_and_classified';
            break;
        }

        case 'human': {
            debug.action = 'human_mode';
            debug.note = 'Bot não responde mais — conversa em modo humano';
            break;
        }
    }

    res.json({
        botMessages,
        stage: s.stage,
        classification: s.classification,
        answers: s.answers,
        lead: s.lead,
        priority: s.priority,
        debug,
    });
});

function _finalize(s, debug) {
    s.stage = 'human';
    s.priority = calculatePriority(s.answers, s.sentiment, s.lead);
    s.answers._classified_at = new Date().toISOString();
    const summary = generateHandoffSummary(s.answers, s.lead, s.sentiment);
    s.messages.push({ role: 'system', text: summary, timestamp: new Date().toISOString() });
    debug.handoff_summary = summary;
    debug.priority = s.priority;
}

// ─── POST /api/simulate/reset ────────────────────────────────────────
router.post('/simulate/reset', (req, res) => {
    const { sessionId } = req.body;
    if (sessionId) sessions.delete(sessionId);
    res.json({ ok: true });
});

// ─── GET /api/simulate/sessions ──────────────────────────────────────
router.get('/simulate/sessions', (req, res) => {
    const list = [...sessions.values()].map(s => ({
        id: s.id,
        stage: s.stage,
        leadName: s.lead.name,
        classification: s.classification,
        messageCount: s.messages.length,
        createdAt: s.createdAt,
    }));
    res.json({ sessions: list });
});

export default router;

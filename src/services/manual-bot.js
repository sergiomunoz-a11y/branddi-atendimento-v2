/**
 * Manual Bot — fluxo simplificado de triagem sem LLM conversacional.
 *
 * Stages:
 *   welcome          → cumprimenta, pergunta Comercial ou OPEC
 *   qualifying       → interpreta resposta (comercial/opec)
 *                      - OPEC: classified + rota, fim.
 *                      - Comercial: ask_qualification.
 *   ask_qualification → 1 pergunta combinada (nome/cargo/empresa/site).
 *                      Resposta livre é parseada por mini-LLM.
 *   classified       → roteado pro atendente.
 */
import { updateConversation, updateLead, createRoutingEvent } from './supabase.js';
import { sendMessage } from './unipile.js';
import logger from './logger.js';

const NVIDIA_API_KEY    = process.env.NVIDIA_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;
const MINI_LLM_MODEL    = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022';

// ─── Mensagens fixas ──────────────────────────────────────────────────

const MSG = {
    welcome: (name) => {
        const first = name ? `, ${name.split(' ')[0]}` : '';
        return `Olá${first}! 👋 Obrigado por entrar em contato com a *Branddi*.\n\n` +
               `Para te direcionar ao time certo, me conta:\n\n` +
               `1️⃣  *Comercial* — quero conhecer os serviços da Branddi\n` +
               `2️⃣  *OPEC* — recebi uma notificação da Branddi\n\n` +
               `_Se é sobre uma notificação nossa, é com OPEC. Se quer saber dos nossos serviços, é com Comercial._`;
    },
    askQualification:
        'Perfeito! Para adiantar o atendimento, me envie em uma mensagem:\n\n' +
        '• *Nome* e *cargo*\n' +
        '• *Empresa* e *site* (domínio)',
    classifiedOpec:
        'Anotado! Nosso time de *Operações* vai retornar em breve. Obrigado! 🙏',
    classifiedComercial:
        'Tudo certo! ✅ Um especialista vai continuar essa conversa com você em instantes.',
    retry: 'Não entendi sua resposta. Responde com *1* (Comercial) ou *2* (OPEC), por favor.',
};

// ─── Entrypoint ───────────────────────────────────────────────────────

export async function processManualBotMessage(conversation, text, chatId) {
    const stage = conversation.chatbot_stage || 'welcome';

    if (stage === 'welcome') return _handleWelcome(conversation, chatId);
    if (stage === 'qualifying') return _handleQualifying(conversation, text, chatId);
    if (stage === 'ask_qualification') return _handleAskQualification(conversation, text, chatId);
    // classified/human → não processa mais
}

async function _handleWelcome(conversation, chatId) {
    const leadName = conversation.leads?.name || '';
    await _send(chatId, conversation.id, MSG.welcome(leadName));
    await updateConversation(conversation.id, { chatbot_stage: 'qualifying' });
}

async function _handleQualifying(conversation, text, chatId) {
    const choice = _parseChoice(text);
    if (choice === 'opec') {
        await updateConversation(conversation.id, {
            chatbot_stage: 'classified',
            chatbot_answers: { ...(conversation.chatbot_answers || {}), classification: 'opec' },
        });
        await updateLead(conversation.leads.id, { classification: 'opec' });
        await createRoutingEvent({
            conversation_id: conversation.id,
            to_team: 'opec',
            reason: 'Manual bot — escolha OPEC',
            routed_by: 'bot',
        });
        await _send(chatId, conversation.id, MSG.classifiedOpec);
        return;
    }
    if (choice === 'comercial') {
        await updateConversation(conversation.id, { chatbot_stage: 'ask_qualification' });
        await _send(chatId, conversation.id, MSG.askQualification);
        return;
    }
    await _send(chatId, conversation.id, MSG.retry);
}

async function _handleAskQualification(conversation, text, chatId) {
    const extracted = await _extractQualification(text);
    const leadId = conversation.leads?.id;

    if (leadId) {
        const updates = {};
        if (extracted.name)    updates.name = extracted.name;
        if (extracted.company) updates.company_name = extracted.company;
        if (Object.keys(updates).length) await updateLead(leadId, updates);
    }

    await updateConversation(conversation.id, {
        chatbot_stage: 'classified',
        chatbot_answers: {
            ...(conversation.chatbot_answers || {}),
            classification: 'comercial',
            role:    extracted.role    || null,
            domain:  extracted.domain  || null,
            company: extracted.company || null,
            raw:     text,
        },
    });
    await updateLead(leadId, { classification: 'comercial' });
    await createRoutingEvent({
        conversation_id: conversation.id,
        to_team: 'comercial',
        reason: 'Manual bot — qualificação comercial',
        routed_by: 'bot',
    });
    await _send(chatId, conversation.id, MSG.classifiedComercial);
}

// ─── Parsers ──────────────────────────────────────────────────────────

function _parseChoice(text) {
    const t = (text || '').toLowerCase().trim();
    if (/^1\b|comerc|servi[cç]o|interesse|conhecer|proposta|or[cç]amento/.test(t)) return 'comercial';
    if (/^2\b|opec|opera[cç]|notifica[cç]|extens[aã]o|remover|negativar/.test(t)) return 'opec';
    return null;
}

async function _extractQualification(text) {
    const fallback = _regexExtract(text);
    if (!GEMINI_API_KEY && !NVIDIA_API_KEY && !ANTHROPIC_API_KEY) return fallback;

    const prompt = `Extraia os campos da mensagem do usuário. Responda SOMENTE JSON válido com as chaves:
{"name": "...|null", "role": "...|null", "company": "...|null", "domain": "...|null"}

Regras:
- name: nome próprio da pessoa.
- role: cargo/função profissional.
- company: nome da empresa do usuário (não confunda com Branddi).
- domain: domínio do site (ex: "exemplo.com.br"), sem http/https.
- Use null se o campo não estiver presente.

Mensagem: """${text.replace(/"/g, "'").slice(0, 800)}"""`;

    try {
        const raw = await _callMiniLLM(prompt);
        if (!raw) return fallback;
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) return fallback;
        const parsed = JSON.parse(match[0]);
        return {
            name:    parsed.name    || fallback.name,
            role:    parsed.role    || fallback.role,
            company: parsed.company || fallback.company,
            domain:  parsed.domain  || fallback.domain,
        };
    } catch (err) {
        logger.warn('Manual bot — falha extração LLM', { error: err.message });
        return fallback;
    }
}

function _regexExtract(text) {
    const domain = (text.match(/\b([a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2})?)\b/i) || [])[1] || null;
    return { name: null, role: null, company: null, domain };
}

async function _callMiniLLM(prompt) {
    if (GEMINI_API_KEY) return _callGeminiMini(prompt);
    if (NVIDIA_API_KEY) return _callNvidiaMini(prompt);
    if (ANTHROPIC_API_KEY) return _callAnthropicMini(prompt);
    return null;
}

async function _callAnthropicMini(prompt) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: MINI_LLM_MODEL,
            max_tokens: 300,
            temperature: 0.1,
            messages: [{ role: 'user', content: prompt }],
        }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.content?.[0]?.text || null;
}

async function _callGeminiMini(prompt) {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 300 },
        }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

async function _callNvidiaMini(prompt) {
    const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${NVIDIA_API_KEY}`,
        },
        body: JSON.stringify({
            model: process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct',
            max_tokens: 300,
            temperature: 0.1,
            response_format: { type: 'json_object' },
            messages: [{ role: 'user', content: prompt }],
        }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
}

async function _send(chatId, conversationId, text) {
    try {
        await sendMessage(chatId, text);
    } catch (err) {
        logger.warn('Manual bot — falha sendMessage', { error: err.message });
    }
    try {
        const { saveMessage } = await import('./supabase.js');
        await saveMessage({
            conversation_id: conversationId,
            direction:       'outbound',
            sender_type:     'bot',
            sender_name:     'Bot',
            content:         text,
            created_at:      new Date().toISOString(),
        });
    } catch (err) {
        logger.warn('Manual bot — falha saveMessage', { error: err.message });
    }
}

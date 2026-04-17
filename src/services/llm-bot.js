/**
 * LLM Bot — Agente inteligente de qualificação
 * Suporta: NVIDIA NIM (Llama) > Anthropic (Claude) > Gemini Flash > fallback state machine
 */
import { updateConversation, updateLead, createRoutingEvent } from './supabase.js';
import { sendMessage } from './unipile.js';
import { saveMessage } from './supabase.js';
import { calculatePriority } from './chatbot-nlp.js';
import { trackBotEvent } from './chatbot-workers.js';
import logger from './logger.js';
import supabase from './supabase.js';

// ─── Config ─────────────────────────────────────────────────────────
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Provider priority: gemini 2.5 > nvidia > anthropic > none
const LLM_PROVIDER = GEMINI_API_KEY ? 'gemini'
    : NVIDIA_API_KEY ? 'nvidia'
    : ANTHROPIC_API_KEY ? 'anthropic'
    : null;

export function isLLMBotAvailable() {
    return !!LLM_PROVIDER;
}

// Log ao importar módulo (startup)
logger.info('LLM Bot config', {
    provider: LLM_PROVIDER || 'NONE',
    nvidia: !!NVIDIA_API_KEY,
    anthropic: !!ANTHROPIC_API_KEY,
    gemini: !!GEMINI_API_KEY,
    model: NVIDIA_API_KEY ? NVIDIA_MODEL : GEMINI_API_KEY ? GEMINI_MODEL : 'none',
});

// ─── System Prompt ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `Você é o assistente da Branddi no WhatsApp. Responda SOMENTE com JSON válido.

BRANDDI: Online Brand Protection. Blindagem digital focada em Performance.
- Brand Bidding: concorrentes no Google Ads inflando CPC. Reduzimos até 70%.
- Golpes Digitais: sites falsos, perfis fakes. Take down rápido.
- Violação de Marca: pirataria em marketplaces.
- Buy Box Protection: regulamentação de preços.
Base jurídica: STJ, Art. 195 LPI.

REGRAS DE COMUNICAÇÃO (CRÍTICO — siga sempre):
- MÁXIMO 1-2 linhas por mensagem. Isso é WhatsApp, não email.
- Seja HUMANO e EMPÁTICO. Reaja ao que o lead diz com entusiasmo genuíno quando apropriado. Ex: se quer contratar → demonstre alegria. Se tem problema → demonstre preocupação. Não seja robótico.
- NUNCA repita, parafraseie ou resuma o que o lead acabou de dizer. Proibido "Entendi que...", "Compreendo seu interesse em...", "Com as informações de que...".
- NUNCA ofereça menu numérico (1, 2, 3). Converse naturalmente.
- NUNCA fale valores ou garanta prazos.
- 1 emoji max. Sem markdown/asteriscos/negrito.
- Faça UMA pergunta por vez. Siga o fluxo ideal passo a passo.

TRIAGEM — 3 fluxos:

COMERCIAL: Quer serviços/reunião/diagnóstico.
- Dados obrigatórios ANTES de classificar: empresa + site/domínio + contexto do problema.
- "Branddi" NÃO é empresa do lead — somos nós. Se disser que é da Branddi, pergunte qual empresa quer proteger.
- NUNCA prometa diagnóstico gratuito imediato.
- Ao classificar: diga que um consultor entrará em contato.
- FLUXO IDEAL (siga os passos, NÃO pule):
  1. Lead diz o que quer → reaja com empatia genuína (urgente? "Claro, vamos agilizar!". Interesse? "Que ótimo!") + pergunte a empresa
  2. Lead dá empresa → "Pode me confirmar o domínio oficial da [empresa]?"
  3. Lead dá domínio → pergunte o problema E SEMPRE dê exemplos: "Estão enfrentando concorrentes comprando seus termos de marca, domínios/sites falsos, ou revendedores não autorizados?"
  4. Com empresa + domínio + contexto → classifique com entusiasmo

OPEC: Recebeu notificação nossa.
- Pergunte só a empresa (se não tem nos dados) e classifique rápido. Encaminhe direto para Operações.

CS: Já é cliente.
- Confirme empresa e encaminhe para Customer Success.

AÇÕES:
- continue: falta dado obrigatório → pergunte naturalmente
- classify: tem empresa + site + contexto do problema → encaminhe
- escalate: lead frustrado ou insistindo em humano

IMPORTANTE: Os "Dados do lead" já contêm informações do perfil WhatsApp (nome, telefone, empresa). NUNCA pergunte algo que já está nesses dados. Use o nome do lead naturalmente.

TOM — exemplos de referência (nunca copie literalmente):
- "Oi, [nome]! Bem-vindo à Branddi, como posso te ajudar? 😊" (saudação acolhedora)
- "Que ótimo! Qual a empresa de vocês?" (empático + coleta empresa)
- "Pode me confirmar o domínio oficial da [empresa]?" (coleta domínio — natural quando já sabe a empresa)
- "Nosso time vai te ajudar com isso! Um consultor entra em contato em breve 😊" (classificação calorosa)
Na primeira mensagem, SEMPRE cumprimente pelo nome se disponível e dê boas-vindas.

Máximo 6 trocas. Na 5ª+, classifique com o que tem.

JSON:
{"message":"texto curto","action":"continue|classify|escalate","classification":"comercial|opec|cs|null","extracted":{"intent":"servicos|notificacao|cliente|reuniao|null","company":"nome|null","domain":"site|null","contact_name":"nome|null","contact_role":"cargo|null","context":"resumo|null"},"reason":"lógica"}`;

// ─── Processador principal ──────────────────────────────────────────

export async function processLLMBotMessage(conversation, text, chatId, attachments = []) {
    try {
        const answers = conversation.chatbot_answers || {};
        const msgCount = answers._llm_msg_count || 0;

        if (msgCount >= 8) {
            await _escalate(conversation, answers, chatId, 'Limite de mensagens atingido');
            return true;
        }

        // Busca histórico + contexto
        const history = await _getConversationHistory(conversation.id);
        const lead = conversation.leads || {};
        const leadContext = [
            lead.name ? `Nome: ${lead.name}` : null,
            lead.phone ? `Telefone: ${lead.phone}` : null,
            lead.company_name ? `Empresa: ${lead.company_name}` : null,
            lead.email ? `Email: ${lead.email}` : null,
        ].filter(Boolean).join('\n');

        const knownData = [
            answers.intent ? `Intenção já identificada: ${answers.intent}` : null,
            answers.company_name ? `Empresa já informada: ${answers.company_name}` : null,
            answers.domain ? `Site já informado: ${answers.domain}` : null,
            answers.contact_name ? `Nome do contato: ${answers.contact_name}` : null,
            answers.contact_role ? `Cargo: ${answers.contact_role}` : null,
            answers.context ? `Contexto já coletado: ${answers.context}` : null,
        ].filter(Boolean).join('\n');

        const userPrompt = `${leadContext ? `Dados do lead:\n${leadContext}\n\n` : ''}${knownData ? `Informações já coletadas:\n${knownData}\n\n` : ''}Mensagem ${msgCount + 1} do lead. Histórico da conversa:\n${history}\n\nNova mensagem do lead: "${text}"`;

        // Chama LLM (Anthropic ou Gemini)
        const llmResponse = await _callLLM(userPrompt);
        if (!llmResponse) {
            logger.warn('LLM bot: sem resposta, fallback', { provider: LLM_PROVIDER });
            return null;
        }

        const parsed = _parseLLMResponse(llmResponse);
        if (!parsed) {
            logger.warn('LLM bot: resposta inválida', { raw: llmResponse.substring(0, 200) });
            return null;
        }

        // Atualiza dados extraídos
        if (parsed.extracted) {
            if (parsed.extracted.intent && !answers.intent) answers.intent = parsed.extracted.intent;
            if (parsed.extracted.company) answers.company_name = parsed.extracted.company;
            if (parsed.extracted.domain) answers.domain = parsed.extracted.domain;
            if (parsed.extracted.contact_name) answers.contact_name = parsed.extracted.contact_name;
            if (parsed.extracted.contact_role) answers.contact_role = parsed.extracted.contact_role;
            if (parsed.extracted.context) answers.context = parsed.extracted.context;
        }
        answers._llm_msg_count = msgCount + 1;
        answers._llm_last_reason = parsed.reason;
        answers._llm_provider = LLM_PROVIDER;

        // Envia mensagem PRIMEIRO — após isso, sempre retorna true
        // (evita que o state machine mande msg duplicada se _classify/_escalate falhar)
        await _sendBotMsg(chatId, conversation.id, parsed.message);

        try {
            switch (parsed.action) {
                case 'escalate':
                    await _escalate(conversation, answers, chatId, parsed.reason);
                    break;
                case 'classify':
                    await _classify(conversation, answers, parsed.classification || 'comercial', chatId);
                    break;
                case 'continue':
                default:
                    await updateConversation(conversation.id, { chatbot_answers: answers });
                    break;
            }
        } catch (actionErr) {
            logger.error('LLM bot action error', { error: actionErr.message, action: parsed.action, conversation_id: conversation.id });
            // Ainda retorna true — a mensagem já foi enviada ao lead
        }

        return true;
    } catch (err) {
        logger.error('LLM bot error', { error: err.message, conversation_id: conversation.id });
        return null;
    }
}

// ─── LLM API Calls ─────────────────────────────────────────────────

async function _callLLM(userMessage) {
    if (LLM_PROVIDER === 'nvidia') return _callNvidia(userMessage);
    if (LLM_PROVIDER === 'anthropic') return _callAnthropic(userMessage);
    if (LLM_PROVIDER === 'gemini') {
        const result = await _callGemini(userMessage);
        if (result) return result;
        // Gemini falhou (503/quota) — tenta NVIDIA como fallback
        if (NVIDIA_API_KEY) {
            logger.info('Gemini failed, falling back to NVIDIA');
            return _callNvidia(userMessage);
        }
        // Tenta Anthropic como último fallback
        if (ANTHROPIC_API_KEY) {
            logger.info('Gemini failed, falling back to Anthropic');
            return _callAnthropic(userMessage);
        }
        return null;
    }
    return null;
}

async function _callNvidia(userMessage) {
    const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${NVIDIA_API_KEY}`,
        },
        body: JSON.stringify({
            model: NVIDIA_MODEL,
            max_tokens: 1024,
            temperature: 0.3,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userMessage },
            ],
        }),
    });

    if (!res.ok) {
        const err = await res.text();
        logger.error('NVIDIA NIM API error', { status: res.status, error: err.substring(0, 300) });
        return null;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
}

async function _callAnthropic(userMessage) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: ANTHROPIC_MODEL,
            max_tokens: 1024,
            temperature: 0.3,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userMessage }],
        }),
    });

    if (!res.ok) {
        const err = await res.text();
        logger.error('Anthropic API error', { status: res.status, error: err.substring(0, 300) });
        return null;
    }

    const data = await res.json();
    return data.content?.[0]?.text || null;
}

async function _callGemini(userMessage) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ parts: [{ text: userMessage }] }],
            generationConfig: {
                temperature: 0.3,
                maxOutputTokens: 1024,
                responseMimeType: 'application/json',
                thinkingConfig: { thinkingBudget: 0 },
            },
        }),
    });

    if (!res.ok) {
        const err = await res.text();
        logger.error('Gemini API error', { status: res.status, error: err.substring(0, 300) });
        return null;
    }

    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

// ─── Helpers ────────────────────────────────────────────────────────

function _parseLLMResponse(raw) {
    // Attempt 1: parse full JSON
    try {
        const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleaned);
        if (!parsed.message || !parsed.action) return null;
        if (!['continue', 'classify', 'escalate'].includes(parsed.action)) parsed.action = 'continue';
        return parsed;
    } catch { /* continue to fallback */ }

    // Attempt 2: extract JSON object from text
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
        try {
            const parsed = JSON.parse(match[0]);
            if (parsed.message && parsed.action) return parsed;
        } catch { /* continue to fallback */ }
    }

    // Attempt 3: extract message from truncated JSON via regex
    const msgMatch = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const actionMatch = raw.match(/"action"\s*:\s*"(continue|classify|escalate)"/);
    const classMatch = raw.match(/"classification"\s*:\s*"(comercial|opec|cs)"/);
    if (msgMatch?.[1]) {
        logger.info('LLM response recovered from truncated JSON', { msgLen: msgMatch[1].length });
        return {
            message: msgMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'),
            action: actionMatch?.[1] || 'continue',
            classification: classMatch?.[1] || null,
            extracted: {},
            reason: 'recovered from truncated response',
        };
    }

    return null;
}

async function _getConversationHistory(conversationId) {
    const { data: msgs } = await supabase
        .from('messages')
        .select('direction, sender_type, content, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(20);

    if (!msgs || msgs.length === 0) return '(nenhuma mensagem anterior)';

    return msgs.map(m => {
        const role = m.sender_type === 'bot' ? 'Bot' : (m.direction === 'outbound' ? 'Atendente' : 'Lead');
        return `[${role}]: ${m.content || '(mídia)'}`;
    }).join('\n');
}

async function _sendBotMsg(chatId, conversationId, text) {
    if (!text) return;
    try {
        const result = await sendMessage(chatId, text);
        const realMsgId = result?.message_id || result?.id || `llm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        await saveMessage({
            conversation_id: conversationId,
            direction: 'outbound',
            sender_type: 'bot',
            sender_name: 'Bot Branddi',
            content: text,
            unipile_message_id: realMsgId,
        });
    } catch (err) {
        logger.error('LLM bot: erro enviando msg', { error: err.message, conversationId });
    }
}

async function _classify(conversation, answers, classification, chatId) {
    const priority = calculatePriority(answers, null, conversation.leads);
    const team = classification === 'opec' ? 'opec' : classification === 'cs' ? 'cs' : 'comercial';

    await createRoutingEvent({
        conversation_id: conversation.id,
        from_team: null,
        to_team: team,
        reason: `LLM classification (${LLM_PROVIDER}): ${classification} | ${answers._llm_last_reason || ''}`,
        routed_by: 'bot',
    });

    if (conversation.lead_id) {
        const leadUpdates = {};
        if (answers.company_name) leadUpdates.company_name = answers.company_name;
        if (answers.contact_name) leadUpdates.name = answers.contact_name;
        if (answers.intent) leadUpdates.classification = classification;
        if (Object.keys(leadUpdates).length > 0) {
            await updateLead(conversation.lead_id, leadUpdates);
        }
    }

    await updateConversation(conversation.id, {
        chatbot_stage: 'human',
        chatbot_answers: {
            ...answers,
            _priority: priority,
            _classified_at: new Date().toISOString(),
            _classified_by: 'llm',
        },
        assigned_to: team,
        status: 'in_progress',
        bot_away_sent: true, // Evita away message — bot já mandou msg de encerramento
    });

    await trackBotEvent(conversation.id, 'classified', {
        classification: team, priority,
        company: answers.company_name, domain: answers.domain,
        method: `llm_${LLM_PROVIDER}`,
    });

    logger.info('LLM bot classificou lead', {
        conversation_id: conversation.id,
        classification: team, company: answers.company_name,
        msgs: answers._llm_msg_count, provider: LLM_PROVIDER,
    });
}

async function _escalate(conversation, answers, chatId, reason) {
    const priority = calculatePriority(answers, null, conversation.leads);
    const team = answers.intent === 'notificacao' ? 'opec' : answers.intent === 'cliente' ? 'cs' : 'comercial';

    await createRoutingEvent({
        conversation_id: conversation.id,
        from_team: null,
        to_team: team,
        reason: `LLM escalation (${LLM_PROVIDER}): ${reason}`,
        routed_by: 'bot',
    });

    await updateConversation(conversation.id, {
        chatbot_stage: 'human',
        chatbot_answers: {
            ...answers,
            _priority: priority + 1,
            _escalated_at: new Date().toISOString(),
            _escalated_reason: reason,
            _escalated_by: 'llm',
        },
        assigned_to: team,
        status: 'in_progress',
        bot_away_sent: true, // Evita away message — bot já mandou msg de encerramento
    });

    await trackBotEvent(conversation.id, 'escalated', {
        reason, stage: 'llm',
        msgs: answers._llm_msg_count, provider: LLM_PROVIDER,
    });

    logger.info('LLM bot escalou para humano', {
        conversation_id: conversation.id,
        reason, msgs: answers._llm_msg_count, provider: LLM_PROVIDER,
    });
}

/**
 * LLM Bot — Agente inteligente de qualificação
 * Suporta: NVIDIA NIM (Llama) > Anthropic (Claude) > Gemini Flash > fallback state machine
 */
import { updateConversation, updateLead, createRoutingEvent } from './supabase.js';
import { sendMessage } from './unipile.js';
import { saveMessage } from './supabase.js';
import { isBusinessHours, calculatePriority } from './chatbot-nlp.js';
import { trackBotEvent } from './chatbot-workers.js';
import logger from './logger.js';
import supabase from './supabase.js';

// ─── Config ─────────────────────────────────────────────────────────
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-20250414';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

// Provider priority: nvidia > anthropic > gemini > none
const LLM_PROVIDER = NVIDIA_API_KEY ? 'nvidia'
    : ANTHROPIC_API_KEY ? 'anthropic'
    : GEMINI_API_KEY ? 'gemini'
    : null;

export function isLLMBotAvailable() {
    return !!LLM_PROVIDER;
}

// ─── System Prompt ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `Você é a Ana, assistente da Branddi no WhatsApp. Converse como uma pessoa real — simpática, direta e profissional.

REGRA DE OURO: Responda APENAS com JSON válido. Nenhum texto fora do JSON.

## Branddi — O que fazemos
Blindagem Digital de Marca. Protegemos marcas contra uso indevido na internet.

Serviços principais:
- Brand Bidding: concorrentes compram sua marca no Google Ads, roubando tráfego e inflando CPC. Monitoramos 24/7 e resolvemos. Clientes reduzem até 90% do CPC.
- Fraude Digital: sites falsos, perfis fake, anúncios fraudulentos. Detectamos e removemos.
- Violação de Marca: uso não autorizado da marca em produtos, publicidade ou canais digitais.
- Buy Box Protection: proteção em marketplaces contra sellers não autorizados.

Se alguém RECEBEU uma notificação nossa: significa que identificamos uso indevido de uma marca que protegemos.

Resultados: +R$90M economizados, Banco Inter -80% CPC, Zenvia -57% CPC.

## Tom de voz
- Fale como gente. Máximo 2-3 linhas por mensagem.
- PROIBIDO: "Entendi que você...", "Vou registrar...", "Obrigado por entrar em contato". Isso é linguagem de robô.
- PROIBIDO: repetir ou parafrasear o que o lead disse.
- 1 emoji no máximo. Sem asteriscos nem formatação markdown.
- Vá direto ao ponto. Seja ágil.

## O que coletar (mínimo: empresa + intenção)
- Nome da empresa
- O que busca (serviços / recebeu notificação / dúvida)
- Site da empresa (bônus, não obrigatório)
- Nome e cargo da pessoa (bônus)

## QUANDO CLASSIFICAR (action = "classify")
Classifique IMEDIATAMENTE quando tiver empresa + intenção. Exemplos:
- "Sou da Nubank, quero saber sobre brand bidding" → classify comercial AGORA
- "Recebi notificação, sou da TechBrasil" → classify opec AGORA
- Lead já deu empresa + quer reunião → classify comercial AGORA
NÃO fique fazendo perguntas extras se já tem o mínimo.

## QUANDO ESCALAR (action = "escalate")
- Lead pede atendente/humano/pessoa real E está frustrado → escalate
- Lead insiste após já ter pedido → escalate

## QUANDO CONTINUAR (action = "continue")
- Falta empresa ou intenção → pergunte de forma natural
- "Oi" ou saudação → cumprimente e pergunte como pode ajudar
- Menu "1"/"2"/"3": 1=serviços, 2=notificação, 3=dúvida → pergunte empresa

## Mensagem ao classificar
- Comercial: "Perfeito! Vou passar para um dos nossos especialistas, que entra em contato em breve para um diagnóstico gratuito da sua marca."
- Opec: "Certo! Nosso time de operações vai entrar em contato para esclarecer tudo."
- Se fora do horário: troque "em breve" por "no próximo dia útil"

## Classificações
- comercial: quer serviços, brand bidding, proteção, reunião, diagnóstico
- opec: recebeu notificação da Branddi, quer remover anúncio

## Limite: máximo 4 mensagens. Com 3+, classifique com o que tem.

## JSON (responda SOMENTE isto, nada mais):
{"message":"texto curto","action":"continue|classify|escalate","classification":"comercial|opec|null","extracted":{"intent":"servicos|notificacao|cliente|reuniao|null","company":"nome|null","domain":"site|null","contact_name":"nome|null","contact_role":"cargo|null","context":"resumo|null"},"reason":"lógica interna"}`;

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

        const hours = isBusinessHours();
        const hoursNote = hours.active
            ? ''
            : '\n[NOTA: Fora do horário comercial. Mencione brevemente que o atendimento humano retorna no próximo dia útil, MAS continue qualificando normalmente — faça perguntas, colete informações, seja útil. NÃO pare no aviso de horário.]';

        const knownData = [
            answers.intent ? `Intenção já identificada: ${answers.intent}` : null,
            answers.company_name ? `Empresa já informada: ${answers.company_name}` : null,
            answers.domain ? `Site já informado: ${answers.domain}` : null,
            answers.context ? `Contexto já coletado: ${answers.context}` : null,
        ].filter(Boolean).join('\n');

        const userPrompt = `${leadContext ? `Dados do lead:\n${leadContext}\n\n` : ''}${knownData ? `Informações já coletadas:\n${knownData}\n\n` : ''}${hoursNote}Mensagem ${msgCount + 1} do lead. Histórico da conversa:\n${history}\n\nNova mensagem do lead: "${text}"`;

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
    if (LLM_PROVIDER === 'gemini') return _callGemini(userMessage);
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
            max_tokens: 500,
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
            max_tokens: 500,
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
                maxOutputTokens: 500,
                responseMimeType: 'application/json',
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
    try {
        const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleaned);
        if (!parsed.message || !parsed.action) return null;
        if (!['continue', 'classify', 'escalate'].includes(parsed.action)) parsed.action = 'continue';
        return parsed;
    } catch {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                const parsed = JSON.parse(match[0]);
                if (parsed.message && parsed.action) return parsed;
            } catch { /* */ }
        }
        return null;
    }
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
    await sendMessage(chatId, text);
    await saveMessage({
        conversation_id: conversationId,
        direction: 'outbound',
        sender_type: 'bot',
        sender_name: 'Bot Branddi',
        content: text,
        unipile_message_id: `llm_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    });
}

async function _classify(conversation, answers, classification, chatId) {
    const priority = calculatePriority(answers, null, conversation.leads);
    const team = classification === 'opec' ? 'opec' : 'comercial';

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
    const team = answers.intent === 'notificacao' ? 'opec' : 'comercial';

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

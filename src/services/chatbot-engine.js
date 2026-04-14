/**
 * Chatbot Engine v3 — Motor inteligente de triagem com NLP
 *
 * Estágios:
 *   welcome → qualifying → ask_company → [comercial: ask_domain → ask_context] → classified → human
 *
 * Capabilities:
 *   - NLP: Intent classification com confidence, fuzzy matching, entity extraction
 *   - FAQ: Responde perguntas comuns automaticamente
 *   - Smart flow: Pula etapas se informação já foi extraída
 *   - Greeting detection: Reconhece "oi", "bom dia" e mostra menu
 *   - Sentiment analysis: Detecta urgência e frustração
 *   - Priority scoring: Leads urgentes sobem na fila
 *   - Media handling: Responde quando lead manda áudio/imagem
 *   - Anti-flood: Ignora spam/flood
 *   - Business hours: Comportamento diferente fora do horário
 *   - Handoff summary: Gera resumo para o atendente
 *   - Domain validation: Verifica se domínio informado é válido
 *   - Retry tolerance: Permite múltiplas tentativas antes de escalar
 *   - Analytics: Tracking de funnel e drop-offs
 */
import {
    updateConversation, updateLead, createRoutingEvent,
    getSettingValue
} from './supabase.js';
import { sendMessage } from './unipile.js';
import {
    classifyIntent, extractEntities, isGreeting, isPureGreeting,
    analyzeSentiment, validateDomain, isMediaOnly, getMediaType,
    isFlood, isBusinessHours, generateHandoffSummary, calculatePriority
} from './chatbot-nlp.js';
import { findFAQAnswer } from './chatbot-faq.js';
import { trackBotEvent } from './chatbot-workers.js';
import logger from './logger.js';

// ─── FLOW MESSAGES ───────────────────────────────────────────────────

const FLOW = {
    welcome: {
        message: (name) =>
            `Olá${name ? `, ${name.split(' ')[0]}` : ''}! 👋 Sou o assistente da *Branddi*.\n\n` +
            `Para te direcionar ao time certo, me conta:\n\n` +
            `1️⃣  Quero conhecer os serviços da Branddi\n` +
            `2️⃣  Recebi uma notificação da Branddi\n` +
            `3️⃣  Sou cliente e tenho uma dúvida`,
    },
    ask_company: {
        message: (classification) => {
            if (classification === 'opec') {
                return `Entendido! 🙏 Para registrar corretamente, qual é o nome da sua *empresa*?`;
            }
            return `Que ótimo! 🚀 Qual é o nome da sua *empresa*?`;
        },
    },
    ask_domain: {
        message: () =>
            `Qual é o endereço do *site* da sua empresa?\n_(ex: minhaempresa.com.br)_`,
    },
    ask_context: {
        message: () =>
            `Perfeito! 😊 Em poucas palavras, qual é o *motivo do seu contato* com a Branddi?`,
    },
    classified: {
        message: (classification) => {
            if (classification === 'opec') {
                return `Perfeito! Registrei seu contato. Nosso time de *Operações* vai entrar em contato em breve. 🙏`;
            }
            return `Ótimo! Um especialista da Branddi vai continuar essa conversa em instantes. 🚀`;
        },
    },
    retry: {
        qualifying:
            `Desculpe, não entendi bem. 😅 Por favor, responda com *1*, *2* ou *3*:\n\n` +
            `1️⃣  Quero conhecer os serviços\n` +
            `2️⃣  Recebi uma notificação\n` +
            `3️⃣  Sou cliente com dúvida`,
        domain_invalid:
            `Hmm, não consegui identificar um site válido. 🤔\n` +
            `Pode digitar o endereço completo? _(ex: suaempresa.com.br)_\n\n` +
            `Se não tiver site, digite *pular* e seguimos!`,
    },
    media: {
        audio:
            `Recebi seu áudio! 🎤 Mas infelizmente sou um assistente de texto e não consigo ouvir. ` +
            `Pode me enviar por escrito? 😊`,
        image:
            `Vi que enviou uma imagem! 📸 Consegue descrever por texto o que precisa? ` +
            `Assim consigo te ajudar melhor! 😊`,
        generic:
            `Recebi seu arquivo! 📎 Para prosseguir no atendimento, ` +
            `pode me responder por texto? 😊`,
    },
    outsideHours:
        `Olá! 👋 Nosso horário de atendimento é de *segunda a sexta, das 9h às 18h* (horário de Brasília).\n\n` +
        `Sua mensagem foi registrada e nosso time responderá no próximo horário disponível! 🕘\n\n` +
        `Enquanto isso, posso coletar algumas informações para agilizar seu atendimento:\n\n` +
        `1️⃣  Quero conhecer os serviços da Branddi\n` +
        `2️⃣  Recebi uma notificação da Branddi\n` +
        `3️⃣  Sou cliente e tenho uma dúvida`,
};

// ─── MAX RETRIES PER STAGE ──────────────────────────────────────────

const MAX_RETRIES = 3;

// ─── PROCESSADOR PRINCIPAL ──────────────────────────────────────────

export async function processChatbotMessage(conversation, text, chatId, attachments = []) {
    const stage   = conversation.chatbot_stage;
    const answers = conversation.chatbot_answers || {};
    const retries = answers._retries || {};

    try {
        // ── Anti-flood check ──
        if (isFlood(chatId)) {
            logger.debug('Flood blocked', { chatId, stage });
            return;
        }

        // ── Media-only message ──
        if (isMediaOnly(text, attachments)) {
            const mediaType = getMediaType(attachments);
            const mediaMsg = FLOW.media[mediaType] || FLOW.media.generic;
            await sendBotMsg(chatId, conversation.id, mediaMsg);
            await trackBotEvent(conversation.id, 'media_received', { mediaType, stage });
            return;
        }

        // ── Sentiment analysis (runs on every message) ──
        const sentiment = analyzeSentiment(text);
        if (sentiment.urgency) {
            answers._sentiment = sentiment;
            answers._priority = calculatePriority(answers, sentiment, conversation.leads);
            await updateConversation(conversation.id, {
                chatbot_answers: answers,
            });
            logger.info('Urgency detected', {
                conversation_id: conversation.id,
                sentiment: sentiment.sentiment,
                stage,
            });
        }

        // ── Entity extraction (runs on every message, enriches lead) ──
        const entities = extractEntities(text);
        if (Object.keys(entities).length > 0) {
            await _enrichLeadFromEntities(conversation, entities, answers);
        }

        // ── Stage-specific processing ──
        switch (stage) {
            case 'welcome':
                await _handleWelcome(conversation, text, chatId, answers);
                break;

            case 'qualifying':
                await _handleQualifying(conversation, text, chatId, answers, retries, sentiment);
                break;

            case 'ask_company':
                await _handleAskCompany(conversation, text, chatId, answers);
                break;

            case 'ask_domain':
                await _handleAskDomain(conversation, text, chatId, answers, retries);
                break;

            case 'ask_context':
                await _handleAskContext(conversation, text, chatId, answers, sentiment);
                break;

            case 'classified':
            case 'human':
                // Em modo humano, não responde mais
                break;

            default:
                logger.warn('Unknown chatbot stage', { stage, conversation_id: conversation.id });
                // Reseta para welcome
                await updateConversation(conversation.id, { chatbot_stage: 'welcome' });
                await sendBotMsg(chatId, conversation.id, FLOW.welcome.message(conversation.leads?.name));
                await updateConversation(conversation.id, { chatbot_stage: 'qualifying' });
                break;
        }
    } catch (err) {
        logger.error('Chatbot engine error', {
            stage, error: err.message, conversation_id: conversation.id,
        });
        await trackBotEvent(conversation.id, 'error', { stage, error: err.message });
    }
}

// ─── STAGE HANDLERS ──────────────────────────────────────────────────

async function _handleWelcome(conversation, text, chatId, answers) {
    // Detecta horário comercial
    const hours = isBusinessHours();

    let welcomeMsg;
    if (!hours.active) {
        welcomeMsg = await getSettingValue('outside_hours_message', FLOW.outsideHours);
        answers._outside_hours = true;
    } else {
        welcomeMsg = FLOW.welcome.message(conversation.leads?.name);
    }

    await sendBotMsg(chatId, conversation.id, welcomeMsg);
    await updateConversation(conversation.id, {
        chatbot_stage: 'qualifying',
        chatbot_answers: answers,
    });
    await trackBotEvent(conversation.id, 'welcome_sent', {
        business_hours: hours.active,
    });
}

async function _handleQualifying(conversation, text, chatId, answers, retries, sentiment) {
    // 1. Check se é saudação pura → re-mostra menu
    if (isPureGreeting(text)) {
        await sendBotMsg(chatId, conversation.id,
            `${text.includes('bom') || text.includes('boa') ? text.charAt(0).toUpperCase() + text.slice(1) + '!' : 'Olá!'} 😊\n\n` +
            `Como posso te ajudar?\n\n` +
            `1️⃣  Quero conhecer os serviços da Branddi\n` +
            `2️⃣  Recebi uma notificação da Branddi\n` +
            `3️⃣  Sou cliente e tenho uma dúvida`
        );
        return;
    }

    // 2. Check FAQ
    const faqResult = await findFAQAnswer(text);
    if (faqResult.matched) {
        await sendBotMsg(chatId, conversation.id, faqResult.faq.answer);
        await trackBotEvent(conversation.id, 'faq_answered', { faq_id: faqResult.faq.id });

        // Se a FAQ tem auto-classificação, aplica
        if (faqResult.faq.autoClassify) {
            answers.intent = faqResult.faq.autoClassify;
            answers.intent_raw = text;
            answers._intent_source = 'faq';
        }

        // Se a FAQ manda para um estágio específico, vai
        if (faqResult.faq.followUp) {
            if (faqResult.faq.followUp === 'classified') {
                const classification = answers.intent || 'comercial';
                await _finalizeClassification(conversation, answers, classification, chatId, sentiment);
            } else {
                await updateConversation(conversation.id, {
                    chatbot_stage: faqResult.faq.followUp,
                    chatbot_answers: answers,
                });
                // Envia pergunta do próximo estágio
                if (faqResult.faq.followUp === 'ask_domain') {
                    answers.intent = answers.intent || 'comercial';
                    await sendBotMsg(chatId, conversation.id, FLOW.ask_domain.message());
                } else if (faqResult.faq.followUp === 'qualifying') {
                    // Volta ao menu
                }
            }
            return;
        }

        // FAQ sem followUp: responde e mantém no qualifying
        return;
    }

    // 3. Intent classification com NLP
    const result = classifyIntent(text);

    if (!result.intent) {
        // Incrementa retries
        retries.qualifying = (retries.qualifying || 0) + 1;
        answers._retries = retries;

        if (retries.qualifying >= MAX_RETRIES) {
            // Após N tentativas, escala para humano
            answers.intent = 'unclassified';
            answers.intent_raw = text;
            answers._escalated_reason = 'max_retries_qualifying';
            await _escalateToHuman(conversation, answers, chatId, sentiment,
                `Não consegui entender a necessidade após ${MAX_RETRIES} tentativas. Vou te conectar com um atendente! 🤝`
            );
            return;
        }

        await sendBotMsg(chatId, conversation.id, FLOW.retry.qualifying);
        await updateConversation(conversation.id, { chatbot_answers: answers });
        await trackBotEvent(conversation.id, 'qualifying_retry', {
            attempt: retries.qualifying,
            text,
        });
        return;
    }

    // ── Intent classified! ──
    answers.intent          = result.intent;
    answers.intent_raw      = text;
    answers._intent_conf    = result.confidence;
    answers._intent_method  = result.method;
    answers._retries        = {};

    await trackBotEvent(conversation.id, 'intent_classified', {
        intent: result.intent,
        confidence: result.confidence,
        method: result.method,
    });

    // Smart skip: Se entities já extraíram empresa ou domínio, pula etapas
    if (answers._extracted_company) {
        answers.company_name = answers._extracted_company;
        if (conversation.lead_id) {
            await updateLead(conversation.lead_id, {
                company_name: answers.company_name,
                classification: result.intent,
            });
        }

        if (result.intent === 'comercial') {
            if (answers._extracted_domain) {
                answers.domain = answers._extracted_domain;
                // Tem empresa + domínio → pula para ask_context
                await updateConversation(conversation.id, {
                    chatbot_stage: 'ask_context',
                    chatbot_answers: answers,
                });
                await sendBotMsg(chatId, conversation.id,
                    `Vi que você é da *${answers.company_name}* (${answers.domain})! 🎯\n\n` +
                    FLOW.ask_context.message()
                );
                return;
            }
            // Tem empresa, não tem domínio → pula para ask_domain
            await updateConversation(conversation.id, {
                chatbot_stage: 'ask_domain',
                chatbot_answers: answers,
            });
            await sendBotMsg(chatId, conversation.id,
                `Vi que você é da *${answers.company_name}*! 🎯\n\n` +
                FLOW.ask_domain.message()
            );
            return;
        } else {
            // OPEC com empresa já extraída → finaliza
            await _finalizeClassification(conversation, answers, result.intent, chatId, analyzeSentiment(text));
            return;
        }
    }

    // Fluxo normal → ask_company
    await updateConversation(conversation.id, {
        chatbot_stage: 'ask_company',
        chatbot_answers: answers,
    });
    await sendBotMsg(chatId, conversation.id, FLOW.ask_company.message(result.intent));
}

async function _handleAskCompany(conversation, text, chatId, answers) {
    const trimmed = text.trim();

    // Extrai entidades para verificar se veio empresa + mais
    const entities = extractEntities(text);

    answers.company_name = entities.company || trimmed;
    const classification = answers.intent || 'comercial';

    if (conversation.lead_id) {
        const leadUpdates = {
            company_name: answers.company_name,
            classification,
        };
        if (entities.email) leadUpdates.email = entities.email;
        await updateLead(conversation.lead_id, leadUpdates);
    }

    await trackBotEvent(conversation.id, 'company_collected', {
        company: answers.company_name,
        classification,
    });

    if (classification === 'comercial') {
        // Se já extraiu domínio → pula ask_domain
        if (entities.domain || answers._extracted_domain) {
            answers.domain = entities.domain || answers._extracted_domain;
            await updateConversation(conversation.id, {
                chatbot_stage: 'ask_context',
                chatbot_answers: answers,
            });
            await sendBotMsg(chatId, conversation.id, FLOW.ask_context.message());
        } else {
            await updateConversation(conversation.id, {
                chatbot_stage: 'ask_domain',
                chatbot_answers: answers,
            });
            await sendBotMsg(chatId, conversation.id, FLOW.ask_domain.message());
        }
    } else {
        // OPEC → finaliza direto
        await _finalizeClassification(conversation, answers, classification, chatId, analyzeSentiment(text));
    }
}

async function _handleAskDomain(conversation, text, chatId, answers, retries) {
    const trimmed = text.trim().toLowerCase();

    // Permite pular
    if (['pular', 'skip', 'não tenho', 'nao tenho', 'não sei', 'nao sei', '-', 'n/a'].includes(trimmed)) {
        answers.domain = null;
        answers._domain_skipped = true;
        await updateConversation(conversation.id, {
            chatbot_stage: 'ask_context',
            chatbot_answers: answers,
        });
        await sendBotMsg(chatId, conversation.id,
            `Sem problemas! 😊\n\n` + FLOW.ask_context.message()
        );
        return;
    }

    // Valida domínio
    const validation = validateDomain(text);

    if (!validation.valid) {
        retries.domain = (retries.domain || 0) + 1;
        answers._retries = retries;

        if (retries.domain >= MAX_RETRIES) {
            // Pula domínio após N tentativas
            answers.domain = trimmed; // salva o que foi digitado como contexto
            answers._domain_forced = true;
            await updateConversation(conversation.id, {
                chatbot_stage: 'ask_context',
                chatbot_answers: answers,
            });
            await sendBotMsg(chatId, conversation.id,
                `Ok, anotei! 📝\n\n` + FLOW.ask_context.message()
            );
            return;
        }

        await sendBotMsg(chatId, conversation.id, FLOW.retry.domain_invalid);
        await updateConversation(conversation.id, { chatbot_answers: answers });
        return;
    }

    answers.domain = validation.domain;
    answers._retries = {};

    if (conversation.lead_id) {
        await updateLead(conversation.lead_id, {
            metadata: { domain: validation.domain },
        });
    }

    await trackBotEvent(conversation.id, 'domain_collected', {
        domain: validation.domain,
    });

    await updateConversation(conversation.id, {
        chatbot_stage: 'ask_context',
        chatbot_answers: answers,
    });
    await sendBotMsg(chatId, conversation.id, FLOW.ask_context.message());
}

async function _handleAskContext(conversation, text, chatId, answers, sentiment) {
    answers.context = text.trim();
    const classification = answers.intent || 'comercial';

    if (conversation.lead_id) {
        await updateLead(conversation.lead_id, {
            metadata: {
                domain:  answers.domain || null,
                context: answers.context,
            },
        });
    }

    await trackBotEvent(conversation.id, 'context_collected', {
        context_length: answers.context.length,
    });

    await _finalizeClassification(conversation, answers, classification, chatId, sentiment);
}

// ─── FINALIZAÇÃO ─────────────────────────────────────────────────────

async function _finalizeClassification(conversation, answers, classification, chatId, sentiment) {
    const priority = calculatePriority(answers, sentiment, conversation.leads);

    // Routing event
    await createRoutingEvent({
        conversation_id: conversation.id,
        from_team: null,
        to_team:   classification,
        reason:    _buildRoutingReason(answers, sentiment),
        routed_by: 'bot',
    });

    // Atualiza conversa
    await updateConversation(conversation.id, {
        chatbot_stage:   'classified',
        chatbot_answers: { ...answers, _priority: priority, _classified_at: new Date().toISOString() },
        assigned_to:     classification,
        status:          'in_progress',
    });

    // Envia mensagem de classificação
    await sendBotMsg(chatId, conversation.id, FLOW.classified.message(classification));

    // Gera e envia handoff summary (mensagem interna para o atendente)
    const summary = generateHandoffSummary(answers, conversation.leads, sentiment);
    await _saveInternalNote(conversation.id, summary);

    // Move para human
    await updateConversation(conversation.id, { chatbot_stage: 'human' });

    logger.info('Lead classificado', {
        conversation_id: conversation.id,
        classification,
        company: answers.company_name,
        domain:  answers.domain || null,
        priority,
        confidence: answers._intent_conf,
        sentiment:  sentiment?.sentiment,
    });

    await trackBotEvent(conversation.id, 'classified', {
        classification,
        priority,
        company: answers.company_name,
        domain: answers.domain,
        confidence: answers._intent_conf,
        method: answers._intent_method,
    });
}

// ─── ESCALAÇÃO PARA HUMANO ──────────────────────────────────────────

async function _escalateToHuman(conversation, answers, chatId, sentiment, message) {
    await sendBotMsg(chatId, conversation.id, message);

    const priority = calculatePriority(answers, sentiment, conversation.leads);
    const classification = answers.intent || 'unclassified';

    await createRoutingEvent({
        conversation_id: conversation.id,
        from_team: null,
        to_team:   classification === 'unclassified' ? 'comercial' : classification,
        reason:    `Bot escalation: ${answers._escalated_reason || 'unknown'} | ` +
                   _buildRoutingReason(answers, sentiment),
        routed_by: 'bot',
    });

    await updateConversation(conversation.id, {
        chatbot_stage: 'human',
        chatbot_answers: {
            ...answers,
            _priority: priority + 1, // boost por escalação
            _escalated: true,
            _classified_at: new Date().toISOString(),
        },
        assigned_to: classification === 'unclassified' ? 'comercial' : classification,
        status: 'in_progress',
    });

    const summary = generateHandoffSummary(answers, conversation.leads, sentiment);
    await _saveInternalNote(conversation.id,
        `⚠️ *ESCALAÇÃO DO BOT*\n${answers._escalated_reason}\n\n${summary}`
    );

    logger.info('Lead escalado para humano', {
        conversation_id: conversation.id,
        reason: answers._escalated_reason,
        priority: priority + 1,
    });

    await trackBotEvent(conversation.id, 'escalated', {
        reason: answers._escalated_reason,
        priority: priority + 1,
    });
}

// ─── ENTITY ENRICHMENT ──────────────────────────────────────────────

async function _enrichLeadFromEntities(conversation, entities, answers) {
    try {
        const leadUpdates = {};

        if (entities.name && !conversation.leads?.name) {
            leadUpdates.name = entities.name;
            answers._extracted_name = entities.name;
        }
        if (entities.company) {
            answers._extracted_company = entities.company;
        }
        if (entities.domain) {
            answers._extracted_domain = entities.domain;
        }
        if (entities.email && !conversation.leads?.email) {
            leadUpdates.email = entities.email;
        }
        if (entities.phone && !conversation.leads?.phone) {
            leadUpdates.phone = entities.phone;
        }

        if (Object.keys(leadUpdates).length > 0 && conversation.lead_id) {
            await updateLead(conversation.lead_id, leadUpdates);
            logger.debug('Lead enriched from entities', {
                lead_id: conversation.lead_id,
                fields: Object.keys(leadUpdates),
            });
        }
    } catch (err) {
        logger.debug('Entity enrichment error', { error: err.message });
    }
}

// ─── HELPERS ─────────────────────────────────────────────────────────

function _buildRoutingReason(answers, sentiment) {
    const parts = [];
    parts.push(`intent="${answers.intent_raw || '—'}"`);
    if (answers.company_name) parts.push(`empresa="${answers.company_name}"`);
    if (answers.domain) parts.push(`domínio="${answers.domain}"`);
    if (answers._intent_conf) parts.push(`conf=${answers._intent_conf}`);
    if (sentiment?.urgency) parts.push('URGENTE');
    return `Chatbot: ${parts.join(', ')}`;
}

async function sendBotMsg(chatId, conversationId, text) {
    try {
        await sendMessage(chatId, text);
        const { saveMessage } = await import('./supabase.js');
        await saveMessage({
            conversation_id:    conversationId,
            direction:          'outbound',
            sender_type:        'bot',
            sender_name:        'Bot Branddi',
            content:            text,
            attachments:        [],
            unipile_message_id: `bot_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        });
    } catch (err) {
        logger.error('Erro enviando mensagem bot', { error: err.message });
    }
}

async function _saveInternalNote(conversationId, text) {
    try {
        const { saveMessage } = await import('./supabase.js');
        await saveMessage({
            conversation_id:    conversationId,
            direction:          'outbound',
            sender_type:        'bot',
            sender_name:        'Bot (nota interna)',
            content:            text,
            attachments:        [{ type: 'internal_note' }],
            unipile_message_id: `note_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        });
    } catch (err) {
        logger.debug('Internal note save error', { error: err.message });
    }
}

// ─── TRIGGER DE BOAS-VINDAS ─────────────────────────────────────────

export async function triggerWelcome(conversationId, chatId, leadName) {
    try {
        const hours = isBusinessHours();
        let msg;
        if (!hours.active) {
            msg = await getSettingValue('outside_hours_message', FLOW.outsideHours);
        } else {
            msg = FLOW.welcome.message(leadName);
        }
        await sendBotMsg(chatId, conversationId, msg);
        await updateConversation(conversationId, { chatbot_stage: 'qualifying' });
        await trackBotEvent(conversationId, 'welcome_triggered', {
            business_hours: hours.active,
        });
    } catch (err) {
        logger.error('Erro trigger welcome', { error: err.message });
    }
}

// ─── SCRIPT VARIABLES ───────────────────────────────────────────────

export function applyScriptVariables(content, lead) {
    return content
        .replace(/{{nome}}/gi,    lead?.name?.split(' ')[0] || 'você')
        .replace(/{{empresa}}/gi, lead?.company_name || 'sua empresa')
        .replace(/{{data}}/gi,    new Date().toLocaleDateString('pt-BR'))
        .replace(/{{dominio}}/gi, lead?.metadata?.domain || 'seu site');
}

// ─── RE-EXPORT dos workers (para backward compat) ───────────────────

export { startChatbotWorkers } from './chatbot-workers.js';

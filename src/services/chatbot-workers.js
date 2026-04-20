/**
 * Chatbot Workers — Background workers para automação
 *
 * Workers:
 *   1. Away Message — Envia mensagem de ausência quando humano não responde
 *   2. Nudge — Re-engaja leads que pararam de responder no meio do fluxo
 *   3. Follow-up — Escala conversas que ninguém pegou
 *   4. Business Hours — Envia mensagem fora do horário automaticamente
 */
import {
    updateConversation, getConversationsWaitingForHuman, getSettingValue
} from './supabase.js';
import supabase from './supabase.js';
import { sendMessage } from './unipile.js';
import { isBusinessHours } from './chatbot-nlp.js';
import logger from './logger.js';

// ─── CONFIGURAÇÕES PADRÃO ────────────────────────────────────────────

const DEFAULTS = {
    away_message:
        `Olá! 👋 No momento nossa equipe não está disponível, mas retornaremos assim que possível! ⏰\n\n` +
        `Enquanto isso, você pode enviar mais informações sobre sua necessidade que nosso time vai atender em breve. 😊`,
    away_minutes: 5,
    away_enabled: true,
    nudge_enabled: true,
    nudge_minutes: 3,
    nudge_message:
        `Ei, ainda está aí? 😊 Posso te ajudar com algo mais? Se preferir, é só responder!`,
    followup_enabled: true,
    followup_minutes: 15,
    business_hours_start: 9,
    business_hours_end: 18,
    outside_hours_message:
        `Olá! 👋 Nosso horário de atendimento é de *segunda a sexta, das 9h às 18h* (horário de Brasília).\n\n` +
        `Sua mensagem foi registrada e nosso time responderá no próximo horário disponível! 🕘`,
};

// ─── HELPER: Envio seguro de mensagem do bot ─────────────────────────

async function sendBotMsg(chatId, conversationId, text) {
    try {
        const result = await sendMessage(chatId, text);
        const realMsgId = result?.message_id || result?.id || `bot_worker_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const { saveMessage } = await import('./supabase.js');
        await saveMessage({
            conversation_id:    conversationId,
            direction:          'outbound',
            sender_type:        'bot',
            sender_name:        'Bot Branddi',
            content:            text,
            attachments:        [],
            unipile_message_id: realMsgId,
        });
    } catch (err) {
        logger.error('Worker: erro enviando msg', { error: err.message, conversationId });
    }
}

// ─── WORKER 1: Away Message ──────────────────────────────────────────
// Envia mensagem quando conversa está em 'human' mas ninguém respondeu.

async function checkAwayMessages() {
    try {
        const enabled = await getSettingValue('away_enabled', DEFAULTS.away_enabled);
        if (!enabled) return;

        const minutes = await getSettingValue('away_minutes', DEFAULTS.away_minutes);
        const msg     = await getSettingValue('away_message', DEFAULTS.away_message);
        const cutoff  = new Date(Date.now() - parseInt(minutes) * 60_000).toISOString();

        const convs = await getConversationsWaitingForHuman(cutoff);

        for (const conv of convs) {
            if (!conv.whatsapp_chat_id || conv.bot_away_sent) continue;

            await sendBotMsg(conv.whatsapp_chat_id, conv.id, msg);
            await updateConversation(conv.id, { bot_away_sent: true });
            logger.info('Away message enviada', { conversation_id: conv.id });

            // Track analytics
            await trackBotEvent(conv.id, 'away_message_sent', { minutes });
        }
    } catch (err) {
        logger.warn('Away worker error', { error: err.message });
    }
}

// ─── WORKER 2: Nudge ─────────────────────────────────────────────────
// Re-engaja leads que pararam no meio do fluxo do bot.

async function checkNudgeMessages() {
    try {
        const enabled = await getSettingValue('nudge_enabled', DEFAULTS.nudge_enabled);
        if (!enabled) return;

        const minutes = await getSettingValue('nudge_minutes', DEFAULTS.nudge_minutes);
        const msg     = await getSettingValue('nudge_message', DEFAULTS.nudge_message);
        const cutoff  = new Date(Date.now() - parseInt(minutes) * 60_000).toISOString();

        // Busca conversas no meio do fluxo bot que pararam
        const { data: convs } = await supabase
            .from('conversations')
            .select('id, whatsapp_chat_id, chatbot_stage, chatbot_answers, updated_at, leads(name)')
            .in('status', ['waiting', 'in_progress'])
            .in('chatbot_stage', ['qualifying', 'ask_company', 'ask_domain', 'ask_context'])
            .lt('updated_at', cutoff)
            .limit(10);

        if (!convs || convs.length === 0) return;

        for (const conv of convs) {
            if (!conv.whatsapp_chat_id) continue;

            // Verifica se já enviou nudge (usa chatbot_answers.nudge_sent)
            const answers = conv.chatbot_answers || {};
            if (answers._nudge_sent) continue;

            // Personaliza a mensagem baseada no estágio
            let personalMsg = msg;
            if (conv.chatbot_stage === 'ask_company') {
                personalMsg = `Ainda estou aqui! 😊 Para te direcionar ao time certo, preciso saber: qual é o nome da sua *empresa*?`;
            } else if (conv.chatbot_stage === 'ask_domain') {
                personalMsg = `Opa, me diz o endereço do *site* da sua empresa? Assim consigo preparar uma análise personalizada! 🔍`;
            } else if (conv.chatbot_stage === 'ask_context') {
                personalMsg = `Estamos quase lá! 😊 Em poucas palavras, qual é o *motivo do seu contato*?`;
            }

            await sendBotMsg(conv.whatsapp_chat_id, conv.id, personalMsg);
            await updateConversation(conv.id, {
                chatbot_answers: { ...answers, _nudge_sent: true },
            });
            logger.info('Nudge enviado', { conversation_id: conv.id, stage: conv.chatbot_stage });

            await trackBotEvent(conv.id, 'nudge_sent', { stage: conv.chatbot_stage });
        }
    } catch (err) {
        logger.warn('Nudge worker error', { error: err.message });
    }
}

// ─── WORKER 3: Follow-up / Escalation ────────────────────────────────
// Escala conversas classified/human que ninguém pegou.

async function checkFollowups() {
    try {
        const enabled = await getSettingValue('followup_enabled', DEFAULTS.followup_enabled);
        if (!enabled) return;

        const minutes = await getSettingValue('followup_minutes', DEFAULTS.followup_minutes);
        const cutoff  = new Date(Date.now() - parseInt(minutes) * 60_000).toISOString();

        // Conversas em estado 'human' sem atendente atribuído
        const { data: convs } = await supabase
            .from('conversations')
            .select('id, whatsapp_chat_id, chatbot_stage, assigned_to, chatbot_answers, leads!inner(name, classification, origin)')
            .eq('chatbot_stage', 'human')
            .neq('leads.origin', 'pipedrive_outbound')
            .in('status', ['waiting', 'in_progress'])
            .is('assigned_user_id', null) // ninguém pegou individualmente
            .lt('updated_at', cutoff)
            .limit(10);

        if (!convs || convs.length === 0) return;

        for (const conv of convs) {
            if (!conv.whatsapp_chat_id) continue;

            const answers = conv.chatbot_answers || {};
            if (answers._followup_sent) continue;

            // Envia msg ao lead
            const followupMsg =
                `${conv.leads?.name ? conv.leads.name.split(' ')[0] + ', ' : ''}obrigado pela paciência! 🙏\n\n` +
                `Nosso time está sendo notificado e um especialista vai atender você em breve. ` +
                `Enquanto isso, pode me contar mais detalhes sobre o que precisa? 😊`;

            await sendBotMsg(conv.whatsapp_chat_id, conv.id, followupMsg);
            await updateConversation(conv.id, {
                chatbot_answers: { ...answers, _followup_sent: true },
            });

            logger.info('Follow-up enviado', {
                conversation_id: conv.id,
                assigned_to: conv.assigned_to,
                wait_minutes: minutes,
            });

            await trackBotEvent(conv.id, 'followup_sent', {
                assigned_to: conv.assigned_to,
                wait_minutes: minutes,
            });
        }
    } catch (err) {
        logger.warn('Follow-up worker error', { error: err.message });
    }
}

// ─── ANALYTICS TRACKING ──────────────────────────────────────────────

/**
 * Registra evento de analytics do bot.
 * Usa platform_settings com key 'chatbot_analytics_buffer' como buffer.
 */
async function trackBotEvent(conversationId, event, metadata = {}) {
    try {
        const { data, error } = await supabase
            .from('chatbot_events')
            .insert([{
                conversation_id: conversationId,
                event_type:      event,
                metadata,
            }]);
        // Silently fail if table doesn't exist yet
        if (error && !error.message?.includes('does not exist')) {
            logger.debug('Bot event tracking error', { error: error.message });
        }
    } catch {
        // Analytics não devem quebrar o fluxo
    }
}

// ─── TRACK EVENT (exported for chatbot-engine) ───────────────────────

export { trackBotEvent };

// ─── MAIN WORKER STARTER ─────────────────────────────────────────────

export function startChatbotWorkers() {
    logger.info('Chatbot workers iniciados', {
        away: '60s',
        nudge: '90s',
        followup: '120s',
    });

    // Away message — verifica a cada 60s
    setInterval(checkAwayMessages, 60_000);

    // Nudge — verifica a cada 90s
    setInterval(checkNudgeMessages, 90_000);

    // Follow-up — verifica a cada 120s
    setInterval(checkFollowups, 120_000);

    // Roda uma vez no startup (após 10s para dar tempo de inicializar)
    setTimeout(() => {
        checkAwayMessages();
        checkNudgeMessages();
        checkFollowups();
    }, 10_000);
}

export { DEFAULTS as WORKER_DEFAULTS };

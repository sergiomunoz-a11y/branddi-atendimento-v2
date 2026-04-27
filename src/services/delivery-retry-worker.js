/**
 * Delivery Retry Worker
 *
 * Roda periodicamente e identifica mensagens outbound humanas que ficaram
 * com delivered=false por mais de 5 minutos. Pra cada uma, tenta enviar
 * a mesma mensagem usando a variante alternativa do número BR (com/sem 9).
 *
 * Princípio: "fail-safe by default". Só faz retry quando:
 *   - msg tem MENOS de 30min (não tenta ressuscitar conversa antiga)
 *   - msg tem MAIS de 5min (dá tempo do delivery normal acontecer)
 *   - existe outra variante BR plausível diferente da original
 *   - retry_attempted_at IS NULL (uma única tentativa por msg)
 *
 * Marcamos retry_attempted_at independente do sucesso pra evitar loops.
 */
import 'dotenv/config';
import supabase from './supabase.js';
import { sendMessage, startNewChat } from './unipile.js';
import logger from './logger.js';

const RETRY_INTERVAL_MS    = 90 * 1000;        // 90s entre passadas
const RETRY_AFTER_MIN      = 5;                // espera 5 min antes de tentar
const RETRY_BEFORE_MIN     = 30;               // não tenta msgs > 30 min
const BATCH_LIMIT          = 10;               // até 10 msgs por ciclo

let _interval = null;

function brPhoneVariants(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return [];
    const local = digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits;
    const out = new Set();
    if (local.length >= 10) out.add(`55${local}`);
    if (local.length === 10) out.add(`55${local.slice(0,2)}9${local.slice(2)}`);
    if (local.length === 11 && local[2] === '9') out.add(`55${local.slice(0,2)}${local.slice(3)}`);
    return [...out];
}

async function processOnce() {
    const sinceLow  = new Date(Date.now() - RETRY_BEFORE_MIN * 60_000).toISOString();
    const sinceHigh = new Date(Date.now() - RETRY_AFTER_MIN  * 60_000).toISOString();

    const { data: candidates, error } = await supabase
        .from('messages')
        .select('id, content, conversation_id, created_at, unipile_message_id')
        .eq('direction', 'outbound')
        .eq('sender_type', 'human')
        .eq('delivered', false)
        .eq('seen', false)
        .is('retry_attempted_at', null)
        .gte('created_at', sinceLow)
        .lte('created_at', sinceHigh)
        .order('created_at', { ascending: true })
        .limit(BATCH_LIMIT);

    if (error) {
        logger.warn('Delivery retry: query failed', { error: error.message });
        return;
    }
    if (!candidates || candidates.length === 0) return;

    for (const msg of candidates) {
        await tryRetry(msg);
    }
}

async function tryRetry(msg) {
    try {
        // Marca já como tentado pra evitar reprocessamento concorrente
        const { data: claimed } = await supabase
            .from('messages')
            .update({ retry_attempted_at: new Date().toISOString() })
            .eq('id', msg.id)
            .is('retry_attempted_at', null)
            .select('id')
            .maybeSingle();
        if (!claimed) return; // outro worker pegou

        // Busca conv + lead pra reconstruir o contexto de envio
        const { data: conv } = await supabase
            .from('conversations')
            .select('id, lead_id, whatsapp_account_id, whatsapp_chat_id')
            .eq('id', msg.conversation_id)
            .maybeSingle();
        if (!conv) return;

        const { data: lead } = await supabase
            .from('leads')
            .select('id, phone')
            .eq('id', conv.lead_id)
            .maybeSingle();
        if (!lead?.phone) return;

        const variants = brPhoneVariants(lead.phone);
        if (variants.length < 2) return; // não há alternativa BR plausível

        // Já temos um chat verificado? startNewChat detecta isso e reusa.
        // Aqui, pra retry, queremos a variante DIFERENTE da já tentada.
        // Heurística: se o chat atual existe, ele é "como veio". Mandamos
        // pelo startNewChat passando uma variante alternativa — ele vai
        // procurar verificada primeiro e usar; se ainda não houver,
        // cria com essa variante alternativa.
        const original = variants[0];
        const alternative = variants.find(v => v !== original);
        if (!alternative) return;

        logger.info('Delivery retry: tentando alternativa', {
            msg_id: msg.id, conversation_id: conv.id,
            original, alternative,
        });

        const result = await startNewChat(alternative, msg.content, conv.whatsapp_account_id);
        const newChatId = result?.id || result?.chat_id;
        if (newChatId && newChatId !== conv.whatsapp_chat_id) {
            // Liga a conversa ao chat verificado, se ainda não estava
            try {
                await supabase
                    .from('conversations')
                    .update({ whatsapp_chat_id: newChatId })
                    .eq('id', conv.id)
                    .is('whatsapp_chat_id', null);
            } catch { /* não crítico */ }
        }

        logger.info('Delivery retry: enviado', {
            msg_id: msg.id, reused: !!result?.reused_existing,
        });
    } catch (err) {
        logger.warn('Delivery retry failed', { msg_id: msg.id, error: err.message });
    }
}

export function startDeliveryRetryWorker() {
    if (_interval) return;
    logger.info('Delivery retry worker iniciado', {
        interval_ms: RETRY_INTERVAL_MS,
        retry_window: `${RETRY_AFTER_MIN}-${RETRY_BEFORE_MIN} min`,
    });
    _interval = setInterval(() => {
        processOnce().catch(err => logger.warn('Delivery retry loop error', { error: err.message }));
    }, RETRY_INTERVAL_MS);
    // Primeira passada após 30s pra dar tempo de subir tudo
    setTimeout(() => {
        processOnce().catch(() => {});
    }, 30_000);
}

export function stopDeliveryRetryWorker() {
    if (_interval) clearInterval(_interval);
    _interval = null;
}

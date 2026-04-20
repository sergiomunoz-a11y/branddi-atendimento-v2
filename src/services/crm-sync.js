/**
 * CRM Sync Worker
 * v2: Retry com backoff exponencial, structured logging
 */
import 'dotenv/config';
import {
    getPendingSyncs, updateSyncLog, updateLead, logCrmSync, getLeadById, getSettingValue,
    getConversationById, getMessages, updateConversation
} from './supabase.js';
import {
    createPerson, findPersonByPhone, findOrCreateOrg, createDeal, createWhatsAppActivity,
    createDealNote, pdPost
} from './pipedrive.js';
import logger from './logger.js';

// ─── Worker Principal ─────────────────────────────────────────────────

export function startCrmSyncWorker(intervalMs = 30_000) {
    logger.info('CRM Sync worker iniciado', { interval_ms: intervalMs });
    setInterval(processPendingSyncs, intervalMs);
}

async function processPendingSyncs() {
    try {
        const pending = await getPendingSyncs(10);
        for (const syncEntry of pending) {
            await processSyncEntry(syncEntry);
        }
    } catch (err) {
        logger.warn('CRM Sync worker error', { error: err.message });
    }
}

async function processSyncEntry(entry) {
    try {
        let result = null;

        if (entry.entity_type === 'lead' && entry.crm_object_type === 'person') {
            result = await syncLeadAsPerson(entry.entity_id, entry.sync_payload);
        } else if (entry.entity_type === 'lead' && entry.crm_object_type === 'deal') {
            result = await syncLeadAsDeal(entry.entity_id, entry.sync_payload);
        } else if (entry.entity_type === 'conversation' && entry.crm_object_type === 'activity') {
            result = await syncConversationAsActivity(entry.entity_id, entry.sync_payload);
        }

        await updateSyncLog(entry.id, {
            sync_status:   'success',
            crm_object_id: result?.id?.toString() || null,
        });
    } catch (err) {
        const retryCount = (entry.retry_count || 0) + 1;
        logger.error('CRM sync error', {
            entity_type: entry.entity_type,
            crm_object_type: entry.crm_object_type,
            error: err.message,
            retry_count: retryCount,
        });

        if (retryCount >= 3) {
            // Esgotou retries — marca como falha permanente
            await updateSyncLog(entry.id, {
                sync_status:   'failed',
                error_message: err.message,
                retry_count:   retryCount,
            });
        } else {
            // Agenda retry com backoff exponencial: 30s, 60s, 120s
            const backoffMs = 30_000 * Math.pow(2, retryCount - 1);
            await updateSyncLog(entry.id, {
                sync_status:   'error',
                error_message: err.message,
                retry_count:   retryCount,
                next_retry_at: new Date(Date.now() + backoffMs).toISOString(),
            });
        }
    }
}

// ─── Sync: Lead → Person + Org no Pipedrive ───────────────────────────

async function syncLeadAsPerson(leadId, payload = {}) {
    const lead = await getLeadById(leadId);
    if (!lead) throw new Error(`Lead ${leadId} não encontrado`);

    if (lead.crm_person_id) {
        return { id: lead.crm_person_id };
    }

    let person = null;
    if (lead.phone) {
        person = await findPersonByPhone(lead.phone);
    }

    if (!person) {
        person = await createPerson({
            name:         lead.name,
            phone:        lead.phone ? `55${lead.phone}` : null,
            email:        lead.email,
            company_name: lead.company_name,
        });
    }

    if (!person) throw new Error('Falha ao criar/encontrar pessoa no Pipedrive');

    await updateLead(leadId, {
        crm_person_id: person.id?.toString(),
        last_synced_at: new Date().toISOString(),
    });

    return person;
}

// ─── Sync: Lead → Deal no Pipedrive ──────────────────────────────────

async function syncLeadAsDeal(leadId, payload = {}) {
    const lead = await getLeadById(leadId);
    if (!lead) throw new Error(`Lead ${leadId} não encontrado`);

    const pipelineId = parseInt(await getSettingValue('pipedrive_pipeline_id', 5));
    const stageId    = parseInt(await getSettingValue('pipedrive_stage_id', 208));
    const ownerId    = await getSettingValue('pipedrive_owner_id', null);

    const label = lead.classification === 'comercial' ? 'hot' : undefined;
    const title = `${lead.name || 'Lead'} — ${lead.company_name || 'WhatsApp'} [Inbound WA]`;

    const deal = await createDeal({
        title,
        personId:   lead.crm_person_id ? parseInt(lead.crm_person_id) : undefined,
        orgId:      lead.crm_org_id    ? parseInt(lead.crm_org_id)    : undefined,
        pipelineId,
        stageId,
        ownerId:    ownerId ? parseInt(ownerId) : undefined,
        label,
        ...payload,
    });

    if (!deal) throw new Error('Falha ao criar deal no Pipedrive');

    const meta = lead.metadata || {};
    if (meta.domain || meta.context) {
        const noteLines = [];
        if (meta.domain)  noteLines.push(`<b>Site:</b> ${meta.domain}`);
        if (meta.context) noteLines.push(`<b>Contexto:</b> ${meta.context}`);
        noteLines.push(`<b>Origem:</b> WhatsApp Inbound`);
        noteLines.push(`<b>Telefone:</b> ${lead.phone || '—'}`);
        try {
            await pdPost('/notes', {
                content:  noteLines.join('<br>'),
                deal_id:  deal.id,
                pinned_to_deal_flag: 1,
            });
        } catch { /* nota não crítica */ }
    }

    await updateLead(leadId, {
        crm_deal_id:    deal.id?.toString(),
        last_synced_at: new Date().toISOString(),
    });

    return deal;
}

// ─── Sync: Conversa → Activity no Pipedrive ───────────────────────────

async function syncConversationAsActivity(conversationId, payload = {}) {
    const { messages = [], leadName, dealId, personId } = payload;

    const transcript = messages.map(m => {
        const sender = m.sender_type === 'lead' ? leadName || 'Lead' :
                       m.sender_type === 'bot' ? 'Bot' : 'Atendente';
        const time = new Date(m.created_at).toLocaleTimeString('pt-BR', {
            hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
        });
        return `[${time}] ${sender}: ${m.content}`;
    }).join('\n');

    const activity = await createWhatsAppActivity({
        dealId,
        personId,
        subject: `WhatsApp — ${leadName || 'Lead'}`,
        transcript,
    });

    return activity;
}

// ─── Enfileirar syncs ─────────────────────────────────────────────────

export async function queueLeadSync(leadId, payload = {}) {
    await logCrmSync({
        entity_type:     'lead',
        entity_id:       leadId,
        crm_type:        'pipedrive',
        crm_object_type: 'person',
        sync_status:     'pending',
        sync_payload:    payload,
    });
    await logCrmSync({
        entity_type:     'lead',
        entity_id:       leadId,
        crm_type:        'pipedrive',
        crm_object_type: 'deal',
        sync_status:     'pending',
        sync_payload:    payload,
    });
}

// ─── Sync manual (botão "Enviar ao Pipedrive") ───────────────────────
// Cria Person + Org + Deal + Note (qualificação) + Activity (transcript)
// em uma única chamada síncrona. Usa dados já existentes (crm_person_id,
// crm_deal_id) se disponíveis.
export async function syncConversationToPipedrive(conversationId) {
    const conv = await getConversationById(conversationId);
    if (!conv) throw new Error(`Conversa ${conversationId} não encontrada`);
    const lead = conv.leads;
    if (!lead) throw new Error('Conversa sem lead vinculado');

    if (conv.crm_deal_id) {
        return { already_synced: true, deal_id: conv.crm_deal_id };
    }

    // 1) Person (reusa ou cria)
    let personId = lead.crm_person_id ? parseInt(lead.crm_person_id) : null;
    if (!personId && lead.phone) {
        const found = await findPersonByPhone(lead.phone);
        if (found) personId = found.id;
    }
    if (!personId) {
        const person = await createPerson({
            name:         lead.name,
            phone:        lead.phone ? `55${lead.phone}` : null,
            email:        lead.email,
            company_name: lead.company_name,
        });
        if (!person) throw new Error('Falha ao criar pessoa no Pipedrive');
        personId = person.id;
    }

    // 2) Org (se tem empresa e ainda não linkada)
    let orgId = lead.crm_org_id ? parseInt(lead.crm_org_id) : null;
    if (!orgId && lead.company_name) {
        orgId = await findOrCreateOrg(lead.company_name);
    }

    // 3) Deal
    const pipelineId = parseInt(await getSettingValue('pipedrive_pipeline_id', 5));
    const stageId    = parseInt(await getSettingValue('pipedrive_stage_id', 208));
    const ownerId    = await getSettingValue('pipedrive_owner_id', null);
    const label      = lead.classification === 'comercial' ? 'hot' : undefined;
    const title      = `${lead.name || 'Lead'} — ${lead.company_name || 'WhatsApp'}`;

    const deal = await createDeal({
        title,
        personId:   personId || undefined,
        orgId:      orgId    || undefined,
        pipelineId,
        stageId,
        ownerId:    ownerId ? parseInt(ownerId) : undefined,
        label,
    });
    if (!deal) throw new Error('Falha ao criar deal no Pipedrive');

    // 4) Nota pinada com dados de qualificação
    const meta = lead.origin_metadata || {};
    const answers = conv.chatbot_answers || {};
    const noteLines = [
        `<b>Classificação:</b> ${lead.classification || 'unclassified'}`,
        lead.name         && `<b>Nome:</b> ${lead.name}`,
        answers.role      && `<b>Cargo:</b> ${answers.role}`,
        lead.company_name && `<b>Empresa:</b> ${lead.company_name}`,
        (meta.domain || answers.domain) && `<b>Site:</b> ${meta.domain || answers.domain}`,
        lead.phone        && `<b>Telefone:</b> ${lead.phone}`,
        lead.email        && `<b>Email:</b> ${lead.email}`,
        meta.context      && `<b>Contexto:</b> ${meta.context}`,
        `<b>Origem:</b> ${lead.origin || 'whatsapp_direct'}`,
    ].filter(Boolean);
    try {
        await createDealNote({
            dealId:  deal.id,
            content: noteLines.join('<br>'),
            pinned:  true,
        });
    } catch (err) {
        logger.warn('Falha ao criar nota no deal (não crítico)', { error: err.message });
    }

    // 5) Activity com transcript
    try {
        const messages = await getMessages(conversationId, { limit: 200 });
        const transcript = messages.map(m => {
            const sender = m.sender_type === 'lead' ? lead.name || 'Lead' :
                           m.sender_type === 'bot'  ? 'Bot' :
                           m.sent_by_name || 'Atendente';
            const time = new Date(m.created_at).toLocaleString('pt-BR', {
                timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit',
                day: '2-digit', month: '2-digit',
            });
            return `[${time}] ${sender}: ${m.content || ''}`;
        }).join('\n');

        await createWhatsAppActivity({
            dealId:   deal.id,
            personId,
            subject:  `WhatsApp — ${lead.name || 'Lead'}`,
            transcript,
        });
    } catch (err) {
        logger.warn('Falha ao criar activity (não crítico)', { error: err.message });
    }

    // 6) Persiste IDs no DB
    await updateLead(lead.id, {
        crm_person_id:  personId.toString(),
        crm_org_id:     orgId ? orgId.toString() : null,
        crm_deal_id:    deal.id.toString(),
        last_synced_at: new Date().toISOString(),
    });
    await updateConversation(conversationId, {
        crm_deal_id: deal.id.toString(),
    });

    return { deal_id: deal.id, person_id: personId, org_id: orgId };
}

export async function queueConversationSync(conversationId, payload = {}) {
    await logCrmSync({
        entity_type:     'conversation',
        entity_id:       conversationId,
        crm_type:        'pipedrive',
        crm_object_type: 'activity',
        sync_status:     'pending',
        sync_payload:    payload,
    });
}

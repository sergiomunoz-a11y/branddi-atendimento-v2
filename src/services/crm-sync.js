/**
 * CRM Sync Worker
 * v2: Retry com backoff exponencial, structured logging
 */
import 'dotenv/config';
import {
    getPendingSyncs, updateSyncLog, updateLead, logCrmSync, getLeadById, getSettingValue
} from './supabase.js';
import {
    createPerson, findPersonByPhone, findOrCreateOrg, createDeal, createWhatsAppActivity, pdPost
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

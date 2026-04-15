/**
 * Pipedrive Integration Routes — Outbound workflow for SDRs
 *
 * Features:
 * - List deals assigned to current user with contacts that have phone numbers
 * - Start outbound conversation from a deal+person
 * - Auto-sync: when lead replies, create activity + update deal fields
 */
import { Router } from 'express';
import { pdGet, pdPut, pdPost, findPersonByPhone, getDealsForPerson } from '../services/pipedrive.js';
import {
    createLead, findLeadByPhone, createConversation, updateLead,
    updateConversation, getMessages, normalizePhone
} from '../services/supabase.js';
import { startNewChat } from '../services/unipile.js';
import logger from '../services/logger.js';

const router = Router();

// ─── GET /api/pipedrive/search-deals — Busca deals por termo ─────────
// Autocomplete: busca no Pipedrive por título/org e retorna matches com telefone
router.get('/pipedrive/search-deals', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.length < 2) return res.json({ deals: [] });

        const data = await pdGet(`/deals/search?term=${encodeURIComponent(q)}&limit=15&status=open`);
        const items = data?.data?.items || [];

        const deals = items.map(item => {
            const d = item.item;
            const person = d.person || {};
            const phones = (person.phones || []).filter(p => p && p.length > 5);

            return {
                id: d.id,
                title: d.title,
                org_name: d.organization?.name || '—',
                stage_name: d.stage?.name || '—',
                stage_id: d.stage?.id,
                pipeline_id: d.pipeline?.id,
                value: d.value != null ? `R$ ${Number(d.value).toLocaleString('pt-BR')}` : '—',
                person_id: person.id || null,
                person_name: person.name || '—',
                person_phones: phones,
                has_phone: phones.length > 0,
                owner_name: d.owner?.name || '—',
            };
        });

        res.json({ deals });
    } catch (err) {
        logger.error('Pipedrive search-deals error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/pipedrive/deal/:id/contacts — Contatos de um deal com telefone
router.get('/pipedrive/deal/:id/contacts', async (req, res) => {
    try {
        const dealId = req.params.id;

        // Busca participants do deal
        const data = await pdGet(`/deals/${dealId}/participants?limit=100`);
        const participants = data?.data || [];

        // Também inclui o person principal do deal
        const dealData = await pdGet(`/deals/${dealId}`);
        const deal = dealData?.data;
        const mainPersonId = deal?.person_id;

        const contacts = [];
        const seenIds = new Set();

        // Função para processar um person
        const addPerson = (personId) => {
            if (!personId || seenIds.has(personId)) return null;
            seenIds.add(personId);
            return personId;
        };

        // Person principal
        if (mainPersonId) addPerson(mainPersonId);

        // Participants
        for (const p of participants) {
            const pid = p.person?.id || p.person_id;
            addPerson(pid);
        }

        // Busca dados completos de cada person
        for (const pid of seenIds) {
            try {
                const pData = await pdGet(`/persons/${pid}`);
                const person = pData?.data;
                if (!person) continue;

                const phones = (person.phone || []).filter(p => p.value && p.value.length > 5);
                if (phones.length === 0) continue; // Sem telefone, não serve para WhatsApp

                contacts.push({
                    id: person.id,
                    name: person.name,
                    job_title: person.job_title || null,
                    org_name: person.org_name || null,
                    phones: phones.map(p => p.value),
                    email: person.email?.[0]?.value || null,
                    label_ids: person.label_ids || [],
                });
            } catch { /* ignora person com erro */ }
        }

        res.json({
            deal: {
                id: deal.id,
                title: deal.title,
                org_name: deal.org_name,
                stage_id: deal.stage_id,
                pipeline_id: deal.pipeline_id,
            },
            contacts,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/pipedrive/start-outbound — Inicia conversa outbound ───
router.post('/pipedrive/start-outbound', async (req, res) => {
    try {
        const { deal_id, person_id, phone, first_message } = req.body;
        if (!deal_id || !person_id || !phone) {
            return res.status(400).json({ error: 'deal_id, person_id e phone são obrigatórios' });
        }
        if (!first_message) {
            return res.status(400).json({ error: 'first_message é obrigatório' });
        }

        // Busca dados do person no Pipedrive
        const pData = await pdGet(`/persons/${person_id}`);
        const person = pData?.data;
        if (!person) return res.status(404).json({ error: 'Person não encontrado no Pipedrive' });

        // Normaliza telefone
        const normalized = normalizePhone(phone);
        if (!normalized) return res.status(400).json({ error: 'Telefone inválido' });

        // Cria ou encontra lead no Supabase
        let lead = await findLeadByPhone(normalized);
        if (!lead) {
            lead = await createLead({
                name: person.name,
                phone: normalized,
                email: person.email?.[0]?.value || null,
                company_name: person.org_name || null,
                origin: 'pipedrive_outbound',
                classification: 'comercial',
                crm_person_id: String(person.id),
                crm_deal_id: String(deal_id),
                metadata: { pipedrive_deal_id: deal_id, pipedrive_person_id: person.id },
            });
        } else {
            // Atualiza lead com dados do Pipedrive se não tinha
            const updates = {};
            if (!lead.crm_deal_id) updates.crm_deal_id = String(deal_id);
            if (!lead.crm_person_id) updates.crm_person_id = String(person.id);
            if (!lead.company_name && person.org_name) updates.company_name = person.org_name;
            if (!lead.name || lead.name === normalized) updates.name = person.name;
            if (Object.keys(updates).length > 0) {
                const { updateLead: ul } = await import('../services/supabase.js');
                await ul(lead.id, updates);
            }
        }

        // Inicia chat no WhatsApp via Unipile
        const whatsappPhone = `55${normalized}`;
        const chatResult = await startNewChat(whatsappPhone, first_message);
        const chatId = chatResult?.id || chatResult?.chat_id;

        if (!chatId) {
            return res.status(500).json({ error: 'Falha ao iniciar chat no WhatsApp' });
        }

        // Cria conversa no Supabase
        const conversation = await createConversation({
            lead_id: lead.id,
            whatsapp_chat_id: chatId,
            channel: 'whatsapp_direct',
            type: 'prospecting',
            status: 'in_progress',
            chatbot_stage: 'human', // Outbound = humano desde o início
            last_message_at: new Date().toISOString(),
        });

        // Salva primeira mensagem
        const { saveMessage } = await import('../services/supabase.js');
        await saveMessage({
            conversation_id: conversation.id,
            direction: 'outbound',
            sender_type: 'human',
            sender_name: req.user?.name || 'SDR',
            sent_by_user_id: req.user?.id || null,
            sent_by_name: req.user?.name || null,
            content: first_message,
            attachments: [],
            unipile_message_id: `outbound_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        });

        // Cria atividade no Pipedrive
        const now = new Date();
        await pdPost('/activities', {
            subject: `WhatsApp Outbound — ${person.name}`,
            type: 'whatsapp',
            deal_id: parseInt(deal_id),
            person_id: parseInt(person_id),
            due_date: now.toISOString().split('T')[0],
            due_time: now.toTimeString().slice(0, 5),
            done: 1,
            note: `Primeira mensagem enviada via Branddi Atendimento:\n\n${first_message}`,
            user_id: req.user?.pipedrive_user_id || undefined,
        });

        // Atualiza campo "Canal de Comunicação" = WhatsApp (235) e "Último ponto de contato"
        await pdPut(`/deals/${deal_id}`, {
            '9f1041ce02d38f454f6aa5012ead87760c0741d2': '235', // Canal = WhatsApp
            '065610f68aea2ba189d2277f326a22f72b50358a': now.toISOString().split('T')[0], // Último contato
        });

        logger.info('Outbound started', {
            deal_id, person_id, phone: normalized, conversation_id: conversation.id,
        });

        res.json({
            success: true,
            conversation_id: conversation.id,
            chat_id: chatId,
            lead_id: lead.id,
        });
    } catch (err) {
        logger.error('Start outbound error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/pipedrive/sync-reply — Chamado quando lead responde ───
// Cria atividade "Respondeu" e atualiza campos do deal
router.post('/pipedrive/sync-reply', async (req, res) => {
    try {
        const { conversation_id, deal_id, person_id } = req.body;
        if (!deal_id) return res.status(400).json({ error: 'deal_id obrigatório' });

        // Busca mensagens da conversa para transcrição
        let transcript = '';
        if (conversation_id) {
            const msgs = await getMessages(conversation_id, { limit: 50 });
            transcript = msgs.map(m => {
                const who = m.direction === 'outbound' ? (m.sent_by_name || 'SDR') : 'Lead';
                const time = new Date(m.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                return `[${time}] ${who}: ${m.content || '(mídia)'}`;
            }).join('\n');
        }

        const now = new Date();

        // Cria atividade "Respondeu"
        await pdPost('/activities', {
            subject: `Lead respondeu via WhatsApp`,
            type: 'whatsapp',
            deal_id: parseInt(deal_id),
            person_id: person_id ? parseInt(person_id) : undefined,
            due_date: now.toISOString().split('T')[0],
            due_time: now.toTimeString().slice(0, 5),
            done: 1,
            note: transcript || 'Lead respondeu via WhatsApp — ver conversa no Branddi Atendimento.',
            user_id: req.user?.pipedrive_user_id || undefined,
        });

        // Atualiza "Último ponto de contato"
        await pdPut(`/deals/${deal_id}`, {
            '065610f68aea2ba189d2277f326a22f72b50358a': now.toISOString().split('T')[0],
        });

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/conversations/import-history — Importa chats existentes ─
router.post('/conversations/import-history', async (req, res) => {
    try {
        const { listChats, getMessages: getWaMsgs, getChatAttendees } = await import('../services/unipile.js');
        const whatsapp = (await import('../providers/index.js')).default;

        const result = await listChats({ limit: 50 });
        const chats = result.items || [];

        let imported = 0;
        let skipped = 0;
        const errors = [];

        for (const chat of chats) {
            try {
                // Verifica se já existe conversa para este chat
                const { findConversationByChat } = await import('../services/supabase.js');
                const existing = await findConversationByChat(chat.id);
                if (existing) { skipped++; continue; }

                // Busca contato
                const attendees = (await getChatAttendees(chat.id)).items || [];
                const rawContact = attendees.find(a => !a.is_self);
                if (!rawContact) { skipped++; continue; }

                const contact = whatsapp.normalizeContact(rawContact);
                const phone = normalizePhone(contact.phone);
                if (!phone) { skipped++; continue; }

                // Cria ou encontra lead
                let lead = await findLeadByPhone(phone);
                if (!lead) {
                    lead = await createLead({
                        name: contact.name || phone,
                        phone,
                        origin: 'whatsapp_import',
                    });
                }

                // Tenta match com Pipedrive
                try {
                    const pdPerson = await findPersonByPhone(phone);
                    if (pdPerson) {
                        await updateLead(lead.id, {
                            crm_person_id: String(pdPerson.id),
                            name: lead.name === phone ? pdPerson.name : lead.name,
                        });
                        // Busca deals
                        const deals = await getDealsForPerson(pdPerson.id);
                        if (deals.length > 0) {
                            await updateLead(lead.id, { crm_deal_id: String(deals[0].id) });
                        }
                    }
                } catch { /* match não crítico */ }

                // Cria conversa
                const conversation = await createConversation({
                    lead_id: lead.id,
                    whatsapp_chat_id: chat.id,
                    channel: 'whatsapp_direct',
                    type: 'prospecting',
                    status: 'in_progress',
                    chatbot_stage: 'human',
                    last_message_at: new Date().toISOString(),
                });

                // Importa últimas mensagens
                const msgs = await getWaMsgs(chat.id, { limit: 30 });
                const items = msgs.items || [];
                const { saveMessage } = await import('../services/supabase.js');

                for (const rawMsg of items) {
                    const msg = whatsapp.normalizeMessage(rawMsg);
                    await saveMessage({
                        conversation_id: conversation.id,
                        direction: msg.direction,
                        sender_type: msg.direction === 'outbound' ? 'human' : 'lead',
                        sender_name: msg.direction === 'outbound' ? 'SDR' : (contact.name || 'Lead'),
                        content: msg.text,
                        attachments: msg.attachments,
                        unipile_message_id: msg.id,
                        created_at: msg.timestamp,
                    });
                }

                imported++;
            } catch (err) {
                errors.push({ chat_id: chat.id, error: err.message });
            }
        }

        res.json({ imported, skipped, errors: errors.slice(0, 5), total_chats: chats.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

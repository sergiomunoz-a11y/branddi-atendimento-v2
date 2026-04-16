/**
 * Branddi Atendimento — App Frontend v2.0.0
 * Multi-usuario com roles SDR / Closer / Admin
 * Melhorias: try/catch por funcao, browser notifications,
 * inbox search client-side, CSV export, window exports completos
 */

const API = '';
let currentConversation = null;
let pollTimer = null;
let chartDay = null, chartOrigin = null, chartClass = null;
let allConversations = [];
let currentFilter = 'all';
let allScripts = [];
let currentScriptCat = '';
let selectedDealId = null; // Deal selecionado no deal picker

// --- Auth State ---
let currentUser = null;

function getToken() {
    return localStorage.getItem('ba_token');
}

function logout() {
    localStorage.removeItem('ba_token');
    localStorage.removeItem('ba_user');
    window.location.href = '/login.html';
}

// --- Browser Notifications ---
let notificationsEnabled = false;

function requestNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
        notificationsEnabled = true;
        return;
    }
    if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(perm => {
            notificationsEnabled = perm === 'granted';
        });
    }
}

function showBrowserNotification(title, body) {
    if (!notificationsEnabled || document.hasFocus()) return;
    try {
        const n = new Notification(title, {
            body,
            icon: '/favicon.ico',
            tag: 'branddi-atendimento',
        });
        n.onclick = () => { window.focus(); n.close(); };
        setTimeout(() => n.close(), 8000);
    } catch { /* ignore */ }
}

// Request permission on first user interaction
document.addEventListener('click', function _reqNotif() {
    requestNotificationPermission();
    document.removeEventListener('click', _reqNotif);
}, { once: true });


// --- Mobile Sidebar ---
function setupMobile() {
    const toggle = document.getElementById('mobile-sidebar-toggle');
    const overlay = document.getElementById('mobile-overlay');
    if (toggle) toggle.addEventListener('click', toggleMobileSidebar);
    if (overlay) overlay.addEventListener('click', closeMobileSidebar);
}

function toggleMobileSidebar() {
    const sidebar = document.querySelector('.inbox-sidebar');
    const overlay = document.getElementById('mobile-overlay');
    if (!sidebar) return;
    const isOpen = sidebar.classList.toggle('mobile-open');
    overlay?.classList.toggle('show', isOpen);
}

function closeMobileSidebar() {
    const sidebar = document.querySelector('.inbox-sidebar');
    const overlay = document.getElementById('mobile-overlay');
    sidebar?.classList.remove('mobile-open');
    overlay?.classList.remove('show');
}

// --- Event Delegation (XSS-safe) ---
function setupEventDelegation() {
    document.body.addEventListener('click', (e) => {
        const el = e.target.closest('[data-action]');
        if (!el) return;
        const action = el.dataset.action;
        const id = el.dataset.id;

        switch (action) {
            case 'select-conversation':
                selectConversation(id);
                closeMobileSidebar();
                break;
            case 'route-conv':
                routeConv(id, el.dataset.team);
                break;
            case 'close-conv':
                closeConv(id);
                break;
            case 'toggle-scripts-menu':
                toggleScriptsMenu();
                break;
            case 'send-msg':
                sendMsg();
                break;
            case 'apply-script':
                applyScript(id);
                break;
            case 'sync-lead':
                syncLeadToPipedrive(id, document.getElementById(`pd-btn-${id}`));
                break;
            case 'edit-script':
                editScript(id);
                break;
            case 'delete-script':
                deleteScript(id);
                break;
            case 'logout':
                logout();
                break;
            case 'edit-user': {
                const user = _cachedUsers.find(u => u.id === el.dataset.userId);
                if (user) openEditUserForm(user);
                break;
            }
            case 'toggle-user':
                toggleUserActive(el.dataset.userId, el.dataset.activate === 'true');
                break;
            case 'open-history':
                e.stopPropagation();
                openHistoryMessages(id, el.dataset.name);
                break;
            case 'chat-tab':
                switchChatTab(el.dataset.tab);
                break;
            case 'save-note':
                saveInternalNote();
                break;
            case 'attach-file':
                document.getElementById('file-input')?.click();
                break;
            case 'remove-attachment':
                removeAttachment();
                break;
            case 'open-deal-contacts':
                openDealContacts(el.dataset.dealId);
                break;
            case 'close-deal-contacts':
                closeDealContactsModal();
                break;
        }
    });
}

// --- Chat Tab Switching ---
function switchChatTab(tab) {
    document.querySelectorAll('.chat-input-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    const msgPanel = document.getElementById('chat-tab-message');
    const notesPanel = document.getElementById('chat-tab-notes');
    if (msgPanel) msgPanel.style.display = tab === 'message' ? '' : 'none';
    if (notesPanel) notesPanel.classList.toggle('active', tab === 'notes');
}

// --- Internal Notes (localStorage) ---
function saveInternalNote() {
    if (!currentConversation) return;
    const input = document.getElementById('chat-notes-input');
    const text = (input?.value || '').trim();
    if (!text) return;
    const key = `ba_notes_${currentConversation.id}`;
    const notes = JSON.parse(localStorage.getItem(key) || '[]');
    notes.push({ text, date: new Date().toISOString(), user: currentUser?.name || 'Admin' });
    localStorage.setItem(key, JSON.stringify(notes));
    input.value = '';
    toast('Anotacao salva', 'success');
    renderConvEvents();
}

function getInternalNotes(convId) {
    return JSON.parse(localStorage.getItem(`ba_notes_${convId}`) || '[]');
}

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
    // Verifica autenticacao
    const token = getToken();
    if (!token) {
        window.location.href = '/login.html';
        return;
    }

    // Carrega dados do usuario
    try {
        const data = await apiFetch('/api/auth/me');
        if (!data || !data.user) throw new Error('Sessao invalida');
        currentUser = data.user;
        localStorage.setItem('ba_user', JSON.stringify(currentUser));
    } catch (err) {
        console.warn('Auth falhou:', err.message);
        localStorage.removeItem('ba_token');
        localStorage.removeItem('ba_user');
        window.location.href = '/login.html';
        return;
    }

    // Inicia a interface — cada setup tem try/catch proprio
    try { setupCurrentUser(); } catch (e) { console.warn('setupCurrentUser:', e); }
    try { setupTabs(); } catch (e) { console.warn('setupTabs:', e); }
    try { setupInboxFilters(); } catch (e) { console.warn('setupInboxFilters:', e); }
    try { setupScriptCats(); } catch (e) { console.warn('setupScriptCats:', e); }
    try { setupScriptForm(); } catch (e) { console.warn('setupScriptForm:', e); }
    try { setupInboxSearch(); } catch (e) { console.warn('setupInboxSearch:', e); }
    try { setupLeadFilters(); } catch (e) { console.warn('setupLeadFilters:', e); }
    try { setupHistoryFilters(); } catch (e) { console.warn('setupHistoryFilters:', e); }
    try { setupDashPeriod(); } catch (e) { console.warn('setupDashPeriod:', e); }

    try { setupEventDelegation(); } catch (e) { console.warn('setupEventDelegation:', e); }
    try { setupMobile(); } catch (e) { console.warn('setupMobile:', e); }

    // Deals tab events
    document.getElementById('btn-send-outbound')?.addEventListener('click', sendOutbound);
    document.getElementById('btn-import-history')?.addEventListener('click', importWhatsAppHistory);
    document.getElementById('deals-search')?.addEventListener('input', debounce(searchDeals, 400));

    // Fix autofill: browser ignora autocomplete=off, limpamos via JS
    document.querySelectorAll('.sidebar-search, .search-input').forEach(el => { el.value = ''; });

    try { loadInbox(); } catch (e) { console.warn('loadInbox:', e); }
    try { startPolling(); } catch (e) { console.warn('startPolling:', e); }
    try { checkHealth(); } catch (e) { console.warn('checkHealth:', e); }
    setInterval(() => { try { checkHealth(); } catch { /* */ } }, 30000);
});


// --- Polling ---
function startPolling() {
    pollTimer = setInterval(() => {
        loadInbox(true); // silent = true (nao reseta selecao)
        if (currentConversation) loadMessages(currentConversation.id, currentConversation.whatsapp_chat_id);
    }, 7000);
}

// --- Health Check ---
async function checkHealth() {
    try {
        const data = await apiFetch('/api/health');
        const dot  = document.getElementById('status-dot');
        if (!dot) return;
        const waOk = data.services?.unipile;
        const rawStatus = data.services?.waStatus || 'unknown';

        dot.className = 'status-dot ' + (waOk ? 'online' : 'offline');
        dot.title = waOk ? 'WhatsApp conectado' :
            (rawStatus === 'CREDENTIALS' || rawStatus === 'error') ? 'WhatsApp desconectado — reconecte' :
            'WhatsApp offline';

        if (!waOk && (rawStatus === 'CREDENTIALS' || rawStatus === 'error')) {
            dot.style.animation = 'pulse-warn 1s infinite';
        }
    } catch {
        const dot = document.getElementById('status-dot');
        if (dot) { dot.className = 'status-dot offline'; dot.title = 'Servidor offline'; }
    }
}

// --- Tabs ---
function setupTabs() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            switchTab(btn.dataset.tab);
        });
    });
}

function switchTab(tab) {
    document.querySelectorAll('.nav-btn[data-tab]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    const btn = document.querySelector(`.nav-btn[data-tab="${tab}"]`);
    if (btn) btn.classList.add('active');
    document.getElementById(`panel-${tab}`)?.classList.add('active');
    if (tab === 'dashboard') loadDashboard();
    if (tab === 'scripts') loadScripts();
    if (tab === 'leads') loadLeads();
    if (tab === 'history') setTimeout(loadHistory, 100);
    if (tab === 'deals') loadDeals();
}

// --- INBOX ---

// Estado da aba de tipo selecionada
let currentTypeFilter = 'all'; // 'all' | 'inbound' | 'prospecting'
let inboxSearchTerm = '';

function setupInboxFilters() {
    // Filtros de status
    document.querySelectorAll('.filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            currentFilter = chip.dataset.filter;
            renderConversationList();
        });
    });

    // Filtro por usuário (Admin only)
    const userFilterEl = document.getElementById('inbox-user-filter');
    if (userFilterEl && currentUser?.role === 'Admin') {
        userFilterEl.style.display = '';
        userFilterEl.addEventListener('change', () => loadInbox());
        // Popula lista de usuários
        apiFetch('/api/users').then(data => {
            const users = data.users || [];
            userFilterEl.innerHTML = '<option value="">Todos os usuários</option>' +
                users.map(u => `<option value="${u.id}">${escHtml(u.name)} (${u.role})</option>`).join('');
        }).catch(() => {});
    }

    // Abas de tipo (Inbound / Prospeccao)
    document.querySelectorAll('.type-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.type-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentTypeFilter = tab.dataset.type;
            loadInbox();
        });
    });

    // Controle de visibilidade das abas por permissions
    if (currentUser && currentUser.role !== 'Admin') {
        const tabAll = document.getElementById('type-tab-all');
        const tabInbound = document.getElementById('type-tab-inbound');
        const tabProspecting = document.getElementById('type-tab-prospecting');
        const perms = currentUser.permissions || {};
        const allowedTypes = perms.conversation_types || [];

        if (allowedTypes.length > 0) {
            const hasInbound = allowedTypes.includes('inbound');
            const hasProspecting = allowedTypes.includes('prospecting');

            if (hasInbound && hasProspecting) {
                // Ambos — mostra tudo normalmente
            } else if (hasInbound) {
                if (tabAll) tabAll.style.display = 'none';
                if (tabProspecting) tabProspecting.style.display = 'none';
                if (tabInbound) { tabInbound.classList.add('active'); currentTypeFilter = 'inbound'; }
            } else if (hasProspecting) {
                if (tabAll) tabAll.style.display = 'none';
                if (tabInbound) tabInbound.style.display = 'none';
                if (tabProspecting) { tabProspecting.classList.add('active'); currentTypeFilter = 'prospecting'; }
            }
        }
        // Sem permissions definidas = vê tudo (filtro é por assigned_user_id no backend)
    }
}

function setupInboxSearch() {
    const searchInput = document.getElementById('inbox-search');
    if (!searchInput) return;
    searchInput.addEventListener('input', debounce(() => {
        inboxSearchTerm = (searchInput.value || '').trim().toLowerCase();
        renderConversationList();
    }, 300));
}

function setInboxFilter(filter) {
    currentFilter = filter;
    document.querySelectorAll('.filter-chip').forEach(c => {
        c.classList.toggle('active', c.dataset.filter === filter);
    });
    renderConversationList();
}

function setInboxType(type) {
    currentTypeFilter = type;
    document.querySelectorAll('.type-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.type === type);
    });
    loadInbox();
}


let _lastInboxHash = '';

async function loadInbox(silent = false) {
    try {
        const typeParam = currentTypeFilter !== 'all' ? `&type=${currentTypeFilter}` : '';
        const userFilter = document.getElementById('inbox-user-filter')?.value;
        const userParam = userFilter ? `&filter_user_id=${userFilter}` : '';
        const data = await apiFetch(`/api/inbox?limit=100${typeParam}${userParam}`);
        const newConversations = data.conversations || [];

        // Hash rápido para detectar mudanças e evitar re-render desnecessário (flicker)
        const newHash = JSON.stringify(newConversations.map(c => `${c.id}:${c.status}:${c.unread_count}:${c.last_message?.created_at}`));
        if (silent && newHash === _lastInboxHash) return; // Nada mudou
        _lastInboxHash = newHash;

        const prevIds = new Set(allConversations.map(c => c.id));
        allConversations = newConversations;

        if (silent) {
            const newConvs = allConversations.filter(c => !prevIds.has(c.id));
            if (newConvs.length > 0) {
                const leadName = newConvs[0].leads?.name || 'Lead';
                showNewMsgNotif(`Nova conversa: ${leadName}`);
                showBrowserNotification('Branddi Atendimento', `Nova conversa: ${leadName}`);
            }
        }

        renderConversationList();
        updateInboxBadge();
    } catch (err) {
        if (!silent) console.error('Inbox error:', err);
    }
}


function renderConversationList() {
    const list = document.getElementById('conversation-list');
    let filtered = allConversations;

    if (currentFilter !== 'all') {
        if (currentFilter === 'waiting') filtered = filtered.filter(c => c.status === 'waiting');
        else if (currentFilter === 'comercial') filtered = filtered.filter(c => c.assigned_to === 'comercial' || c.leads?.classification === 'comercial');
        else if (currentFilter === 'opec') filtered = filtered.filter(c => c.assigned_to === 'opec' || c.leads?.classification === 'opec');
    }

    // Client-side search
    if (inboxSearchTerm) {
        filtered = filtered.filter(c => {
            const lead = c.leads || {};
            const haystack = [
                lead.name || '',
                lead.company_name || '',
                lead.phone || '',
            ].join(' ').toLowerCase();
            return haystack.includes(inboxSearchTerm);
        });
    }

    if (filtered.length === 0) {
        list.innerHTML = '<div class="empty-state-pro"><div class="empty-illustration"><svg class="icon"><use href="/icons.svg#icon-inbox"></use></svg></div><h4 class="empty-title">Nenhuma conversa</h4><p class="empty-desc">As novas conversas aparecer\u00e3o aqui automaticamente</p></div>';
        return;
    }

    list.innerHTML = filtered.map(conv => {
        const lead = conv.leads || {};
        const name = lead.name || formatPhone(lead.phone) || 'Desconhecido';
        const preview = conv.last_message?.content ? truncate(conv.last_message.content, 55) : '...';
        const time = conv.last_message ? relativeTime(conv.last_message.created_at) : relativeTime(conv.created_at);
        const isActive = currentConversation?.id === conv.id;
        const hasUnread = (conv.unread_count || 0) > 0;
        const convType = conv.type || 'inbound';
        const typeLabel = convType === 'prospecting' ? '🚀 Prospeccao' : '📥 Inbound';

        return `<div class="conv-item${isActive ? ' active' : ''}${hasUnread ? ' unread' : ''}" data-id="${conv.id}" data-action="select-conversation">
            <div class="conv-item-top">
                <span class="conv-name">${escHtml(name)}</span>
                <span class="conv-time">${time}</span>
            </div>
            <div class="conv-preview">${escHtml(preview)}</div>
            ${hasUnread ? `<div class="conv-tags"><span class="tag tag-unread">${conv.unread_count} nova${conv.unread_count > 1 ? 's' : ''}</span></div>` : ''}
        </div>`;
    }).join('');
}

function updateInboxBadge() {
    const waiting = allConversations.filter(c => c.status === 'waiting').length;
    const badge   = document.getElementById('badge-inbox');
    if (badge) {
        badge.textContent = waiting;
        badge.classList.toggle('show', waiting > 0);
    }
}

async function selectConversation(convId) {
    currentConversation = allConversations.find(c => c.id === convId);
    if (!currentConversation) return;

    _lastMessagesHash = ''; // Reset ao mudar de conversa
    renderConversationList();
    renderChatArea(currentConversation);
    renderLeadPanel(currentConversation);
    await loadMessages(convId, currentConversation.whatsapp_chat_id);
}

// --- Chat Area ---

function renderChatArea(conv) {
    const lead = conv.leads || {};
    const name = lead.name || formatPhone(lead.phone) || 'Desconhecido';
    const initials = name.split(' ').slice(0,2).map(w => w[0]).join('').toUpperCase();
    const cls = lead.classification || 'unclassified';

    const area = document.getElementById('chat-area');
    area.innerHTML = `
        <div class="chat-header">
            <div class="chat-header-left">
                <div class="chat-avatar">${initials}</div>
                <div>
                    <div class="chat-meta-name">${escHtml(name)}</div>
                    <div class="chat-meta-sub">${lead.company_name ? escHtml(lead.company_name) + ' · ' : ''}${classLabel(cls)}</div>
                </div>
            </div>
            <div class="chat-header-actions">
                <button class="btn-sm" data-action="route-conv" data-id="${conv.id}" data-team="comercial">→ Comercial</button>
                <button class="btn-sm" data-action="route-conv" data-id="${conv.id}" data-team="opec">→ OPEC</button>
                <button class="btn-sm" data-action="close-conv" data-id="${conv.id}">✕ Fechar</button>
            </div>
        </div>
        <div class="messages-wrap" id="messages-wrap">
            <div class="empty-state" style="padding:40px 0"><span>Carregando mensagens...</span></div>
        </div>
        <div class="chat-input-tabs">
            <button class="chat-input-tab active" data-action="chat-tab" data-tab="message">Mensagem</button>
            <button class="chat-input-tab" data-action="chat-tab" data-tab="notes">Anotacoes internas</button>
        </div>
        <div class="chat-input-wrap" id="chat-tab-message">
            <div class="chat-input-toolbar">
                <div class="scripts-dropdown" id="scripts-dropdown">
                    <button class="scripts-trigger" data-action="toggle-scripts-menu">📋 Scripts ▾</button>
                    <div class="scripts-menu" id="scripts-menu"></div>
                </div>
            </div>
            <div class="chat-attach-preview" id="attach-preview" style="display:none">
                <div class="attach-preview-content" id="attach-preview-content"></div>
                <button class="attach-remove-btn" data-action="remove-attachment" title="Remover">✕</button>
            </div>
            <div class="chat-input-row">
                <button class="attach-btn" data-action="attach-file" title="Anexar arquivo">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
                    </svg>
                </button>
                <textarea class="chat-textarea" id="chat-input" placeholder="Digite sua mensagem..." rows="1"
                    onkeydown="handleInputKey(event)"></textarea>
                <button class="send-btn" data-action="send-msg">▶</button>
                <input type="file" id="file-input" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx" style="display:none">
            </div>
        </div>
        <div class="chat-notes-area" id="chat-tab-notes">
            <textarea class="chat-notes-textarea" id="chat-notes-input" placeholder="Escreva uma anotacao interna sobre esta conversa..."></textarea>
            <div class="chat-notes-actions">
                <button class="btn-sm btn-primary" data-action="save-note">Salvar anotacao</button>
            </div>
        </div>
    `;

    loadScriptsForMenu();
    autoResizeTextarea(document.getElementById('chat-input'));
    setupFileAttachment();
}

let _lastMessagesHash = '';

async function loadMessages(convId, chatId) {
    try {
        const data = await apiFetch(`/api/messages/${convId}`);
        const msgs = data.messages || [];
        const wrap = document.getElementById('messages-wrap');
        if (!wrap) return;

        // Hash check — evita re-render se nada mudou (elimina flicker do polling)
        const newHash = msgs.map(m => `${m.id}:${m.created_at}`).join('|');
        if (newHash === _lastMessagesHash) return;
        _lastMessagesHash = newHash;

        if (msgs.length === 0) {
            wrap.textContent = '';
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.textContent = 'Nenhuma mensagem ainda';
            wrap.appendChild(empty);
            return;
        }

        // Deduplica: se bot e atendente enviaram msg com mesmo conteúdo (polling salva duplicata),
        // mantém apenas a versão bot para evitar bolha duplicada
        const deduped = [];
        const botContents = new Set();
        for (const m of msgs) {
            if (m.sender_type === 'bot' && m.content) {
                botContents.add(m.content.trim());
            }
        }
        for (const m of msgs) {
            // Pula mensagem outbound/human que é duplicata de uma mensagem bot
            if (m.sender_type !== 'bot' && m.direction === 'outbound' && m.content && botContents.has(m.content.trim())) {
                continue;
            }
            deduped.push(m);
        }

        wrap.innerHTML = deduped.map(renderMessage).join('');
        wrap.scrollTop = wrap.scrollHeight;
    } catch (err) {
        console.error('Messages error:', err);
    }
}

function renderMessage(msg) {
    const isBot    = msg.sender_type === 'bot';
    const isOut    = msg.direction === 'outbound';
    const cls      = isBot ? 'bot' : (isOut ? 'outbound' : 'inbound');
    const time     = formatTime(msg.created_at);

    // Nome do remetente: bot, nome do usuário que enviou, ou nada para lead
    let sender = '';
    if (isBot) {
        sender = '🤖 Bot';
    } else if (isOut) {
        sender = msg.sent_by_name || msg.sender_name || 'Equipe';
    }

    // Renderiza attachments (imagens, vídeos, documentos)
    let attachmentsHtml = '';
    const atts = msg.attachments || [];
    for (const att of atts) {
        const uri = att.uri || att.url || '';
        const mime = (att.mime_type || att.type || '').toLowerCase();
        const name = att.name || att.filename || 'arquivo';

        // Monta URL do proxy
        let proxyUrl = '';
        if (uri.startsWith('att://')) {
            const path = uri.replace('att://', '').split('/').slice(1).join('/');
            proxyUrl = `/api/attachments/${path}`;
        } else if (uri.startsWith('http')) {
            proxyUrl = uri;
        }

        if (!proxyUrl) continue;

        if (mime.startsWith('image/')) {
            attachmentsHtml += `<div class="msg-attachment msg-image">
                <img src="${proxyUrl}" alt="${escHtml(name)}" loading="lazy" onclick="window.open(this.src,'_blank')">
            </div>`;
        } else if (mime.startsWith('video/')) {
            attachmentsHtml += `<div class="msg-attachment msg-video">
                <video src="${proxyUrl}" controls preload="metadata" style="max-width:100%;border-radius:8px;"></video>
            </div>`;
        } else if (mime.startsWith('audio/') || mime === 'audio/ogg; codecs=opus') {
            attachmentsHtml += `<div class="msg-attachment msg-audio">
                <audio src="${proxyUrl}" controls preload="metadata" style="width:100%;"></audio>
            </div>`;
        } else {
            attachmentsHtml += `<div class="msg-attachment msg-file">
                <a href="${proxyUrl}" target="_blank" rel="noopener" class="file-link">📎 ${escHtml(name)}</a>
            </div>`;
        }
    }

    // Conteúdo de texto com links clicáveis
    const textContent = msg.content ? linkify(escHtml(msg.content)) : (atts.length ? '' : '(mídia)');

    return `<div class="msg-bubble ${cls}">
        ${attachmentsHtml}
        ${textContent ? `<div class="msg-text">${textContent}</div>` : ''}
        <div class="msg-meta">
            ${sender ? `<span class="msg-sender${isBot ? ' bot-label' : ''}">${escHtml(sender)}</span>` : ''}
            <span class="msg-time">${time}</span>
        </div>
    </div>`;
}

function linkify(text) {
    // Converte URLs em links clicáveis (já recebe HTML escaped)
    return text.replace(
        /https?:\/\/[^\s&lt;&quot;]+/g,
        url => {
            // Desescapa para obter a URL real
            const realUrl = url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
            const display = realUrl.length > 50 ? realUrl.substring(0, 47) + '...' : realUrl;
            return `<a href="${realUrl}" target="_blank" rel="noopener" class="msg-link">${display}</a>`;
        }
    );
}

// --- File Attachment ---
let _pendingFile = null;

function setupFileAttachment() {
    const fileInput = document.getElementById('file-input');
    if (!fileInput) return;

    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (!file) return;
        if (file.size > 16 * 1024 * 1024) {
            toast('Arquivo muito grande (máx 16MB)', 'error');
            fileInput.value = '';
            return;
        }
        _pendingFile = file;
        showAttachPreview(file);
    });
}

function showAttachPreview(file) {
    const preview = document.getElementById('attach-preview');
    const content = document.getElementById('attach-preview-content');
    if (!preview || !content) return;

    const mime = file.type || '';
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);

    if (mime.startsWith('image/')) {
        const url = URL.createObjectURL(file);
        content.innerHTML = `<img src="${url}" class="attach-thumb"><span class="attach-name">${escHtml(file.name)} (${sizeMB}MB)</span>`;
    } else if (mime.startsWith('video/')) {
        content.innerHTML = `<span class="attach-icon">🎬</span><span class="attach-name">${escHtml(file.name)} (${sizeMB}MB)</span>`;
    } else if (mime.startsWith('audio/')) {
        content.innerHTML = `<span class="attach-icon">🎵</span><span class="attach-name">${escHtml(file.name)} (${sizeMB}MB)</span>`;
    } else {
        content.innerHTML = `<span class="attach-icon">📎</span><span class="attach-name">${escHtml(file.name)} (${sizeMB}MB)</span>`;
    }
    preview.style.display = 'flex';
}

function removeAttachment() {
    _pendingFile = null;
    const preview = document.getElementById('attach-preview');
    const fileInput = document.getElementById('file-input');
    if (preview) preview.style.display = 'none';
    if (fileInput) fileInput.value = '';
}

async function sendMsg() {
    const input = document.getElementById('chat-input');
    const text  = (input?.value || '').trim();
    if (!text && !_pendingFile) return;
    if (!currentConversation) return;

    const chatId = currentConversation.whatsapp_chat_id || null;

    input.value = '';
    input.style.height = '';

    try {
        let res;

        if (_pendingFile) {
            // Envia com mídia via FormData
            const fd = new FormData();
            fd.append('file', _pendingFile);
            if (text) fd.append('text', text);
            if (chatId) fd.append('chatId', chatId);

            const response = await fetch(`/api/messages/${currentConversation.id}/send-media`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${getToken()}` },
                body: fd,
            });
            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || 'Erro ao enviar mídia');
            }
            res = await response.json();
            removeAttachment();
        } else {
            // Envio de texto normal
            res = await apiFetch(`/api/messages/${currentConversation.id}/send`, {
                method: 'POST', body: JSON.stringify({ text, chatId }),
            });
        }

        // Se o chat foi iniciado agora, atualiza o chatId na conversa local
        if (res.chat_started && !currentConversation.whatsapp_chat_id) {
            await loadInbox();
            currentConversation = allConversations.find(c => c.id === currentConversation.id) || currentConversation;
        }

        _lastMessagesHash = ''; // Força reload das mensagens
        await loadMessages(currentConversation.id);
    } catch (err) {
        toast(`Erro ao enviar: ${err.message}`, 'error');
    }
}

function sendMessage() { return sendMsg(); }

function handleInputKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMsg();
    }
}

function autoResizeTextarea(el) {
    if (!el) return;
    el.addEventListener('input', () => {
        el.style.height = '';
        el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    });
}

// --- Scripts Menu ---

async function loadScriptsForMenu() {
    try {
        const data = await apiFetch('/api/scripts');
        allScripts = data.scripts || [];
        renderScriptsMenu();
    } catch { /* silencioso */ }
}

function renderScriptsMenu() {
    const menu = document.getElementById('scripts-menu');
    if (!menu) return;

    if (allScripts.length === 0) {
        menu.innerHTML = `<div style="padding:12px;text-align:center;color:var(--text-muted);font-size:12px">Nenhum script</div>`;
        return;
    }

    menu.innerHTML = allScripts.map(s => `
        <div class="scripts-menu-item" data-action="apply-script" data-id="${s.id}">
            <div class="script-item-title">${escHtml(s.title)}</div>
            <div class="script-item-preview">${escHtml(truncate(s.content, 60))}</div>
        </div>
    `).join('');
}

function toggleScriptsMenu() {
    document.getElementById('scripts-menu')?.classList.toggle('open');
}

document.addEventListener('click', e => {
    if (!e.target.closest('.scripts-dropdown')) {
        document.getElementById('scripts-menu')?.classList.remove('open');
    }
});

async function applyScript(scriptId) {
    const script = allScripts.find(s => s.id === scriptId);
    if (!script || !currentConversation) return;

    document.getElementById('scripts-menu')?.classList.remove('open');

    const chatId = currentConversation.whatsapp_chat_id;
    if (!chatId) { toast('Conversa sem chat ID', 'error'); return; }

    try {
        await apiFetch(`/api/messages/${currentConversation.id}/script`, {
            method: 'POST',
            body: JSON.stringify({
                script_content: script.content,
                chatId,
                lead_id: currentConversation.lead_id,
            }),
        });
        toast(`Script enviado: ${script.title}`, 'success');
        await loadMessages(currentConversation.id);
    } catch (err) {
        toast(`Erro: ${err.message}`, 'error');
    }
}

// --- Lead Panel ---

function renderLeadPanel(conv) {
    const lead = conv.leads || {};
    const name = lead.name || formatPhone(lead.phone) || 'Desconhecido';
    const initial = name.charAt(0).toUpperCase();
    const convType = conv.type || 'inbound';
    const typeLabel = convType === 'prospecting' ? '🚀 Prospeccao' : '📥 Inbound';

    // Mostra o content, esconde o empty
    const emptyEl = document.getElementById('lead-panel-empty');
    const contentEl = document.getElementById('lead-panel-content');
    if (emptyEl) emptyEl.style.display = 'none';
    if (contentEl) contentEl.style.display = 'flex';

    // Preenche info do lead
    const avatarEl = document.getElementById('lp-avatar');
    if (avatarEl) avatarEl.textContent = initial;
    const nameEl = document.getElementById('lp-name');
    if (nameEl) nameEl.textContent = name;
    const phoneEl = document.getElementById('lp-phone');
    if (phoneEl) phoneEl.textContent = formatPhone(lead.phone);
    const compEl = document.getElementById('lp-company');
    if (compEl) {
        compEl.textContent = lead.company_name || '';
        compEl.style.display = lead.company_name ? '' : 'none';
    }

    // Badge de tipo — clicável para Admin (alterna inbound/prospecting)
    const typeBadge = document.getElementById('lp-type-badge');
    if (typeBadge) {
        const labels = { inbound: 'Inbound', prospecting: 'Prospeccao' };
        typeBadge.textContent = labels[convType] || convType;
        typeBadge.className = `conv-type-badge ${convType}`;

        if (currentUser?.role === 'Admin') {
            typeBadge.classList.add('clickable');
            typeBadge.title = 'Clique para alterar tipo';
            typeBadge.onclick = async () => {
                const newType = convType === 'inbound' ? 'prospecting' : 'inbound';
                await apiFetch(`/api/inbox/${conv.id}/type`, {
                    method: 'PATCH',
                    body: JSON.stringify({ type: newType }),
                });
                conv.type = newType;
                renderLeadPanel(conv);
                loadInbox();
                toast(`Tipo alterado para ${labels[newType]}`, 'success');
            };
        } else {
            typeBadge.classList.remove('clickable');
            typeBadge.onclick = null;
            typeBadge.title = '';
        }
    }

    // Busca TODOS os deals vinculados ao telefone no Pipedrive
    selectedDealId = null;
    loadDealsForLead(lead, conv);

    // Atividades ficam escondidas até um deal ser selecionado
    const actSection = document.getElementById('lp-activities-section');
    if (actSection) actSection.style.display = 'none';

    // Botao criar deal
    const btnCreateDeal = document.getElementById('btn-create-deal-lp');
    if (btnCreateDeal) {
        btnCreateDeal.onclick = () => syncLeadPanelPipedrive(lead.id, conv.id);
    }

    // Botao sync Pipedrive
    const btnSync = document.getElementById('btn-sync-pipedrive-lp');
    if (btnSync) {
        btnSync.onclick = () => syncLeadPanelPipedrive(lead.id, conv.id);
    }

    // --- Populate new sections ---
    // Sobre a conversa
    const convIdEl = document.getElementById('lp-conv-id');
    if (convIdEl) convIdEl.textContent = conv.id?.substring(0, 8) || '—';
    const convStatusEl = document.getElementById('lp-conv-status');
    if (convStatusEl) {
        const statusMap = { waiting: 'Aguardando', in_progress: 'Em andamento', routed: 'Roteado', closed: 'Fechado' };
        convStatusEl.textContent = statusMap[conv.status] || conv.status || '—';
    }
    const convOriginEl = document.getElementById('lp-conv-origin');
    if (convOriginEl) {
        const originMap = { form: 'Formulario', whatsapp_direct: 'WhatsApp Direto', prospecting: 'Prospeccao' };
        convOriginEl.textContent = originMap[lead.origin] || lead.origin || '—';
    }
    const convAssignedEl = document.getElementById('lp-conv-assigned');
    if (convAssignedEl) convAssignedEl.textContent = conv.assigned_to || 'Nao atribuido';
    const convCreatedEl = document.getElementById('lp-conv-created');
    if (convCreatedEl) convCreatedEl.textContent = conv.created_at ? formatDate(conv.created_at) : '—';

    // Tags
    const tagsEl = document.getElementById('lp-tags');
    if (tagsEl) {
        const tags = [];
        if (lead.classification) tags.push(`<span class="lp-tag tag-${lead.classification}">${classLabel(lead.classification)}</span>`);
        if (conv.type) tags.push(`<span class="lp-tag tag-${conv.type === 'prospecting' ? 'wa' : 'form'}">${conv.type === 'prospecting' ? 'Prospeccao' : 'Inbound'}</span>`);
        if (conv.status === 'waiting') tags.push('<span class="lp-tag tag-waiting">Aguardando</span>');
        tagsEl.innerHTML = tags.length ? tags.join('') : '<span class="lp-muted">Sem tags</span>';
    }

    // Edição inline de contato
    setupInlineEdit(lead, conv);

    // Historico de conversas do lead
    renderLeadHistory(lead.id, conv.id);

    // Eventos da conversa
    renderConvEvents();

    renderScriptsPanelList();
}

// --- Inline Edit de contato ---
function setupInlineEdit(lead, conv) {
    document.querySelectorAll('.lp-edit-btn').forEach(btn => {
        btn.onclick = () => {
            const field = btn.dataset.field;
            const wrap = btn.parentElement;
            const span = wrap.querySelector('span');
            const currentVal = field === 'phone' ? (lead.phone || '') :
                               field === 'name' ? (lead.name || '') :
                               (lead.company_name || '');

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'lp-inline-input';
            input.value = currentVal;
            if (field === 'phone') input.placeholder = '31971335127';
            if (field === 'name') input.placeholder = 'Nome do contato';
            if (field === 'company_name') input.placeholder = 'Empresa';

            span.style.display = 'none';
            btn.style.display = 'none';
            wrap.insertBefore(input, btn);
            input.focus();
            input.select();

            let _saving = false;
            const save = async () => {
                if (_saving) return;
                _saving = true;
                const newVal = input.value.trim();
                if (newVal && newVal !== currentVal) {
                    try {
                        await apiFetch(`/api/leads/${lead.id}`, {
                            method: 'PUT',
                            body: JSON.stringify({ [field]: newVal }),
                        });
                        lead[field] = newVal;
                        toast('Contato atualizado', 'success');
                        renderLeadPanel(conv);
                        loadInbox();
                    } catch (err) {
                        toast('Erro: ' + err.message, 'error');
                        _saving = false;
                    }
                }
                cancel();
            };

            const cancel = () => {
                if (input.parentElement) input.remove();
                span.style.display = '';
                btn.style.display = '';
            };

            input.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); save(); }
                if (e.key === 'Escape') cancel();
            });
            // Blur: save only after small delay (avoid saving partial value on accidental click)
            input.addEventListener('blur', () => setTimeout(() => { if (!_saving) save(); }, 200));
        };
    });
}

// --- Lead History (other conversations of the same lead) ---
async function renderLeadHistory(leadId, currentConvId) {
    const el = document.getElementById('lp-history-list');
    if (!el || !leadId) return;
    const otherConvs = allConversations.filter(c => c.lead_id === leadId && c.id !== currentConvId);
    if (otherConvs.length === 0) {
        el.innerHTML = '<span class="lp-muted">Nenhuma conversa anterior</span>';
        return;
    }
    el.innerHTML = otherConvs.map(c => {
        const statusMap = { waiting: 'Aguardando', in_progress: 'Andamento', routed: 'Roteado', closed: 'Fechado' };
        return `<div class="lp-history-item" data-action="select-conversation" data-id="${c.id}">
            <span>${formatDate(c.created_at)}</span>
            <span class="lp-history-status tag-${c.status === 'waiting' ? 'waiting' : 'form'}">${statusMap[c.status] || c.status}</span>
        </div>`;
    }).join('');
}

// --- Conversation Events Timeline ---
function renderConvEvents() {
    const el = document.getElementById('lp-events-list');
    if (!el || !currentConversation) return;
    const conv = currentConversation;
    const events = [];

    // Created
    if (conv.created_at) events.push({ text: 'Conversa criada', time: conv.created_at });
    // Routed
    if (conv.assigned_to) events.push({ text: `Atribuida a ${conv.assigned_to}`, time: conv.updated_at || conv.created_at });
    // Internal notes
    const notes = getInternalNotes(conv.id);
    notes.forEach(n => events.push({ text: `Nota: ${n.text.substring(0, 40)}${n.text.length > 40 ? '...' : ''}`, time: n.date }));

    events.sort((a, b) => new Date(b.time) - new Date(a.time));

    if (events.length === 0) {
        el.innerHTML = '<span class="lp-muted">Nenhum evento registrado</span>';
        return;
    }
    el.innerHTML = events.map(ev => `
        <div class="lp-event">
            <div class="lp-event-dot"></div>
            <div>
                <div>${escHtml(ev.text)}</div>
                <div class="lp-event-time">${formatDate(ev.time)}</div>
            </div>
        </div>
    `).join('');
}

async function syncLeadPanelPipedrive(leadId, convId) {
    try {
        await apiFetch(`/api/leads/${leadId}/sync-crm`, { method: 'POST' });
        toast('Lead sincronizado com Pipedrive!', 'success');
        await loadInbox();
        const refreshed = allConversations.find(c => c.id === convId);
        if (refreshed) renderLeadPanel(refreshed);
    } catch (err) {
        toast(`Erro: ${err.message}`, 'error');
    }
}

async function loadDealsForLead(lead, conv) {
    const loading  = document.getElementById('lp-deal-loading');
    const picker   = document.getElementById('lp-deal-picker');
    const notfound = document.getElementById('lp-deal-notfound');
    const listEl   = document.getElementById('lp-deal-list');

    const hintEl = document.getElementById('lp-deal-hint');

    if (loading) loading.style.display   = '';
    if (picker) picker.style.display     = 'none';
    if (notfound) notfound.style.display = 'none';
    if (hintEl) hintEl.style.display     = '';

    try {
        const data = await apiFetch(`/api/leads/${lead.id}/deals`);
        const deals = data?.deals || [];
        const persons = data?.persons || [];
        const labelOptions = data?.label_options || [];

        // Renderiza labels do person (primeiro person encontrado)
        renderPersonLabels(lead, persons, labelOptions);

        if (deals.length === 0) {
            if (notfound) notfound.style.display = '';
            return;
        }

        // Renderiza lista de deals como cards clicáveis
        if (listEl) {
            listEl.innerHTML = deals.map(d => {
                const statusBadge = d.status === 'won' ? 'deal-won'
                    : d.status === 'lost' ? 'deal-lost' : 'deal-open';
                return `
                    <div class="deal-picker-item" data-deal-id="${d.id}" data-deal-title="${escHtml(d.title)}">
                        <div class="deal-picker-radio"></div>
                        <div class="deal-picker-info">
                            <div class="deal-picker-title">${escHtml(d.title)}</div>
                            <div class="deal-picker-meta">
                                <span class="deal-stage-badge">${escHtml(d.stage_name)}</span>
                                <span class="deal-status-badge ${statusBadge}">${d.status}</span>
                            </div>
                            ${d.person_name ? `<div class="deal-picker-person">${escHtml(d.person_name)}</div>` : ''}
                        </div>
                        <a href="${d.link}" target="_blank" class="deal-picker-link" title="Ver no Pipedrive" onclick="event.stopPropagation()">↗</a>
                    </div>`;
            }).join('');

            // Event delegation para seleção de deal
            listEl.onclick = (e) => {
                const item = e.target.closest('.deal-picker-item');
                if (!item) return;
                selectDeal(item, lead, conv);
            };
        }

        if (picker) picker.style.display = '';

        // Auto-seleciona se só tem 1 deal, ou se lead.crm_deal_id bate com um deal
        if (deals.length === 1) {
            const firstItem = listEl?.querySelector('.deal-picker-item');
            if (firstItem) selectDeal(firstItem, lead, conv);
        } else if (lead.crm_deal_id) {
            const matchItem = listEl?.querySelector(`[data-deal-id="${lead.crm_deal_id}"]`);
            if (matchItem) selectDeal(matchItem, lead, conv);
        }
    } catch {
        if (notfound) notfound.style.display = '';
    } finally {
        if (loading) loading.style.display = 'none';
    }
}

function selectDeal(itemEl, lead, conv) {
    selectedDealId = itemEl.dataset.dealId;
    const dealTitle = itemEl.dataset.dealTitle;

    const listEl = document.getElementById('lp-deal-list');
    const hintEl = document.getElementById('lp-deal-hint');

    // Colapsa lista — mostra só o deal selecionado em modo compacto
    if (listEl) {
        listEl.innerHTML = `
            <div class="deal-selected-compact">
                <div class="deal-selected-info">
                    <div class="deal-picker-title">${escHtml(dealTitle)}</div>
                    <div class="deal-picker-meta"><span class="deal-stage-badge">#${selectedDealId}</span></div>
                </div>
                <a href="https://brandmonitor.pipedrive.com/deal/${selectedDealId}" target="_blank" class="deal-picker-link" title="Ver no Pipedrive">↗</a>
                <button class="btn-deal-change" id="btn-deal-change" title="Alterar deal">Alterar</button>
            </div>`;

        // Botão "Alterar" recarrega a lista completa
        const btnChange = document.getElementById('btn-deal-change');
        if (btnChange) {
            btnChange.onclick = (e) => {
                e.stopPropagation();
                loadDealsForLead(lead, conv);
            };
        }
    }
    if (hintEl) hintEl.style.display = 'none';

    // Mostra seção de atividades
    const actSection = document.getElementById('lp-activities-section');
    if (actSection) actSection.style.display = '';

    // Esconde "Nenhum deal vinculado"
    const notfound = document.getElementById('lp-deal-notfound');
    if (notfound) notfound.style.display = 'none';

    setupActivityButtons(conv, lead);
}

function setupActivityButtons(conv, lead) {
    const btnNote = document.getElementById('btn-act-note');
    if (btnNote) btnNote.onclick = () => createDealNote(conv, lead);
}

async function createDealNote(conv, lead) {
    if (!selectedDealId) {
        toast('Selecione um deal primeiro', 'warning');
        return;
    }
    const btn = document.getElementById('btn-act-note');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Salvando...'; }
    try {
        await apiFetch(`/api/leads/${lead.id}/notes`, {
            method: 'POST',
            body: JSON.stringify({ conversation_id: conv.id, deal_id: selectedDealId }),
        });
        toast(`Anotação com transcrição salva no Deal #${selectedDealId}!`, 'success');
    } catch (err) {
        toast(`Erro: ${err.message}`, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '📝 Salvar transcrição como anotação'; }
    }
}


// --- Pipedrive Person Labels ---

function renderPersonLabels(lead, persons, labelOptions) {
    const container = document.getElementById('lp-labels-container');
    const section = document.getElementById('lp-labels-section');
    if (!container) return;

    if (!persons || persons.length === 0) {
        container.innerHTML = '<span class="lp-muted">Número não encontrado no Pipedrive</span>';
        return;
    }

    // Usa o primeiro person (mais relevante)
    const person = persons[0];
    const currentLabelIds = person.label_ids || [];

    const colorMap = { blue: '#3B82F6', red: '#EF4444', yellow: '#EAB308', purple: '#A855F7', 'dark-gray': '#6B7280', green: '#22C55E' };

    container.innerHTML = labelOptions.map(opt => {
        const active = currentLabelIds.includes(opt.id);
        const color = colorMap[opt.color] || '#6B7280';
        return `<button class="pd-label-btn${active ? ' active' : ''}" data-label-id="${opt.id}" data-person-id="${person.id}" style="--label-color: ${color}">
            ${escHtml(opt.label)}
        </button>`;
    }).join('');

    // Click handler — toggle label
    container.onclick = async (e) => {
        const btn = e.target.closest('.pd-label-btn');
        if (!btn) return;

        const labelId = parseInt(btn.dataset.labelId);
        const personId = parseInt(btn.dataset.personId);
        const isActive = btn.classList.contains('active');

        // Toggle
        let newLabelIds;
        if (isActive) {
            newLabelIds = currentLabelIds.filter(id => id !== labelId);
        } else {
            newLabelIds = [...currentLabelIds, labelId];
        }

        btn.classList.toggle('active');
        btn.disabled = true;

        try {
            const res = await apiFetch(`/api/leads/${lead.id}/person-labels`, {
                method: 'PUT',
                body: JSON.stringify({ person_id: personId, label_ids: newLabelIds }),
            });
            // Update local state
            person.label_ids = res.label_ids || newLabelIds;
            currentLabelIds.length = 0;
            currentLabelIds.push(...person.label_ids);
            toast(`Etiqueta ${isActive ? 'removida' : 'adicionada'}`, 'success');
        } catch (err) {
            // Revert toggle on error
            btn.classList.toggle('active');
            toast(`Erro: ${err.message}`, 'error');
        } finally {
            btn.disabled = false;
        }
    };
}

function renderScriptsPanelList() {
    const list = document.getElementById('scripts-panel-list');
    if (!list || allScripts.length === 0) return;

    list.innerHTML = allScripts.slice(0, 6).map(s => `
        <div class="script-panel-item" data-action="apply-script" data-id="${s.id}">
            <div class="script-panel-title">${escHtml(s.title)}</div>
            <div class="script-panel-cat">${catLabel(s.category)}</div>
        </div>
    `).join('');
}

// --- Routing & Closing ---

async function routeConv(convId, team) {
    try {
        await apiFetch('/api/inbox/route', {
            method: 'POST',
            body: JSON.stringify({ conversation_id: convId, to_team: team }),
        });
        toast(`Conversa atribuida ao ${team === 'comercial' ? 'Comercial' : 'OPEC'}`, 'success');
        await loadInbox();
        if (currentConversation?.id === convId) {
            currentConversation.assigned_to = team;
            currentConversation.status = 'routed';
            renderLeadPanel(currentConversation);
        }
    } catch (err) {
        toast(`Erro: ${err.message}`, 'error');
    }
}

async function closeConv(convId) {
    if (!confirm('Encerrar esta conversa?')) return;
    try {
        await apiFetch(`/api/inbox/${convId}/close`, {
            method: 'POST', body: JSON.stringify({ reason: 'Encerrado pelo atendente' }),
        });
        toast('Conversa encerrada', 'info');
        currentConversation = null;
        document.getElementById('chat-area').innerHTML = '<div class="empty-state-pro"><div class="empty-illustration"><svg class="icon"><use href="/icons.svg#icon-inbox"></use></svg></div><h4 class="empty-title">Selecione uma conversa</h4><p class="empty-desc">Escolha uma conversa na lista ao lado</p></div>';
        const lpEmpty = document.getElementById('lead-panel-empty');
        const lpContent = document.getElementById('lead-panel-content');
        if (lpEmpty) lpEmpty.style.display = '';
        if (lpContent) lpContent.style.display = 'none';
        await loadInbox();
    } catch (err) {
        toast(`Erro: ${err.message}`, 'error');
    }
}

// --- LEADS ---

async function loadLeads() {
    const tbody = document.getElementById('leads-tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="8" class="loading-row">Carregando...</td></tr>`;

    try {
        const search = document.getElementById('leads-search')?.value || '';
        const origin = document.getElementById('leads-filter-origin')?.value || '';
        const cls    = document.getElementById('leads-filter-class')?.value || '';

        let qs = `?limit=100`;
        if (search) qs += `&search=${encodeURIComponent(search)}`;
        if (origin) qs += `&origin=${origin}`;
        if (cls)    qs += `&classification=${cls}`;

        const data = await apiFetch(`/api/leads${qs}`);
        const leads = data.leads || [];

        if (leads.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" class="loading-row">Nenhum lead encontrado</td></tr>`;
            return;
        }

        tbody.innerHTML = leads.map(lead => {
            const hasCrm = !!lead.crm_deal_id;
            const crmCell = hasCrm
                ? `<a href="https://brandmonitor.pipedrive.com/deal/${lead.crm_deal_id}" target="_blank" class="crm-synced">✅ #${lead.crm_deal_id}</a>`
                : `<button class="btn-pipedrive" id="pd-btn-${lead.id}" data-action="sync-lead" data-id="${lead.id}">📤 Pipedrive</button>`;
            return `<tr>
                <td><strong>${escHtml(lead.name || '—')}</strong></td>
                <td>${escHtml(lead.company_name || '—')}</td>
                <td>${escHtml(lead.phone || '—')}</td>
                <td><span class="tag tag-${lead.origin === 'form' ? 'form' : 'wa'}">${originLabel(lead.origin)}</span></td>
                <td><span class="tag tag-${lead.classification || 'unclassified'}">${classLabel(lead.classification)}</span></td>
                <td>${crmCell}</td>
                <td>${formatDate(lead.created_at)}</td>
                <td><button class="btn-sm" data-action="sync-lead" data-id="${lead.id}">↑ Sync</button></td>
            </tr>`;
        }).join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="8" class="loading-row" style="color:var(--red)">Erro: ${err.message}</td></tr>`;
    }
}

async function syncLead(leadId) {
    await syncLeadToPipedrive(leadId, document.getElementById(`pd-btn-${leadId}`));
}

// Setup filtros de leads
function setupLeadFilters() {
    const setupLeadFilter = id => {
        const el = document.getElementById(id);
        el?.addEventListener('change', loadLeads);
    };
    const searchEl = document.getElementById('leads-search');
    searchEl?.addEventListener('input', debounce(loadLeads, 400));
    setupLeadFilter('leads-filter-origin');
    setupLeadFilter('leads-filter-class');
}

// --- CSV Export ---
async function exportLeadsCSV() {
    try {
        const data = await apiFetch('/api/leads?limit=5000');
        const leads = data.leads || [];
        if (leads.length === 0) {
            toast('Nenhum lead para exportar', 'info');
            return;
        }

        const headers = ['Nome', 'Empresa', 'Telefone', 'Email', 'Origem', 'Classificacao', 'CRM Deal ID', 'Data Criacao'];
        const rows = leads.map(l => [
            l.name || '',
            l.company_name || '',
            l.phone || '',
            l.email || '',
            l.origin || '',
            l.classification || '',
            l.crm_deal_id || '',
            l.created_at ? new Date(l.created_at).toLocaleDateString('pt-BR') : '',
        ]);

        const csvContent = [headers, ...rows]
            .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
            .join('\n');

        const BOM = '\uFEFF';
        const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `leads-branddi-${new Date().toISOString().slice(0,10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast('CSV exportado com sucesso!', 'success');
    } catch (err) {
        toast(`Erro ao exportar: ${err.message}`, 'error');
    }
}

// --- DASHBOARD ---

async function loadDashboard() {
    const days = document.getElementById('dash-period')?.value || 30;
    try {
        const data = await apiFetch(`/api/dashboard?days=${days}`);

        const setKpi = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ?? '—'; };
        setKpi('kpi-total', data.totals?.leads);
        setKpi('kpi-comercial', data.totals?.comercial);
        setKpi('kpi-opec', data.totals?.opec);
        setKpi('kpi-form', data.byOrigin?.form);
        setKpi('kpi-wa', data.byOrigin?.whatsapp_direct);

        const total = data.totals?.leads || 1;
        setKpi('kpi-comercial-pct', `${Math.round((data.totals?.comercial||0)/total*100)}%`);
        setKpi('kpi-opec-pct', `${Math.round((data.totals?.opec||0)/total*100)}%`);

        renderCharts(data);
    } catch (err) {
        console.error('Dashboard error:', err);
    }
}

function setupDashPeriod() {
    document.getElementById('dash-period')?.addEventListener('change', loadDashboard);
}

function renderCharts(data) {
    // Chart: Leads por dia
    const dayLabels = Object.keys(data.leadsByDay || {}).sort().slice(-30);
    const dayValues = dayLabels.map(d => data.leadsByDay[d] || 0);

    if (chartDay) chartDay.destroy();
    const ctx1 = document.getElementById('chart-leads-day')?.getContext('2d');
    if (ctx1) {
        chartDay = new Chart(ctx1, {
            type: 'line',
            data: {
                labels: dayLabels,
                datasets: [{
                    label: 'Leads',
                    data: dayValues,
                    borderColor: '#00E5FF',
                    backgroundColor: 'rgba(0,229,255,.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: .4,
                    pointRadius: 3,
                    pointBackgroundColor: '#00E5FF',
                }]
            },
            options: chartOpts({ yMin: 0 }),
        });
    }

    // Chart: Origem
    if (chartOrigin) chartOrigin.destroy();
    const ctx2 = document.getElementById('chart-origin')?.getContext('2d');
    const originData = data.byOrigin || {};
    if (ctx2) {
        chartOrigin = new Chart(ctx2, {
            type: 'doughnut',
            data: {
                labels: ['Formulario', 'WhatsApp', 'Prospeccao'],
                datasets: [{
                    data: [originData.form||0, originData.whatsapp_direct||0, originData.prospecting||0],
                    backgroundColor: ['#3B82F6','#00E5FF','#F59E0B'],
                    borderWidth: 0,
                }]
            },
            options: { ...chartOpts(), cutout: '68%' },
        });
    }

    // Chart: Classificacao
    if (chartClass) chartClass.destroy();
    const ctx3 = document.getElementById('chart-classification')?.getContext('2d');
    const clsData = data.byClassification || {};
    if (ctx3) {
        chartClass = new Chart(ctx3, {
            type: 'doughnut',
            data: {
                labels: ['Comercial', 'OPEC', 'Nao classificado'],
                datasets: [{
                    data: [clsData.comercial||0, clsData.opec||0, clsData.unclassified||0],
                    backgroundColor: ['#00E5FF','#F59E0B','#374151'],
                    borderWidth: 0,
                }]
            },
            options: { ...chartOpts(), cutout: '68%' },
        });
    }
}

function chartOpts(extra = {}) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: {
                labels: { color: '#9AA3B8', font: { family: 'Inter', size: 11 }, boxWidth: 12 }
            }
        },
        scales: extra.yMin !== undefined ? {
            y: {
                min: extra.yMin,
                grid: { color: 'rgba(255,255,255,.05)' },
                ticks: { color: '#9AA3B8', font: { family: 'Inter', size: 10 } }
            },
            x: {
                grid: { color: 'rgba(255,255,255,.03)' },
                ticks: { color: '#9AA3B8', font: { family: 'Inter', size: 10 }, maxTicksLimit: 8 }
            }
        } : undefined,
        ...extra,
    };
}

// --- SCRIPTS ---

function setupScriptCats() {
    document.querySelectorAll('.script-cat-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.script-cat-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentScriptCat = btn.dataset.cat;
            renderScriptsGrid();
        });
    });
}

async function loadScripts() {
    try {
        const data = await apiFetch('/api/scripts');
        allScripts = data.scripts || [];
        renderScriptsGrid();
    } catch (err) {
        const grid = document.getElementById('scripts-grid');
        if (grid) grid.innerHTML = `<div class="empty-state"><p style="color:var(--red)">Erro ao carregar</p></div>`;
    }
}

function renderScriptsGrid() {
    const grid = document.getElementById('scripts-grid');
    if (!grid) return;
    let filtered = allScripts;
    if (currentScriptCat) filtered = filtered.filter(s => s.category === currentScriptCat);

    // Filtro de visibilidade (público/meus/todos)
    const visFilter = document.getElementById('scripts-visibility-filter')?.value || 'all';
    if (visFilter === 'public') filtered = filtered.filter(s => s.is_public !== false);
    else if (visFilter === 'mine') filtered = filtered.filter(s => s.owner_user_id === currentUser?.id);

    if (filtered.length === 0) {
        grid.innerHTML = `<div class="empty-state"><p>Nenhum script nesta categoria</p></div>`;
        return;
    }

    const userId = currentUser?.id;
    const isAdmin = currentUser?.role === 'Admin';

    grid.innerHTML = filtered.map(s => {
        const isMine = s.owner_user_id === userId;
        const canEdit = isMine || isAdmin || !s.owner_user_id;
        const privacyBadge = s.is_public === false
            ? `<span class="tag" style="background:rgba(139,92,246,.15);color:#a78bfa;font-size:10px">🔒 Pessoal</span>`
            : '';
        return `
        <div class="script-card${s.is_public === false ? ' script-private' : ''}">
            <div class="script-card-header">
                <div class="script-card-title">${escHtml(s.title)} ${privacyBadge}</div>
                <div class="script-card-actions">
                    ${canEdit ? `<button class="icon-btn" data-action="edit-script" data-id="${s.id}" title="Editar">✏️</button>
                    <button class="icon-btn danger" data-action="delete-script" data-id="${s.id}" title="Remover">🗑</button>` : ''}
                </div>
            </div>
            <div class="script-card-category">
                <span class="tag tag-${s.category === 'comercial' ? 'comercial' : s.category === 'opec' ? 'opec' : 'wa'}">${catLabel(s.category)}</span>
            </div>
            <div class="script-card-content">${escHtml(s.content)}</div>
        </div>`;
    }).join('');
}

function setupScriptForm() {
    document.getElementById('btn-new-script')?.addEventListener('click', () => {
        document.getElementById('modal-script-title').textContent = 'Novo Script';
        document.getElementById('script-id').value = '';
        document.getElementById('form-script').reset();
        openModal('modal-script');
    });

    // Toggle de visibilidade — atualiza label
    document.getElementById('script-is-public')?.addEventListener('change', e => {
        const label = document.getElementById('script-visibility-label');
        if (label) label.textContent = e.target.checked
            ? 'Público — visível para toda a equipe'
            : 'Pessoal — só você vê este script';
    });

    // Filtro de visibilidade no painel
    document.getElementById('scripts-visibility-filter')?.addEventListener('change', () => renderScriptsGrid());

    document.getElementById('form-script')?.addEventListener('submit', async e => {
        e.preventDefault();
        const id = document.getElementById('script-id').value;
        const payload = {
            category:  document.getElementById('script-category').value,
            title:     document.getElementById('script-title').value,
            content:   document.getElementById('script-content').value,
            is_public: document.getElementById('script-is-public')?.checked ?? true,
        };
        try {
            if (id) {
                await apiFetch(`/api/scripts/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
                toast('Script atualizado!', 'success');
            } else {
                await apiFetch('/api/scripts', { method: 'POST', body: JSON.stringify(payload) });
                toast('Script criado!', 'success');
            }
            closeModal('modal-script');
            await loadScripts();
        } catch (err) {
            toast(`Erro: ${err.message}`, 'error');
        }
    });
}

function openScriptEditor() {
    document.getElementById('modal-script-title').textContent = 'Novo Script';
    document.getElementById('script-id').value = '';
    document.getElementById('form-script')?.reset();
    const pub = document.getElementById('script-is-public');
    if (pub) pub.checked = true;
    const label = document.getElementById('script-visibility-label');
    if (label) label.textContent = 'Público — visível para toda a equipe';
    openModal('modal-script');
}

function closeScriptEditor() {
    closeModal('modal-script');
}

function saveScript() {
    // Trigger the form submit event
    document.getElementById('form-script')?.requestSubmit();
}

function editScript(scriptId) {
    const s = allScripts.find(x => x.id === scriptId);
    if (!s) return;
    document.getElementById('modal-script-title').textContent = 'Editar Script';
    document.getElementById('script-id').value = s.id;
    document.getElementById('script-category').value = s.category;
    document.getElementById('script-title').value = s.title;
    document.getElementById('script-content').value = s.content;
    const pub = document.getElementById('script-is-public');
    if (pub) pub.checked = s.is_public !== false;
    const label = document.getElementById('script-visibility-label');
    if (label) label.textContent = s.is_public !== false
        ? 'Público — visível para toda a equipe'
        : 'Pessoal — só você vê este script';
    openModal('modal-script');
}

async function deleteScript(scriptId) {
    if (!confirm('Desativar este script?')) return;
    try {
        await apiFetch(`/api/scripts/${scriptId}`, { method: 'DELETE' });
        toast('Script removido', 'info');
        await loadScripts();
    } catch (err) {
        toast(`Erro: ${err.message}`, 'error');
    }
}

// --- API Helper ---

async function apiFetch(url, options = {}) {
    const token = getToken();
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(url, { ...options, headers });

    // Sessao expirada — lanca erro para o caller decidir o que fazer
    if (res.status === 401) {
        const err = new Error('Sessao expirada');
        err.status = 401;
        throw err;
    }
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
    }
    return res.json();
}

/** Exibe o usuario logado no side-nav */
function setupCurrentUser() {
    if (!currentUser) return;

    const container = document.getElementById('side-nav-user');
    if (!container) return;

    const roleColors = { Admin: '#a78bfa', Usuario: '#34d399' };
    const roleColor  = roleColors[currentUser.role] || '#8b949e';

    container.className = 'side-nav-user';
    container.title = `${currentUser.name} (${currentUser.role})`;
    container.innerHTML = `
        <div class="user-avatar">${currentUser.name.charAt(0).toUpperCase()}</div>
        <span class="user-role-dot" style="color:${roleColor}">${currentUser.role}</span>
        <button class="btn-logout" data-action="logout" title="Sair">&#x2715;</button>
    `;

    const isAdmin = currentUser.role === 'Admin';

    // Admin ve o link de usuarios nas configuracoes
    if (isAdmin) {
        document.querySelectorAll('.admin-only').forEach(el => el.style.display = '');
    }

    // Visibilidade por role: Dashboard e Simulador só para Admin
    const dashTab = document.getElementById('tab-dashboard');
    if (dashTab) dashTab.style.display = isAdmin ? '' : 'none';
    const simBtn = document.getElementById('btn-simulator');
    if (simBtn) simBtn.style.display = isAdmin ? '' : 'none';
}


// --- Modal ---
function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
}
function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
}
document.querySelectorAll('.modal-overlay')?.forEach(overlay => {
    overlay.addEventListener('click', e => {
        if (e.target === overlay) overlay.style.display = 'none';
    });
});

// --- Toast ---
function toast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const iconMap = { success: 'icon-check', error: 'icon-alert', info: 'icon-info', warning: 'icon-alert' };
    const iconId = iconMap[type] || 'icon-info';
    el.innerHTML = `<svg class="icon icon-sm"><use href="/icons.svg#${iconId}"></use></svg> ${escHtml(msg)}`;
    container.appendChild(el);
    setTimeout(() => {
        el.classList.add('toast-out');
        el.addEventListener('animationend', () => el.remove());
    }, 3500);
}

// --- New Msg Notif ---
function showNewMsgNotif(text) {
    const notif = document.getElementById('new-msg-notif');
    const notifText = document.getElementById('notif-text');
    if (!notif || !notifText) return;
    notifText.textContent = text;
    notif.style.display = 'flex';
    setTimeout(() => { notif.style.display = 'none'; }, 4000);
    notif.onclick = () => { notif.style.display = 'none'; };
}

// --- Utils ---
function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function truncate(str, n) { return str.length > n ? str.slice(0, n) + '...' : str; }
function formatPhone(phone) {
    if (!phone) return '—';
    const d = String(phone).replace(/\D/g, '');
    // 11 dígitos BR: (DD) 9XXXX-XXXX
    if (d.length === 11) return `(${d.slice(0,2)}) ${d[2]}${d.slice(3,7)}-${d.slice(7)}`;
    // 10 dígitos: (DD) XXXX-XXXX
    if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
    return phone;
}
function classLabel(cls) {
    return { comercial: '🟢 Comercial', opec: '🟡 OPEC', unclassified: '⚪ Aguardando', prospecting: '🔵 Prospeccao' }[cls] || cls || '—';
}
function catLabel(cat) {
    return { welcome: '👋 Boas-vindas', comercial: '🟢 Comercial', opec: '🟡 OPEC', qualification: '❓ Qualificacao', closing: '🤝 Encerramento' }[cat] || cat;
}
function originLabel(origin) {
    return { form: '📋 Formulario', whatsapp_direct: '📱 WhatsApp', prospecting: '🔍 Prospeccao' }[origin] || origin || '—';
}
function formatTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
}
function formatDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function relativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - new Date(ts).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'agora';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
}
function debounce(fn, ms) {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// --- WhatsApp Connect via QR Code ---

let _waAccountId = null;

async function checkWaStatus() {
    const detail = document.getElementById('wa-status-detail');
    if (!detail) return;
    detail.textContent = '⏳ Verificando...';

    try {
        const data = await apiFetch('/api/whatsapp/accounts');
        const accounts = data.accounts || [];

        if (accounts.length > 0) {
            const acc = accounts[0];
            _waAccountId = acc.id;
            const identifier = acc.name || acc.identifier || acc.id;
            detail.innerHTML = `<span style="color:#00E5FF">✅ Conectado</span> — ${identifier}`;

            const btnQR = document.getElementById('btn-wa-generate-qr');
            const btnDis = document.getElementById('btn-wa-disconnect');
            const qrArea = document.getElementById('wa-qr-area');
            if (btnQR) btnQR.style.display = 'none';
            if (btnDis) btnDis.style.display = 'inline-flex';
            if (qrArea) qrArea.style.display = 'none';
        } else {
            _waAccountId = null;
            detail.innerHTML = `<span style="color:#F59E0B">⚠️ Nenhuma conta conectada</span>`;
            const btnQR = document.getElementById('btn-wa-generate-qr');
            const btnDis = document.getElementById('btn-wa-disconnect');
            if (btnQR) btnQR.style.display = 'inline-flex';
            if (btnDis) btnDis.style.display = 'none';
        }
    } catch (err) {
        detail.innerHTML = `<span style="color:#EF4444">❌ Erro ao verificar: ${err.message}</span>`;
    }
}

function openWaConnect() {
    openModal('modal-wa-connect');
    const qrArea = document.getElementById('wa-qr-area');
    if (qrArea) qrArea.style.display = 'none';
    checkWaStatus();
}

function closeWaConnect() {
    closeModal('modal-wa-connect');
    checkHealth();
}

// Aliases for window exports
function openWhatsAppModal() { openWaConnect(); }
function closeWhatsAppModal() { closeWaConnect(); }
function connectWhatsApp() { generateWaQR(); }

async function generateWaQR() {
    const btn = document.getElementById('btn-wa-generate-qr');
    const qrArea = document.getElementById('wa-qr-area');
    const container = document.getElementById('wa-qr-container');

    if (btn) { btn.disabled = true; btn.textContent = '⏳ Gerando...'; }
    if (qrArea) qrArea.style.display = 'block';
    if (container) container.innerHTML = '<span style="color:#666">⏳ Aguardando QR code da Unipile...</span>';

    try {
        const res = await fetch('/api/whatsapp/connect', { method: 'POST' });
        const json = await res.json();

        if (json.error) throw new Error(json.error);

        const checkpoint = json.checkpoint || json;
        const qrData = checkpoint.qrcode || checkpoint.qr_code || json.qr_code;

        if (qrData && container) {
            container.innerHTML = '';

            if (qrData.startsWith('data:image') || qrData.startsWith('iVBOR')) {
                container.innerHTML = `<img src="${qrData.startsWith('data:') ? qrData : 'data:image/png;base64,' + qrData}"
                    style="max-width:250px;border-radius:8px">`;
            } else {
                const canvas = document.createElement('canvas');
                container.appendChild(canvas);
                try {
                    new QRious({ element: canvas, value: qrData, size: 240, level: 'M', background: 'white', foreground: '#000' });
                } catch (qrErr) {
                    container.innerHTML = `<span style="color:red">Erro ao renderizar QR: ${qrErr.message}</span>`;
                }
            }

            _pollWaConnection();

        } else if (json.object === 'Account' || json.id) {
            if (container) container.innerHTML = '<span style="color:#00E5FF;font-size:16px">✅ Conta conectada!</span>';
            setTimeout(() => { checkWaStatus(); checkHealth(); }, 1000);
        } else {
            if (container) container.innerHTML = `<pre style="font-size:10px;color:#888;max-width:280px;overflow:auto;white-space:pre-wrap;text-align:left">${JSON.stringify(json, null, 2)}</pre>`;
        }
    } catch (err) {
        if (container) container.innerHTML = `<span style="color:#EF4444">❌ ${err.message}</span>`;
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '📱 Gerar novo QR'; }
    }
}

function _pollWaConnection() {
    let attempts = 0;
    const maxAttempts = 40;

    const interval = setInterval(async () => {
        attempts++;
        if (attempts >= maxAttempts) {
            clearInterval(interval);
            return;
        }
        try {
            const data = await apiFetch('/api/whatsapp/accounts');
            if ((data.accounts || []).length > 0) {
                clearInterval(interval);
                const container = document.getElementById('wa-qr-container');
                if (container) container.innerHTML = '<span style="color:#00E5FF;font-size:20px">✅ WhatsApp Conectado!</span>';
                setTimeout(() => {
                    checkWaStatus();
                    checkHealth();
                }, 1500);
            }
        } catch { /* ignora erros de polling */ }
    }, 3000);
}

async function disconnectWa() {
    if (!_waAccountId) return;
    try {
        await apiFetch(`/api/whatsapp/accounts/${_waAccountId}`, { method: 'DELETE' });
        toast('WhatsApp desconectado', 'info');
        _waAccountId = null;
        checkWaStatus();
        checkHealth();
    } catch (err) {
        toast(`Erro ao desconectar: ${err.message}`, 'error');
    }
}

// --- SETTINGS ---

let _settingsData = null;

async function openSettingsModal() {
    const modal = document.getElementById('modal-settings');
    if (modal) modal.style.display = 'flex';

    const isAdmin = currentUser?.role === 'Admin';

    // Mostra/esconde aba de usuários (Admin only)
    const tabUsers = document.querySelector('[data-stab="users"]');
    if (tabUsers) tabUsers.style.display = isAdmin ? '' : 'none';

    // Mostra/esconde seções admin (bot, pipedrive, agent name)
    document.querySelectorAll('.admin-section').forEach(el => {
        el.style.display = isAdmin ? '' : 'none';
    });

    try {
        // Carrega perfil pessoal do user logado
        const profileRes = await apiFetch('/api/settings/my-profile');
        const profile = profileRes.profile || {};
        const myNameEl = document.getElementById('settings-my-name');
        if (myNameEl) myNameEl.value = profile.name || '';

        // Foto do user
        const preview = document.getElementById('settings-photo-preview');
        if (preview) {
            if (profile.avatar_url) {
                preview.innerHTML = `<img src="${profile.avatar_url}" alt="foto" />`;
            } else {
                preview.innerHTML = `<span id="settings-photo-icon">👤</span>`;
            }
        }

        // Se Admin, carrega configs globais + dados Pipedrive
        if (isAdmin) {
            const [settRes, pdRes] = await Promise.all([
                apiFetch('/api/settings'),
                apiFetch('/api/settings/pipedrive-data'),
            ]);
            _settingsData = settRes.settings;
            const { pipelines = [], stages = [], users = [] } = pdRes;

            // Agent name global (do bot)
            const agentNameEl = document.getElementById('settings-agent-name');
            if (agentNameEl) agentNameEl.value = _settingsData.agent_name || '';

            // Bot 24h
            const awayEnabledEl = document.getElementById('settings-away-enabled');
            if (awayEnabledEl) awayEnabledEl.checked = !!_settingsData.away_enabled;
            const awayMinEl = document.getElementById('settings-away-minutes');
            if (awayMinEl) awayMinEl.value = _settingsData.away_minutes ?? 10;
            const awayMsgEl = document.getElementById('settings-away-message');
            if (awayMsgEl) awayMsgEl.value = _settingsData.away_message || '';

            // Funis
            const pipelineSel = document.getElementById('settings-pipeline');
            if (pipelineSel) {
                pipelineSel.innerHTML = pipelines.map(p =>
                    `<option value="${p.id}" ${p.id == _settingsData.pipedrive_pipeline_id ? 'selected' : ''}>${p.name}</option>`
                ).join('');
            }

            // Etapas
            const stageSel = document.getElementById('settings-stage');
            if (stageSel) {
                stageSel.innerHTML = stages.map(s =>
                    `<option value="${s.id}" ${s.id == _settingsData.pipedrive_stage_id ? 'selected' : ''}>${s.name}</option>`
                ).join('') || '<option value="">Nenhuma etapa encontrada</option>';
            }

            // Proprietarios
            const ownerSel = document.getElementById('settings-owner');
            if (ownerSel) {
                ownerSel.innerHTML = `<option value="">— Nao atribuido —</option>` +
                    users.map(u =>
                        `<option value="${u.id}" ${u.id == _settingsData.pipedrive_owner_id ? 'selected' : ''}>${u.name}</option>`
                    ).join('');
            }

            window._pdUsers = users;
        }

    } catch (err) {
        toast(`Erro ao carregar configuracoes: ${err.message}`, 'error');
    }
}

function switchSettingsTab(tabId) {
    document.querySelectorAll('.settings-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.stab === tabId)
    );
    document.querySelectorAll('.settings-tab-panel').forEach(p => {
        const isActive = p.id === `stab-${tabId}`;
        p.classList.toggle('active', isActive);
        p.style.display = isActive ? 'block' : 'none';
    });

    if (tabId === 'users') loadUsersList();
}

// --- User Management ---
async function loadUsersList() {
    const container = document.getElementById('users-list');
    if (!container) return;
    container.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">Carregando...</div>';

    try {
        const data = await apiFetch('/api/users');
        renderUsersList(data.users || []);
    } catch (err) {
        container.innerHTML = `<div style="color:var(--red-soft)">Erro: ${err.message}</div>`;
    }
}

let _cachedUsers = [];

function renderUsersList(users) {
    _cachedUsers = users;
    const container = document.getElementById('users-list');
    if (!container) return;

    if (users.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Nenhum usuario cadastrado.</div>';
        return;
    }

    container.innerHTML = users.map(u => {
        const initial = (u.name || u.email || '?').charAt(0).toUpperCase();
        const inactive = !u.active;
        return `
        <div class="user-list-item${inactive ? ' user-inactive' : ''}">
            <div class="user-avatar-sm">${initial}</div>
            <div class="user-info">
                <div class="user-name-row">
                    <span class="user-name">${escHtml(u.name || '—')}</span>
                    <span class="role-badge ${u.role}">${u.role}</span>
                    ${inactive ? '<span style="font-size:10px;color:var(--text-muted)">(inativo)</span>' : ''}
                </div>
                <div class="user-email">${escHtml(u.email)}</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0">
                <button class="btn-sm btn-outline" style="padding:5px 10px;font-size:11px"
                    data-action="edit-user" data-user-id="${u.id}">✏️</button>
                <button class="btn-sm btn-outline" style="padding:5px 10px;font-size:11px"
                    data-action="toggle-user" data-user-id="${u.id}" data-activate="${inactive}">
                    ${inactive ? '✅ Ativar' : '🚫 Desativar'}
                </button>
            </div>
        </div>`;
    }).join('');
}

function openAddUserForm() {
    const titleEl = document.getElementById('user-form-title');
    if (titleEl) titleEl.textContent = 'Novo usuario';
    const idEl = document.getElementById('uf-id');
    if (idEl) idEl.value = '';
    const nameEl = document.getElementById('uf-name');
    if (nameEl) nameEl.value = '';
    const emailEl = document.getElementById('uf-email');
    if (emailEl) emailEl.value = '';
    const pwEl = document.getElementById('uf-password');
    if (pwEl) pwEl.value = '';
    const roleEl = document.getElementById('uf-role');
    if (roleEl) roleEl.value = 'Usuario';
    const tokenEl = document.getElementById('uf-pipedrive-token');
    if (tokenEl) { tokenEl.value = ''; tokenEl.placeholder = 'Cole o token aqui (Pipedrive > Config > Preferencias > API)'; }
    const tokenStatus = document.getElementById('uf-token-status');
    if (tokenStatus) { tokenStatus.textContent = 'Necessario para que atividades aparecam como criadas por este usuario no Pipedrive'; tokenStatus.style.color = 'var(--text-muted)'; }
    populatePdUsersDropdown(null);
    populatePermissions({});
    const wrap = document.getElementById('user-form-wrap');
    if (wrap) wrap.style.display = '';
}

function openEditUserForm(user) {
    const titleEl = document.getElementById('user-form-title');
    if (titleEl) titleEl.textContent = 'Editar usuario';
    const idEl = document.getElementById('uf-id');
    if (idEl) idEl.value = user.id;
    const nameEl = document.getElementById('uf-name');
    if (nameEl) nameEl.value = user.name || '';
    const emailEl = document.getElementById('uf-email');
    if (emailEl) emailEl.value = user.email;
    const pwEl = document.getElementById('uf-password');
    if (pwEl) pwEl.value = '';
    const roleEl = document.getElementById('uf-role');
    if (roleEl) roleEl.value = user.role;
    // Pipedrive token
    const tokenEl = document.getElementById('uf-pipedrive-token');
    if (tokenEl) {
        tokenEl.value = '';
        tokenEl.placeholder = user.pipedrive_api_token
            ? `Token salvo (${user.pipedrive_api_token})`
            : 'Cole o token aqui (Pipedrive > Config > Preferencias > API)';
    }
    const tokenStatus = document.getElementById('uf-token-status');
    if (tokenStatus) {
        tokenStatus.textContent = user.pipedrive_api_token
            ? `✅ Token configurado (${user.pipedrive_api_token}). Deixe vazio para manter.`
            : 'Necessario para que atividades aparecam como criadas por este usuario no Pipedrive';
        tokenStatus.style.color = user.pipedrive_api_token ? 'var(--accent)' : 'var(--text-muted)';
    }
    populatePdUsersDropdown(user.pipedrive_user_id);
    populatePermissions(user.permissions || {});
    const wrap = document.getElementById('user-form-wrap');
    if (wrap) wrap.style.display = '';
}

function populatePermissions(perms) {
    // Conversation types
    const inboundCb = document.getElementById('uf-perm-inbound');
    const prospCb = document.getElementById('uf-perm-prospecting');
    const types = perms.conversation_types || [];
    if (inboundCb) inboundCb.checked = types.includes('inbound');
    if (prospCb) prospCb.checked = types.includes('prospecting');

    // WhatsApp accounts
    const waContainer = document.getElementById('uf-wa-accounts');
    if (!waContainer) return;
    const allowedAccounts = perms.whatsapp_accounts || [];

    apiFetch('/api/whatsapp/accounts').then(data => {
        const accounts = data?.accounts || [];
        if (accounts.length === 0) {
            waContainer.textContent = 'Nenhuma conta WhatsApp conectada';
            return;
        }
        waContainer.innerHTML = accounts.map(a => {
            const checked = allowedAccounts.includes(a.id) ? 'checked' : '';
            const label = a.connection_params?.im?.phone_number || a.name || a.id;
            return `<label class="perm-check"><input type="checkbox" value="${a.id}" class="uf-wa-check" ${checked} /> ${escHtml(String(label))}</label>`;
        }).join('');
    }).catch(() => {
        waContainer.textContent = 'Erro ao carregar contas';
    });
}

function getPermissionsFromForm() {
    const types = [];
    if (document.getElementById('uf-perm-inbound')?.checked) types.push('inbound');
    if (document.getElementById('uf-perm-prospecting')?.checked) types.push('prospecting');

    const waAccounts = [];
    document.querySelectorAll('.uf-wa-check:checked').forEach(cb => {
        waAccounts.push(cb.value);
    });

    return { conversation_types: types, whatsapp_accounts: waAccounts };
}

function populatePdUsersDropdown(selectedId) {
    const sel = document.getElementById('uf-pipedrive-user');
    if (!sel) return;
    const users = window._pdUsers || [];
    sel.innerHTML = `<option value="">— Nao vincular —</option>` +
        users.map(u =>
            `<option value="${u.id}" ${u.id == selectedId ? 'selected' : ''}>${u.name}</option>`
        ).join('');
}

function closeAddUserForm() {
    const wrap = document.getElementById('user-form-wrap');
    if (wrap) wrap.style.display = 'none';
}

function toggleTokenVisibility() {
    const el = document.getElementById('uf-pipedrive-token');
    if (!el) return;
    el.type = el.type === 'password' ? 'text' : 'password';
}

async function saveUser() {
    const id       = document.getElementById('uf-id')?.value;
    const name     = document.getElementById('uf-name')?.value.trim();
    const email    = document.getElementById('uf-email')?.value.trim();
    const password = document.getElementById('uf-password')?.value;
    const role     = document.getElementById('uf-role')?.value;
    const pdUserId = document.getElementById('uf-pipedrive-user')?.value;
    const pdToken  = document.getElementById('uf-pipedrive-token')?.value.trim();
    const permissions = getPermissionsFromForm();

    if (!name || !email) { toast('Nome e e-mail sao obrigatorios', 'error'); return; }
    if (!id && !password) { toast('Senha obrigatoria para novo usuario', 'error'); return; }

    try {
        const body = { name, email, role, pipedrive_user_id: pdUserId || null, permissions };
        if (password) body.password = password;
        if (pdToken) body.pipedrive_api_token = pdToken; // só envia se preenchido (não sobrescreve com vazio)

        if (id) {
            await apiFetch(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
            toast('Usuario atualizado!', 'success');
        } else {
            await apiFetch('/api/users', { method: 'POST', body: JSON.stringify(body) });
            toast('Usuario criado!', 'success');
        }
        closeAddUserForm();
        loadUsersList();
    } catch (err) {
        toast(`Erro: ${err.message}`, 'error');
    }
}

async function toggleUserActive(userId, setActive) {
    try {
        await apiFetch(`/api/users/${userId}`, {
            method: 'PATCH',
            body: JSON.stringify({ active: setActive }),
        });
        toast(setActive ? 'Usuario ativado' : 'Usuario desativado', 'success');
        loadUsersList();
    } catch (err) {
        toast(`Erro: ${err.message}`, 'error');
    }
}

async function loadSettingsStages(pipelineId) {
    if (!pipelineId) return;
    const stageSel = document.getElementById('settings-stage');
    if (!stageSel) return;
    stageSel.innerHTML = '<option>Carregando...</option>';
    try {
        const { stages } = await apiFetch(`/api/settings/stages?pipeline_id=${pipelineId}`);
        stageSel.innerHTML = stages.map(s =>
            `<option value="${s.id}">${s.name}</option>`
        ).join('') || '<option value="">Nenhuma etapa</option>';
    } catch {
        stageSel.innerHTML = '<option value="">Erro ao carregar</option>';
    }
}

function closeSettingsModal() {
    const modal = document.getElementById('modal-settings');
    if (modal) modal.style.display = 'none';
}

function handlePhotoUpload(input) {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
        toast('Foto muito grande (max 4MB)', 'error');
        return;
    }
    const reader = new FileReader();
    reader.onload = e => {
        const b64 = e.target.result;
        const preview = document.getElementById('settings-photo-preview');
        if (preview) {
            preview.innerHTML = `<img src="${b64}" alt="foto" />`;
            preview.dataset.photo = b64;
        }
    };
    reader.readAsDataURL(file);
}

async function saveSettings() {
    const isAdmin = currentUser?.role === 'Admin';
    const preview = document.getElementById('settings-photo-preview');

    try {
        // 1. Salva perfil pessoal (todos os users)
        const myName = document.getElementById('settings-my-name')?.value.trim();
        const profilePayload = { name: myName || '' };
        if (preview?.dataset.photo) profilePayload.avatar_url = preview.dataset.photo;

        await apiFetch('/api/settings/my-profile', {
            method: 'PATCH',
            body: JSON.stringify(profilePayload),
        });

        // Atualiza nome no header/localStorage
        if (myName && currentUser) {
            currentUser.name = myName;
            localStorage.setItem('ba_user', JSON.stringify(currentUser));
        }

        // 2. Se Admin, salva configs globais (bot, pipedrive)
        if (isAdmin) {
            const pipelineSel = document.getElementById('settings-pipeline');
            const stageSel    = document.getElementById('settings-stage');
            const ownerSel    = document.getElementById('settings-owner');

            if (pipelineSel && stageSel && ownerSel) {
                const ownerOpt    = ownerSel.options[ownerSel.selectedIndex];
                const pipelineOpt = pipelineSel.options[pipelineSel.selectedIndex];
                const stageOpt    = stageSel.options[stageSel.selectedIndex];

                const payload = {
                    agent_name:  document.getElementById('settings-agent-name')?.value.trim() || '',
                    agent_photo: preview?.dataset.photo || _settingsData?.agent_photo || '',
                    away_enabled: document.getElementById('settings-away-enabled')?.checked || false,
                    away_minutes: parseInt(document.getElementById('settings-away-minutes')?.value) || 10,
                    away_message: document.getElementById('settings-away-message')?.value.trim() || '',
                    pipedrive_pipeline_id:   parseInt(pipelineSel.value) || null,
                    pipedrive_pipeline_name: pipelineOpt?.text || '',
                    pipedrive_stage_id:      parseInt(stageSel.value) || null,
                    pipedrive_stage_name:    stageOpt?.text || '',
                    pipedrive_owner_id:      ownerSel.value ? parseInt(ownerSel.value) : null,
                    pipedrive_owner_name:    ownerOpt?.text || 'Nao atribuido',
                };
                await apiFetch('/api/settings', { method: 'POST', body: JSON.stringify(payload) });
            }
        }

        toast('Configuracoes salvas!', 'success');
        closeSettingsModal();
    } catch (err) {
        toast(`Erro ao salvar: ${err.message}`, 'error');
    }
}

// --- Pipedrive Sync Button ---

async function syncLeadToPipedrive(leadId, btnEl) {
    if (!leadId) return;
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '⏳ Enviando...'; }
    try {
        const res = await apiFetch(`/api/leads/${leadId}/sync-crm`, { method: 'POST' });
        if (res.already_synced) {
            toast(`Deal #${res.crm_deal_id} ja existente no Pipedrive`, 'info');
        } else {
            toast(`✅ ${res.message}`, 'success');
            if (btnEl) {
                btnEl.textContent = `✅ Deal #${res.crm_deal_id}`;
                btnEl.classList.add('synced');
                btnEl.disabled = false;
            }
        }
        loadLeads();
    } catch (err) {
        toast(`Erro ao enviar: ${err.message}`, 'error');
        if (btnEl) { btnEl.disabled = false; btnEl.textContent = '📤 Enviar Pipedrive'; }
    }
}

// Stub CRM sync functions for onclick compatibility
function syncCRM() { toast('Sync CRM iniciado...', 'info'); }
function syncAllToday() { toast('Sync All Today iniciado...', 'info'); }

// --- Conversation actions (aliases) ---
function loadConversation(convId) { return selectConversation(convId); }
function claimConversation(convId) {
    if (!convId) return;
    apiFetch(`/api/inbox/${convId}/claim`, { method: 'POST' })
        .then(() => { toast('Conversa reivindicada', 'success'); loadInbox(); })
        .catch(err => toast(`Erro: ${err.message}`, 'error'));
}
function releaseConversation(convId) {
    if (!convId) return;
    apiFetch(`/api/inbox/${convId}/release`, { method: 'POST' })
        .then(() => { toast('Conversa liberada', 'success'); loadInbox(); })
        .catch(err => toast(`Erro: ${err.message}`, 'error'));
}

// --- HISTORY ---

async function loadHistory() {
    const search = document.getElementById('history-search')?.value || '';
    const status = document.getElementById('history-filter-status')?.value || '';
    const days   = document.getElementById('history-filter-days')?.value || '30';
    const tbody  = document.getElementById('history-tbody');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="8" class="loading-row">Carregando...</td></tr>';

    const params = new URLSearchParams({ limit: '100' });
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (days)   params.set('days', days);

    try {
        const { conversations = [] } = await apiFetch(`/api/history?${params}`);

        if (!conversations.length) {
            tbody.innerHTML = '<tr><td colspan="8" class="loading-row">Nenhuma conversa encontrada</td></tr>';
            return;
        }

        tbody.innerHTML = conversations.map(conv => {
            const lead  = conv.leads || {};
            const date  = new Date(conv.updated_at || conv.created_at).toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' });
            const cls   = lead.classification || 'unclassified';
            const clsTags = { comercial: '🟢 Comercial', opec: '🟡 OPEC', unclassified: '⚪ Nao class.' };
            const statusLabels = { closed: '✅ Encerrada', in_progress: '💬 Em andamento', waiting: '⏳ Aguardando', human: '👤 Humano' };
            const crmLink = lead.crm_deal_id
                ? `<a href="https://brandmonitor.pipedrive.com/deal/${lead.crm_deal_id}" target="_blank" class="crm-synced">#${lead.crm_deal_id}</a>`
                : `<span class="crm-pending">—</span>`;

            return `<tr class="history-row" data-action="open-history" data-id="${conv.id}" data-name="${escHtml(lead.name||'Lead')}">
                <td>${date}</td>
                <td><strong>${escHtml(lead.name || '—')}</strong><br><span style="font-size:11px;color:var(--text-muted)">${escHtml(lead.phone || '')}</span></td>
                <td>${escHtml(lead.company_name || '—')}</td>
                <td><span style="font-size:11px">${conv.channel || 'whatsapp'}</span></td>
                <td><span class="tag tag-${cls}">${clsTags[cls] || cls}</span></td>
                <td><span style="font-size:11px">${statusLabels[conv.status] || conv.status || '—'}</span></td>
                <td>${crmLink}</td>
                <td><button class="btn-sm" data-action="open-history" data-id="${conv.id}" data-name="${escHtml(lead.name||'Lead')}">💬 Ver</button></td>
            </tr>`;
        }).join('');

    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="8" class="loading-row" style="color:var(--red)">Erro: ${err.message}</td></tr>`;
    }
}

async function openHistoryMessages(convId, leadName) {
    const modal = document.getElementById('modal-history-msgs');
    const body  = document.getElementById('modal-history-body');
    const title = document.getElementById('modal-history-title');
    if (!modal) return;

    if (title) title.textContent = `💬 ${leadName}`;
    if (body) body.innerHTML = '<div class="loading-row">Carregando...</div>';
    modal.style.display = 'flex';

    try {
        const { messages = [] } = await apiFetch(`/api/history/${convId}/messages`);

        if (!messages.length) {
            if (body) body.innerHTML = '<div class="loading-row">Nenhuma mensagem encontrada</div>';
            return;
        }

        if (body) {
            body.innerHTML = messages.map(msg => {
                const time = new Date(msg.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                const date = new Date(msg.created_at).toLocaleDateString('pt-BR');
                const cls  = msg.direction === 'inbound' ? 'inbound' : msg.sender_type === 'bot' ? 'bot' : 'outbound';
                const sender = msg.sender_type === 'bot' ? '🤖 Bot' : msg.direction === 'inbound' ? '👤 Lead' : '👩 Atendente';
                return `<div class="msg-bubble ${cls}" style="max-width:85%">
                    <div class="msg-text">${msg.content || ''}</div>
                    <div class="msg-meta">
                        <span class="msg-sender ${cls === 'bot' ? 'bot-label' : ''}">${sender}</span>
                        <span class="msg-time">${date} ${time}</span>
                    </div>
                </div>`;
            }).join('');

            body.scrollTop = body.scrollHeight;
        }

    } catch (err) {
        if (body) body.innerHTML = `<div class="loading-row" style="color:var(--red)">Erro: ${err.message}</div>`;
    }
}

function showConversationMessages(convId) {
    return openHistoryMessages(convId, 'Conversa');
}
function closeHistoryModal() {
    closeModal('modal-history-msgs');
}

// Setup history filters
function setupHistoryFilters() {
    const histSearch = document.getElementById('history-search');
    const histStatus = document.getElementById('history-filter-status');
    const histDays   = document.getElementById('history-filter-days');

    histSearch?.addEventListener('input', debounce(loadHistory, 350));
    histStatus?.addEventListener('change', loadHistory);
    histDays?.addEventListener('change', loadHistory);
}


// ===================================================================
//  WINDOW EXPORTS — all functions used in inline onclick handlers
//  (necessary because script is type="module")
// ===================================================================
// ─── DEALS TAB (Pipedrive Integration) ─────────────────────────────
// ===================================================================

let _selectedDealForOutbound = null;
let _selectedContactForOutbound = null;

function loadDeals() {
    // Deals tab agora é busca — foca no input
    const input = document.getElementById('deals-search');
    if (input) { input.value = ''; input.focus(); }
    const results = document.getElementById('deals-results');
    if (results) results.innerHTML = '<div class="deals-empty">Digite o nome da empresa ou deal acima para buscar no Pipedrive</div>';
}

async function searchDeals() {
    const input = document.getElementById('deals-search');
    const results = document.getElementById('deals-results');
    if (!input || !results) return;

    const q = input.value.trim();
    if (q.length < 2) {
        results.innerHTML = '<div class="deals-empty">Digite pelo menos 2 caracteres para buscar</div>';
        return;
    }

    results.innerHTML = '<div class="deals-empty">Buscando...</div>';

    try {
        const data = await apiFetch(`/api/pipedrive/search-deals?q=${encodeURIComponent(q)}`);
        const deals = data?.deals || [];

        if (deals.length === 0) {
            results.innerHTML = '<div class="deals-empty">Nenhum deal encontrado para "' + escHtml(q) + '"</div>';
            return;
        }

        results.innerHTML = deals.map(d => {
            const statusCls = d.status === 'won' ? 'deal-won' : d.status === 'lost' ? 'deal-lost' : 'deal-open';
            const participants = d.participant_count || 0;
            return `
            <div class="deal-result-item" data-action="open-deal-contacts" data-deal-id="${d.id}">
                <div class="deal-result-left">
                    <div class="deal-result-title">${escHtml(d.title)}</div>
                    <div class="deal-result-meta">
                        <span class="deal-result-org">${escHtml(d.org_name)}</span>
                        <span class="deal-stage-badge">${escHtml(d.stage_name)}</span>
                        <span class="deal-status-badge ${statusCls}">${escHtml(d.status_label)}</span>
                        <span class="deal-result-value">${escHtml(d.value)}</span>
                    </div>
                    <div class="deal-result-person">
                        ${escHtml(d.person_name)} ${participants > 0 ? `(+${participants} participantes)` : ''}
                    </div>
                </div>
                <div class="deal-result-right">
                    <span class="deal-result-action">Ver contatos →</span>
                </div>
            </div>`;
        }).join('');
    } catch (err) {
        results.innerHTML = '<div class="deals-empty">Erro: ' + escHtml(err.message) + '</div>';
    }
}

async function openDealContacts(dealId) {
    const modal = document.getElementById('deal-contacts-modal');
    const list = document.getElementById('deal-contacts-list');
    const title = document.getElementById('deal-contacts-title');
    const form = document.getElementById('deal-outbound-form');
    if (!modal || !list) return;

    modal.style.display = 'flex';
    list.textContent = 'Carregando contatos...';
    if (form) form.style.display = 'none';
    _selectedContactForOutbound = null;
    _selectedDealForOutbound = dealId;

    try {
        const data = await apiFetch(`/api/pipedrive/deal/${dealId}/contacts`);
        const contacts = data?.contacts || [];
        if (title && data?.deal) title.textContent = `Contatos — ${data.deal.title}`;

        if (contacts.length === 0) {
            list.textContent = 'Nenhum contato com telefone encontrado neste deal.';
            return;
        }

        list.innerHTML = contacts.map(c => {
            const phones = c.phones || [];
            return phones.map(phone => `
                <div class="deal-contact-item deal-contact-clickable" data-person-id="${c.id}" data-phone="${escHtml(phone)}" data-name="${escHtml(c.name)}">
                    <div class="deal-contact-info">
                        <div class="deal-contact-name">${escHtml(c.name)}</div>
                        ${c.job_title ? `<div class="deal-contact-role">${escHtml(c.job_title)} — ${escHtml(c.org_name || '')}</div>` : ''}
                        <div class="deal-contact-phone">${escHtml(phone)}</div>
                    </div>
                    <span class="deal-result-action">Iniciar →</span>
                </div>
            `).join('');
        }).join('');

        // Click = seleciona e inicia conversa direto
        list.onclick = async (e) => {
            const item = e.target.closest('.deal-contact-clickable');
            if (!item) return;

            _selectedContactForOutbound = {
                person_id: item.dataset.personId,
                phone: item.dataset.phone,
                name: item.dataset.name,
            };

            // Feedback visual
            item.style.opacity = '0.5';
            item.style.pointerEvents = 'none';
            const actionEl = item.querySelector('.deal-result-action');
            if (actionEl) actionEl.textContent = 'Criando...';

            await sendOutbound();
        };
    } catch (err) {
        list.textContent = 'Erro: ' + err.message;
    }
}

async function sendOutbound() {
    if (!_selectedDealForOutbound || !_selectedContactForOutbound) {
        toast('Selecione um contato primeiro', 'warning');
        return;
    }

    const btn = document.getElementById('btn-send-outbound');
    if (btn) { btn.disabled = true; btn.textContent = 'Criando conversa...'; }

    try {
        const res = await apiFetch('/api/pipedrive/start-outbound', {
            method: 'POST',
            body: JSON.stringify({
                deal_id: _selectedDealForOutbound,
                person_id: _selectedContactForOutbound.person_id,
                phone: _selectedContactForOutbound.phone,
            }),
        });

        toast(`Conversa com ${_selectedContactForOutbound.name} aberta no inbox!`, 'success');

        // Fecha modal e vai para o inbox
        closeDealContactsModal();
        switchTab('inbox');
        await loadInbox();

        // Seleciona a conversa recem criada
        if (res.conversation_id) {
            selectConversation(res.conversation_id);
        }
    } catch (err) {
        toast('Erro: ' + err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Iniciar Conversa WhatsApp'; }
    }
}

function closeDealContactsModal() {
    const modal = document.getElementById('deal-contacts-modal');
    if (modal) modal.style.display = 'none';
}

async function importWhatsAppHistory() {
    const btn = document.getElementById('btn-import-history');
    if (btn) { btn.disabled = true; btn.textContent = 'Importando...'; }

    try {
        const res = await apiFetch('/api/conversations/import-history', { method: 'POST' });
        toast(`Importado: ${res.imported} conversas (${res.skipped} ja existiam)`, 'success');
        loadInbox();
    } catch (err) {
        toast('Erro: ' + err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Importar Historico WhatsApp'; }
    }
}

// ===================================================================

// Auth
window.logout = logout;

// Tabs
window.switchTab = switchTab;
window.switchSettingsTab = switchSettingsTab;

// Inbox / Chat
window.selectConversation = selectConversation;
window.sendMsg            = sendMsg;
window.sendMessage        = sendMessage;
window.handleInputKey     = handleInputKey;
window.toggleScriptsMenu  = toggleScriptsMenu;
window.applyScript        = applyScript;
window.setInboxFilter     = setInboxFilter;
window.setInboxType       = setInboxType;
window.loadConversation   = loadConversation;
window.claimConversation  = claimConversation;
window.releaseConversation = releaseConversation;

// Routing
window.routeConv = routeConv;
window.closeConv = closeConv;

// Leads
window.syncLead            = syncLead;
window.syncLeadToPipedrive = syncLeadToPipedrive;
window.exportLeadsCSV      = exportLeadsCSV;

// CRM sync stubs
window.syncCRM       = syncCRM;
window.syncAllToday  = syncAllToday;

// Scripts
window.editScript        = editScript;
window.deleteScript      = deleteScript;
window.openScriptEditor  = openScriptEditor;
window.closeScriptEditor = closeScriptEditor;
window.saveScript        = saveScript;

// Modals
window.openModal  = openModal;
window.closeModal = closeModal;

// Settings
window.openSettingsModal   = openSettingsModal;
window.closeSettingsModal  = closeSettingsModal;
window.saveSettings        = saveSettings;
window.loadSettingsStages  = loadSettingsStages;
window.handlePhotoUpload   = handlePhotoUpload;

// Users
window.openAddUserForm       = openAddUserForm;
window.closeAddUserForm      = closeAddUserForm;
window.saveUser              = saveUser;
window.openEditUserForm      = openEditUserForm;
window.toggleUserActive      = toggleUserActive;
window.toggleTokenVisibility = toggleTokenVisibility;

// WhatsApp
window.openWaConnect      = openWaConnect;
window.closeWaConnect     = closeWaConnect;
window.generateWaQR       = generateWaQR;
window.disconnectWa       = disconnectWa;
window.openWhatsAppModal  = openWhatsAppModal;
window.closeWhatsAppModal = closeWhatsAppModal;
window.connectWhatsApp    = connectWhatsApp;

// History
window.openHistoryMessages      = openHistoryMessages;
window.showConversationMessages = showConversationMessages;
window.closeHistoryModal        = closeHistoryModal;

// Dashboard
window.loadDashboard = loadDashboard;

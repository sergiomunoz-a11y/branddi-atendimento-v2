/**
 * Simulador de conversa com o Bot Branddi
 * Roda direto no terminal sem precisar de Unipile ou Supabase.
 *
 * Testa: NLP, FAQ, flow completo, entity extraction, sentiment, etc.
 */

// ─── Import dos módulos puros (sem side effects de DB) ───────────────
import {
    classifyIntent, extractEntities, isGreeting, isPureGreeting,
    analyzeSentiment, validateDomain, isMediaOnly, getMediaType,
    isBusinessHours, generateHandoffSummary, calculatePriority
} from './src/services/chatbot-nlp.js';
import { matchFAQ } from './src/services/chatbot-faq.js';

// ─── Cores para o terminal ───────────────────────────────────────────
const C = {
    reset:   '\x1b[0m',
    bold:    '\x1b[1m',
    dim:     '\x1b[2m',
    green:   '\x1b[32m',
    blue:    '\x1b[34m',
    yellow:  '\x1b[33m',
    red:     '\x1b[31m',
    cyan:    '\x1b[36m',
    magenta: '\x1b[35m',
    white:   '\x1b[37m',
    bg_green: '\x1b[42m',
    bg_red:   '\x1b[41m',
};

function bot(msg) {
    // Remove markdown WhatsApp para exibição
    const clean = msg.replace(/\*/g, '').replace(/_/g, '');
    console.log(`${C.green}  🤖 Bot:${C.reset} ${clean}`);
}
function lead(msg) {
    console.log(`${C.blue}  👤 Lead:${C.reset} ${msg}`);
}
function info(msg) {
    console.log(`${C.dim}  ℹ️  ${msg}${C.reset}`);
}
function section(title) {
    console.log(`\n${C.bold}${C.cyan}${'═'.repeat(60)}${C.reset}`);
    console.log(`${C.bold}${C.cyan}  ${title}${C.reset}`);
    console.log(`${C.cyan}${'═'.repeat(60)}${C.reset}\n`);
}
function subsection(title) {
    console.log(`\n${C.yellow}  ── ${title} ${'─'.repeat(40 - title.length)}${C.reset}\n`);
}

// ─── FLOW MESSAGES (replica do engine) ───────────────────────────────

const FLOW = {
    welcome: (name) =>
        `Olá${name ? `, ${name.split(' ')[0]}` : ''}! 👋 Sou o assistente da *Branddi*.\n\n` +
        `Para te direcionar ao time certo, me conta:\n\n` +
        `1️⃣  Quero conhecer os serviços da Branddi\n` +
        `2️⃣  Recebi uma notificação da Branddi\n` +
        `3️⃣  Sou cliente e tenho uma dúvida`,
    ask_company_comercial: `Que ótimo! 🚀 Qual é o nome da sua *empresa*?`,
    ask_company_opec: `Entendido! 🙏 Para registrar corretamente, qual é o nome da sua *empresa*?`,
    ask_domain: `Qual é o endereço do *site* da sua empresa?\n_(ex: minhaempresa.com.br)_`,
    ask_context: `Perfeito! 😊 Em poucas palavras, qual é o *motivo do seu contato* com a Branddi?`,
    classified_comercial: `Ótimo! Um especialista da Branddi vai continuar essa conversa em instantes. 🚀`,
    classified_opec: `Perfeito! Registrei seu contato. Nosso time de *Operações* vai entrar em contato em breve. 🙏`,
    retry_qualifying:
        `Desculpe, não entendi bem. 😅 Por favor, responda com *1*, *2* ou *3*:\n\n` +
        `1️⃣  Quero conhecer os serviços\n` +
        `2️⃣  Recebi uma notificação\n` +
        `3️⃣  Sou cliente com dúvida`,
    domain_invalid:
        `Hmm, não consegui identificar um site válido. 🤔\n` +
        `Pode digitar o endereço completo? _(ex: suaempresa.com.br)_\n\n` +
        `Se não tiver site, digite *pular* e seguimos!`,
};

// ─── SIMULAÇÃO DE CONVERSA COMPLETA ──────────────────────────────────

function simulateConversation(name, messages) {
    let stage = 'welcome';
    let answers = {};
    let classification = null;

    // Welcome
    bot(FLOW.welcome(name));
    stage = 'qualifying';
    console.log();

    for (const msg of messages) {
        lead(msg);

        // Greeting check
        if (isPureGreeting(msg) && stage === 'qualifying') {
            bot(`Olá! 😊\n\nComo posso te ajudar?\n\n1️⃣  Quero conhecer os serviços da Branddi\n2️⃣  Recebi uma notificação da Branddi\n3️⃣  Sou cliente e tenho uma dúvida`);
            console.log();
            continue;
        }

        // Entity extraction (sempre)
        const entities = extractEntities(msg);
        if (Object.keys(entities).length > 0) {
            info(`Entities extraídas: ${JSON.stringify(entities)}`);
            if (entities.company) answers._extracted_company = entities.company;
            if (entities.domain) answers._extracted_domain = entities.domain;
            if (entities.name) answers._extracted_name = entities.name;
        }

        // Sentiment (sempre)
        const sentiment = analyzeSentiment(msg);
        if (sentiment.sentiment !== 'neutral') {
            info(`Sentimento: ${sentiment.sentiment} (score: ${sentiment.score})${sentiment.urgency ? ' ⚠️ URGENTE' : ''}`);
        }

        switch (stage) {
            case 'qualifying': {
                // Check FAQ
                const faqResult = matchFAQ(msg);
                if (faqResult.matched) {
                    bot(faqResult.faq.answer);
                    info(`FAQ matched: ${faqResult.faq.id} (score: ${faqResult.score.toFixed(2)})`);
                    if (faqResult.faq.autoClassify) {
                        answers.intent = faqResult.faq.autoClassify;
                        classification = faqResult.faq.autoClassify;
                    }
                    if (faqResult.faq.followUp === 'classified') {
                        classification = answers.intent || 'comercial';
                        bot(classification === 'opec' ? FLOW.classified_opec : FLOW.classified_comercial);
                        stage = 'human';
                    } else if (faqResult.faq.followUp === 'ask_domain') {
                        answers.intent = answers.intent || 'comercial';
                        bot(FLOW.ask_domain);
                        stage = 'ask_domain';
                    }
                    console.log();
                    continue;
                }

                const result = classifyIntent(msg);
                info(`Intent: ${result.intent || 'null'} (confidence: ${result.confidence.toFixed(2)}, method: ${result.method})`);

                if (!result.intent) {
                    bot(FLOW.retry_qualifying);
                    console.log();
                    continue;
                }

                answers.intent = result.intent;
                answers.intent_raw = msg;
                classification = result.intent;

                // Smart skip com entities
                if (answers._extracted_company) {
                    answers.company_name = answers._extracted_company;
                    if (result.intent === 'comercial' && answers._extracted_domain) {
                        answers.domain = answers._extracted_domain;
                        bot(`Vi que você é da *${answers.company_name}* (${answers.domain})! 🎯\n\n${FLOW.ask_context}`);
                        stage = 'ask_context';
                    } else if (result.intent === 'comercial') {
                        bot(`Vi que você é da *${answers.company_name}*! 🎯\n\n${FLOW.ask_domain}`);
                        stage = 'ask_domain';
                    } else {
                        bot(FLOW.classified_opec);
                        const summary = generateHandoffSummary(answers, { name }, sentiment);
                        info(`Handoff summary gerado (${summary.split('\n').length} linhas)`);
                        stage = 'human';
                    }
                } else {
                    bot(result.intent === 'opec' ? FLOW.ask_company_opec : FLOW.ask_company_comercial);
                    stage = 'ask_company';
                }
                break;
            }

            case 'ask_company': {
                answers.company_name = entities.company || msg.trim();
                info(`Empresa: "${answers.company_name}"`);

                if (classification === 'comercial') {
                    if (entities.domain || answers._extracted_domain) {
                        answers.domain = entities.domain || answers._extracted_domain;
                        bot(FLOW.ask_context);
                        stage = 'ask_context';
                    } else {
                        bot(FLOW.ask_domain);
                        stage = 'ask_domain';
                    }
                } else {
                    bot(FLOW.classified_opec);
                    const priority = calculatePriority(answers, sentiment, { name });
                    info(`Classificado: ${classification} | Prioridade: ${priority}`);
                    const summary = generateHandoffSummary(answers, { name }, sentiment);
                    info(`Handoff summary gerado`);
                    stage = 'human';
                }
                break;
            }

            case 'ask_domain': {
                const skip = ['pular', 'skip', 'não tenho', 'nao tenho', '-'].includes(msg.trim().toLowerCase());
                if (skip) {
                    answers.domain = null;
                    bot(`Sem problemas! 😊\n\n${FLOW.ask_context}`);
                    stage = 'ask_context';
                    console.log();
                    continue;
                }
                const validation = validateDomain(msg);
                info(`Domain validation: ${validation.valid ? '✅' : '❌'} ${validation.domain || validation.reason}`);
                if (!validation.valid) {
                    bot(FLOW.domain_invalid);
                    console.log();
                    continue;
                }
                answers.domain = validation.domain;
                bot(FLOW.ask_context);
                stage = 'ask_context';
                break;
            }

            case 'ask_context': {
                answers.context = msg.trim();
                bot(FLOW.classified_comercial);
                const priority = calculatePriority(answers, sentiment, { name });
                info(`Classificado: ${classification} | Prioridade: ${priority}`);
                const summary = generateHandoffSummary(answers, { name, phone: '11999998888' }, sentiment);
                console.log(`\n${C.magenta}${summary}${C.reset}`);
                stage = 'human';
                break;
            }

            case 'human':
                info(`[Modo humano — bot não responde mais]`);
                break;
        }
        console.log();
    }

    return { stage, answers, classification };
}

// ════════════════════════════════════════════════════════════════════════
//  TESTES
// ════════════════════════════════════════════════════════════════════════

console.log(`\n${C.bold}${C.white}  🤖 SIMULADOR DO BOT BRANDDI v3${C.reset}\n`);

// ─── Teste 1: Fluxo comercial completo ──────────────────────────────
section('TESTE 1: Fluxo Comercial Completo');
simulateConversation('João Silva', [
    '1',
    'TechCorp Brasil',
    'techcorp.com.br',
    'Quero proteger minha marca no Google Ads, muitos concorrentes estão usando',
]);

// ─── Teste 2: Fluxo OPEC (notificação) ─────────────────────────────
section('TESTE 2: Fluxo OPEC — Notificação');
simulateConversation('Maria Santos', [
    'Recebi uma notificação de vocês sobre brand bidding',
    'MegaStore LTDA',
]);

// ─── Teste 3: Saudação + FAQ ─────────────────────────────────────────
section('TESTE 3: Saudação + FAQ');
simulateConversation('Pedro', [
    'Bom dia',
    'Quanto custa o serviço de vocês?',
    'pedroempresa.com.br',
    'Nossos concorrentes estão usando nossa marca no Google',
]);

// ─── Teste 4: Entity extraction inteligente ─────────────────────────
section('TESTE 4: Entity Extraction — Smart Skip');
simulateConversation('Ana', [
    'Oi, sou a Ana da empresa Natura, site natura.com.br, quero conhecer os serviços',
]);

// ─── Teste 5: Lead frustrado (sentiment + urgency) ──────────────────
section('TESTE 5: Lead Frustrado — Urgência');
simulateConversation('Carlos', [
    'ESTOU ESPERANDO HÁ DIAS!!! NINGUÉM RESPONDE!!! ABSURDO!!!',
    'MinhaMarca SA',
]);

// ─── Teste 6: Mensagem confusa → retry → sucesso ───────────────────
section('TESTE 6: Retry — Mensagem Confusa');
simulateConversation('Lucas', [
    'asdfghjk',
    'opa desculpa, quero conhecer os serviços',
    'StartupXYZ',
    'pular',
    'Queremos monitorar anuncios que usam nossa marca',
]);

// ─── Teste 7: FAQ brand bidding ──────────────────────────────────────
section('TESTE 7: FAQ — Brand Bidding');
simulateConversation('Fernanda', [
    'O que é brand bidding?',
    '1',
    'InvestBank',
    'investbank.com.br',
    'Precisamos de proteção da marca no Google Ads',
]);

// ─── Teste 8: Domínio inválido → correção ───────────────────────────
section('TESTE 8: Validação de Domínio');
simulateConversation('Roberto', [
    '1',
    'Loja do Roberto',
    'lojadoroberto',
    'www.lojadoroberto.com.br',
    'Quero proteger minha marca online',
]);

// ─── Testes NLP isolados ─────────────────────────────────────────────
section('TESTES NLP ISOLADOS');

subsection('Intent Classification');
const intentTests = [
    '1', '2', '3',
    'quero conhecer os serviços',
    'recebi uma notificação',
    'sou cliente e tenho uma dúvida',
    'quanto custa a proteção de marca?',
    'estou sendo notificado por vocês',
    'quero um orçamento',
    'negativar termo de busca',
    'agendar uma demo',
    'já sou cliente',
    'blablabla nada a ver',
];
for (const t of intentTests) {
    const r = classifyIntent(t);
    const icon = r.intent === 'comercial' ? '💼' : r.intent === 'opec' ? '📨' : '❓';
    console.log(`  ${icon} "${t}"`);
    console.log(`     → ${r.intent || 'null'} (conf: ${r.confidence.toFixed(2)}, method: ${r.method})`);
}

subsection('Entity Extraction');
const entityTests = [
    'Sou o João da empresa Magazine Luiza',
    'Meu nome é Maria Silva, trabalho na Petrobras',
    'Aqui é o Pedro, email pedro@techcorp.com.br',
    'Site: www.minhaempresa.com.br, telefone 11 99999-8888',
    'Empresa: Natura Cosméticos',
];
for (const t of entityTests) {
    const e = extractEntities(t);
    console.log(`  📝 "${t}"`);
    console.log(`     → ${JSON.stringify(e)}`);
}

subsection('Sentiment Analysis');
const sentimentTests = [
    'Obrigado pela ajuda, vocês são ótimos!',
    'Tudo bem, pode ser',
    'ABSURDO!!! NINGUÉM RESPONDE!!! VOU PROCESSAR!!!',
    'Estou esperando há horas, por favor urgente',
    'ok',
];
for (const t of sentimentTests) {
    const s = analyzeSentiment(t);
    const icon = s.sentiment === 'positive' ? '😊' : s.sentiment === 'negative' ? '😠' : '😐';
    console.log(`  ${icon} "${t}"`);
    console.log(`     → ${s.sentiment} (score: ${s.score})${s.urgency ? ' ⚠️ URGENTE' : ''}`);
}

subsection('Domain Validation');
const domainTests = [
    'minhaempresa.com.br',
    'https://www.google.com/search?q=teste',
    'techcorp',
    'loja do roberto',
    'natura.com.br',
    'sub.domain.empresa.co',
];
for (const t of domainTests) {
    const d = validateDomain(t);
    console.log(`  ${d.valid ? '✅' : '❌'} "${t}" → ${d.domain || d.reason}`);
}

subsection('Business Hours');
const hours = isBusinessHours();
console.log(`  🕐 Agora: ${hours.active ? '✅ Em horário comercial' : '🌙 Fora do horário'}`);
console.log(`     Hora: ${hours.hour}h | Dia: ${hours.dayNum} | Dia útil: ${hours.isWorkDay}`);

subsection('FAQ Matching');
const faqTests = [
    'O que é a Branddi?',
    'Como funciona brand bidding?',
    'Quanto custa o serviço?',
    'Quero agendar uma demo',
    'Recebi uma notificação',
    'Horário de atendimento?',
    'Qual o endereço de vocês?',
    'asdfghjkl',
];
for (const t of faqTests) {
    const r = matchFAQ(t);
    if (r.matched) {
        console.log(`  ✅ "${t}" → FAQ: ${r.faq.id} (score: ${r.score.toFixed(2)})`);
    } else {
        console.log(`  ❌ "${t}" → Sem match`);
    }
}

console.log(`\n${C.bold}${C.green}  ✅ Simulação completa!${C.reset}\n`);

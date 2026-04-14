/**
 * Chatbot FAQ — Sistema inteligente de perguntas frequentes
 *
 * Responde automaticamente perguntas comuns sobre a Branddi
 * sem precisar de intervenção humana.
 *
 * FAQs são hardcoded (built-in) + configuráveis via DB (platform_settings).
 */
import { getSettingValue } from './supabase.js';
import logger from './logger.js';

// ─── FAQs BUILT-IN ───────────────────────────────────────────────────

const BUILTIN_FAQS = [
    {
        id: 'what_is_branddi',
        triggers: [
            'o que é a branddi', 'o que e a branddi', 'o que faz a branddi',
            'o que vocês fazem', 'o que voces fazem', 'qual serviço',
            'quais serviços', 'quais servicos', 'serviço da branddi',
            'como funciona a branddi', 'como a branddi funciona',
        ],
        answer:
            `A *Branddi* é a líder em proteção de marca digital no Brasil! 🛡️\n\n` +
            `Nossos serviços:\n` +
            `🔍 *Brand Bidding* — Identificamos e removemos anúncios não autorizados que usam sua marca no Google Ads\n` +
            `🛑 *Anti-fraude Digital* — Detectamos sites falsos e golpes que usam seu nome\n` +
            `⚖️ *Violação de Marca* — Combatemos o uso indevido da sua marca em marketplaces e redes sociais\n\n` +
            `Quer saber mais sobre algum desses serviços? 😊`,
        followUp: 'qualifying', // volta para o fluxo de qualificação
    },
    {
        id: 'brand_bidding',
        triggers: [
            'brand bidding', 'brandbidding', 'o que é brand bidding',
            'anúncio com minha marca', 'anuncio com minha marca',
            'usando minha marca no google', 'concorrente anunciando',
            'minha marca no google ads', 'anúncio não autorizado',
            'anuncio nao autorizado', 'como funciona brand bidding',
        ],
        answer:
            `*Brand Bidding* é quando terceiros usam o nome da sua marca como palavra-chave no Google Ads. ` +
            `Isso faz você pagar mais caro por cliques que deveriam ser seus! 💸\n\n` +
            `A Branddi monitora em tempo real e remove esses anúncios. ` +
            `Resultado: você economiza até *30% no CPC* e recupera tráfego que era desviado.\n\n` +
            `Quer um diagnóstico gratuito para ver se sua marca está sendo usada? 🔍`,
    },
    {
        id: 'pricing',
        triggers: [
            'quanto custa', 'qual o preço', 'qual o preco', 'valores',
            'tabela de preço', 'tabela de preco', 'planos e preços',
            'planos e precos', 'mensalidade', 'investimento mensal',
            'fee', 'custo mensal', 'pricing', 'orçamento', 'orcamento',
        ],
        answer:
            `Os valores da Branddi variam de acordo com o volume de buscas da sua marca e ` +
            `os serviços contratados. 💰\n\n` +
            `Para te passar uma proposta personalizada, preciso de algumas informações:\n` +
            `• Qual é o site da sua empresa?\n` +
            `• Já investe em Google Ads?\n\n` +
            `Posso te direcionar para um especialista que vai preparar uma proposta sob medida! 🎯`,
        followUp: 'ask_domain', // pula para coleta de domínio
    },
    {
        id: 'demo',
        triggers: [
            'quero ver uma demo', 'demonstração', 'demonstracao',
            'apresentação', 'apresentacao', 'quero agendar',
            'agendar reunião', 'agendar reuniao', 'marcar conversa',
            'quero uma reunião', 'quero uma reuniao',
        ],
        answer:
            `Ótimo! 🎯 Nosso time pode preparar uma apresentação personalizada para mostrar ` +
            `como a Branddi protege sua marca.\n\n` +
            `Para agendar, vou te conectar com um dos nossos especialistas agora mesmo! 🚀`,
        followUp: 'classified', // pula direto para handoff
    },
    {
        id: 'notification',
        triggers: [
            'recebi uma notificação', 'recebi uma notificacao',
            'recebi um email', 'recebi um e-mail',
            'fui notificado', 'fui notificada',
            'notificação de brand', 'notificacao de brand',
            'remover meu anúncio', 'remover meu anuncio',
            'negativar termo', 'negativar palavra',
        ],
        answer:
            `Entendido! Se você recebeu uma notificação da Branddi, nosso time de Operações ` +
            `pode te ajudar. 📋\n\n` +
            `Para agilizar o processo, me diz:\n` +
            `• Qual é o nome da sua empresa?\n` +
            `• Qual termo/palavra-chave foi notificado?\n\n` +
            `Vou encaminhar para a equipe responsável! 🙏`,
        autoClassify: 'opec',
    },
    {
        id: 'support',
        triggers: [
            'já sou cliente', 'ja sou cliente', 'sou cliente',
            'minha conta', 'meu contrato', 'atendimento ao cliente',
            'suporte técnico', 'suporte tecnico', 'falar com suporte',
            'preciso de ajuda', 'problema na conta',
        ],
        answer:
            `Olá! Se você já é cliente Branddi, nosso time de suporte vai te atender. 🤝\n\n` +
            `Para agilizar, me conta:\n` +
            `• Qual é o nome da sua empresa?\n` +
            `• Qual é sua dúvida ou problema?\n\n` +
            `Vou te conectar com a equipe certa! 😊`,
        autoClassify: 'opec',
    },
    {
        id: 'business_hours',
        triggers: [
            'horário de atendimento', 'horario de atendimento',
            'que horas abrem', 'que horas fecham',
            'horário comercial', 'horario comercial',
            'funciona fim de semana', 'funciona sábado', 'funciona sabado',
        ],
        answer:
            `Nosso horário de atendimento é:\n\n` +
            `🕘 *Segunda a Sexta:* 9h às 18h\n` +
            `📍 Horário de Brasília (GMT-3)\n\n` +
            `Fora do horário, você pode deixar sua mensagem que respondemos no próximo dia útil! 😊`,
    },
    {
        id: 'location',
        triggers: [
            'onde ficam', 'onde fica', 'endereço', 'endereco',
            'localização', 'localizacao', 'qual cidade',
            'escritório', 'escritorio', 'sede',
        ],
        answer:
            `A Branddi tem operação 100% digital, atendendo empresas de todo o Brasil! 🇧🇷\n\n` +
            `Nosso time trabalha remotamente para garantir a melhor proteção de marca para nossos clientes. ` +
            `Todas as reuniões são feitas por videoconferência. 💻`,
    },
];

// ─── FAQ MATCHER ─────────────────────────────────────────────────────

/**
 * Busca a FAQ mais relevante para a mensagem.
 * Retorna: { matched: true, faq: {...} } ou { matched: false }
 */
export function matchFAQ(text) {
    const t = (text || '').toLowerCase().trim();
    if (!t || t.length < 5) return { matched: false };

    let bestMatch = null;
    let bestScore = 0;

    for (const faq of BUILTIN_FAQS) {
        for (const trigger of faq.triggers) {
            // Exact match
            if (t === trigger || t.includes(trigger)) {
                const score = trigger.length / t.length; // mais longa = mais específica
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = faq;
                }
            }

            // Partial match: pelo menos 70% das palavras do trigger presentes
            const triggerWords = trigger.split(' ');
            const matchedWords = triggerWords.filter(w => t.includes(w));
            const partial = matchedWords.length / triggerWords.length;
            if (partial >= 0.7 && triggerWords.length >= 2) {
                const adjustedScore = partial * 0.8; // penaliza parcial
                if (adjustedScore > bestScore) {
                    bestScore = adjustedScore;
                    bestMatch = faq;
                }
            }
        }
    }

    // Exige score mínimo de 0.4 para evitar false positives
    if (bestMatch && bestScore >= 0.4) {
        return { matched: true, faq: bestMatch, score: bestScore };
    }

    return { matched: false };
}

// ─── CUSTOM FAQs (via DB) ─────────────────────────────────────────────

let _customFaqsCache = null;
let _customFaqsCacheAt = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

/**
 * Carrega FAQs customizadas do DB e busca match.
 */
export async function matchCustomFAQ(text) {
    try {
        const now = Date.now();
        if (!_customFaqsCache || now - _customFaqsCacheAt > CACHE_TTL) {
            const raw = await getSettingValue('chatbot_custom_faqs', []);
            _customFaqsCache = Array.isArray(raw) ? raw : [];
            _customFaqsCacheAt = now;
        }

        if (_customFaqsCache.length === 0) return { matched: false };

        const t = (text || '').toLowerCase().trim();
        for (const faq of _customFaqsCache) {
            if (!faq.triggers || !faq.answer) continue;
            for (const trigger of faq.triggers) {
                if (t.includes(trigger.toLowerCase())) {
                    return { matched: true, faq, score: 0.9 };
                }
            }
        }
    } catch (err) {
        logger.warn('Error loading custom FAQs', { error: err.message });
    }

    return { matched: false };
}

/**
 * Busca em AMBOS os FAQs (built-in primeiro, depois custom).
 */
export async function findFAQAnswer(text) {
    const builtin = matchFAQ(text);
    if (builtin.matched) return builtin;

    const custom = await matchCustomFAQ(text);
    return custom;
}

// ─── EXPORTS ─────────────────────────────────────────────────────────

export { BUILTIN_FAQS };

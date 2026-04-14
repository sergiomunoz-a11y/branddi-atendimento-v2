/**
 * Validate — Validação inline de campos (sem dependência externa)
 */

/**
 * Valida um body contra um conjunto de regras.
 * @param {object} body - req.body
 * @param {object} rules - { campo: { required, type, enum, maxLength, minLength, pattern } }
 * @returns {string|null} - mensagem de erro ou null se válido
 */
export function validate(body, rules) {
    for (const [field, rule] of Object.entries(rules)) {
        const val = body[field];

        if (rule.required && (val === undefined || val === null || val === '')) {
            return `${field} é obrigatório`;
        }

        if (val !== undefined && val !== null && val !== '') {
            if (rule.type && typeof val !== rule.type) {
                return `${field} deve ser do tipo ${rule.type}`;
            }
            if (rule.enum && !rule.enum.includes(val)) {
                return `${field} deve ser: ${rule.enum.join(', ')}`;
            }
            if (rule.maxLength && String(val).length > rule.maxLength) {
                return `${field} excede ${rule.maxLength} caracteres`;
            }
            if (rule.minLength && String(val).length < rule.minLength) {
                return `${field} deve ter no mínimo ${rule.minLength} caracteres`;
            }
            if (rule.pattern && !rule.pattern.test(String(val))) {
                return `${field} formato inválido`;
            }
        }
    }
    return null;
}

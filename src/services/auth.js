/**
 * Auth Service — JWT + bcrypt helpers
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required. Set it before starting the server.');
}

const JWT_EXPIRES = '7d';

export async function hashPassword(password) {
    return bcrypt.hash(password, 12);
}

export async function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}

export function signToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

export function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch {
        return null;
    }
}

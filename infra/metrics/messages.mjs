import { InvalidReport } from './report.mjs';

export function normalizeMessage(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new InvalidReport('Invalid message');
  const { id, message, email = '', page = '/' } = data;
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) throw new InvalidReport('Invalid submission ID');
  if (typeof message !== 'string' || !message.trim() || message.length > 5000 || message.includes('\0')) throw new InvalidReport('Message must contain 1–5,000 characters');
  if (typeof email !== 'string' || email.length > 254 || (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) || email.includes('\0')) throw new InvalidReport('Invalid email address');
  if (typeof page !== 'string' || page.length > 256 || !/^\/[a-zA-Z0-9/_.-]*$/.test(page)) throw new InvalidReport('Invalid page');
  return { id: id.toLowerCase(), message: message.trim(), email: email.trim() || null, page };
}

export async function insertMessage(db, data) {
  const result = await db.query(`INSERT INTO website_messages (id, message, email, page)
    VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING id`,
  [data.id, data.message, data.email, data.page]);
  if (!result.rowCount) {
    const existing = await db.query(`SELECT message = $2 AND email IS NOT DISTINCT FROM $3 AND page = $4 AS matches
      FROM website_messages WHERE id = $1`, [data.id, data.message, data.email, data.page]);
    if (!existing.rows[0]?.matches) throw Object.assign(new Error('Submission ID already used'), { code: 'MESSAGE_CONFLICT' });
  }
}

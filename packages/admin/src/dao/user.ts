import { query, execute } from '../db/pool.js';

export const jobUserWriteDao = {
  async insert(user: { username: string; password: string; role: number; permission: string | null }): Promise<number> {
    const r = await execute(
      'INSERT INTO xxl_job_user(username, password, role, permission) VALUES (?,?,?,?)',
      [user.username, user.password, user.role, user.permission],
    );
    return Number((r as { insertId: number }).insertId);
  },

  async update(id: number, fields: { password?: string; role?: number; permission?: string | null }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.password !== undefined) {
      sets.push('password = ?');
      params.push(fields.password);
    }
    if (fields.role !== undefined) {
      sets.push('role = ?');
      params.push(fields.role);
    }
    if (fields.permission !== undefined) {
      sets.push('permission = ?');
      params.push(fields.permission);
    }
    if (!sets.length) return;
    await execute(`UPDATE xxl_job_user SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  },

  async remove(id: number): Promise<void> {
    await execute('DELETE FROM xxl_job_user WHERE id = ?', [id]);
  },

  async countAdmins(): Promise<number> {
    const rows = await query<{ c: number }>('SELECT COUNT(1) AS c FROM xxl_job_user WHERE role = 1');
    return Number(rows[0]?.c ?? 0);
  },
};

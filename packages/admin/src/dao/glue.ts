import { query, execute } from '../db/pool.js';

export interface XxlJobLogGlue {
  id: number;
  job_id: number;
  glue_type: string | null;
  glue_source: string | null;
  glue_remark: string;
  add_time: string | null;
  update_time: string | null;
}

export const jobLogGlueDao = {
  async listByJobId(jobId: number): Promise<XxlJobLogGlue[]> {
    return query<XxlJobLogGlue>(
      'SELECT id, job_id, glue_type, glue_source, glue_remark, add_time, update_time FROM xxl_job_logglue WHERE job_id = ? ORDER BY id DESC LIMIT 50',
      [jobId],
    );
  },

  async save(jobId: number, glueType: string, glueSource: string, glueRemark: string): Promise<void> {
    await execute(
      'INSERT INTO xxl_job_logglue(job_id, glue_type, glue_source, glue_remark, add_time, update_time) VALUES (?,?,?,?,now(),now())',
      [jobId, glueType, glueSource, glueRemark],
    );
    // 版本保留上限：仅留最近 50 条
    await execute(
      `DELETE FROM xxl_job_logglue WHERE job_id = ? AND id NOT IN (
         SELECT id FROM (SELECT id FROM xxl_job_logglue WHERE job_id = ? ORDER BY id DESC LIMIT 50) AS keep_ids)`,
      [jobId, jobId],
    );
  },

  async removeByJobId(jobId: number): Promise<void> {
    await execute('DELETE FROM xxl_job_logglue WHERE job_id = ?', [jobId]);
  },
};

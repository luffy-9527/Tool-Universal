import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TextComplianceResult } from '@tool-universal/shared';
import type { AppConfig } from '../config.js';
import {
  extractClientWxOpenId,
  verifyCustomTextCompliance,
} from '../security/contentSecurity.js';

const TextCheckSchema = z.object({
  text: z.string({ required_error: '请提供待检测的文字内容' }),
  scene: z.enum(['watermark', 'document', 'image']).optional(),
});

export function registerComplianceRoutes(app: FastifyInstance, config: AppConfig): void {
  app.post('/api/compliance/text-check', async (request, reply) => {
    const parsed = TextCheckSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        allowed: false,
        suggest: 'risky',
        source: 'local-guard',
        reasonCode: 'CONTENT_COMPLIANCE_BLOCKED',
        message: parsed.error.issues[0]?.message || '请求参数无效',
      } satisfies TextComplianceResult);
    }

    const openid = extractClientWxOpenId(request.headers);
    const result = await verifyCustomTextCompliance(parsed.data.text, config, {
      openid,
      scene: 2,
    });

    if (!result.allowed && result.reasonCode === 'CONTENT_SECURITY_UNAVAILABLE') {
      return reply.code(503).send(result);
    }

    return reply.code(200).send(result);
  });
}

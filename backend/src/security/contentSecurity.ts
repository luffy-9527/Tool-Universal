import {
  COMPLIANCE_UNAVAILABLE_MESSAGE,
  checkCustomTextComplianceLocal,
  formatComplianceBlockMessage,
  mapWechatComplianceLabel,
  type CreateTaskRequest,
  type TextComplianceResult,
} from '@tool-universal/shared';
import type { AppConfig } from '../config.js';

interface WxMsgSecDetailItem {
  strategy?: string;
  errcode?: number;
  suggest?: 'pass' | 'review' | 'risky';
  label?: number;
}

interface WxMsgSecCheckResponse {
  errcode: number;
  errmsg: string;
  result?: {
    suggest?: 'pass' | 'review' | 'risky';
    label?: number;
  };
  detail?: WxMsgSecDetailItem[];
  trace_id?: string;
}

export function extractClientWxOpenId(
  headers: Record<string, string | string[] | undefined>
): string {
  const candidates = [headers['x-wx-openid'], headers['x-wx-from-openid']];
  for (const val of candidates) {
    if (typeof val === 'string' && val.trim()) {
      return val.trim();
    }
    if (Array.isArray(val) && typeof val[0] === 'string' && val[0].trim()) {
      return val[0].trim();
    }
  }
  return '';
}

export function extractTaskCustomTexts(
  request: Pick<CreateTaskRequest, 'toolId' | 'params'>
): Array<{ field: string; text: string }> {
  const texts: Array<{ field: string; text: string }> = [];
  const watermark = request.params?.watermark;
  if (
    watermark &&
    typeof watermark.text === 'string' &&
    watermark.text.trim().length > 0 &&
    (request.toolId === 'pdf-watermark' || watermark.enabled !== false)
  ) {
    texts.push({ field: 'watermark.text', text: watermark.text.trim() });
  }
  return texts;
}

async function callWechatMsgSecCheckV2(
  content: string,
  openid: string,
  scene: number = 2
): Promise<TextComplianceResult> {
  const wxOpenApiBase = process.env.WX_OPENAPI_BASE || 'http://api.weixin.qq.com';

  try {
    const res = await fetch(`${wxOpenApiBase}/wxa/msg_sec_check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        scene,
        openid,
        content,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(
        `[compliance] wxa/msg_sec_check 请求失败 (HTTP ${res.status})${
          errText ? `: ${errText.slice(0, 160)}` : ''
        } — 请确认云托管「云调用」白名单已添加 /wxa/msg_sec_check`
      );
      return {
        allowed: false,
        suggest: 'review',
        source: 'wechat-msg-sec-check',
        reasonCode: 'CONTENT_SECURITY_UNAVAILABLE',
        message: COMPLIANCE_UNAVAILABLE_MESSAGE,
      };
    }

    const data = (await res.json()) as WxMsgSecCheckResponse;

    if (data.errcode === 87014) {
      const category = '违法违规内容';
      return {
        allowed: false,
        suggest: 'risky',
        source: 'wechat-msg-sec-check',
        reasonCode: 'CONTENT_COMPLIANCE_BLOCKED',
        label: 21000,
        category,
        message: formatComplianceBlockMessage(category, 'risky'),
      };
    }

    if (data.errcode !== 0) {
      console.warn(`[compliance] wxa/msg_sec_check 错误 (${data.errcode}): ${data.errmsg}`);
      return {
        allowed: false,
        suggest: 'review',
        source: 'wechat-msg-sec-check',
        reasonCode: 'CONTENT_SECURITY_UNAVAILABLE',
        message: COMPLIANCE_UNAVAILABLE_MESSAGE,
      };
    }

    const detailViolation = Array.isArray(data.detail)
      ? data.detail.find((item) => item.suggest === 'risky' || item.suggest === 'review')
      : undefined;

    const suggest =
      data.result?.suggest === 'risky' || detailViolation?.suggest === 'risky'
        ? 'risky'
        : data.result?.suggest === 'review' || detailViolation?.suggest === 'review'
          ? 'review'
          : data.result?.suggest === 'pass'
            ? 'pass'
            : undefined;

    if (!suggest) {
      console.warn('[compliance] wxa/msg_sec_check 返回缺少有效 suggest 字段:', JSON.stringify(data));
      return {
        allowed: false,
        suggest: 'review',
        source: 'wechat-msg-sec-check',
        reasonCode: 'CONTENT_SECURITY_UNAVAILABLE',
        message: COMPLIANCE_UNAVAILABLE_MESSAGE,
      };
    }

    if (suggest === 'risky' || suggest === 'review') {
      const label = data.result?.label ?? detailViolation?.label;
      const category = mapWechatComplianceLabel(label);
      return {
        allowed: false,
        suggest,
        source: 'wechat-msg-sec-check',
        reasonCode: 'CONTENT_COMPLIANCE_BLOCKED',
        label,
        category,
        message: formatComplianceBlockMessage(category, suggest),
      };
    }

    return {
      allowed: true,
      suggest: 'pass',
      source: 'wechat-msg-sec-check',
      label: data.result?.label,
      message: '通过微信内容安全检测',
    };
  } catch (err: any) {
    console.warn('[compliance] wxa/msg_sec_check 调用异常:', err?.message || err);
    return {
      allowed: false,
      suggest: 'review',
      source: 'wechat-msg-sec-check',
      reasonCode: 'CONTENT_SECURITY_UNAVAILABLE',
      message: COMPLIANCE_UNAVAILABLE_MESSAGE,
    };
  }
}

export async function verifyCustomTextCompliance(
  rawText: string,
  config: Pick<AppConfig, 'storageMode'>,
  options?: { openid?: string; scene?: number }
): Promise<TextComplianceResult> {
  const localResult = checkCustomTextComplianceLocal(rawText);
  if (!localResult.allowed || localResult.source === 'empty') {
    return localResult;
  }

  const trimmed = rawText.trim();
  const openid = options?.openid?.trim() || '';
  const wxCheckEnabled =
    config.storageMode === 'cloudbase' ||
    Boolean(process.env.WX_OPENAPI_BASE) ||
    process.env.ENABLE_WX_SEC_CHECK === 'true';

  if (wxCheckEnabled && openid) {
    return callWechatMsgSecCheckV2(trimmed, openid, options?.scene ?? 2);
  }

  if (config.storageMode === 'cloudbase' && !openid) {
    console.warn('[compliance] 请求头缺少 x-wx-openid，本次仅执行本地内置合规规则拦截检测');
  }

  return localResult;
}

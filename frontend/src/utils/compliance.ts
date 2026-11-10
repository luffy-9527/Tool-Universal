import {
  COMPLIANCE_UNAVAILABLE_MESSAGE,
  checkCustomTextComplianceLocal,
  isComplianceBlockMessage,
  type TextComplianceResult,
} from '@tool-universal/shared';
import { callBackendApi } from './request';

export class ComplianceBlockedError extends Error {
  readonly result: TextComplianceResult;

  constructor(result: TextComplianceResult) {
    super(result.message);
    this.name = 'ComplianceBlockedError';
    this.result = result;
  }
}

export function getLocalTextComplianceWarning(rawText: string): string {
  const verdict = checkCustomTextComplianceLocal(rawText);
  return verdict.allowed ? '' : verdict.message;
}

export function isComplianceError(err: unknown): boolean {
  if (err instanceof ComplianceBlockedError) return true;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as any).message === 'string') {
    return isComplianceBlockMessage((err as any).message);
  }
  return false;
}

export function showComplianceBlockModal(message: string): void {
  if (typeof uni !== 'undefined' && typeof uni.showModal === 'function') {
    uni.showModal({
      title: '内容合规安全提示',
      content: message,
      showCancel: false,
      confirmText: '去修改',
    });
  }
}

/**
 * 统一校验自定义文字合规性：
 * 1. 先执行零延迟本地关键词与变形字符拦截；
 * 2. 再调用云端 `/api/compliance/text-check`（云托管环境会自动通过微信 wxa/msg_sec_check V2 复核）；
 * 3. 命中风险或安全服务不可用时均即时阻断并抛出标准化提示。
 */
export async function ensureCustomTextCompliant(
  rawText: string,
  scene: 'watermark' | 'document' | 'image' = 'watermark'
): Promise<void> {
  const trimmed = (rawText || '').trim();
  if (!trimmed) {
    return;
  }

  const localVerdict = checkCustomTextComplianceLocal(trimmed);
  if (!localVerdict.allowed) {
    throw new ComplianceBlockedError(localVerdict);
  }

  let remoteVerdict: TextComplianceResult;
  try {
    remoteVerdict = await callBackendApi<TextComplianceResult>('/api/compliance/text-check', 'POST', {
      text: trimmed,
      scene,
    });
  } catch (err: any) {
    const msg =
      typeof err?.message === 'string' && isComplianceBlockMessage(err.message)
        ? err.message
        : COMPLIANCE_UNAVAILABLE_MESSAGE;
    throw new ComplianceBlockedError({
      allowed: false,
      suggest: 'review',
      source: 'wechat-msg-sec-check',
      reasonCode: 'CONTENT_SECURITY_UNAVAILABLE',
      message: msg,
    });
  }

  if (!remoteVerdict || !remoteVerdict.allowed) {
    throw new ComplianceBlockedError(
      remoteVerdict || {
        allowed: false,
        suggest: 'risky',
        source: 'wechat-msg-sec-check',
        reasonCode: 'CONTENT_COMPLIANCE_BLOCKED',
        message: '内容合规拦截：您输入的自定义文字包含违法违规或敏感信息，已阻断本次生成，请修改后重试。',
      }
    );
  }
}

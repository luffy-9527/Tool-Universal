import type { ComplianceSuggest, TextComplianceResult } from './api.js';

export const MAX_CUSTOM_TEXT_LENGTH = 500;

export const COMPLIANCE_UNAVAILABLE_MESSAGE =
  '内容合规安全检测服务暂不可用，为保障内容安全已暂停本次生成，请检查网络或稍后重试。';

export function isComplianceBlockMessage(message?: string): boolean {
  if (!message) return false;
  return (
    message.startsWith('内容合规拦截') ||
    message.startsWith('内容合规安全检测') ||
    message.startsWith('内容安全校验')
  );
}

export function mapWechatComplianceLabel(label?: number): string {
  switch (label) {
    case 10001:
      return '广告或恶意引流内容';
    case 20001:
      return '时政敏感信息';
    case 20002:
      return '色情低俗信息';
    case 20003:
      return '辱骂或人身攻击内容';
    case 20006:
      return '违法犯罪或违禁品信息';
    case 20008:
      return '欺诈或虚假违法信息';
    case 20012:
      return '低俗不良信息';
    case 20013:
      return '涉嫌侵权或违规版权信息';
    case 21000:
      return '违法违规或敏感风险信息';
    default:
      return '违法违规或敏感信息';
  }
}

export function formatComplianceBlockMessage(
  category?: string,
  suggest: ComplianceSuggest = 'risky'
): string {
  if (category) {
    return `内容合规拦截：您输入的自定义文字疑似包含${category}，已阻断本次生成，请修改为合法合规的表述后重试。`;
  }
  if (suggest === 'review') {
    return '内容合规拦截：您输入的自定义文字存在安全合规风险，已暂停本次生成，请修改为合法合规的表述后重试。';
  }
  return '内容合规拦截：您输入的自定义文字包含违法违规或敏感信息，已阻断本次生成，请修改为合法合规的表述后重试。';
}

interface LocalComplianceRule {
  label: number;
  category: string;
  /** Matched against full-width->half-width normalized lowercase text */
  exactPatterns?: RegExp[];
  /** Unambiguous multi-char phrases matched against both normalized and punctuation-stripped text */
  phrases: string[];
}

const LOCAL_COMPLIANCE_RULES: LocalComplianceRule[] = [
  {
    label: 20001,
    category: '时政敏感或违禁组织信息',
    exactPatterns: [/\bisis\b/i],
    phrases: [
      '法轮功',
      '全能神',
      '真善忍',
      '天灭中共',
      '九评共产党',
      '台独',
      '藏独',
      '疆独',
      '港独',
      '占中',
      '八九六四',
      '六四事件',
      '天安门事件',
      '颠覆国家政权',
      '分裂国家',
      '恐怖袭击',
      '东突',
      '伊斯兰国',
    ],
  },
  {
    label: 20006,
    category: '涉赌博彩或非法金融信息',
    phrases: [
      '赌博',
      '网赌',
      '网络赌博',
      '跨境赌博',
      '赌球',
      '赌场',
      '澳门赌场',
      '威尼斯人赌场',
      '葡京娱乐场',
      '皇冠现金网',
      '六合彩',
      '地下六合彩',
      '时时彩',
      '幸运飞艇',
      '北京赛车pk10',
      '分分彩',
      '百家乐',
      '洗钱',
      '跑分平台',
      '地下钱庄',
      '套现花呗',
      '信用卡套现',
      '校园贷',
      '裸贷',
      '高利贷',
      '杀猪盘',
      '刷单兼职',
    ],
  },
  {
    label: 20002,
    category: '色情低俗信息',
    exactPatterns: [/\b(porn|pornhub|hentai|nsfw)\b/i],
    phrases: [
      '色情',
      '黄色网站',
      '黄片',
      '成人影片',
      'av女优',
      '约炮',
      '一夜情',
      '援交',
      '招嫖',
      '卖淫',
      '嫖娼',
      '裸聊',
      '强奸',
      '迷奸',
      '乱伦',
      '春药',
      '催情药',
      '听话水',
      '迷情药',
      '色情服务',
      '三级片',
    ],
  },
  {
    label: 20006,
    category: '涉毒或违禁危险物品信息',
    phrases: [
      '冰毒',
      '海洛因',
      '可卡因',
      '大麻出售',
      '吸毒',
      '贩毒',
      '制毒',
      '摇头丸',
      '氯胺酮',
      'k粉',
      '笑气购买',
      '出售枪支',
      '买卖枪支',
      '私藏枪支',
      '炸药配方',
      '自制炸弹',
      '氰化物出售',
    ],
  },
  {
    label: 20008,
    category: '违法制售假证或黑灰产信息',
    phrases: [
      '办假证',
      '办理假证',
      '制售假证',
      '高仿证件',
      '高仿身份证',
      '代办身份证',
      '伪造证件',
      '伪造公章',
      '私刻公章',
      '刻章办证',
      '假毕业证',
      '假学历证',
      '代开假发票',
      '买假发票',
      '兜售假发票',
      '木马病毒',
      '黑客接单',
      '盗号软件',
      '代考包过',
    ],
  },
  {
    label: 20003,
    category: '违法暴力或辱骂内容',
    exactPatterns: [/\b(fuck|bitch|nmsl|cnm)\b/i],
    phrases: ['杀人放火', '买凶杀人', '自杀教程', '教唆自杀', '操你妈', '傻逼', '去死吧'],
  },
];

function stripZeroWidthAndNormalize(input: string): string {
  return input
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    .normalize('NFKC')
    .toLowerCase();
}

function stripSeparatorsForPhraseScan(normalized: string): string {
  return normalized.replace(
    /[\s`~!@#$%^&*()\-_=+[\]{}\\|;:'",.<>/?·•￥…—、。，！？；：“”‘’（）【】《》]/g,
    ''
  );
}

/**
 * Deterministic zero-dependency text compliance check run identically on
 * both mini-program frontend and backend API before generating images/PDFs.
 */
export function checkCustomTextComplianceLocal(rawText: string): TextComplianceResult {
  const trimmed = (rawText || '').trim();
  if (!trimmed) {
    return {
      allowed: true,
      suggest: 'pass',
      source: 'empty',
      message: '通过内容合规检测',
    };
  }

  if (trimmed.length > MAX_CUSTOM_TEXT_LENGTH) {
    return {
      allowed: false,
      suggest: 'risky',
      source: 'local-guard',
      reasonCode: 'CONTENT_LENGTH_EXCEEDED',
      category: '超长限制内容',
      message: `内容合规拦截：自定义文字最多支持 ${MAX_CUSTOM_TEXT_LENGTH} 个字符，请精简后重试。`,
    };
  }

  const normalized = stripZeroWidthAndNormalize(trimmed);
  const compact = stripSeparatorsForPhraseScan(normalized);

  for (const rule of LOCAL_COMPLIANCE_RULES) {
    if (rule.exactPatterns?.some((re) => re.test(normalized))) {
      return {
        allowed: false,
        suggest: 'risky',
        source: 'local-guard',
        reasonCode: 'CONTENT_COMPLIANCE_BLOCKED',
        category: rule.category,
        label: rule.label,
        message: formatComplianceBlockMessage(rule.category, 'risky'),
      };
    }

    for (const phrase of rule.phrases) {
      if (normalized.includes(phrase) || compact.includes(phrase)) {
        return {
          allowed: false,
          suggest: 'risky',
          source: 'local-guard',
          reasonCode: 'CONTENT_COMPLIANCE_BLOCKED',
          category: rule.category,
          label: rule.label,
          message: formatComplianceBlockMessage(rule.category, 'risky'),
        };
      }
    }
  }

  return {
    allowed: true,
    suggest: 'pass',
    source: 'local-guard',
    message: '通过内容合规检测',
  };
}

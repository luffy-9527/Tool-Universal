import { ref } from 'vue';
import type { ToolId } from '@tool-universal/shared';

export interface ConversionRecordItem {
  id: string;
  toolId: ToolId;
  toolTitle: string;
  mode: 'local' | 'cloud';
  inputNames: string[];
  outputCount: number;
  outputSummary: string;
  /** Preview or local path/url (may expire for cloud tmp files after 30 min) */
  primaryFileName: string;
  primaryUrl?: string;
  primarySource?: 'local' | 'cloudbase';
  createdAt: number;
}

const STORAGE_KEY = 'tu_conversion_records_v1';
const MAX_RECORDS = 100;

function readInitial(): ConversionRecordItem[] {
  try {
    const raw = uni.getStorageSync(STORAGE_KEY);
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string' && raw) return JSON.parse(raw);
  } catch {
    // ignore corrupted storage
  }
  return [];
}

export const conversionRecords = ref<ConversionRecordItem[]>(readInitial());

function persist(): void {
  try {
    uni.setStorageSync(STORAGE_KEY, conversionRecords.value);
  } catch {
    // ignore storage quota errors
  }
}

export function addConversionRecord(item: Omit<ConversionRecordItem, 'id' | 'createdAt'>): void {
  const next: ConversionRecordItem = {
    ...item,
    id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: Date.now(),
  };
  conversionRecords.value = [next, ...conversionRecords.value].slice(0, MAX_RECORDS);
  persist();
}

export function removeConversionRecord(id: string): void {
  conversionRecords.value = conversionRecords.value.filter((r) => r.id !== id);
  persist();
}

export function clearConversionRecords(): void {
  conversionRecords.value = [];
  persist();
}

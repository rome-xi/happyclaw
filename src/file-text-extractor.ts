/**
 * Extract plain text from common file types for inline prompt injection.
 *
 * Models like MiniMax-M2.7 often fail to call Read reliably or fabricate from
 * session cache. Feeding extracted text directly into the prompt bypasses the
 * unreliable tool-use round-trip.
 *
 * Supported on macOS:
 * - PDF           → `pdftotext -layout`
 * - DOC/DOCX/RTF  → `textutil -convert txt -stdout`
 * - TXT/MD/CSV/JSON → direct fs read
 * - Other         → returns null (caller keeps the original file path)
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileP = promisify(execFile);

export const EXTRACT_MAX_BYTES = 20 * 1024; // 20 KB
const EXEC_TIMEOUT_MS = 15_000;
const TRUNCATION_NOTE = '\n\n[...内容过长已截断，完整文件见原路径]';

const TEXT_EXTS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.log',
  '.yml',
  '.yaml',
  '.xml',
  '.html',
  '.htm',
]);

const OFFICE_EXTS = new Set(['.doc', '.docx', '.rtf']);

export interface ExtractResult {
  /** Extracted plain text (possibly truncated with a marker). */
  text: string;
  /** True when extracted text exceeded the cap and was truncated. */
  truncated: boolean;
  /** Extractor that produced the text. */
  method: 'pdftotext' | 'textutil' | 'fs';
}

function truncate(text: string): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= EXTRACT_MAX_BYTES) {
    return { text, truncated: false };
  }
  // Cut on a character boundary by slicing utf8 then decoding loosely.
  const sliced = buf.subarray(0, EXTRACT_MAX_BYTES).toString('utf8');
  // Drop the trailing possibly-broken char.
  const safe = sliced.slice(0, Math.max(0, sliced.length - 1));
  return { text: safe + TRUNCATION_NOTE, truncated: true };
}

/**
 * Try to extract plain text from `filePath`. Returns null when the file type
 * is not supported or extraction fails.
 */
export async function extractFileText(
  filePath: string,
): Promise<ExtractResult | null> {
  const ext = path.extname(filePath).toLowerCase();

  try {
    if (ext === '.pdf') {
      const { stdout } = await execFileP(
        'pdftotext',
        ['-layout', filePath, '-'],
        { timeout: EXEC_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      );
      const { text, truncated } = truncate(stdout);
      return { text, truncated, method: 'pdftotext' };
    }

    if (OFFICE_EXTS.has(ext)) {
      // macOS built-in; fails silently on other platforms.
      const { stdout } = await execFileP(
        'textutil',
        ['-convert', 'txt', '-stdout', filePath],
        { timeout: EXEC_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      );
      const { text, truncated } = truncate(stdout);
      return { text, truncated, method: 'textutil' };
    }

    if (TEXT_EXTS.has(ext)) {
      const raw = await fs.readFile(filePath, 'utf8');
      const { text, truncated } = truncate(raw);
      return { text, truncated, method: 'fs' };
    }

    return null;
  } catch {
    // Any extraction failure (missing binary, timeout, bad file) → let the
    // caller fall back to "just reference the file path".
    return null;
  }
}

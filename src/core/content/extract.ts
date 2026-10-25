import { File } from 'expo-file-system';
import { FileoraStorage, type NativeOfficeDocument } from 'fileora-storage';

import { FileoraError, toFileoraError } from '@/core/errors/FileoraError';
import { extensionOf } from '@/core/storage/fileTypes';

/**
 * On-device text extraction. Document content is untrusted input: sizes are capped, parsing happens
 * natively with limits, and nothing is sent anywhere.
 */
export type ExtractionMethod = 'text' | 'office' | 'pdf-ocr' | 'image-ocr';

export type Extraction = {
  method: ExtractionMethod;
  text: string;
  truncated: boolean;
  office?: NativeOfficeDocument;
  pageCount?: number;
  pagesRead?: number;
};

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'log', 'yml', 'yaml', 'ini', 'cfg', 'conf', 'ics', 'vcf', 'srt', 'rtf', 'tex', 'js', 'ts', 'py', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'css', 'sh', 'sql']);
const OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'heic', 'heif', 'gif']);

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;

export function extractionMethodFor(name: string, mimeType: string | null): ExtractionMethod | null {
  const ext = extensionOf(name);
  if (TEXT_EXTENSIONS.has(ext) || (mimeType?.startsWith('text/') ?? false)) return 'text';
  if (!FileoraStorage) return null;
  if (OFFICE_EXTENSIONS.has(ext)) return 'office';
  if (ext === 'pdf' || mimeType === 'application/pdf') return 'pdf-ocr';
  if (IMAGE_EXTENSIONS.has(ext) || (mimeType?.startsWith('image/') ?? false)) return 'image-ocr';
  return null;
}

/** Human description of how text was obtained, shown next to search matches and findings. */
export const METHOD_LABELS: Record<ExtractionMethod, string> = {
  text: 'document text',
  office: 'document text',
  'pdf-ocr': 'scanned PDF text (OCR)',
  'image-ocr': 'text in image (OCR)',
};

export async function extractText(
  file: { uri: string; name: string; mimeType: string | null; size: number | null },
  options: { maxPdfPages: number } = { maxPdfPages: 5 },
): Promise<Extraction> {
  const method = extractionMethodFor(file.name, file.mimeType);
  if (!method) throw new FileoraError('ERR_UNSUPPORTED', 'This file type cannot be read yet');
  try {
    switch (method) {
      case 'text': {
        if (FileoraStorage) {
          const result = await FileoraStorage.readText(file.uri, MAX_TEXT_BYTES);
          return { method, text: result.text, truncated: result.truncated };
        }
        if ((file.size ?? 0) > MAX_TEXT_BYTES) throw new FileoraError('ERR_UNSUPPORTED', 'File is too large to read');
        return { method, text: await new File(file.uri).text(), truncated: false };
      }
      case 'office': {
        if ((file.size ?? 0) > MAX_DOCUMENT_BYTES) throw new FileoraError('ERR_UNSUPPORTED', 'Document is too large to read');
        const office = await FileoraStorage!.extractOfficeDocument(file.uri);
        return { method, text: office.text, truncated: false, office };
      }
      case 'pdf-ocr': {
        if ((file.size ?? 0) > MAX_DOCUMENT_BYTES) throw new FileoraError('ERR_UNSUPPORTED', 'PDF is too large to read');
        const pdf = await FileoraStorage!.extractPdfText(file.uri, options.maxPdfPages);
        return {
          method,
          text: pdf.pages.join('\n\n'),
          truncated: pdf.pageCount > pdf.pages.length,
          pageCount: pdf.pageCount,
          pagesRead: pdf.pages.length,
        };
      }
      case 'image-ocr': {
        if ((file.size ?? 0) > MAX_IMAGE_BYTES) throw new FileoraError('ERR_UNSUPPORTED', 'Image is too large to read');
        const ocr = await FileoraStorage!.recognizeText(file.uri);
        return { method, text: ocr.text, truncated: false };
      }
    }
  } catch (error) {
    throw toFileoraError(error);
  }
}

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DOCUMENT_KINDS = ['resume', 'jobDescription'];

function createEmptyDocumentRecord() {
  return {
    text: '',
    enabled: true,
    source: null,
    hash: null,
    updatedAt: null
  };
}

function getDefaultDocumentsState() {
  return {
    resume: createEmptyDocumentRecord(),
    jobDescription: createEmptyDocumentRecord()
  };
}

function normalizeKind(kind) {
  const normalized = String(kind || '').trim();
  if (normalized === 'cv' || normalized === 'resume') {
    return 'resume';
  }
  if (normalized === 'job' || normalized === 'jobDescription' || normalized === 'job-description') {
    return 'jobDescription';
  }
  return null;
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function sanitizeDocumentRecord(record) {
  const next = createEmptyDocumentRecord();
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return next;
  }

  if (typeof record.text === 'string') {
    next.text = record.text;
  }
  next.enabled = record.enabled !== false;
  if (record.source && typeof record.source === 'object') {
    next.source = {
      type: typeof record.source.type === 'string' ? record.source.type : null,
      name: typeof record.source.name === 'string' ? record.source.name : null,
      path: typeof record.source.path === 'string' ? record.source.path : null,
      mimeType: typeof record.source.mimeType === 'string' ? record.source.mimeType : null
    };
  }
  if (typeof record.hash === 'string' && record.hash.trim()) {
    next.hash = record.hash.trim();
  } else if (next.text) {
    next.hash = hashText(next.text);
  }
  if (typeof record.updatedAt === 'string' || typeof record.updatedAt === 'number') {
    next.updatedAt = record.updatedAt;
  }
  return next;
}

function sanitizeDocumentsState(documents) {
  const defaults = getDefaultDocumentsState();
  if (!documents || typeof documents !== 'object' || Array.isArray(documents)) {
    return defaults;
  }

  return {
    resume: sanitizeDocumentRecord(documents.resume),
    jobDescription: sanitizeDocumentRecord(documents.jobDescription)
  };
}

function detectFileKind(filePath) {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  if (extension === '.pdf') return 'pdf';
  if (extension === '.docx') return 'docx';
  if (extension === '.txt' || extension === '.md' || extension === '.text') return 'txt';
  return null;
}

async function extractTextFromPdf(buffer) {
  const pdfParse = require('pdf-parse');
  const result = await pdfParse(buffer);
  return String(result?.text || '').trim();
}

async function extractTextFromDocx(buffer) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return String(result?.value || '').trim();
}

async function extractTextFromPath(filePath) {
  const absolutePath = path.resolve(String(filePath || ''));
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Document not found: ${absolutePath}`);
  }

  const kind = detectFileKind(absolutePath);
  if (!kind) {
    throw new Error('Unsupported document type. Use PDF, DOCX, or TXT.');
  }

  const buffer = fs.readFileSync(absolutePath);
  let text = '';

  if (kind === 'pdf') {
    text = await extractTextFromPdf(buffer);
  } else if (kind === 'docx') {
    text = await extractTextFromDocx(buffer);
  } else {
    text = buffer.toString('utf8').trim();
  }

  if (!text) {
    throw new Error('No extractable text found in document.');
  }

  return {
    text,
    source: {
      type: 'file',
      name: path.basename(absolutePath),
      path: absolutePath,
      mimeType: kind === 'pdf'
        ? 'application/pdf'
        : kind === 'docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'text/plain'
    }
  };
}

function extractTextFromPaste(text, options = {}) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    throw new Error('Pasted document text is empty.');
  }

  return {
    text: normalized,
    source: {
      type: 'paste',
      name: typeof options.name === 'string' && options.name.trim()
        ? options.name.trim()
        : 'pasted-text',
      path: null,
      mimeType: 'text/plain'
    }
  };
}

function createDocumentService({
  getDocuments,
  saveDocuments,
  onBeforeDocumentsChange,
  now = () => new Date().toISOString()
} = {}) {
  if (typeof getDocuments !== 'function' || typeof saveDocuments !== 'function') {
    throw new Error('document-service requires getDocuments and saveDocuments');
  }

  function readState() {
    return sanitizeDocumentsState(getDocuments());
  }

  async function persistDocuments(nextState, reason) {
    const invalidation = typeof onBeforeDocumentsChange === 'function'
      ? onBeforeDocumentsChange(reason)
      : undefined;
    const save = saveDocuments(nextState);
    const [saved] = await Promise.all([save, invalidation]);
    return sanitizeDocumentsState(saved);
  }

  async function persistKind(kind, payload) {
    const normalizedKind = normalizeKind(kind);
    if (!normalizedKind) {
      throw new Error(`Unsupported document kind: ${kind}`);
    }

    const current = readState();
    const nextRecord = sanitizeDocumentRecord({
      text: payload.text,
      enabled: payload.enabled !== false,
      source: payload.source,
      hash: hashText(payload.text),
      updatedAt: now()
    });

    const nextState = {
      ...current,
      [normalizedKind]: nextRecord
    };

    const saved = await persistDocuments(nextState, 'documents-changed');
    return {
      kind: normalizedKind,
      document: saved[normalizedKind],
      documents: saved
    };
  }

  async function ingestFile(kind, filePath, options = {}) {
    const extracted = await extractTextFromPath(filePath);
    return persistKind(kind, {
      text: extracted.text,
      source: extracted.source,
      enabled: options.enabled !== false
    });
  }

  async function ingestPaste(kind, text, options = {}) {
    const extracted = extractTextFromPaste(text, options);
    return persistKind(kind, {
      text: extracted.text,
      source: extracted.source,
      enabled: options.enabled !== false
    });
  }

  async function setEnabled(kind, enabled) {
    const normalizedKind = normalizeKind(kind);
    if (!normalizedKind) {
      throw new Error(`Unsupported document kind: ${kind}`);
    }

    const current = readState();
    const existing = current[normalizedKind];
    if (!existing?.text) {
      throw new Error(`No ${normalizedKind} document stored yet.`);
    }

    return persistKind(normalizedKind, {
      ...existing,
      enabled: enabled !== false
    });
  }

  async function clear(kind = null) {
    const current = readState();
    if (!kind) {
      const cleared = getDefaultDocumentsState();
      const saved = await persistDocuments(cleared, 'documents-cleared');
      return { documents: saved };
    }

    const normalizedKind = normalizeKind(kind);
    if (!normalizedKind) {
      throw new Error(`Unsupported document kind: ${kind}`);
    }

    const nextState = {
      ...current,
      [normalizedKind]: createEmptyDocumentRecord()
    };
    const saved = await persistDocuments(nextState, 'documents-cleared');
    return { kind: normalizedKind, documents: saved };
  }

  function getEnabledText(kind) {
    const normalizedKind = normalizeKind(kind);
    if (!normalizedKind) {
      return '';
    }
    const record = readState()[normalizedKind];
    if (!record?.enabled || !record.text) {
      return '';
    }
    return record.text;
  }

  function getPinnedDocumentTexts() {
    return {
      resume: getEnabledText('resume'),
      jobDescription: getEnabledText('jobDescription')
    };
  }

  return {
    DOCUMENT_KINDS,
    getDefaultDocumentsState,
    sanitizeDocumentsState,
    sanitizeDocumentRecord,
    hashText,
    extractTextFromPath,
    extractTextFromPaste,
    ingestFile,
    ingestPaste,
    setEnabled,
    clear,
    getEnabledText,
    getPinnedDocumentTexts,
    getDocuments: readState
  };
}

module.exports = {
  DOCUMENT_KINDS,
  createEmptyDocumentRecord,
  getDefaultDocumentsState,
  sanitizeDocumentsState,
  sanitizeDocumentRecord,
  hashText,
  extractTextFromPath,
  extractTextFromPaste,
  createDocumentService
};

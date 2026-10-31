export type DriveKind = 'document' | 'spreadsheet' | 'presentation' | 'file' | 'folder';

export interface DriveTarget {
  id: string;
  kind: DriveKind;
}

export interface DriveFetch {
  status: number;
  contentType: string | null;
  body: Buffer;
}

export interface DrivePage {
  source: 'drive';
  id: string;
  kind: DriveKind;
  title: string;
  url: string;
  body: string;
  encoding: 'utf8' | 'base64';
}

const ID = '([a-zA-Z0-9_-]+)';

export function driveTarget(url: string): DriveTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  if (host !== 'docs.google.com' && host !== 'drive.google.com') {
    return null;
  }
  const path = parsed.pathname;
  const documentId = path.match(new RegExp(`/document/(?:u/\\d+/)?d/${ID}`))?.[1];
  if (documentId) {
    return { id: documentId, kind: 'document' };
  }
  const sheetId = path.match(new RegExp(`/spreadsheets/(?:u/\\d+/)?d/${ID}`))?.[1];
  if (sheetId) {
    return { id: sheetId, kind: 'spreadsheet' };
  }
  const slideId = path.match(new RegExp(`/presentation/(?:u/\\d+/)?d/${ID}`))?.[1];
  if (slideId) {
    return { id: slideId, kind: 'presentation' };
  }
  const fileId = path.match(new RegExp(`/file/(?:u/\\d+/)?d/${ID}`))?.[1];
  if (fileId) {
    return { id: fileId, kind: 'file' };
  }
  const folderId = path.match(new RegExp(`/folders/${ID}`))?.[1];
  if (folderId) {
    return { id: folderId, kind: 'folder' };
  }
  const openId = parsed.searchParams.get('id');
  if (openId && /^[a-zA-Z0-9_-]+$/.test(openId)) {
    return { id: openId, kind: 'file' };
  }
  return null;
}

export function driveExportUrl(target: DriveTarget): string | null {
  if (target.kind === 'document') {
    return `https://docs.google.com/document/d/${target.id}/export?format=txt`;
  }
  if (target.kind === 'presentation') {
    return `https://docs.google.com/presentation/d/${target.id}/export?format=txt`;
  }
  if (target.kind === 'spreadsheet') {
    return `https://docs.google.com/spreadsheets/d/${target.id}/export?format=xlsx`;
  }
  if (target.kind === 'file') {
    return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(target.id)}`;
  }
  return null;
}

export async function loadDrive(url: string, get: (exportUrl: string) => Promise<DriveFetch>): Promise<DrivePage> {
  const target = driveTarget(url);
  const exportUrl = target ? driveExportUrl(target) : null;
  if (!target || !exportUrl) {
    throw new Error(`drive is not readable: ${url}`);
  }
  const response = await get(exportUrl);
  const type = (response.contentType ?? '').toLowerCase();
  if (response.status < 200 || response.status >= 300 || type.includes('html') || response.body.length === 0) {
    throw new Error(`drive is not readable: ${url}`);
  }
  const text = type.startsWith('text/') || type.includes('json') || type.includes('csv');
  return {
    source: 'drive',
    id: target.id,
    kind: target.kind,
    title: target.id,
    url,
    body: text ? response.body.toString('utf8') : response.body.toString('base64'),
    encoding: text ? 'utf8' : 'base64',
  };
}

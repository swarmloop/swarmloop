import { driveExportUrl, driveTarget, loadDrive } from './drive';

describe('drive pages', () => {
  it('reads every export for a document, a spreadsheet, and a file', async () => {
    const document = await loadDrive('https://docs.google.com/document/d/abc_1/edit', async (exportUrl) => {
      expect(exportUrl).toBe('https://docs.google.com/document/d/abc_1/export?format=txt');
      return { status: 200, contentType: 'text/plain', body: Buffer.from('page one\npage two') };
    });
    expect(document.body).toBe('page one\npage two');
    expect(document.encoding).toBe('utf8');

    const sheet = await loadDrive('https://docs.google.com/spreadsheets/u/0/d/sheet1/edit#gid=0', async (exportUrl) => {
      expect(exportUrl).toBe('https://docs.google.com/spreadsheets/d/sheet1/export?format=xlsx');
      return { status: 200, contentType: 'application/vnd.ms-excel', body: Buffer.from([1, 2, 3]) };
    });
    expect(sheet.encoding).toBe('base64');
    expect(Buffer.from(sheet.body, 'base64')).toEqual(Buffer.from([1, 2, 3]));

    const file = await loadDrive('https://drive.google.com/file/d/file1/view', async () => ({
      status: 200,
      contentType: 'text/plain',
      body: Buffer.from('file text'),
    }));
    expect(file.id).toBe('file1');
    expect(file.body).toBe('file text');
  });

  it('fails a folder and an unread page instead of storing a partial page', async () => {
    await expect(loadDrive('https://drive.google.com/drive/folders/folder1', async () => {
      throw new Error('should not fetch a folder');
    })).rejects.toThrow('drive is not readable: https://drive.google.com/drive/folders/folder1');

    await expect(
      loadDrive('https://docs.google.com/presentation/d/slides1/edit', async () => ({
        status: 200,
        contentType: 'text/html',
        body: Buffer.from('<html>Sign in</html>'),
      })),
    ).rejects.toThrow('drive is not readable: https://docs.google.com/presentation/d/slides1/edit');

    expect(driveTarget('https://example.com/file')).toBeNull();
    expect(driveExportUrl({ id: 'folder1', kind: 'folder' })).toBeNull();
  });
});

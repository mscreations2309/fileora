import { buildManifest, type Workspace, type WorkspaceItem } from '../repository';

jest.mock('@/core/database/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/core/storage/storage', () => ({ storage: {} }));

const workspace: Workspace = {
  id: 'w1',
  name: 'Car Purchase',
  note: 'private note',
  labels: ['2026'],
  color: 'indigo',
  pinned: false,
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  itemCount: 1,
  missingCount: 0,
};

const item: WorkspaceItem = {
  workspaceId: 'w1',
  uri: 'content://com.android.externalstorage.documents/tree/primary%3AFinance/document/primary%3AFinance%2Finvoice.pdf',
  parentUri: 'content://x',
  locationId: 'l',
  name: 'invoice.pdf',
  isDirectory: false,
  size: 1234,
  mimeType: 'application/pdf',
  collection: 'Invoices',
  note: 'paid in full',
  missing: false,
  addedAt: 0,
  checkedAt: 0,
};

describe('buildManifest', () => {
  it('omits locations and notes by default', () => {
    const json = buildManifest(workspace, [item], { includeLocations: false, includeNotes: false });
    expect(json).not.toContain('content://');
    expect(json).not.toContain('private note');
    expect(json).not.toContain('paid in full');
    const parsed = JSON.parse(json);
    expect(parsed.items[0]).toEqual({ name: 'invoice.pdf', type: 'file', size: 1234, collection: 'Invoices' });
  });

  it('includes them only when asked', () => {
    const json = buildManifest(workspace, [item], { includeLocations: true, includeNotes: true });
    expect(json).toContain('content://');
    expect(json).toContain('paid in full');
  });
});

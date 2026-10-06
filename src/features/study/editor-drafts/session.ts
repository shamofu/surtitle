import { editorDraftApi, type EditorDraft, type EditorKind } from './api';
import type { SubtitleSegment } from '../../../shared/contracts/media';

export type DraftSaveStatus = 'loading' | 'saved' | 'saving' | 'error';
export interface DraftSessionOptions {
  mediaId: string;
  kind: EditorKind;
  sourceKey: string;
  sourceCues: SubtitleSegment[];
  initialValue: Record<string, string>;
}

/** Keeps writes alive across a component closing, and serializes each CAS version. */
export class EditorDraftSession {
  value: Record<string, string>;
  draft?: EditorDraft;
  status: DraftSaveStatus = 'loading';
  error = '';
  private listeners = new Set<() => void>();
  private loaded: Promise<void>;
  private inFlight?: Promise<EditorDraft | undefined>;
  private timer?: ReturnType<typeof setTimeout>;
  private savedValue: string;
  private edited = false;
  private consumed = false;
  private invalidated = false;
  private loadSucceeded = false;
  private id: string = crypto.randomUUID();
  constructor(readonly options: DraftSessionOptions) {
    this.value = { ...options.initialValue };
    this.savedValue = options.kind === 'phrase' ? '' : JSON.stringify(this.value);
    this.loaded = this.load();
    void this.loaded.catch(() => {});
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private emit() { for (const listener of this.listeners) listener(); }
  private async load() {
    try {
      const items = await editorDraftApi.list(this.options.mediaId);
      const stored = items.find(item => item.kind === this.options.kind && item.sourceKey === this.options.sourceKey);
      if (stored) {
        this.draft = stored;
        this.id = stored.id;
        this.savedValue = JSON.stringify(stored.fields);
        if (!this.edited) this.value = { ...stored.fields };
      }
      const changed = JSON.stringify(this.value) !== this.savedValue;
      this.status = changed ? 'saving' : 'saved';
      this.loadSucceeded = true;
      this.error = '';
      if (changed) this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, 500);
    } catch (error) {
      this.status = 'error';
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { this.emit(); }
  }
  setValue(value: Record<string, string>) {
    if (this.invalidated) return;
    this.consumed = false;
    this.edited = true;
    this.value = { ...value };
    this.status = 'saving';
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, 500);
    this.emit();
  }
  async flush(force = false): Promise<EditorDraft | undefined> {
    if (this.invalidated) throw new Error('A backup was restored. Reopen this editor to continue.');
    clearTimeout(this.timer);
    if (this.inFlight) { await this.inFlight; return this.flush(force); }
    if (this.consumed) return undefined;
    const operation = async () => {
      try {
        await this.loaded;
        while (!this.consumed && ((force && !this.draft) || JSON.stringify(this.value) !== this.savedValue)) {
          this.status = 'saving'; this.emit();
          const fields = { ...this.value };
          const saved = await editorDraftApi.save({
            mediaId: this.options.mediaId, kind: this.options.kind,
            sourceKey: this.options.sourceKey, sourceCues: this.options.sourceCues,
            id: this.id, expectedVersion: this.draft?.version ?? 0, fields,
          });
          this.draft = saved;
          this.savedValue = JSON.stringify(fields);
        }
        this.status = 'saved'; this.error = ''; this.emit();
        return this.draft;
      } catch (error) {
        this.status = 'error';
        this.error = error instanceof Error ? error.message : String(error);
        this.emit();
        throw error;
      }
    };
    this.inFlight = operation();
    try { return await this.inFlight; } finally { this.inFlight = undefined; }
  }
  async retry() {
    if (this.status === 'error' && !this.draft) this.loaded = this.load();
    return this.flush();
  }
  async discard() {
    if (this.invalidated) throw new Error('A backup was restored. Reopen this editor to continue.');
    clearTimeout(this.timer);
    await this.loaded;
    if (this.inFlight) await this.inFlight;
    if (this.draft) await editorDraftApi.discard(this.draft);
    this.consume();
  }
  consume() {
    clearTimeout(this.timer);
    this.consumed = true;
    this.draft = undefined;
    this.savedValue = JSON.stringify(this.value);
    this.status = 'saved'; this.error = ''; this.emit();
  }
  invalidate() {
    clearTimeout(this.timer);
    this.invalidated = true; this.consumed = true;
    this.status = 'error'; this.error = 'A backup was restored. Reopen this editor to continue.';
    this.emit();
  }
  async rebind(sourceCues: SubtitleSegment[]) {
    const saved = await this.flush(true);
    if (!saved) return;
    const operation = async () => {
      this.draft = await editorDraftApi.rebind(saved, sourceCues);
      const previousKey = sessionKey(this.options);
      this.options.sourceCues = sourceCues;
      this.options.sourceKey = this.draft.sourceKey;
      const registered = sessions.get(previousKey);
      if (registered?.session === this) {
        sessions.delete(previousKey); sessions.set(sessionKey(this.options), registered);
      }
      this.emit();
      return this.draft;
    };
    this.inFlight = operation();
    try { return await this.inFlight; } finally { this.inFlight = undefined; }
  }
  get ready() { return this.loadSucceeded; }
}

const sessions = new Map<string, { session: EditorDraftSession; users: number }>();
const sessionKey = (options: DraftSessionOptions) => JSON.stringify([options.mediaId, options.kind, options.sourceKey]);
export function acquireEditorDraft(options: DraftSessionOptions) {
  const key = sessionKey(options);
  let entry = sessions.get(key);
  if (!entry) { entry = { session: new EditorDraftSession(options), users: 0 }; sessions.set(key, entry); }
  entry.users++;
  const current = entry;
  return { session: current.session, release: () => {
    current.users--;
    if (!current.users) void current.session.flush().then(() => {
      const currentKey = sessionKey(current.session.options);
      if (!current.users && sessions.get(currentKey) === current) sessions.delete(currentKey);
    }).catch(() => { /* Keep failed writes recoverable and registered for a retry. */ });
  } };
}

/** Await this before leaving the page, opening setup, or closing the native window. */
export async function flushEditorDrafts() {
  await Promise.all([...sessions.values()].map(({ session }) => session.flush()));
}

/** Call only after flushEditorDrafts and a successful restore. Never deletes imported drafts. */
export function clearEditorDraftSessions() {
  for (const { session } of sessions.values()) session.invalidate();
  sessions.clear();
}

// SPDX-License-Identifier: GPL-3.0-or-later
import type { DraftKind, EditFields, UiDraft } from '../contracts/editing';
import { uiDraftApi } from './drafts';

export interface EditState { fields: EditFields; revision: string }
export interface EditAdapter {
  read: () => Promise<EditState>;
  save: (fields: EditFields, previous: EditState) => Promise<EditState & { applied: string[] }>;
  changed?: () => void;
  draftOnly?: string[];
}
export interface EditorView {
  fields: EditFields;
  ready: boolean;
  saving: boolean;
  dirty: boolean;
  error?: string;
  recovery?: EditFields;
}
type DraftStore = typeof uiDraftApi;
const same = (a: EditFields, b: EditFields) => JSON.stringify(a) === JSON.stringify(b);

/** Lives outside the mounted editor: navigation does not abandon a save. */
export class EditingSession {
  private view: EditorView = { fields: {}, ready: false, saving: false, dirty: false };
  private listeners = new Set<() => void>();
  private baseline: EditState = { fields: {}, revision: '' };
  private draftRevision = 0;
  private version = 0;
  private persistedVersion = 0;
  private writing?: Promise<void>;
  private committing?: Promise<boolean>;
  private initializing?: Promise<void>;
  private refreshing?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private foreignDraft?: UiDraft;
  private detachedRecovery?: EditFields;
  constructor(readonly kind: DraftKind, readonly entityId: string, private adapter: EditAdapter, private drafts: DraftStore = uiDraftApi) {}
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<EditorView>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach(listener => listener());
  }
  private isDirty(fields: EditFields) {
    return Object.keys({ ...fields, ...this.baseline.fields }).some(key => !this.adapter.draftOnly?.includes(key) && fields[key] !== this.baseline.fields[key]);
  }
  load() {
    return this.initializing ??= this.initialize();
  }
  refresh(): Promise<void> {
    return this.refreshing ??= this.refreshCurrent().finally(() => { this.refreshing = undefined; });
  }
  private async refreshCurrent() {
    if (!this.view.ready) return this.load();
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.committing;
    await this.writing?.catch(() => {});
    if (this.persistedVersion < this.version) return; // Failed durable writes must keep their only copy in memory.
    // Read both the authoritative revision and durable input again after navigation/restore.
    // An older input revision is offered for recovery, never silently replayed.
    this.initializing = this.initialize();
    return this.initializing;
  }
  private async initialize() {
    const requestedVersion = this.version;
    try {
      const [state, draft] = await Promise.all([this.adapter.read(), this.drafts.get(this.kind, this.entityId)]);
      // A reopened editor stays usable while reading. Never replace text typed
      // since that read began, or adopt a stale durable revision for its writes.
      if (requestedVersion !== this.version) return;
      this.baseline = state;
      this.draftRevision = draft?.revision ?? 0;
      const { baseRevision, recovery: recoveryJson, ...fields } = draft?.fields ?? {};
      let recovery: EditFields | undefined;
      if (recoveryJson) recovery = JSON.parse(recoveryJson) as EditFields;
      const recover = !!draft && Object.keys(fields).length > 0 && (draft.stale || baseRevision !== state.revision);
      const initial = draft && !recover && !this.detachedRecovery ? { ...state.fields, ...fields } : state.fields;
      if (this.detachedRecovery) this.foreignDraft = draft ?? undefined;
      this.persistedVersion = this.version;
      this.publish({ ready: true, fields: initial, dirty: this.isDirty(initial), recovery: this.detachedRecovery ?? (recover ? { ...recovery, ...fields } : recovery), error: undefined });
      if (this.view.dirty) this.schedule();
    } catch (error) {
      this.publish({ error: String(error) });
      this.initializing = undefined;
    }
  }
  change(patch: EditFields) {
    if (!this.view.ready) return;
    const fields = { ...this.view.fields, ...patch };
    if (same(fields, this.view.fields)) return;
    this.version++;
    this.publish({ fields, dirty: this.isDirty(fields), error: undefined });
    void this.persist().catch(() => {});
    this.schedule();
  }
  recover() {
    if (!this.view.recovery) return;
    const fields = this.view.recovery;
    this.detachedRecovery = undefined;
    this.publish({ recovery: undefined });
    this.change(fields);
  }
  /** Consume a successfully submitted draft; creating content remains explicit. */
  async resetDraft() {
    if (!await this.flush()) throw new Error(this.view.error || 'Unable to save unfinished input');
    clearTimeout(this.timer);
    this.timer = undefined;
    const version = this.version;
    const reset = async () => {
      await this.archiveForeignDraft();
      if (this.draftRevision) await this.drafts.remove(this.kind, this.entityId, this.draftRevision);
      this.draftRevision = 0;
      if (this.version === version) {
        this.version++;
        this.persistedVersion = this.version;
        this.publish({ fields: { ...this.baseline.fields }, dirty: false, recovery: undefined, error: undefined });
      } else {
        // Input written during consumption belongs to the next draft.
        this.persistedVersion = Math.min(this.persistedVersion, version);
      }
    };
    this.writing = reset().finally(() => { this.writing = undefined; });
    await this.writing;
    await this.persist();
  }
  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, 500);
  }
  private async archiveForeignDraft() {
    const draft = this.foreignDraft;
    if (!draft) return;
    // A later explicit edit may acquire this token, but must preserve the other
    // writer's input before replacing/deleting its active record.
    await this.drafts.archive(this.kind, this.entityId, draft.fields);
    if (this.foreignDraft === draft) this.foreignDraft = undefined;
  }
  private async preserveDraftConflict(latest: UiDraft | null, error: unknown) {
    const version = this.version;
    const incoming = { ...this.view.fields };
    await this.drafts.archive(this.kind, this.entityId, { ...incoming, baseRevision: this.baseline.revision,
      ...(this.view.recovery ? { recovery: JSON.stringify(this.view.recovery) } : {}) });
    const current = await this.adapter.read().catch(() => undefined);
    // Typing during archival still needs its own durable write. Keep the old
    // token so the next iteration also detects the competing active record.
    if (version !== this.version) { this.persistedVersion = version; return; }
    if (current) this.baseline = current;
    this.foreignDraft = latest ?? undefined;
    this.draftRevision = latest?.revision ?? 0;
    this.detachedRecovery = incoming;
    this.version++;
    this.persistedVersion = this.version;
    this.publish({ fields: { ...this.baseline.fields }, dirty: false, recovery: incoming, error: String(error) });
  }
  private persist(): Promise<void> {
    if (this.writing) return this.writing;
    const write = async () => {
      while (this.persistedVersion < this.version) {
        const version = this.version;
        const changed = Object.fromEntries(Object.entries(this.view.fields).filter(([key, value]) => value !== this.baseline.fields[key]));
        try {
          await this.archiveForeignDraft();
          if (!Object.keys(changed).length && !this.view.recovery) {
            // Successful edits must not consume the unfinished-draft capacity.
            if (this.draftRevision) await this.drafts.remove(this.kind, this.entityId, this.draftRevision);
            this.draftRevision = 0;
          } else {
            const saved: UiDraft = await this.drafts.save(this.kind, this.entityId, this.draftRevision,
              { ...changed, baseRevision: this.baseline.revision, ...(this.view.recovery ? { recovery: JSON.stringify(this.view.recovery) } : {}) });
            this.draftRevision = saved.revision;
          }
          this.persistedVersion = version;
        } catch (error) {
          const latest = await this.drafts.get(this.kind, this.entityId);
          if ((latest?.revision ?? 0) === this.draftRevision) throw error;
          await this.preserveDraftConflict(latest, error);
        }
      }
    };
    this.writing = write().catch(error => { this.publish({ error: String(error) }); throw error; }).finally(() => { this.writing = undefined; });
    return this.writing;
  }
  get pending() { return this.persistedVersion < this.version || !!this.committing || !!this.timer; }
  flush = (): Promise<boolean> => {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.view.ready && this.view.error) return this.load().then(() => this.view.ready ? this.flush() : false);
    if (this.committing) return this.committing.then(() => this.flush());
    this.committing = this.commit().finally(() => { this.committing = undefined; });
    return this.committing;
  };
  private async commit(): Promise<boolean> {
    if (!this.view.ready) return !this.view.error;
    this.publish({ saving: true, error: undefined });
    try {
      await this.persist();
      while (this.view.dirty) {
        const submitted = this.view.fields;
        let result: EditState & { applied: string[] };
        try {
          result = await this.adapter.save(submitted, this.baseline);
        } catch (error) {
          // A failed write may be a revision conflict. Preserve the user's input
          // separately and display current content; never replay it over restore
          // or another writer. Ordinary I/O failures keep their retryable fields.
          const current = await this.adapter.read().catch(() => undefined);
          if (current && current.revision !== this.baseline.revision) {
            const unfinished = Object.fromEntries(Object.entries(this.view.fields).filter(([key, value]) => value !== this.baseline.fields[key]));
            if (this.view.recovery && Object.keys(unfinished).some(key =>
              this.view.recovery?.[key] !== undefined && this.view.recovery[key] !== unfinished[key])) {
              // Repeated source conflicts can contain two different raw values
              // for one field. Archive the older recovery before replacing it.
              await this.drafts.archive(this.kind, this.entityId, { ...this.view.recovery, baseRevision: this.baseline.revision });
            }
            this.baseline = current;
            this.version++;
            this.publish({ fields: current.fields, dirty: false, recovery: { ...this.view.recovery, ...unfinished } });
            await this.persist();
          }
          throw error;
        }
        this.baseline = { fields: result.fields, revision: result.revision };
        const fields = { ...this.view.fields };
        // Canonicalize only fields actually saved and not edited again in flight.
        for (const key of result.applied) if (fields[key] === submitted[key]) fields[key] = result.fields[key];
        this.publish({ fields, dirty: this.isDirty(fields) });
        this.version++;
        await this.persist();
        if (result.applied.length) this.adapter.changed?.();
        if (!result.applied.length) break;
        if (Object.keys(fields).some(key => fields[key] !== submitted[key] && !result.applied.includes(key))) {
          // Let newer input finish its debounce instead of saving every keystroke.
          this.schedule();
          break;
        }
      }
      return true;
    } catch (error) {
      this.publish({ error: String(error) });
      return false;
    } finally { this.publish({ saving: false }); }
  }
}

const sessions = new Map<string, EditingSession>();
export function editingSession(kind: DraftKind, entityId: string, adapter: EditAdapter) {
  const key = `${kind}:${entityId}`;
  let session = sessions.get(key);
  if (!session) { session = new EditingSession(kind, entityId, adapter); sessions.set(key, session); }
  return session;
}
export const pendingEdits = () => [...sessions.values()].some(session => session.pending);
export async function flushEdits() { return (await Promise.all([...sessions.values()].map(session => session.flush()))).every(Boolean); }
export async function refreshEdits() { await Promise.all([...sessions.values()].map(session => session.refresh())); }

// SPDX-License-Identifier: GPL-3.0-or-later
import { libraryApi } from './api';
import { languagePair, mergeQueue, validatedItem, type ImportQueueItem } from './import-queue';
import { uiDraftApi } from '../../shared/editing/drafts';
import type { ActivityDescriptor, ActivityUpdate, TrackedOptions } from '../../shared/contracts/activity';
import type { UiDraft } from '../../shared/contracts/editing';

interface ImportView {
  ready: boolean;
  learningLanguage: string; explanationLanguage: string;
  rows: ImportQueueItem[]; busy: boolean; completed: number; total: number; error?: string;
}
type Track = <T>(descriptor: ActivityDescriptor, action: (update: (patch: ActivityUpdate) => void) => Promise<T>, options?: TrackedOptions<T>) => Promise<T>;
type Commit = <T>(action: () => Promise<T>) => Promise<T>;
type ImportFields = Partial<Pick<ImportView, 'learningLanguage' | 'explanationLanguage'>>;

/** App-owned work keeps running when its panel is closed. */
export class ImportWorkspace {
  private view: ImportView = { ready: false, learningLanguage: 'en', explanationLanguage: 'ja', rows: [], busy: false, completed: 0, total: 0 };
  private listeners = new Set<() => void>();
  private initialization?: Promise<void>;
  private writing?: Promise<void>;
  private revision = 0;
  private version = 0;
  private persisted = 0;
  private nextId = 0;
  private earlyChanges: ImportFields = {};
  private foreignDraft?: UiDraft;
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<ImportView>, persist = true) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach(listener => listener());
    if (persist) { this.version++; void this.flush().catch(() => {}); }
  }
  initialize(learningLanguage: string, explanationLanguage: string) {
    return this.initialization ??= (async () => {
      try {
        const saved = await uiDraftApi.get('import', 'default');
        this.revision = saved?.revision ?? 0;
        const fields = saved?.fields;
        let rows: ImportQueueItem[] = [];
        if (fields?.rows) {
          const parsed: unknown = JSON.parse(fields.rows);
          if (Array.isArray(parsed)) rows = parsed.filter((row): row is ImportQueueItem => !!row && typeof row.inputPath === 'string' && typeof row.id === 'number').map(row =>
            row.status === 'importing' || row.status === 'ready' ? { ...row, status: 'failed', error: 'Interrupted — retry to continue.' } : row);
        }
        this.nextId = Math.max(0, ...rows.map(row => row.id));
        this.publish({ ready: true,
          learningLanguage: fields?.learningLanguage ?? learningLanguage, explanationLanguage: fields?.explanationLanguage ?? explanationLanguage,
          rows, ...this.earlyChanges, error: undefined }, false);
        this.earlyChanges = {};
      } catch (error) {
        // Do not claim an empty revision after a read failure. That would both
        // overwrite visible typing and make every subsequent CAS save conflict.
        this.initialization = undefined;
        this.publish({ ready: false, learningLanguage, explanationLanguage, ...this.earlyChanges, error: String(error) }, false);
      }
    })();
  }
  change(patch: ImportFields) {
    if (!this.view.ready) this.earlyChanges = { ...this.earlyChanges, ...patch };
    this.publish(patch);
  }
  clear() { if (!this.view.busy) this.publish({ rows: [], error: undefined }); }
  remove(id: number) { if (!this.view.busy) this.publish({ rows: this.view.rows.filter(row => row.id !== id) }); }
  get pending() { return this.persisted < this.version; }
  flush(): Promise<void> {
    if (!this.view.ready) return this.initialize(this.view.learningLanguage, this.view.explanationLanguage).then(() => {
      if (!this.view.ready) throw new Error(this.view.error || 'Unable to read unfinished import input');
      return this.flush();
    });
    if (this.writing) return this.writing;
    this.writing = (async () => {
      while (this.persisted < this.version) {
        const version = this.version;
        const { learningLanguage, explanationLanguage, rows } = this.view;
        const fields = { learningLanguage, explanationLanguage, rows: JSON.stringify(rows) };
        try {
          if (this.foreignDraft) {
            await uiDraftApi.archive('import', 'default', this.foreignDraft.fields);
            this.foreignDraft = undefined;
          }
          const saved = await uiDraftApi.save('import', 'default', this.revision, fields);
          this.revision = saved.revision;
          this.persisted = version;
        } catch (error) {
          const latest = await uiDraftApi.get('import', 'default');
          if ((latest?.revision ?? 0) === this.revision) throw error;
          await uiDraftApi.archive('import', 'default', fields);
          this.persisted = version;
          // Retain live input and do not replace the other writer's active draft.
          // New edits may acquire its token only after archiving it first.
          if (version === this.version) {
            this.revision = latest?.revision ?? 0;
            this.foreignDraft = latest ?? undefined;
            this.publish({ error: String(error) }, false);
          }
        }
      }
    })().catch(error => { this.publish({ error: String(error) }, false); throw error; }).finally(() => { this.writing = undefined; });
    return this.writing;
  }
  async add(paths: string[], commit: Commit, track: Track, label: string, retry = false): Promise<void> {
    if (!paths.length) return;
    if (this.view.busy) {
      await new Promise<void>(resolve => { const stop = this.subscribe(() => { if (!this.view.busy) { stop(); resolve(); } }); });
      return this.add(paths, commit, track, label, retry);
    }
    const learning = this.view.learningLanguage.trim(), explanation = this.view.explanationLanguage.trim();
    if (!learning || !explanation) return;
    this.publish({ busy: true, completed: 0, total: paths.length, error: undefined });
    const pair = languagePair(learning, explanation);
    try {
      await track({ kind: 'import', label, phase: 'checking_files' }, async update => {
        const validated = await libraryApi.validateMediaFiles(paths, learning, explanation);
        const incoming = validated.map(result => validatedItem(++this.nextId, result, pair));
        const old = retry ? this.view.rows.filter(row => !paths.includes(row.inputPath)) : this.view.rows;
        const merged = [...old.filter(row => row.languagePair !== pair), ...mergeQueue(old.filter(row => row.languagePair === pair), incoming)];
        const ids = new Set(incoming.map(row => row.id));
        this.publish({ rows: merged });
        await this.flush();
        const ready = merged.filter(row => ids.has(row.id) && row.status === 'ready');
        let failed = incoming.filter(row => row.status === 'invalid').length;
        let completed = paths.length - ready.length;
        const progress = () => { this.publish({ completed }, false); update({ phase: 'importing', completed, total: paths.length, unit: 'items' }); };
        progress();
        for (const row of ready) {
          this.publish({ rows: this.view.rows.map(item => item.id === row.id ? { ...item, status: 'importing' } : item) });
          try {
            const result = await commit(() => libraryApi.importLocalMedia({ path: row.canonicalPath || row.inputPath, learningLanguage: learning, explanationLanguage: explanation }));
            this.publish({ rows: this.view.rows.map(item => item.id === row.id ? { ...item, status: result.created ? 'imported' : 'existing', mediaId: result.mediaId } : item) });
          } catch (error) {
            failed++;
            this.publish({ rows: this.view.rows.map(item => item.id === row.id ? { ...item, status: 'failed', error: String(error) } : item) });
          }
          completed++; progress();
        }
        return failed;
      }, { classifyResult: failed => ({ status: failed ? 'failed' : 'completed' }) });
    } catch (error) { this.publish({ error: String(error), rows: this.view.rows.map(row => row.status === 'ready' || row.status === 'importing' ? { ...row, status: 'failed', error: String(error) } : row) }); }
    finally { this.publish({ busy: false }); }
  }
}
export const importWorkspace = new ImportWorkspace();

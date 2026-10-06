// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelEditor, emptyModel } from '../features/ai/ModelEditor';
import { ModelSetup } from '../features/ai/ModelSetup';
import { aiApi } from '../features/ai/api';
import type { AiModelPreference, AiPurpose } from '../shared/contracts/ai';

vi.mock('../features/ai/api', () => ({ aiApi: { vertexModels: vi.fn(), vertexPrice: vi.fn() } }));
vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
vi.mock('../app/runtime', () => ({
  useAppearance: () => ({ t: (_ja: string, en: string) => en }),
  useNotifications: () => ({ report: (action: () => Promise<unknown>) => action() }),
}));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

function Editor({ purpose = 'transcription' }: { purpose?: AiPurpose }) {
  const [value, setValue] = useState<AiModelPreference>({ ...emptyModel(purpose), modelId: 'custom-model', transcriptionMode: 'subtitles' });
  return <><ModelEditor value={value} onChange={setValue} purpose={purpose} location="global" /><output data-testid="model-state">{JSON.stringify(value)}</output></>;
}
const edited = () => JSON.parse(screen.getByTestId('model-state').textContent || '{}') as AiModelPreference;

it('pairs transcription model names with their API modes and leaves arbitrary model choices editable', () => {
  render(<Editor />);
  const id = screen.getByLabelText(/Gemini model ID/);
  fireEvent.change(id, { target: { value: 'gemini-test-transcribe' } });
  expect(screen.getByRole('combobox', { name: /^How to create subtitles/ })).toHaveValue('transcribe');
  fireEvent.change(id, { target: { value: 'gemini-test-flash' } });
  expect(screen.getByRole('combobox', { name: /^How to create subtitles/ })).toHaveValue('subtitles');
  fireEvent.change(id, { target: { value: 'custom-research-model' } });
  expect(screen.getByRole('combobox', { name: /^How to create subtitles/ })).toHaveValue('subtitles');
  fireEvent.change(screen.getByRole('combobox', { name: /^How to create subtitles/ }), { target: { value: 'transcribe' } });
  expect(edited()).toMatchObject({ modelId: 'custom-research-model', transcriptionMode: 'transcribe' });
});

it('does not change non-transcription API settings based on a typed model name', () => {
  render(<Editor purpose="vocabulary" />);
  fireEvent.change(screen.getByLabelText(/Gemini model ID/), { target: { value: 'gemini-test-transcribe' } });
  expect(edited().transcriptionMode).toBe('subtitles');
  expect(screen.queryByRole('combobox', { name: /^How to create subtitles/ })).not.toBeInTheDocument();
});

it('fills unset purposes without overwriting a configured model, its price, or output settings', () => {
  const existing: AiModelPreference = { ...emptyModel('transcription'), modelId: 'my-existing-transcriber', maxOutputTokens: 4096, thinkingBudget: 123, price: { id: 'custom-price', source: 'user', observedAtMs: 1, inputMicrousdPerMillion: 123, outputMicrousdPerMillion: 456 } };
  const changed = vi.fn();
  render(<ModelSetup models={{ transcription: existing }} location="global" disabled={false} onChange={changed} />);
  expect(screen.getByRole('checkbox', { name: /Transcription/ })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Vocabulary' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Explanation' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Translation' })).toBeChecked();
  fireEvent.change(screen.getByLabelText('Flash model'), { target: { value: 'gemini-selected-flash' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply to selected purposes' }));
  expect(changed).toHaveBeenCalledOnce();
  const result = changed.mock.calls[0][0] as Record<AiPurpose, AiModelPreference>;
  expect(result.transcription).toEqual(existing);
  for (const purpose of ['vocabulary', 'explanation', 'translation'] as const) {
    expect(result[purpose]).toMatchObject({ modelId: 'gemini-selected-flash', transcriptionMode: 'subtitles', price: null });
  }
});

it('replaces only an explicitly selected configured purpose and resets stale model pricing', () => {
  const existing = { ...emptyModel('transcription'), modelId: 'existing', price: { id: 'old-price', source: 'user', observedAtMs: 1, inputMicrousdPerMillion: 123, outputMicrousdPerMillion: 456 } };
  const models = { transcription: existing, vocabulary: existing, explanation: existing, translation: existing };
  const changed = vi.fn();
  render(<ModelSetup models={models} location="global" disabled={false} onChange={changed} />);
  const apply = screen.getByRole('button', { name: 'Apply to selected purposes' });
  expect(apply).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Transcribe model'), { target: { value: 'gemini-selected-transcribe' } });
  expect(apply).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /Transcription/ }));
  fireEvent.click(apply);
  const result = changed.mock.calls[0][0] as Record<AiPurpose, AiModelPreference>;
  expect(result.transcription).toMatchObject({ modelId: 'gemini-selected-transcribe', transcriptionMode: 'transcribe', price: null });
  expect(result.vocabulary).toEqual(existing);
  expect(result.explanation).toEqual(existing);
  expect(result.translation).toEqual(existing);
});

const modelChoices = (label: string) => {
  const input = screen.getByRole('combobox', { name: new RegExp(`^${label}`) }) as HTMLInputElement;
  return Array.from(document.getElementById(input.getAttribute('list')!)!.querySelectorAll('option')).map(option => option.value);
};

it('uses shared model candidates without offering or sending another discovery request', () => {
  const changed = vi.fn();
  const { rerender } = render(<ModelSetup models={{}} location="global" disabled={false} onChange={changed} candidates={[
    { id: 'gemini-selected-flash', displayName: 'Gemini Flash' },
    { id: 'gemini-selected-transcribe', displayName: 'Gemini Transcribe' },
    { id: 'gemini-other', displayName: 'Gemini Other' },
  ]} />);
  expect(screen.queryByRole('button', { name: 'Fetch model choices' })).not.toBeInTheDocument();
  expect(modelChoices('Flash model')).toEqual(['gemini-selected-flash']);
  expect(modelChoices('Transcribe model')).toEqual(['gemini-selected-transcribe']);
  expect(aiApi.vertexModels).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  rerender(<ModelSetup models={{}} location="us-central1" disabled={false} onChange={changed} candidates={[]} />);
  expect(modelChoices('Flash model')).toEqual([]);
  expect(modelChoices('Transcribe model')).toEqual([]);
  expect(screen.queryByRole('button', { name: 'Fetch model choices' })).not.toBeInTheDocument();
});

it('retains standalone model discovery when shared candidates are not supplied', async () => {
  vi.mocked(aiApi.vertexModels).mockResolvedValue([{ id: 'gemini-standalone-flash', displayName: 'Gemini Flash' }]);
  render(<ModelSetup models={{}} location="us-central1" disabled={false} onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Fetch model choices' }));
  await waitFor(() => expect(modelChoices('Flash model')).toEqual(['gemini-standalone-flash']));
  expect(aiApi.vertexModels).toHaveBeenCalledExactlyOnceWith('us-central1');
});

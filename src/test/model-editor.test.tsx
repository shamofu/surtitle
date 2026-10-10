// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { ModelEditor, emptyModel } from '../features/ai/ModelEditor';
import type {
  AiModelPreference,
  AiPurpose,
  DiscoveredModel,
} from '../shared/contracts/ai';
import { aiApi } from '../features/ai/api';

vi.mock('../features/ai/api', () => ({
  aiApi: { vertexModels: vi.fn(), vertexPrice: vi.fn() },
}));

vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
vi.mock('../app/runtime', () => {
  const useFixture = () => ({
    mutate: (action: () => Promise<unknown>) => action(),
    t: (_ja: string, en: string) => en,
  });
  return {
    useSnapshot: useFixture,
    useDataActions: useFixture,
    useAppearance: useFixture,
    useNotifications: useFixture,
    useSurface: useFixture,
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function Harness({
  initial = emptyModel('vocabulary'),
  purpose = 'vocabulary',
  candidates,
}: {
  initial?: AiModelPreference;
  purpose?: AiPurpose;
  candidates?: DiscoveredModel[];
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ModelEditor
        value={value}
        onChange={setValue}
        purpose={purpose}
        location="global"
        candidates={candidates}
      />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}
const state = () =>
  JSON.parse(
    screen.getByTestId('value').textContent || '{}',
  ) as AiModelPreference;
describe('arbitrary model and price selection', () => {
  it('uses shared candidates without fetching or selecting a model automatically', () => {
    const onChange = vi.fn();
    const value = { ...emptyModel('translation'), modelId: 'gemini-saved' };
    const { rerender, container } = render(
      <ModelEditor
        value={value}
        onChange={onChange}
        purpose="translation"
        location="global"
        candidates={[]}
      />,
    );
    expect(
      screen.queryByRole('button', { name: 'Fetch Vertex candidates' }),
    ).not.toBeInTheDocument();
    rerender(
      <ModelEditor
        value={value}
        onChange={onChange}
        purpose="translation"
        location="global"
        candidates={[
          {
            id: 'gemini-discovered',
            displayName: 'Discovered model',
            launchStage: 'GA',
          },
        ]}
      />,
    );
    expect(container.querySelector('datalist option')).toHaveAttribute(
      'value',
      'gemini-discovered',
    );
    expect(screen.getByDisplayValue('gemini-saved')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(aiApi.vertexModels).not.toHaveBeenCalled();
  });
  it('clears standalone candidates when the location changes', async () => {
    vi.mocked(aiApi.vertexModels).mockResolvedValue([
      { id: 'gemini-old-location', displayName: 'Old location' },
    ]);
    const value = emptyModel('vocabulary');
    const onChange = vi.fn();
    const { rerender, container } = render(
      <ModelEditor
        value={value}
        onChange={onChange}
        purpose="vocabulary"
        location="global"
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Fetch Vertex candidates' }),
    );
    await screen.findByText(/These are candidates returned by Google/);
    expect(container.querySelector('datalist option')).toHaveAttribute(
      'value',
      'gemini-old-location',
    );
    rerender(
      <ModelEditor
        value={value}
        onChange={onChange}
        purpose="vocabulary"
        location="us-central1"
      />,
    );
    expect(container.querySelector('datalist option')).not.toBeInTheDocument();
  });
  it.each([
    ['explanation', 4096],
    ['vocabulary', 8192],
    ['transcription', 12288],
    ['translation', 12288],
  ] as const)('restores the %s standard output limit to %i', (purpose, tokens) => {
    render(
      <Harness
        purpose={purpose}
        initial={{ ...emptyModel(purpose), maxOutputTokens: 7777 }}
      />,
    );
    const preset = screen.getByRole('combobox', { name: /^Output limit/ });
    expect(preset).toHaveValue('custom');
    expect(state().maxOutputTokens).toBe(7777);
    fireEvent.change(preset, { target: { value: 'standard' } });
    expect(state().maxOutputTokens).toBe(tokens);
    expect(preset).toHaveValue('standard');
    expect(
      screen.queryByRole('spinbutton', { name: /^Maximum output tokens/ }),
    ).not.toBeInTheDocument();
  });
  it('opens custom settings without changing the preset value and retains a custom limit', () => {
    const { container } = render(<Harness />);
    fireEvent.change(screen.getByRole('combobox', { name: /^Output limit/ }), {
      target: { value: 'custom' },
    });
    expect(state().maxOutputTokens).toBe(8192);
    expect(container.querySelector('details')).toHaveAttribute('open');
    const tokens = screen.getByRole('spinbutton', {
      name: /^Maximum output tokens/,
    });
    expect(tokens).toHaveAttribute('max', '1048576');
    fireEvent.change(tokens, { target: { value: '131072' } });
    expect(state().maxOutputTokens).toBe(131072);
    fireEvent.change(screen.getByRole('combobox', { name: /Gemini model ID/ }), {
      target: { value: 'gemini-another' },
    });
    expect(state().maxOutputTokens).toBe(131072);
    expect(screen.getByRole('combobox', { name: /^Output limit/ })).toHaveValue(
      'custom',
    );
  });
  it('explains the subtitle methods with user-facing names', () => {
    render(
      <Harness
        purpose="transcription"
        initial={emptyModel('transcription')}
      />,
    );
    const method = screen.getByRole('combobox', {
      name: /^How to create subtitles/,
    });
    expect(method).toHaveValue('transcribe');
    expect(
      screen.getByRole('option', {
        name: 'Verbatim transcription and word timestamps',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/the app assembles the subtitles \(Transcribe\)/),
    ).toBeInTheDocument();
    fireEvent.change(method, { target: { value: 'subtitles' } });
    expect(state().transcriptionMode).toBe('subtitles');
    expect(
      screen.getByText(/generates a start and end time for each cue \(GenerateContent\)/),
    ).toBeInTheDocument();
    expect(screen.queryByText('Transcription API mode')).not.toBeInTheDocument();
  });
  it('discards a stale price after location changes, even if the location changes back', async () => {
    let complete!: (
      value: Awaited<ReturnType<typeof aiApi.vertexPrice>>,
    ) => void;
    vi.mocked(aiApi.vertexPrice).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const value = { ...emptyModel('vocabulary'), modelId: 'gemini-any' };
    const onChange = vi.fn();
    const { rerender } = render(
      <ModelEditor
        value={value}
        onChange={onChange}
        purpose="vocabulary"
        location="global"
      />,
    );
    fireEvent.click(screen.getByText('Output, thinking, and pricing'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Retrieve public prices' }),
    );
    rerender(
      <ModelEditor
        value={value}
        onChange={onChange}
        purpose="vocabulary"
        location="us-central1"
      />,
    );
    rerender(
      <ModelEditor
        value={value}
        onChange={onChange}
        purpose="vocabulary"
        location="global"
      />,
    );
    await act(async () =>
      complete({
        price: {
          id: 'old',
          source: 'google',
          observedAtMs: 1,
          inputMicrousdPerMillion: 1,
          outputMicrousdPerMillion: 2,
        },
        candidates: [],
        observedAtMs: 1,
        complete: true,
      }),
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/Retrieved maximum public SKU/),
    ).not.toBeInTheDocument();
  });
  it('merges a received price through the current callback and current output settings', async () => {
    let complete!: (
      value: Awaited<ReturnType<typeof aiApi.vertexPrice>>,
    ) => void;
    vi.mocked(aiApi.vertexPrice).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const value = { ...emptyModel('vocabulary'), modelId: 'gemini-any' };
    const oldChange = vi.fn(),
      newChange = vi.fn();
    const { rerender } = render(
      <ModelEditor
        value={value}
        onChange={oldChange}
        purpose="vocabulary"
        location="global"
      />,
    );
    fireEvent.click(screen.getByText('Output, thinking, and pricing'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Retrieve public prices' }),
    );
    const updated = { ...value, maxOutputTokens: 1024 };
    rerender(
      <ModelEditor
        value={updated}
        onChange={newChange}
        purpose="vocabulary"
        location="global"
      />,
    );
    const price = {
      id: 'fresh',
      source: 'google',
      observedAtMs: 1,
      inputMicrousdPerMillion: 1,
      outputMicrousdPerMillion: 2,
    };
    await act(async () =>
      complete({ price, candidates: [], observedAtMs: 1, complete: true }),
    );
    expect(oldChange).not.toHaveBeenCalled();
    expect(newChange).toHaveBeenCalledExactlyOnceWith({ ...updated, price });
  });
  it('starts unset and remains editable after discovery fails', async () => {
    vi.mocked(aiApi.vertexModels).mockRejectedValue(new Error('denied'));
    render(<Harness />);
    expect(
      screen.getByRole('combobox', { name: /Gemini model ID/ }),
    ).toHaveValue('');
    fireEvent.click(
      screen.getByRole('button', { name: 'Fetch Vertex candidates' }),
    );
    await screen.findByText(
      'Could not fetch the list. You can still enter a model ID directly.',
    );
    fireEvent.change(
      screen.getByRole('combobox', { name: /Gemini model ID/ }),
      { target: { value: 'gemini-future-model' } },
    );
    expect(state().modelId).toBe('gemini-future-model');
    expect(state().price).toBeNull();
    expect(aiApi.vertexPrice).not.toHaveBeenCalled();
  });
  it('clears a previous model price when the ID changes', () => {
    render(
      <Harness
        initial={{
          ...emptyModel('vocabulary'),
          modelId: 'gemini-example',
          price: {
            id: 'p',
            source: 'user',
            observedAtMs: 1,
            inputMicrousdPerMillion: 1000000,
            outputMicrousdPerMillion: 2000000,
          },
        }}
      />,
    );
    fireEvent.change(screen.getByDisplayValue('gemini-example'), {
      target: { value: 'gemini-new' },
    });
    expect(state().price).toBeNull();
  });
  it('requires explicit valid manual rates, including an intentional zero', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Output, thinking, and pricing'));
    fireEvent.click(screen.getByRole('button', { name: 'Set rates manually' }));
    const input = screen.getByRole('textbox', {
      name: 'Input USD / million tokens',
    });
    const output = screen.getByRole('textbox', {
      name: 'Output USD / million tokens',
    });
    const apply = screen.getByRole('button', { name: 'Apply these rates' });
    expect(apply).toBeDisabled();
    fireEvent.change(input, { target: { value: '-1' } });
    fireEvent.change(output, { target: { value: '3.75' } });
    expect(apply).toBeDisabled();
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(apply);
    expect(state().price?.inputMicrousdPerMillion).toBe(0);
    expect(state().price?.outputMicrousdPerMillion).toBe(3750000);
    expect(state().price?.source).toBe('user');
  });
  it('keeps manual rate inputs, draft text and selection when their region is closed and reopened', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Output, thinking, and pricing'));
    const toggle = screen.getByRole('button', { name: 'Set rates manually' });
    fireEvent.click(toggle);
    const input = screen.getByRole('textbox', { name: 'Input USD / million tokens' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1.234' } });
    input.focus();
    input.setSelectionRange(2, 4);
    fireEvent.compositionStart(input);
    fireEvent.compositionEnd(input, { data: '34' });
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(2);
    fireEvent.click(toggle);
    expect(screen.queryByRole('textbox', { name: 'Input USD / million tokens' })).not.toBeInTheDocument();
    expect(input).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByRole('textbox', { name: 'Input USD / million tokens' })).toBe(input);
    expect(input).toHaveValue('1.234');
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(4);
  });
  it('never fabricates a price after an unsuccessful public lookup', async () => {
    vi.mocked(aiApi.vertexPrice).mockResolvedValue({
      price: null,
      candidates: [],
      observedAtMs: 1,
      complete: true,
    });
    render(
      <Harness
        initial={{ ...emptyModel('vocabulary'), modelId: 'gemini-any' }}
      />,
    );
    fireEvent.click(screen.getByText('Output, thinking, and pricing'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Retrieve public prices' }),
    );
    await screen.findByText(
      'Could not identify applicable rates. Set rates manually or report with unknown pricing.',
    );
    expect(state().price).toBeNull();
    expect(aiApi.vertexPrice).toHaveBeenCalledWith('gemini-any', 'global');
  });
});

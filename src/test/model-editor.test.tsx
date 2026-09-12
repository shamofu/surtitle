// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ModelEditor, emptyModel } from '../components/ModelEditor';
import type { AiModelPreference } from '../api';
import { api } from '../api';

vi.mock('../api', () => ({ nativeAvailable: () => true, api: { vertexModels: vi.fn(), vertexPrice: vi.fn() } }));
vi.mock('../context', () => ({ useApp: () => ({ t: (_ja: string, en: string) => en }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function Harness({ initial = emptyModel('vocabulary') }: { initial?: AiModelPreference }) {
  const [value, setValue] = useState(initial);
  return <><ModelEditor value={value} onChange={setValue} purpose="vocabulary" location="global" /><output data-testid="value">{JSON.stringify(value)}</output></>;
}
const state = () => JSON.parse(screen.getByTestId('value').textContent || '{}') as AiModelPreference;
describe('arbitrary model and price selection', () => {
  it('discards a stale price after location changes, even if the location changes back', async () => {
    let complete!: (value: Awaited<ReturnType<typeof api.vertexPrice>>) => void;
    vi.mocked(api.vertexPrice).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const value = { ...emptyModel('vocabulary'), modelId: 'gemini-any' };
    const onChange = vi.fn();
    const { rerender } = render(<ModelEditor value={value} onChange={onChange} purpose="vocabulary" location="global" />);
    fireEvent.click(screen.getByText('Output, thinking, and pricing'));
    fireEvent.click(screen.getByRole('button', { name: 'Retrieve public prices' }));
    rerender(<ModelEditor value={value} onChange={onChange} purpose="vocabulary" location="us-central1" />);
    rerender(<ModelEditor value={value} onChange={onChange} purpose="vocabulary" location="global" />);
    await act(async () => complete({ price: { id: 'old', source: 'google', observedAtMs: 1, inputMicrousdPerMillion: 1, outputMicrousdPerMillion: 2 }, candidates: [], observedAtMs: 1, complete: true }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText(/Retrieved maximum public SKU/)).not.toBeInTheDocument();
  });
  it('merges a received price through the current callback and current output settings', async () => {
    let complete!: (value: Awaited<ReturnType<typeof api.vertexPrice>>) => void;
    vi.mocked(api.vertexPrice).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const value = { ...emptyModel('vocabulary'), modelId: 'gemini-any' };
    const oldChange = vi.fn(), newChange = vi.fn();
    const { rerender } = render(<ModelEditor value={value} onChange={oldChange} purpose="vocabulary" location="global" />);
    fireEvent.click(screen.getByText('Output, thinking, and pricing'));
    fireEvent.click(screen.getByRole('button', { name: 'Retrieve public prices' }));
    const updated = { ...value, maxOutputTokens: 1024 };
    rerender(<ModelEditor value={updated} onChange={newChange} purpose="vocabulary" location="global" />);
    const price = { id: 'fresh', source: 'google', observedAtMs: 1, inputMicrousdPerMillion: 1, outputMicrousdPerMillion: 2 };
    await act(async () => complete({ price, candidates: [], observedAtMs: 1, complete: true }));
    expect(oldChange).not.toHaveBeenCalled();
    expect(newChange).toHaveBeenCalledExactlyOnceWith({ ...updated, price });
  });
  it('starts unset and remains editable after discovery fails', async () => {
    vi.mocked(api.vertexModels).mockRejectedValue(new Error('denied'));
    render(<Harness />);
    expect(screen.getByRole('combobox', { name: /Gemini model ID/ })).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Fetch Vertex candidates' }));
    await screen.findByText('Could not fetch the list. You can still enter a model ID directly.');
    fireEvent.change(screen.getByRole('combobox', { name: /Gemini model ID/ }), { target: { value: 'gemini-future-model' } });
    expect(state().modelId).toBe('gemini-future-model');
    expect(state().price).toBeNull();
    expect(api.vertexPrice).not.toHaveBeenCalled();
  });
  it('clears a previous model price when the ID changes', () => {
    render(<Harness initial={{ ...emptyModel('vocabulary'), modelId: 'gemini-example', price: { id: 'p', source: 'user', observedAtMs: 1, inputMicrousdPerMillion: 1000000, outputMicrousdPerMillion: 2000000 } }} />);
    fireEvent.change(screen.getByDisplayValue('gemini-example'), { target: { value: 'gemini-new' } });
    expect(state().price).toBeNull();
  });
  it('requires explicit valid manual rates, including an intentional zero', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Output, thinking, and pricing'));
    fireEvent.click(screen.getByRole('button', { name: 'Set rates manually' }));
    const input = screen.getByRole('textbox', { name: 'Input USD / million tokens' });
    const output = screen.getByRole('textbox', { name: 'Output USD / million tokens' });
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
  it('never fabricates a price after an unsuccessful public lookup', async () => {
    vi.mocked(api.vertexPrice).mockResolvedValue({ price: null, candidates: [], observedAtMs: 1, complete: true });
    render(<Harness initial={{ ...emptyModel('vocabulary'), modelId: 'gemini-any' }} />);
    fireEvent.click(screen.getByText('Output, thinking, and pricing'));
    fireEvent.click(screen.getByRole('button', { name: 'Retrieve public prices' }));
    await screen.findByText('Could not identify applicable rates. Set rates manually or run with unknown pricing.');
    expect(state().price).toBeNull();
    expect(api.vertexPrice).toHaveBeenCalledWith('gemini-any', 'global');
  });
});

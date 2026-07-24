import { formatSuggestions, suggestClosest } from '../src/utils/suggest.js';

describe('suggestClosest', () => {
  it('suggests mistral for mistal', () => {
    expect(suggestClosest('mistal', ['gemini', 'mistral', 'groq'])).toEqual(
      expect.arrayContaining(['mistral']),
    );
  });

  it('prefers prefix matches', () => {
    expect(suggestClosest('mis', ['mistral', 'gemini'])[0]).toBe('mistral');
  });
});

describe('formatSuggestions', () => {
  it('renders a did-you-mean message', () => {
    expect(formatSuggestions('mistal', ['mistral', 'gemini'])).toMatch(/Did you mean: mistral/);
  });
});
